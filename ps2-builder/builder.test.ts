import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../builder/builder";
import { PS2_STEPS } from "../server/games";
import { createPs2Builder } from "./builder";
import { MARK } from "./patch";

// Real folders, links and copies: slower than a unit test, on Windows above all.
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

/** port.sh and shots.py, faked: port.sh prints its stages and writes what build_web.sh would. */
function fakeTools(fake: Fake = {}) {
  const calls: string[] = [];
  const seen: string[][] = [];
  const run: Runner = async (cmd, { cwd, log }) => {
    if (cmd[1]!.endsWith("shots.py")) {
      calls.push("shots");
      await mkdir(cmd[3]!, { recursive: true });
      for (const n of ["01", "02", "03"]) await writeFile(join(cmd[3]!, `${n}.webp`), "shot");
      return { code: 0, output: "3\n" };
    }
    const id = cmd[2]!;
    calls.push(`port ${id}`);
    seen.push(cmd);
    for (let n = 1; n <= 6; n++) log(`== [${n}/6] stage\n`);
    await mkdir(join(cwd, "games", id), { recursive: true });
    const f = fake.fail?.[id];
    await writeFile(join(cwd, "games", id, "explore.log"), f?.explore ?? "[ee] halted: idle loop at 0x1000\n");
    await fake.during?.(id);
    if (f) return { code: f.code, output: f.output };
    const web = join(cwd, "build", `web-${id}`);
    await mkdir(web, { recursive: true });
    for (const name of ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data", "ps2web.wasm.gz", "ps2web.js.gz", "build.ninja"])
      await writeFile(join(web, name), `${id} ${name}`);
    return { code: 0, output: "Done." };
  };
  return { calls, seen, run };
}

async function setup(tools: ReturnType<typeof fakeTools>) {
  const root = await mkdtemp(join(tmpdir(), "cordplay-ps2b-"));
  dirs.push(root);
  const data = join(root, "data");
  const repo = join(root, "recomp");
  await mkdir(join(repo, "web"), { recursive: true });
  await writeFile(join(repo, "web", "shell.html"), await readFile(fixture));
  let clock = 1_000_000;
  const builder = createPs2Builder({ data, repo, run: tools.run, now: () => (clock += 1000) });
  const status = async (id: string) => JSON.parse(await readFile(join(data, "ps2", id, "status.json"), "utf8"));
  async function game(id: string, at: number, { disc = true } = {}) {
    const dir = join(data, "ps2", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "game.json"), JSON.stringify({ id, serial: id.toUpperCase(), name: id, by: { id: "42", name: "Ana" }, at, cover: false }));
    if (disc) await writeFile(join(dir, "disc.iso"), "iso");
  }
  return { root, data, repo, builder, status, game };
}

test("nothing to build: heartbeat only", async () => {
  const tools = fakeTools();
  const { builder, game, status } = await setup(tools);
  await game("sles-11111", 1, { disc: false });
  await builder.tick();
  expect(tools.calls).toEqual([]);
  await game("sles-22222", 2);
  await builder.beat();
  expect((await status("sles-22222")).at).toBeGreaterThan(1_000_000);
});

test("one game at a time, oldest first; the others stay queued", async () => {
  const tools = fakeTools();
  const { builder, game, status } = await setup(tools);
  await game("sles-22222", 20);
  await game("sles-11111", 10);
  await builder.tick();
  expect(tools.calls).toEqual(["port sles-11111", "shots"]);
  expect((await status("sles-11111")).state).toBe("ready");
  expect((await status("sles-22222")).state).toBe("idle");
  await builder.tick();
  expect(tools.calls).toEqual(["port sles-11111", "shots", "port sles-22222", "shots"]);
  await builder.tick();
  expect(tools.calls).toHaveLength(4);
});

test("steps follow port.sh's output; publish swaps build/ with the page, gz and shots", async () => {
  const steps: number[] = [];
  const tools = fakeTools();
  const { builder, game, status, data, repo } = await setup(tools);
  await game("sles-11111", 10);
  const watch = setInterval(async () => {
    try {
      const s = await status("sles-11111");
      if (s.state === "building" && !steps.includes(s.step)) steps.push(s.step);
    } catch {}
  }, 1);
  await builder.tick();
  clearInterval(watch);
  expect(tools.seen[0]).toEqual(["bash", "scripts/port.sh", "sles-11111", join(data, "ps2", "sles-11111", "disc.iso"), "--rounds", "4", "--frames", "3600"]);
  const s = await status("sles-11111");
  expect(s).toMatchObject({ state: "ready", note: "idle loop at 0x1000", shots: 3 });
  expect(steps.at(-1)).toBe(6);
  const build = join(data, "ps2", "sles-11111", "build");
  expect((await readdir(build)).sort()).toEqual(["ps2web.data", "ps2web.html", "ps2web.js", "ps2web.js.gz", "ps2web.wasm", "ps2web.wasm.gz", "shots"]);
  expect((await readdir(join(build, "shots"))).sort()).toEqual(["01.webp", "02.webp", "03.webp"]);
  expect(await exists(join(data, "ps2", "sles-11111", "build.tmp"))).toBe(false);
  // the work stays in ps2-work/<id>/, reachable from the repo through links
  expect(await exists(join(data, "ps2-work", "sles-11111", "web", "ps2web.html"))).toBe(true);
  expect(await readFile(join(repo, "build", "web-sles-11111", "ps2web.html"), "utf8")).toBe("sles-11111 ps2web.html");
  expect(PS2_STEPS).toHaveLength(6);
});

test("a failing port.sh is failed with the log's end and the reason from explore.log", async () => {
  const tools = fakeTools({
    fail: { "sles-11111": { code: 1, output: "a\nb\nninja: build stopped", explore: "[ee] boot\n[sys] unhandled syscall 0x7c\n[sys] unhandled syscall 0x7d\n" } },
  });
  const { builder, game, status, data } = await setup(tools);
  await game("sles-11111", 10);
  await builder.tick();
  expect(await status("sles-11111")).toMatchObject({ state: "failed", message: "a\nb\nninja: build stopped", reason: "[sys] unhandled syscall 0x7c", refused: false });
  expect(await exists(join(data, "ps2", "sles-11111", "build"))).toBe(false);
  // failed with this disc: not tried again on its own
  await builder.tick();
  expect(tools.calls).toEqual(["port sles-11111"]);
});

test("no space left is said plainly and the intermediate files go", async () => {
  const tools = fakeTools({ fail: { "sles-11111": { code: 1, output: "write error: No space left on device" } } });
  const { builder, game, status, data } = await setup(tools);
  await game("sles-11111", 10);
  await builder.tick();
  expect((await status("sles-11111")).message).toBe("Sem espaço no servidor");
  expect(await exists(join(data, "ps2-work", "sles-11111"))).toBe(false);
});

test("retry builds again; a removed game is dropped midway without publishing", async () => {
  const tools = fakeTools({ fail: { "sles-11111": { code: 1, output: "boom" } } });
  const { builder, game, status, data } = await setup(tools);
  await game("sles-11111", 10);
  await builder.tick();
  expect((await status("sles-11111")).state).toBe("failed");
  const ok = fakeTools();
  const again = createPs2Builder({ data, repo: join(data, "..", "recomp"), run: ok.run, now: () => 5_000_000 });
  await writeFile(join(data, "ps2", "sles-11111", "retry"), "");
  await again.tick();
  expect(ok.calls).toEqual(["port sles-11111", "shots"]);
  expect((await status("sles-11111")).state).toBe("ready");
  expect(await exists(join(data, "ps2", "sles-11111", "retry"))).toBe(false);

  const gone = fakeTools({ during: (id) => rm(join(data, "ps2", id), { recursive: true, force: true }) });
  const third = createPs2Builder({ data, repo: join(data, "..", "recomp"), run: gone.run, now: () => 6_000_000 });
  await game("sles-22222", 20);
  await third.tick();
  expect(gone.calls).toEqual(["port sles-22222"]);
  expect(await exists(join(data, "ps2", "sles-22222"))).toBe(false);
  expect(await exists(join(data, "ps2-work", "sles-22222"))).toBe(false);
});

test("the shell is patched once before the first build", async () => {
  const tools = fakeTools();
  const { builder, game, repo } = await setup(tools);
  await game("sles-11111", 10);
  await builder.tick();
  const patched = await readFile(join(repo, "web", "shell.html"), "utf8");
  expect(patched.trimEnd()).toEndWith(MARK);
  await game("sles-22222", 20);
  await builder.tick();
  expect(await readFile(join(repo, "web", "shell.html"), "utf8")).toBe(patched);
});
