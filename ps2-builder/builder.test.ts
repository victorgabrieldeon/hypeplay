import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { S3Client } from "bun";
import type { Runner } from "../builder/builder";
import { FAST_STEPS } from "../server/games";
import { createQueue, PRIORITY, type EnqueueOptions } from "../server/queue";
import { createPs2Builder, parseMisses, type FastStatus } from "./builder";
import { localJobs } from "./jobs";
import { MARK } from "./patch";

// Real folders, links and copies: slower than a unit test.
setDefaultTimeout(20_000);

const fixture = join(import.meta.dir, "fixtures", "shell.html");
const exists = (path: string) => stat(path).then(() => true, () => false);

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Fake {
  /** port.sh's exit code and output for a game */
  fail?: Record<string, { code: number; output: string; explore?: string }>;
  /** run while port.sh "runs", e.g. to remove the game */
  during?: (id: string) => Promise<void>;
}

/** port.sh, faked: prints its stages and writes what build_web.sh would. */
function fakeTools(fake: Fake = {}) {
  const seen: string[][] = [];
  const run: Runner = async (cmd, { cwd, log }) => {
    const id = cmd[2]!;
    seen.push(cmd);
    for (let n = 1; n <= 6; n++) log(`== [${n}/6] stage\n`);
    await mkdir(join(cwd, "games", id), { recursive: true });
    // (port.sh starts the entry points' list; build_web.sh only builds the page)
    if (cmd[1] === "scripts/port.sh") await appendFile(join(cwd, "games", id, "entries.txt"), "");
    const f = fake.fail?.[id];
    await writeFile(join(cwd, "games", id, "explore.log"), f?.explore ?? "[ee] halted: frame limit reached\n");
    await fake.during?.(id);
    if (f) return { code: f.code, output: f.output };
    const web = join(cwd, "build", `web-${id}`);
    await mkdir(web, { recursive: true });
    for (const name of ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data", "ps2web.wasm.gz", "build.ninja"])
      await writeFile(join(web, name), `${id} ${name} ${seen.length}`);
    return { code: 0, output: "Done." };
  };
  return { seen, run };
}

async function setup(tools: ReturnType<typeof fakeTools>, { r2 = null as S3Client | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), "hypeplay-ps2b-"));
  dirs.push(root);
  const data = join(root, "data");
  const repo = join(root, "recomp");
  await mkdir(join(repo, "web"), { recursive: true });
  await writeFile(join(repo, "web", "shell.html"), await readFile(fixture));
  let clock = 1_000_000;
  const now = () => (clock += 1000);
  const queue = createQueue(":memory:", { now });
  const jobs = localJobs({ data, queue, r2, worker: "test" });
  // (another builder over the same folders: the next image, with its own page and recompiler)
  const make = (commit = "") => {
    const b = createPs2Builder({ work: join(data, "ps2-work"), repo, run: tools.run, commit, now, announce: () => {} });
    return { tick: () => b.next(jobs) };
  };
  const builder = make();
  const fast = (id: string) => join(data, "ps2", id, "fast");
  const status = (id: string) => queue.get(`ps2/${id}`)!.status as unknown as FastStatus;
  /** As library.ts asks: "Compilar versão rápida", "Tentar de novo", code met. */
  const ask = (id: string, o: EnqueueOptions = {}) => queue.enqueue(`ps2/${id}`, "ps2", o);
  async function game(id: string, { ask: asked = true } = {}) {
    const dir = join(data, "ps2", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "game.json"), JSON.stringify({ id, serial: id.toUpperCase(), name: id, by: { id: "42", name: "Ana" }, at: 1, cover: false }));
    await writeFile(join(dir, "disc.iso"), "iso");
    if (asked) {
      await mkdir(fast(id), { recursive: true });
      await writeFile(join(fast(id), "request"), "");
      ask(id);
    }
  }
  const miss = async (id: string, text: string) => {
    await writeFile(join(fast(id), "misses.txt"), text);
    ask(id, { priority: PRIORITY.miss, revive: false });
  };
  return { data, repo, builder, make, status, game, fast, queue, ask, miss, jobs, advance: (ms: number) => (clock += ms) };
}

test("a game nobody asked a fast version of is never built", async () => {
  const tools = fakeTools();
  const { builder, game, fast } = await setup(tools);
  await game("scus-97399", { ask: false });
  await builder.tick();
  expect(tools.seen).toEqual([]);
  expect(await exists(fast("scus-97399"))).toBe(false);
});

test("asked: port.sh builds it, the page is published whole, and the shell was patched first", async () => {
  const tools = fakeTools();
  const { builder, game, status, fast, repo, data } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  expect(tools.seen).toEqual([["bash", "scripts/port.sh", "scus-97399", join(data, "ps2", "scus-97399", "disc.iso"), "--rounds", "4", "--frames", "3600"]]);
  expect((await status("scus-97399")).state).toBe("ready");
  const build = join(fast("scus-97399"), "build");
  for (const f of ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data", "ps2web.wasm.gz"]) expect(await exists(join(build, f))).toBe(true);
  // (only the page's files: nothing else of the build folder)
  expect(await exists(join(build, "build.ninja"))).toBe(false);
  expect(await readFile(join(repo, "web", "shell.html"), "utf8")).toContain(MARK);
  // its files live in the data volume, not the image
  expect(await exists(join(data, "ps2-work", "scus-97399", "web", "ps2web.html"))).toBe(true);
  // ready: nothing more to do
  await builder.tick();
  expect(tools.seen.length).toBe(1);
});

test("the steps reach the queue while it builds", async () => {
  const seen: (number | undefined)[] = [];
  let st: ReturnType<typeof setup> extends Promise<infer T> ? T : never;
  const tools = fakeTools({ during: async (id) => void seen.push((await st.status(id)).step) });
  st = await setup(tools);
  await st.game("scus-97399");
  await st.builder.tick();
  expect(seen[0]).toBeGreaterThanOrEqual(1);
  expect(seen[0]).toBeLessThanOrEqual(FAST_STEPS.length);
});

test("a failure says why and waits for Tentar de novo (code met meanwhile doesn't wake it)", async () => {
  const tools = fakeTools({ fail: { "scus-97399": { code: 1, output: "boom", explore: "[sys] unhandled syscall 0x77\n" } } });
  const { builder, game, status, queue, ask, miss } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  const s = await status("scus-97399");
  expect(s).toMatchObject({ state: "failed", message: "boom", reason: "[sys] unhandled syscall 0x77" });
  expect(queue.get("ps2/scus-97399")!.state).toBe("failed");
  await miss("scus-97399", "0027959C\n");
  expect(await builder.tick()).toBe(false);
  expect(tools.seen.length).toBe(1);
  ask("scus-97399", { retry: true });
  await builder.tick();
  expect(tools.seen.length).toBe(2);
  expect(queue.get("ps2/scus-97399")!.retry).toBe(false);
});

test("code the players met is added and built in, without the test runs", async () => {
  const tools = fakeTools();
  const { builder, game, status, fast, data, miss } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  // (one known already, one out of range, one fine)
  await writeFile(join(data, "ps2-work", "scus-97399", "game", "entries.txt"), "12a4c0\n");
  await miss("scus-97399", "0012A4C0\n00000010\n0027959C\n");
  await builder.tick();
  expect(tools.seen[1]).toEqual(["bash", "scripts/port.sh", "scus-97399", join(data, "ps2", "scus-97399", "disc.iso"), "--no-explore"]);
  expect(await readFile(join(data, "ps2-work", "scus-97399", "game", "entries.txt"), "utf8")).toBe("12a4c0\n27959c\n");
  expect((await status("scus-97399")).state).toBe("ready");
  expect(await readFile(join(fast("scus-97399"), "build", "ps2web.html"), "utf8")).toEndWith(" 2");
  // learned: nothing new to build (asked again, it's done without building)
  await builder.tick();
  await miss("scus-97399", "0012A4C0\n0027959C\n");
  expect(await builder.tick()).toBe(true);
  expect(tools.seen.length).toBe(2);
});

test("code met on a machine without the game's translation: everything again, then that code in", async () => {
  const tools = fakeTools();
  const { builder, game, data, miss } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  // (another worker's build: this one has no ps2-work for it)
  await rm(join(data, "ps2-work", "scus-97399"), { recursive: true, force: true });
  await miss("scus-97399", "0027959C\n");
  await builder.tick();
  expect(tools.seen.slice(1).map((c) => c.slice(4))).toEqual([["--rounds", "4", "--frames", "3600"], ["--no-explore"]]);
  expect(await readFile(join(data, "ps2-work", "scus-97399", "game", "entries.txt"), "utf8")).toBe("27959c\n");
});

test("removed while it builds: nothing published, its files freed", async () => {
  let fast!: (id: string) => string;
  let st!: Awaited<ReturnType<typeof setup>>;
  // (as the app's "Apagar a versão rápida" does it: library.removeFast, retrying while the log is being written)
  const tools = fakeTools({
    during: async (id) => {
      st.queue.drop(`ps2/${id}`);
      await rm(fast(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  });
  st = await setup(tools);
  fast = st.fast;
  await st.game("scus-97399");
  await st.builder.tick();
  expect(await exists(fast("scus-97399"))).toBe(false);
  expect(await exists(join(st.data, "ps2-work", "scus-97399"))).toBe(false);
  expect(st.queue.get("ps2/scus-97399")).toBeNull();
});

test("oldest request first, one at a time; a player stopped on missing code goes ahead", async () => {
  const tools = fakeTools();
  const { builder, game, miss } = await setup(tools);
  await game("slus-20001");
  await builder.tick();
  await game("slus-20002");
  await game("scus-97399");
  await miss("slus-20001", "0027959C\n");
  await builder.tick();
  expect(tools.seen.map((c) => c[2])).toEqual(["slus-20001", "slus-20001"]);
  await builder.tick();
  await builder.tick();
  expect(tools.seen.map((c) => c[2])).toEqual(["slus-20001", "slus-20001", "slus-20002", "scus-97399"]);
  expect(await builder.tick()).toBe(false);
});

test("misses: only word-aligned pcs in main memory, once each", () => {
  expect(parseMisses("0027959C\n0027959c\n00279599\n00000010\n02000000\nxyz\n001FFFFC\n")).toEqual(["27959c", "1ffffc"]);
});

test("a new page (the shell's patch changed) rebuilds the page alone; a new recompiler translates again, without test runs", async () => {
  const tools = fakeTools();
  const { builder, make, game, status, data, repo } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  expect((await status("scus-97399")).shell).toMatch(/^[0-9a-f]{16}$/);
  // the next image's patch: another shell
  const shell = join(repo, "web", "shell.html");
  await writeFile(shell, `${await readFile(shell, "utf8")}<!-- outra versão -->\n`);
  const next = make();
  await next.tick();
  expect(tools.seen[1]).toEqual(["bash", "scripts/build_web.sh", "scus-97399"]);
  expect(await status("scus-97399")).toMatchObject({ state: "ready" });
  await next.tick();
  expect(tools.seen.length).toBe(2);
  // the next image's recompiler
  await make("abc123").tick();
  expect(tools.seen[2]).toEqual(["bash", "scripts/port.sh", "scus-97399", join(data, "ps2", "scus-97399", "disc.iso"), "--no-explore"]);
  expect(await status("scus-97399")).toMatchObject({ state: "ready", recomp: "abc123" });
});

test("while it's brought up to date it says so, and without its files the page can't be rebuilt alone", async () => {
  const seen: { updating?: boolean; step?: number }[] = [];
  let st!: Awaited<ReturnType<typeof setup>>;
  const tools = fakeTools({ during: async (id) => void seen.push(await st.status(id)) });
  st = await setup(tools);
  await st.game("scus-97399");
  await st.builder.tick();
  await rm(join(st.data, "ps2-work", "scus-97399", "web", "build.ninja"));
  const shell = join(st.repo, "web", "shell.html");
  await writeFile(shell, `${await readFile(shell, "utf8")}<!-- outra versão -->\n`);
  await st.make().tick();
  expect(tools.seen[1]![1]).toBe("scripts/port.sh");
  expect(tools.seen[1]).toContain("--no-explore");
  expect(seen[1]).toMatchObject({ updating: true });
});

test("Tentar de novo over a build redoes its code too (what failed may have been learning)", async () => {
  const tools = fakeTools();
  const { builder, game, ask } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  ask("scus-97399", { retry: true });
  await builder.tick();
  expect(tools.seen[1]).toContain("--no-explore");
});

test("a game whose disc is in R2: brought here for port.sh, gone again after", async () => {
  const asked: string[] = [];
  // (R2 faked: a Blob for any key, as Bun.write takes an S3 file)
  const r2 = { file: (key: string) => (asked.push(key), new Blob(["iso from r2"])) } as unknown as import("bun").S3Client;
  let during = "";
  const tools = fakeTools({ during: async (id) => void (during = await readFile(join(root, "ps2", id, "disc.iso"), "utf8")) });
  const { data, builder, game } = await setup(tools, { r2 });
  const root = data;
  await game("slus-20001");
  const iso = join(data, "ps2", "slus-20001", "disc.iso");
  await rm(iso);
  await writeFile(`${iso}.r2`, "10");
  await builder.tick();
  expect(asked).toEqual(["ps2/slus-20001/disc.iso"]);
  expect(during).toBe("iso from r2");
  expect(await exists(iso)).toBe(false);
  expect(await exists(`${iso}.r2`)).toBe(true);
});

test("an error that isn't the build's (R2 down) is tried again after a pause, then fails", async () => {
  let down = 2;
  const r2 = {
    file: () => {
      if (down-- > 0) throw new Error("R2 down");
      return new Blob(["iso from r2"]);
    },
  } as unknown as S3Client;
  const tools = fakeTools();
  const { builder, game, data, queue, status, advance } = await setup(tools, { r2 });
  await game("slus-20001");
  const iso = join(data, "ps2", "slus-20001", "disc.iso");
  await rm(iso);
  await writeFile(`${iso}.r2`, "10");
  await builder.tick();
  expect(queue.get("ps2/slus-20001")).toMatchObject({ state: "queued", attempts: 1 });
  // (held back a little)
  expect(await builder.tick()).toBe(false);
  advance(60_000);
  await builder.tick();
  expect(queue.get("ps2/slus-20001")).toMatchObject({ state: "queued", attempts: 2 });
  advance(120_000);
  await builder.tick();
  expect(status("slus-20001").state).toBe("ready");
  expect(tools.seen.length).toBe(1);
});

test("a worker that died mid-build: its job goes back in line once its lease is gone", async () => {
  const tools = fakeTools();
  const { builder, game, queue, advance } = await setup(tools);
  await game("slus-20001");
  // (claimed by a worker that never comes back)
  expect(queue.claim("gone", { kinds: ["ps2"] })!.key).toBe("ps2/slus-20001");
  expect(await builder.tick()).toBe(false);
  advance(3 * 60_000);
  await builder.tick();
  expect(queue.get("ps2/slus-20001")!.state).toBe("done");
  expect(tools.seen.length).toBe(1);
});
