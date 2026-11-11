/**
 * The Budokai Tenkaichi 3 plugin's builder (service builder in docker-compose.yml): watches the data
 * folder the plugin's server shares with it, and when a disc image is there and no game built from it, makes one:
 *
 *   1. Conferindo a ISO      install.py's disc step: the USA release, unmodified (else the image is deleted)
 *   2. Extraindo os dados    install.py's game data and executable data steps
 *   3. Compilando o jogo     port/web/build.py, gen_data_web.py, link.py web + webasync
 *   4. Ajustando caminhos    patch.ts: the page and net.js work under a path
 *   5. Publicando            the fixed list of files into build.tmp/, swapped in as build/
 *
 * It's the only writer of status.json (with a heartbeat, `at`, every few seconds: the page shows "offline" without
 * it). The tools' output goes to build.log; their intermediate files stay in work/, reused by a later build.
 *
 * Several builders may watch the same folder: a build is the builds' queue's job "bt3" (server/queue.ts), and only the
 * one that claimed it builds (and writes status.json meanwhile). Only on this machine: the disc never goes to R2.
 */
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createQueue, PRIORITY, type Queue } from "../server/queue";
import { patchNet, patchShell } from "./patch";

/** The game's files the server serves (the same list as bt3's files in server/games.ts). */
export const GAME_FILES = [
  "index.html",
  "net.js",
  "net.css",
  "bt3-jspi.js",
  "bt3-jspi.wasm",
  "bt3-async.js",
  "bt3-async.wasm",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "manifest.webmanifest",
];

export const STEPS = ["Conferindo a ISO", "Extraindo os dados", "Compilando o jogo", "Ajustando caminhos", "Publicando"];

export const REFUSED =
  "Essa ISO não é a versão americana sem modificações (SLUS-21678). Envie a ISO americana original do jogo.";

/** steps.py's exit code when install.py turned the disc image down (not a crash). */
const REFUSED_CODE = 2;

export type Runner = (cmd: string[], opts: { cwd: string; log: (text: string) => void }) => Promise<{ code: number; output: string }>;

/** status.json (read by server/upload.ts). */
interface Status {
  at: number;
  state: "idle" | "building" | "ready" | "failed";
  iso?: number;
  step?: number;
  total?: number;
  label?: string;
  startedAt?: number;
  message?: string;
  refused?: boolean;
}

/** A build's turn: the job, claimed; its lease renewed while it builds; given back once done. */
export interface Turn {
  beat(): void;
  done(): void;
}

/** The turn to build from the queue's job "bt3", or null while another builder has it. */
export function queueTurns(queue: Queue, worker: string, key = "bt3"): () => Turn | null {
  return () => {
    // (rerun off: a builder asking while another builds isn't a second build)
    queue.enqueue(key, "bt3", { priority: PRIORITY.ask, rerun: false });
    const c = queue.claim(worker, { kinds: ["bt3"] });
    if (!c) return null;
    return { beat: () => void queue.beat(key, c.token, undefined, worker), done: () => void queue.done(key, c.token) };
  };
}

export interface BuilderOptions {
  /** The data folder shared with the plugin's server (/app/data/bt3/). */
  dir: string;
  /** The fork's source in the image, at its fixed commit; copied to work/ to build in. */
  source: string;
  commit: string;
  run: Runner;
  python?: string;
  /** steps.py, next to this file. */
  steps?: string;
  now?: () => number;
  /** Builds only with a turn (queueTurns): another builder over the same folder doesn't build it twice. */
  take?: () => Turn | null;
}

class StepFailed extends Error {
  constructor(
    message: string,
    readonly refused = false,
  ) {
    super(message);
  }
}

const exists = (path: string) => stat(path).then((s) => s, () => null);
const tail = (text: string, lines = 12) => text.trimEnd().split("\n").slice(-lines).join("\n");

export function createBuilder({ dir, source, commit, run, python = "python3", steps = join(import.meta.dir, "steps.py"), now = () => Date.now(), take }: BuilderOptions) {
  const paths = {
    iso: join(dir, "disc.iso"),
    retry: join(dir, "retry"),
    status: join(dir, "status.json"),
    log: join(dir, "build.log"),
    work: join(dir, "work"),
    build: join(dir, "build"),
    tmp: join(dir, "build.tmp"),
    old: join(dir, "build.old"),
  };
  let status: Status = { at: now(), state: "idle" };
  let log = "";
  /** This builder's turn while it builds; `aside` while another builder has it (its status.json, not ours). */
  let turn: Turn | null = null;
  let aside = false;

  async function load() {
    try {
      status = { ...(JSON.parse(await readFile(paths.status, "utf8")) as Status) };
    } catch {
      // (first start)
    }
  }

  // (its own temporary name: another builder over the same folder writes its own)
  const tmp = `${paths.status}.${randomBytes(4).toString("hex")}.tmp`;
  async function save() {
    status.at = now();
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(status));
    await rename(tmp, paths.status);
  }

  // One at a time: the heartbeat and tick() both write, and they'd share the temporary file.
  let writing: Promise<unknown> = Promise.resolve();
  function write() {
    turn?.beat();
    if (aside) return writing;
    const next = writing.then(save, save);
    writing = next.catch(() => undefined);
    return next;
  }

  const say = (text: string) => {
    log += text;
    // (the log is for reading on the server; a failed write only loses lines)
    void writeFile(paths.log, log).catch(() => undefined);
  };

  async function exec(cmd: string[], cwd = paths.work) {
    say(`\n$ ${cmd.join(" ")}\n`);
    const r = await run(cmd, { cwd, log: say });
    if (r.code !== 0) throw new StepFailed(tail(r.output) || `${cmd.join(" ")}: código ${r.code}`, false);
    return r;
  }

  async function step(n: number) {
    status = { ...status, state: "building", step: n, total: STEPS.length, label: STEPS[n - 1] };
    say(`\n===== ${n}/${STEPS.length} ${STEPS[n - 1]} =====\n`);
    await write();
  }

  /** work/: the fork's source at its commit, kept between builds (the extracted data and objects are reused). */
  async function prepare() {
    const mark = join(paths.work, ".hypemeet-commit");
    if ((await readFile(mark, "utf8").catch(() => "")) === commit) return;
    await rm(paths.work, { recursive: true, force: true });
    await cp(source, paths.work, { recursive: true });
    await writeFile(mark, commit);
  }

  async function build(iso: number) {
    log = `build ${new Date(now()).toISOString()}\n`;
    say("");
    status = { at: now(), state: "building", iso, startedAt: now() };
    await step(1);
    await prepare();
    const disc = [python, steps, "disc", paths.iso];
    say(`\n$ ${disc.join(" ")}\n`);
    const checked = await run(disc, { cwd: paths.work, log: say });
    // Only install.py turning the image down deletes it; a crash is the server's problem, not the image's.
    if (checked.code === REFUSED_CODE) throw new StepFailed(REFUSED, true);
    if (checked.code !== 0) throw new StepFailed(tail(checked.output) || `código ${checked.code}`);
    await step(2);
    await exec([python, steps, "gamedata", paths.iso]);
    await exec([python, steps, "split"]);
    await step(3);
    await exec([python, "port/web/build.py"]);
    await exec([python, "port/web/gen_data_web.py"]);
    await exec([python, "port/web/link.py", "web"]);
    await exec([python, "port/web/link.py", "webasync"]);
    await step(4);
    const out = join(paths.work, "port", "build", "web");
    await rm(paths.tmp, { recursive: true, force: true });
    await mkdir(paths.tmp, { recursive: true });
    try {
      await writeFile(join(paths.tmp, "index.html"), patchShell(await readFile(join(out, "index.html"), "utf8")));
      await writeFile(join(paths.tmp, "net.js"), patchNet(await readFile(join(out, "net.js"), "utf8")));
    } catch (err) {
      throw new StepFailed((err as Error).message);
    }
    await step(5);
    for (const f of GAME_FILES) {
      if (f === "index.html" || f === "net.js") continue;
      if (!(await exists(join(out, f)))) throw new StepFailed(`O build não gerou ${f}`);
      await cp(join(out, f), join(paths.tmp, f));
    }
    await rm(paths.old, { recursive: true, force: true });
    if (await exists(paths.build)) await rename(paths.build, paths.old);
    await rename(paths.tmp, paths.build);
    await rm(paths.old, { recursive: true, force: true });
  }

  /** One look at the folder: builds if there's something to build. */
  async function tick() {
    const retry = !!(await exists(paths.retry));
    const iso = await exists(paths.iso);
    aside = false;
    if (retry && (!iso || (await exists(join(paths.build, "index.html"))))) await rm(paths.retry, { force: true });
    if (!iso) {
      // "Tentar de novo" after the image was turned down: back to asking for one.
      if (retry && status.state === "failed") status = { at: now(), state: "idle" };
      await write();
      return;
    }
    if (await exists(join(paths.build, "index.html"))) {
      if (status.state !== "ready") status = { at: now(), state: "ready", iso: iso.mtimeMs };
      await write();
      return;
    }
    if (status.state === "failed" && status.iso === iso.mtimeMs && !retry) {
      await write();
      return;
    }
    turn = take?.() ?? null;
    if (take && !turn) {
      // (another builder is on it: what it writes stands)
      aside = true;
      return;
    }
    if (retry) await rm(paths.retry, { force: true });
    try {
      await build(iso.mtimeMs);
      status = { at: now(), state: "ready", iso: iso.mtimeMs };
      say("\npronto\n");
    } catch (err) {
      const failed = err instanceof StepFailed ? err : new StepFailed(String((err as Error)?.message ?? err));
      say(`\nfalhou: ${failed.message}\n`);
      if (failed.refused) await rm(paths.iso, { force: true });
      status = { ...status, state: "failed", message: failed.message, refused: failed.refused };
    }
    await write();
    turn?.done();
    turn = null;
  }

  return { tick, load, write, paths, get status() { return status; } };
}

/** Spawns a tool; its output goes to the log as it comes and the last of it is kept. */
export const spawnRunner: Runner = async (cmd, { cwd, log }) => {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true });
      log(text);
      output = (output + text).slice(-64 * 1024);
    }
  };
  await Promise.all([read(proc.stdout), read(proc.stderr)]);
  return { code: await proc.exited, output };
};

const LOOK_MS = 5000;

if (import.meta.main) {
  const dir = process.env.BT3_DIR ?? "/app/data/bt3";
  // (the builds' queue next to the data: <DATA>/queue.db, as the app and ps2-builder have it)
  const queue = createQueue(process.env.QUEUE_DB ?? join(dir, "..", "queue.db"));
  const builder = createBuilder({
    dir,
    source: process.env.BT3_SOURCE ?? "/opt/t3",
    commit: process.env.BT3_COMMIT ?? "",
    run: spawnRunner,
    take: queueTurns(queue, process.env.WORKER_ID || `${hostname()}-${process.pid}`),
  });
  await builder.load();
  // The heartbeat goes on during a build, which takes many minutes.
  setInterval(() => void builder.write().catch((err) => console.error("status.json:", err)), LOOK_MS);
  console.log(`bt3-builder: watching ${builder.paths.iso}`);
  for (;;) {
    await builder.tick().catch((err) => console.error("bt3-builder:", err));
    await Bun.sleep(LOOK_MS);
  }
}
