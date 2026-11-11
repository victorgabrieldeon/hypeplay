import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runner } from "../builder/builder";
import { createPs2Builder } from "../ps2-builder/builder";
import { localJobs, remoteJobs } from "../ps2-builder/jobs";
import { createLibrary } from "./library";
import { createQueue } from "./queue";
import { fakeR2 } from "./testing/r2";
import { createWorkerApi } from "./workers";

// The app's side (its volume, its queue, /worker/) and a worker on another machine (its own folder, R2), for real.
const r2 = fakeR2();
const TOKEN = "segredo";
let root = "";
let dir = "";
let far = "";
let repo = "";
let server: ReturnType<typeof Bun.serve>;
let url = "";
const queue = () => library.queue;
let library: ReturnType<typeof createLibrary>;
let api: ReturnType<typeof createWorkerApi>;
const exists = (path: string) => stat(path).then(() => true, () => false);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "hypeplay-workers-"));
  dir = join(root, "app");
  far = join(root, "far");
  repo = join(root, "recomp");
  await mkdir(join(repo, "web"), { recursive: true });
  await writeFile(join(repo, "web", "shell.html"), await readFile(join(import.meta.dir, "..", "ps2-builder", "fixtures", "shell.html")));
  library = createLibrary(dir, { r2: r2.client, queue: createQueue(join(dir, "..", "queue.db")) });
  api = createWorkerApi({ dir, queue: library.queue, r2: r2.client, token: TOKEN });
  server = Bun.serve({ port: 0, fetch: (req) => api.handle(req) ?? new Response("app", { status: 200 }) });
  url = `http://127.0.0.1:${server.port}/`;
});
afterAll(async () => {
  server.stop(true);
  r2.stop();
  await rm(root, { recursive: true, force: true });
});

/** port.sh, faked: what the disc says ends up in the page. */
function fakeTools(during?: (id: string) => Promise<void>) {
  const seen: string[][] = [];
  const run: Runner = async (cmd, { cwd, log }) => {
    const id = cmd[2]!;
    seen.push(cmd);
    for (let n = 1; n <= 6; n++) log(`== [${n}/6] stage\n`);
    await mkdir(join(cwd, "games", id), { recursive: true });
    if (cmd[1] === "scripts/port.sh") await writeFile(join(cwd, "games", id, "entries.txt"), "");
    const disc = cmd[3] ? await readFile(cmd[3], "utf8") : "";
    await during?.(id);
    const web = join(cwd, "build", `web-${id}`);
    await mkdir(web, { recursive: true });
    for (const f of ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data", "ps2web.wasm.gz"]) await writeFile(join(web, f), `${f} from ${disc}`);
    return { code: 0, output: "Done." };
  };
  return { seen, run };
}

/** A game asked for, its disc in R2 (or on the app's disk). */
async function game(id: string, { inR2 = true } = {}) {
  const p = join(dir, "ps2", id);
  await mkdir(p, { recursive: true });
  await writeFile(join(p, "game.json"), JSON.stringify({ id, serial: id.toUpperCase(), name: id, by: { id: "42", name: "Ana" }, at: Date.now(), cover: false }));
  if (inR2) {
    await r2.client.write(`ps2/${id}/disc.iso`, `disc of ${id}`);
    await writeFile(join(p, "disc.iso.r2"), String(`disc of ${id}`.length));
  } else await writeFile(join(p, "disc.iso"), `local disc of ${id}`);
  expect(await library.askFast(id)).toBe(true);
}

const remote = (tools: ReturnType<typeof fakeTools>, token = TOKEN) => {
  const builder = createPs2Builder({ work: join(far, "ps2-work"), repo, run: tools.run, announce: () => {} });
  const jobs = remoteJobs({ url, token, r2: r2.client, worker: "far-1", data: far });
  return { next: () => builder.next(jobs) };
};
const keysUnder = (prefix: string) => [...r2.objects.keys()].filter((k) => k.startsWith(prefix));

test("a worker elsewhere: the job through /worker/, the disc from R2, the build to R2, served from there", async () => {
  await game("slus-20001");
  expect(await library.fast("slus-20001")).toEqual({ state: "offline" });
  const tools = fakeTools();
  expect(await remote(tools).next()).toBe(true);
  const job = queue().get("ps2/slus-20001")!;
  expect(job).toMatchObject({ state: "done", status: { state: "ready" } });
  expect(job.build!.prefix).toMatch(/^ps2\/slus-20001\/fast\/[0-9a-z-]+$/);
  expect(job.build!.files.sort()).toEqual(["ps2web.data", "ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.wasm.gz"]);
  expect(await library.fast("slus-20001")).toEqual({ state: "ready" });
  const page = await library.fastFile("slus-20001", "ps2web.html");
  expect(page!.from).toBe("r2");
  expect(await page!.file.text()).toBe("ps2web.html from disc of slus-20001");
  expect(await library.fastFile("slus-20001", "ps2web.data.gz")).toBeNull();
  // nothing of it on the app's disk but its log; the worker's copy of the disc gone
  expect(await exists(join(dir, "ps2", "slus-20001", "fast", "build"))).toBe(false);
  expect(await readFile(join(dir, "ps2", "slus-20001", "fast", "build.log"), "utf8")).toContain("$ bash scripts/port.sh slus-20001");
  expect(await exists(join(far, "ps2", "slus-20001", "disc.iso"))).toBe(false);
  // (seen: the page no longer says offline for the next one)
  expect(queue().online("ps2")).toBe(true);

  // built again here (Tentar de novo on this machine): the R2 build goes
  const before = keysUnder(job.build!.prefix);
  expect(before.length).toBe(5);
  queue().enqueue("ps2/slus-20001", "ps2", { retry: true });
  const local = createPs2Builder({ work: join(dir, "ps2-work"), repo, run: fakeTools().run, announce: () => {} });
  expect(await local.next(localJobs({ data: dir, queue: queue(), r2: r2.client, worker: "here" }))).toBe(true);
  expect(queue().get("ps2/slus-20001")!.build).toBeNull();
  expect(keysUnder(job.build!.prefix)).toEqual([]);
  expect((await library.fastFile("slus-20001", "ps2web.html"))!.from).toBe("local");
});

test("a disc only on the app's disk goes to the worker through /worker/disc", async () => {
  await game("slus-20002", { inR2: false });
  const tools = fakeTools();
  expect(await remote(tools).next()).toBe(true);
  expect(await (await library.fastFile("slus-20002", "ps2web.js"))!.file.text()).toBe("ps2web.js from local disc of slus-20002");
});

test("removed while it builds elsewhere: nothing published, nothing left in R2", async () => {
  const tools = fakeTools(async (id) => library.removeFast(id));
  await game("slus-20003");
  expect(await remote(tools).next()).toBe(true);
  expect(queue().get("ps2/slus-20003")).toBeNull();
  expect(keysUnder("ps2/slus-20003/fast/")).toEqual([]);
  expect(await exists(join(dir, "ps2", "slus-20003", "fast"))).toBe(false);
});

test("without the token, nothing; anything not /worker/ is the app's", async () => {
  expect(await remote(fakeTools(), "outro").next().catch((e: Error) => e.message)).toStartWith("claim: 401");
  const res = await fetch(`${url}worker/claim`, { method: "POST", body: JSON.stringify({ worker: "x" }) });
  expect(res.status).toBe(401);
  expect(await (await fetch(`${url}p/abc/`)).text()).toBe("app");
  // (a build somewhere else in R2 isn't taken)
  await game("slus-20004");
  const c = (await (await fetch(`${url}worker/claim`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify({ worker: "x" }) })).json()) as {
    job: { key: string; token: string };
  };
  const done = await fetch(`${url}worker/done`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ worker: "x", ...c.job, status: { state: "ready" }, build: { prefix: "ps2/slus-20001/fast/x", files: ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data"] } }),
  });
  expect(done.status).toBe(400);
  expect(queue().get("ps2/slus-20004")!.state).toBe("running");
});
