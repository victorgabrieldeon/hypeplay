import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTEMPTS, createQueue, LEASE_MS, PRIORITY } from "./queue";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function clocked() {
  let clock = 1_000_000;
  const queue = createQueue(":memory:", { now: () => clock, backoff: 1000 });
  return { queue, tick: (ms = 1) => (clock += ms) };
}

test("concurrent claims, in several processes on one file: every job once, never twice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hypeplay-queue-"));
  dirs.push(dir);
  const path = join(dir, "queue.db");
  const queue = createQueue(path);
  const keys = Array.from({ length: 200 }, (_, i) => `ps2/slus-${String(20000 + i).padStart(5, "0")}`);
  for (const k of keys) queue.enqueue(k, "ps2");
  const workers = Array.from({ length: 6 }, (_, i) =>
    Bun.spawn(["bun", join(import.meta.dir, "testing", "claimer.ts"), path, `w${i}`], { stdout: "pipe", stderr: "pipe" }),
  );
  // (once every one of them is up, so none is late to the race)
  while (!(await Promise.all(workers.map((_, i) => Bun.file(`${path}.ready.w${i}`).exists()))).every(Boolean)) await Bun.sleep(5);
  await writeFile(`${path}.go`, "");
  const outs = await Promise.all(
    workers.map(async (w) => {
      const [out, err, code] = await Promise.all([new Response(w.stdout).text(), new Response(w.stderr).text(), w.exited]);
      expect(err).toBe("");
      expect(code).toBe(0);
      return out.split("\n").filter(Boolean);
    }),
  );
  const all = outs.flat();
  expect(all.length).toBe(keys.length);
  expect(new Set(all).size).toBe(keys.length);
  // (more than one of them got work: they did race)
  expect(outs.filter((o) => o.length > 0).length).toBeGreaterThan(1);
  expect(queue.list().every((j) => j.state === "done")).toBe(true);
  queue.close();
});

test("concurrent claims of one job in one process: one gets it", () => {
  const { queue } = clocked();
  queue.enqueue("ps2/slus-20001", "ps2");
  const got = Array.from({ length: 10 }, (_, i) => queue.claim(`w${i}`, { kinds: ["ps2"] })).filter(Boolean);
  expect(got.length).toBe(1);
});

test("best priority first, then oldest; only the kinds a worker builds", () => {
  const { queue, tick } = clocked();
  queue.enqueue("ps2/a", "ps2", { priority: PRIORITY.update });
  tick();
  queue.enqueue("ps2/b", "ps2");
  tick();
  queue.enqueue("other", "other");
  tick();
  queue.enqueue("ps2/c", "ps2");
  tick();
  queue.enqueue("ps2/d", "ps2", { priority: PRIORITY.miss });
  const order: string[] = [];
  for (let c; (c = queue.claim("w", { kinds: ["ps2"] })); ) order.push(c.key);
  expect(order).toEqual(["ps2/d", "ps2/b", "ps2/c", "ps2/a"]);
  expect(queue.claim("w", { kinds: ["other"] })!.key).toBe("other");
});

test("asking twice is one job; asked while it builds, it runs once more after", () => {
  const { queue } = clocked();
  queue.enqueue("ps2/a", "ps2");
  queue.enqueue("ps2/a", "ps2", { priority: PRIORITY.miss });
  expect(queue.list().length).toBe(1);
  expect(queue.get("ps2/a")!.priority).toBe(PRIORITY.miss);
  const c = queue.claim("w", { kinds: ["ps2"] })!;
  queue.enqueue("ps2/a", "ps2");
  expect(queue.claim("x", { kinds: ["ps2"] })).toBeNull();
  queue.done(c.key, c.token, { status: { state: "ready" } });
  expect(queue.get("ps2/a")!.state).toBe("queued");
  const again = queue.claim("w", { kinds: ["ps2"] })!;
  queue.done(again.key, again.token);
  expect(queue.get("ps2/a")).toMatchObject({ state: "done", status: { state: "ready" } });
  // (rerun off: the one asking knows it's being built)
  const third = (queue.enqueue("ps2/a", "ps2"), queue.claim("w", { kinds: ["ps2"] })!);
  queue.enqueue("ps2/a", "ps2", { rerun: false });
  queue.done(third.key, third.token);
  expect(queue.get("ps2/a")!.state).toBe("done");
});

test("a lease gone quiet: the job back in line with a new token, the old one told it lost it; then failed", () => {
  const { queue, tick } = clocked();
  queue.enqueue("ps2/a", "ps2");
  const first = queue.claim("w1", { kinds: ["ps2"] })!;
  tick(LEASE_MS / 2);
  expect(queue.beat(first.key, first.token, { state: "building", step: 2 })).toBe(true);
  tick(LEASE_MS / 2 + 1);
  // (still within the renewed lease)
  expect(queue.claim("w2", { kinds: ["ps2"] })).toBeNull();
  tick(LEASE_MS);
  const second = queue.claim("w2", { kinds: ["ps2"] })!;
  expect(second.token).not.toBe(first.token);
  expect(second.attempts).toBe(2);
  expect(queue.beat(first.key, first.token)).toBe(false);
  expect(queue.done(first.key, first.token)).toBeNull();
  expect(queue.fail(first.key, first.token)).toBe(false);
  // the rest of its attempts die the same way
  for (let n = 3; n <= ATTEMPTS; n++) {
    tick(LEASE_MS + 1);
    expect(queue.claim(`w${n}`, { kinds: ["ps2"] })!.attempts).toBe(n);
  }
  tick(LEASE_MS + 1);
  expect(queue.claim("w9", { kinds: ["ps2"] })).toBeNull();
  expect(queue.get("ps2/a")).toMatchObject({ state: "failed", status: { state: "failed" } });
});

test("failures: the build's own waits for Tentar de novo; anything else is tried again after a pause", () => {
  const { queue, tick } = clocked();
  queue.enqueue("ps2/a", "ps2");
  let c = queue.claim("w", { kinds: ["ps2"] })!;
  queue.fail(c.key, c.token, { status: { state: "failed", message: "R2" }, final: false });
  expect(queue.get("ps2/a")!.state).toBe("queued");
  expect(queue.claim("w", { kinds: ["ps2"] })).toBeNull();
  tick(1000);
  c = queue.claim("w", { kinds: ["ps2"] })!;
  queue.fail(c.key, c.token, { status: { state: "failed", message: "boom" } });
  expect(queue.get("ps2/a")).toMatchObject({ state: "failed", status: { message: "boom" } });
  // (code met doesn't wake it; Tentar de novo does)
  queue.enqueue("ps2/a", "ps2", { priority: PRIORITY.miss, revive: false });
  expect(queue.claim("w", { kinds: ["ps2"] })).toBeNull();
  queue.enqueue("ps2/a", "ps2", { retry: true });
  expect(queue.claim("w", { kinds: ["ps2"] })).toMatchObject({ retry: true, attempts: 1 });
});

test("a ready build made with another image is brought up to date, last in line; one that failed isn't", () => {
  const { queue, tick } = clocked();
  const image = { shell: "s2", recomp: "r1" };
  for (const k of ["ps2/a", "ps2/b"]) {
    queue.enqueue(k, "ps2");
    const c = queue.claim("w", { kinds: ["ps2"] })!;
    queue.done(c.key, c.token, { status: { state: k === "ps2/a" ? "ready" : "idle" }, shell: "s1", recomp: "r1" });
    tick();
  }
  queue.enqueue("ps2/c", "ps2");
  expect(queue.claim("w", { kinds: ["ps2"], image })!.key).toBe("ps2/c");
  const up = queue.claim("w", { kinds: ["ps2"], image })!;
  expect(up).toMatchObject({ key: "ps2/a", priority: PRIORITY.update, attempts: 1 });
  queue.done(up.key, up.token, { status: { state: "ready" }, shell: "s2", recomp: "r1" });
  expect(queue.claim("w", { kinds: ["ps2"], image })).toBeNull();
  // (without an image, nothing is brought up to date)
  expect(queue.claim("w", { kinds: ["ps2"], image: { shell: "s3", recomp: "r1" } })!.key).toBe("ps2/a");
});

test("dropped: gone from the queue, and its worker hears so", () => {
  const { queue } = clocked();
  queue.enqueue("ps2/a", "ps2");
  const c = queue.claim("w", { kinds: ["ps2"] })!;
  expect(queue.drop("ps2/a")!.key).toBe("ps2/a");
  expect(queue.beat(c.key, c.token)).toBe(false);
  expect(queue.get("ps2/a")).toBeNull();
});

test("a worker seen lately is online, for the kinds it builds", () => {
  const { queue, tick } = clocked();
  expect(queue.online("ps2")).toBe(false);
  queue.claim("w", { kinds: ["ps2"] });
  expect(queue.online("ps2")).toBe(true);
  expect(queue.online("other")).toBe(false);
  tick(3 * 60_000);
  expect(queue.online("ps2")).toBe(false);
});

test("adopted from the volume once: the queue keeps what it knows", () => {
  const { queue } = clocked();
  expect(queue.adopt("ps2/a", "ps2", "done", { status: { state: "ready" }, shell: "s", recomp: "r" })).toBe(true);
  expect(queue.adopt("ps2/a", "ps2", "queued")).toBe(false);
  expect(queue.get("ps2/a")).toMatchObject({ state: "done", shell: "s", recomp: "r" });
});
