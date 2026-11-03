import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../builder/builder";
import { FAST_STEPS } from "../server/games";
import { createPs2Builder, parseMisses } from "./builder";
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

async function setup(tools: ReturnType<typeof fakeTools>) {
  const root = await mkdtemp(join(tmpdir(), "hypeplay-ps2b-"));
  dirs.push(root);
  const data = join(root, "data");
  const repo = join(root, "recomp");
  await mkdir(join(repo, "web"), { recursive: true });
  await writeFile(join(repo, "web", "shell.html"), await readFile(fixture));
  let clock = 1_000_000;
  // (another builder over the same folders: the next image, with its own page and recompiler)
  const make = (commit = "") => createPs2Builder({ data, repo, run: tools.run, commit, now: () => (clock += 1000) });
  const builder = make();
  const fast = (id: string) => join(data, "ps2", id, "fast");
  const status = async (id: string) => JSON.parse(await readFile(join(fast(id), "status.json"), "utf8"));
  async function game(id: string, { ask = true } = {}) {
    const dir = join(data, "ps2", id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "game.json"), JSON.stringify({ id, serial: id.toUpperCase(), name: id, by: { id: "42", name: "Ana" }, at: 1, cover: false }));
    await writeFile(join(dir, "disc.iso"), "iso");
    if (ask) {
      await mkdir(fast(id), { recursive: true });
      await writeFile(join(fast(id), "request"), "");
    }
  }
  return { data, repo, builder, make, status, game, fast };
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

test("the steps reach status.json while it builds", async () => {
  const seen: number[] = [];
  let st: ReturnType<typeof setup> extends Promise<infer T> ? T : never;
  const tools = fakeTools({ during: async (id) => void seen.push((await st.status(id)).step) });
  st = await setup(tools);
  await st.game("scus-97399");
  await st.builder.tick();
  expect(seen[0]).toBeGreaterThanOrEqual(1);
  expect(seen[0]).toBeLessThanOrEqual(FAST_STEPS.length);
});

test("a failure says why and waits for Tentar de novo", async () => {
  const tools = fakeTools({ fail: { "scus-97399": { code: 1, output: "boom", explore: "[sys] unhandled syscall 0x77\n" } } });
  const { builder, game, status, fast } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  const s = await status("scus-97399");
  expect(s).toMatchObject({ state: "failed", message: "boom", reason: "[sys] unhandled syscall 0x77" });
  await builder.tick();
  expect(tools.seen.length).toBe(1);
  await writeFile(join(fast("scus-97399"), "retry"), "");
  await builder.tick();
  expect(tools.seen.length).toBe(2);
  expect(await exists(join(fast("scus-97399"), "retry"))).toBe(false);
});

test("code the players met is added and built in, without the test runs", async () => {
  const tools = fakeTools();
  const { builder, game, status, fast, data } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  // (one known already, one out of range, one fine)
  await writeFile(join(data, "ps2-work", "scus-97399", "game", "entries.txt"), "12a4c0\n");
  await writeFile(join(fast("scus-97399"), "misses.txt"), "0012A4C0\n00000010\n0027959C\n");
  await builder.tick();
  expect(tools.seen[1]).toEqual(["bash", "scripts/port.sh", "scus-97399", join(data, "ps2", "scus-97399", "disc.iso"), "--no-explore"]);
  expect(await readFile(join(data, "ps2-work", "scus-97399", "game", "entries.txt"), "utf8")).toBe("12a4c0\n27959c\n");
  expect((await status("scus-97399")).state).toBe("ready");
  expect(await readFile(join(fast("scus-97399"), "build", "ps2web.html"), "utf8")).toEndWith(" 2");
  // learned: nothing new to build
  await builder.tick();
  expect(tools.seen.length).toBe(2);
});

test("removed while it builds: nothing published, its files freed", async () => {
  let fast!: (id: string) => string;
  // (as the app's "Apagar a versão rápida" does it: library.removeFast, retrying while the log is being written)
  const tools = fakeTools({ during: async (id) => rm(fast(id), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) });
  const st = await setup(tools);
  fast = st.fast;
  await st.game("scus-97399");
  await st.builder.tick();
  expect(await exists(fast("scus-97399"))).toBe(false);
  expect(await exists(join(st.data, "ps2-work", "scus-97399"))).toBe(false);
});

test("oldest request first, one at a time", async () => {
  const tools = fakeTools();
  const { builder, game } = await setup(tools);
  await game("slus-20001");
  await Bun.sleep(20);
  await game("scus-97399");
  await builder.tick();
  expect(tools.seen.map((c) => c[2])).toEqual(["slus-20001"]);
  await builder.tick();
  expect(tools.seen.map((c) => c[2])).toEqual(["slus-20001", "scus-97399"]);
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
  const { builder, game, fast } = await setup(tools);
  await game("scus-97399");
  await builder.tick();
  await writeFile(join(fast("scus-97399"), "retry"), "");
  await builder.tick();
  expect(tools.seen[1]).toContain("--no-explore");
});

test("a game whose disc is in R2: brought here for port.sh, gone again after", async () => {
  const asked: string[] = [];
  // (R2 faked: a Blob for any key, as Bun.write takes an S3 file)
  const r2 = { file: (key: string) => (asked.push(key), new Blob(["iso from r2"])) } as unknown as import("bun").S3Client;
  let during = "";
  const tools = fakeTools({ during: async (id) => void (during = await readFile(join(root, "ps2", id, "disc.iso"), "utf8")) });
  const { data, repo, game } = await setup(tools);
  const root = data;
  await game("slus-20001");
  const iso = join(data, "ps2", "slus-20001", "disc.iso");
  await rm(iso);
  await writeFile(`${iso}.r2`, "10");
  await createPs2Builder({ data, repo, run: tools.run, r2 }).tick();
  expect(asked).toEqual(["ps2/slus-20001/disc.iso"]);
  expect(during).toBe("iso from r2");
  expect(await exists(iso)).toBe(false);
  expect(await exists(`${iso}.r2`)).toBe(true);
});
