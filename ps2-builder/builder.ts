/**
 * The PS2 games' "versão rápida" (service ps2-builder in docker-compose.yml). A PS2 game plays in TabStationToo (PCSX2
 * in WebAssembly) as soon as its disc is in; when someone asks, this compiles it with ps2-web-recomp's scripts/port.sh
 * into a page that is much faster in heavy games, for the games the recompiler supports.
 *
 * A worker: it takes one job at a time from the builds' queue (server/queue.ts), the best priority first, builds it and
 * says how it went. Several can run, here or on other machines (jobs.ts): each job goes to one of them.
 *
 *   on this machine   the queue's file (<DATA>/queue.db) and the game's folder, ps2/<id>/ (server/fastjobs.ts): its
 *                     disc (or disc.iso.r2, the disc in R2, brought to ps2-work/<id>/ for the build and gone again
 *                     after), misses.txt, build.log, and build/ (ps2web.{html,js,wasm,data} + .gz) swapped in whole
 *   elsewhere         QUEUE_URL + WORKER_TOKEN: the app's /worker/ (server/workers.ts) for the job and its progress, R2
 *                     for the disc and the build (the app serves it from there)
 *   ps2-work/<id>/    port.sh's files: games/<id>, generated/<id>, build/web-<id>, build/native-<id> of the recompiler's
 *                     folder are links into here, so nothing of a game lives in the image
 *
 * What a build takes depends on the game: all of it the first time; the code the players met added (no test runs); a
 * new recompiler (or "Tentar de novo"): the code again; a new page (patched shell) alone. A ready build made with
 * another page or recompiler is brought up to date when nothing else waits (the queue hands it over).
 *
 * Before the first build, the recompiler's web/shell.html gets patch.ts (saves on the server, missing code, browser).
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PUBLISHED, type FastClaim } from "../server/fastjobs";
import { BUILD_SECONDS, telemetryFromEnv, type Histogram } from "../server/otlp";
import { FAST_STEPS } from "../server/games";
import type { Image } from "../server/queue";
import { jobsFromEnv } from "./jobs";
import { MARK, patchShell } from "./patch";

export { PUBLISHED };

export type Runner = (cmd: string[], opts: { cwd: string; log: (text: string) => void }) => Promise<{ code: number; output: string }>;

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

/** A missing pc a page may report: word-aligned, in the EE's main memory above the kernel. */
const MISS = /^[0-9A-F]{8}$/;
const MISS_MIN = 0x0010_0000;
const MISS_MAX = 0x0200_0000;
/** Learned in one go at most (a page reports one per halt; more means something odd). */
const LEARN_MAX = 64;

/** A build's report, kept with its job in the queue (read by server/library.ts). */
export interface FastStatus {
  state: "idle" | "building" | "ready" | "failed";
  step?: number;
  total?: number;
  label?: string;
  startedAt?: number;
  /** Building in code the players met, over a build that still plays. */
  learning?: boolean;
  /** Bringing a build up to date with a new page or recompiler, over a build that still plays. */
  updating?: boolean;
  /** (ready) the patched shell's hash and the recompiler's commit it was built with */
  shell?: string;
  recomp?: string;
  message?: string;
  /** The line of the test runs' log that says why the game stopped, when it did. */
  reason?: string;
}

/** Where the jobs come from and go to: this machine's queue and volume, or the app's /worker/ and R2 (jobs.ts). */
export interface Jobs {
  claim(image: Image): Promise<FastClaim | null>;
  /** The job's lease renewed, its progress kept; false: it isn't this worker's any more (removed, taken over). */
  beat(c: FastClaim, status: FastStatus): Promise<boolean>;
  /** The output so far (all of it). */
  log(c: FastClaim, text: string): void;
  /** The game's disc on this disk for port.sh, and what to do once done with it. */
  disc(c: FastClaim): Promise<{ path: string; release: () => Promise<void> }>;
  /** Built: `web`'s page published (without it, there was nothing to build). False: not this worker's job any more. */
  finish(c: FastClaim, report: { status: FastStatus; shell?: string; recomp?: string }, web?: string): Promise<boolean>;
  /** `final`: the build's own failure (it waits for "Tentar de novo"); else it's tried again later. */
  fail(c: FastClaim, status: FastStatus, final: boolean): Promise<void>;
}

class StepFailed extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The game was removed, or its fast version, while it built (or another worker has the job): nothing to publish. */
class Gone extends Error {}

const exists = (path: string) => stat(path).then((s) => s, () => null);
const tail = (text: string, lines = 12) => text.trimEnd().split("\n").slice(-lines).join("\n");
const noSpace = (text: string) => /No space left on device|ENOSPC/.test(text);
const NO_SPACE = "Sem espaço no servidor";

/** The pcs in a misses.txt the recompiler takes as entry points (entries.txt's form: lowercase hex, no 0x). */
export function parseMisses(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split("\n")) {
    const t = line.trim().toUpperCase();
    if (!MISS.test(t)) continue;
    const pc = Number.parseInt(t, 16);
    if (pc % 4 || pc < MISS_MIN || pc >= MISS_MAX) continue;
    found.add(pc.toString(16));
  }
  return [...found];
}

export interface Ps2BuilderOptions {
  /** ps2-work/: port.sh's files, one folder per game (this machine's) */
  work: string;
  /** the recompiler's folder (/opt/recomp), with its tools built */
  repo: string;
  run: Runner;
  /** the recompiler's commit (the image's RECOMP_COMMIT) */
  commit?: string;
  rounds?: number;
  frames?: number;
  now?: () => number;
  /** How often a build renews its job while port.sh runs. */
  beatMs?: number;
  /** Where it says which job it took (the console). */
  announce?: (line: string) => void;
  /** Each build's seconds, by its kind and result (server/otlp.ts) */
  builds?: Histogram;
}

/** How much a build takes: all of it, code the players met, a new recompiler (or a retry), or the page alone. */
type Mode = "full" | "learn" | "recomp" | "page";

export function createPs2Builder({ work, repo, run, commit = "", rounds = 4, frames = 3600, now = () => Date.now(), beatMs = 5000, announce = console.log, builds }: Ps2BuilderOptions) {
  /** The patched shell's hash, once patched. */
  let shell = "";

  const game = (id: string) => {
    const w = join(work, id);
    return {
      work: w,
      web: join(w, "web"),
      entries: join(w, "game", "entries.txt"),
      /** the recompiler's folders for this game, linked into ps2-work/<id>/ */
      links: [
        [join(repo, "games", id), join(w, "game")],
        [join(repo, "generated", id), join(w, "generated")],
        [join(repo, "build", `web-${id}`), join(w, "web")],
        [join(repo, "build", `native-${id}`), join(w, "native")],
      ] as const,
    };
  };

  /** Code the players met that this machine's translation doesn't have yet. */
  async function newMisses(id: string, text: string) {
    const misses = parseMisses(text);
    if (!misses.length) return [];
    const known = new Set((await readFile(game(id).entries, "utf8").catch(() => "")).split(/\s+/));
    return misses.filter((m) => !known.has(m)).slice(0, LEARN_MAX);
  }

  async function prepare() {
    if (shell) return;
    const path = join(repo, "web", "shell.html");
    let html = await readFile(path, "utf8");
    if (!html.includes(MARK)) await writeFile(path, (html = patchShell(html)));
    shell = createHash("sha256").update(html).digest("hex").slice(0, 16);
  }

  async function link(id: string) {
    for (const [from, to] of game(id).links) {
      await mkdir(to, { recursive: true });
      await mkdir(join(from, ".."), { recursive: true });
      await rm(from, { recursive: true, force: true });
      // (a junction on Windows, where the tests may run; a plain link elsewhere)
      await symlink(to, from, "junction");
    }
  }

  /** What this job takes on this machine (its ps2-work may be another's: then the code is redone here). */
  async function plan(c: FastClaim): Promise<{ mode: Mode; learn: string[] } | null> {
    const g = c.game;
    const p = game(g.id);
    const translated = !!(await exists(p.entries));
    const learn = g.built ? await newMisses(g.id, g.misses) : [];
    if (!g.built) return { mode: "full", learn: [] };
    // (learning adds to this machine's translation: without one, everything again, then the code met)
    if (learn.length) return { mode: translated ? "learn" : "full", learn };
    // (a retry over a build redoes the code too: what failed may have been learning)
    if (g.retry || g.recomp !== commit) return { mode: translated ? "recomp" : "full", learn: [] };
    if (g.shell !== shell) return { mode: (await exists(join(p.web, "build.ninja"))) ? "page" : translated ? "recomp" : "full", learn: [] };
    return null;
  }

  async function build(c: FastClaim, jobs: Jobs, mode: Mode, learn: string[], status: FastStatus, iso: string) {
    const { id } = c.game;
    const p = game(id);
    let log = `build ${new Date(now()).toISOString()} (${mode}${learn.length ? `: ${learn.join(" ")}` : ""})\n`;
    const say = (text: string) => {
      log += text;
      jobs.log(c, log);
    };
    await link(id);
    // (port.sh links the disc it's given once, and keeps a link that points nowhere: the disc may be elsewhere now)
    if (iso) await rm(join(p.work, "game", "disc.iso"), { force: true });
    const explore = ["bash", "scripts/port.sh", id, iso, "--rounds", String(rounds), "--frames", String(frames)];
    const known = ["bash", "scripts/port.sh", id, iso, "--no-explore"];
    // (learning or a new recompiler: everything translated again with the entry points known, no test runs; a new page:
    // the page alone, from the code already built; all of it with code met: the test runs, then that code in)
    const cmds = mode === "page" ? [["bash", "scripts/build_web.sh", id]] : mode === "full" ? (learn.length ? [explore, known] : [explore]) : [known];
    if (mode === "learn") await appendFile(p.entries, learn.map((m) => `${m}\n`).join(""));
    for (const [i, cmd] of cmds.entries()) {
      if (i > 0) {
        const left = await newMisses(id, c.game.misses);
        if (!left.length) break;
        await appendFile(p.entries, left.map((m) => `${m}\n`).join(""));
      }
      say(`\n$ ${cmd.join(" ")}\n`);
      let pending = "";
      const r = await run(cmd, {
        cwd: repo,
        log: (text) => {
          say(text);
          pending += text;
          const lines = pending.split("\n");
          pending = lines.pop()!;
          for (const line of lines) {
            const m = /^== \[(\d)\/6\]/.exec(line);
            if (!m) continue;
            const n = Number(m[1]);
            Object.assign(status, { step: n, label: FAST_STEPS[n - 1] });
            void jobs.beat(c, status).catch(() => undefined);
          }
        },
      });
      if (!(await jobs.beat(c, status))) throw new Gone();
      if (r.code !== 0) {
        if (noSpace(r.output)) throw new StepFailed(NO_SPACE);
        const ran = await readFile(join(p.work, "game", "explore.log"), "utf8").catch(() => "");
        const reason = /^\[(?:sys\] unhandled syscall|iop\] missing ).*$/m.exec(ran)?.[0];
        throw new StepFailed(tail(r.output) || `port.sh: código ${r.code}`, reason);
      }
    }
    for (const f of PUBLISHED) if (!(await exists(join(p.web, f)))) throw new StepFailed(`O build não gerou ${f}`);
    if (!(await jobs.finish(c, { status: { state: "ready", shell, recomp: commit }, shell, recomp: commit }, p.web))) throw new Gone();
    say("\npronto\n");
  }

  /** One job, start to end: whatever happens, the queue hears how it went. */
  async function take(c: FastClaim, jobs: Jobs) {
    await prepare();
    const planned = await plan(c);
    if (!planned) {
      await jobs.finish(c, { status: { state: "ready", shell, recomp: commit }, shell, recomp: commit });
      return;
    }
    const { mode, learn } = planned;
    const first = mode === "page" ? FAST_STEPS.length : 1;
    const status: FastStatus = {
      state: "building",
      startedAt: now(),
      step: first,
      total: FAST_STEPS.length,
      label: FAST_STEPS[first - 1],
      // (over a build that still plays: learning the code met, or brought up to date)
      ...(learn.length ? { learning: true } : c.game.built ? { updating: true } : {}),
    };
    // The lease goes on during a build, which takes many minutes.
    const beating = setInterval(() => void jobs.beat(c, status).catch((err) => console.error("ps2-builder: beat:", err)), beatMs);
    let disc: { path: string; release: () => Promise<void> } | null = null;
    const started = now();
    const took = (result: string) => builds?.record((now() - started) / 1000, { mode, result });
    try {
      if (!(await jobs.beat(c, status))) throw new Gone();
      // (the page alone doesn't read the disc)
      disc = mode === "page" ? { path: "", release: async () => {} } : await jobs.disc(c);
      await build(c, jobs, mode, learn, status, disc.path);
      took("ready");
    } catch (err) {
      took(err instanceof Gone ? "gone" : "failed");
      if (err instanceof Gone) {
        // (removed: its files go; library.ts does the same on this machine)
        await rm(game(c.game.id).work, { recursive: true, force: true });
        return;
      }
      const failed = err instanceof StepFailed ? err : new StepFailed(noSpace(String(err)) ? NO_SPACE : String((err as Error)?.message ?? err));
      if (failed.message === NO_SPACE) await rm(game(c.game.id).work, { recursive: true, force: true });
      // (port.sh's own failure waits for "Tentar de novo"; anything else, R2 or the network, is tried again)
      await jobs.fail(c, { state: "failed", message: failed.message, ...(failed.reason ? { reason: failed.reason } : {}) }, err instanceof StepFailed);
    } finally {
      clearInterval(beating);
      await disc?.release().catch((err) => console.error("ps2-builder: disc:", err));
    }
  }

  return {
    prepare,
    /** The page and recompiler this worker builds with (after prepare). */
    image: (): Image => ({ shell, recomp: commit }),
    run: take,
    /** The next job, if any, built: whether there was one. */
    async next(jobs: Jobs) {
      await prepare();
      const c = await jobs.claim({ shell, recomp: commit });
      if (!c) return false;
      announce(`ps2-builder: ${c.game.id} (tentativa ${c.job.attempts})`);
      await take(c, jobs);
      return true;
    },
  };
}

const LOOK_MS = 5000;

/** The discs builds brought to ps2-work/ and never let go (the container stopped mid-build): nobody's now. */
export async function clearDiscs(work: string) {
  for (const id of await readdir(work).catch(() => [] as string[]))
    for (const f of ["disc.iso", "disc.iso.part"]) await rm(join(work, id, f), { force: true });
}

/**
 * The container's own heartbeat (docker-compose.yml's healthcheck: healthy while it's recent), touched whenever the
 * queue answered a claim or a beat: idle for days, with no game asked for, it still beats.
 */
export const HEARTBEAT = process.env.HEARTBEAT_FILE ?? "/tmp/hypeplay-heartbeat";
export const beatHeartbeat = () => writeFile(HEARTBEAT, String(Date.now()));

/** The builds' seconds, out by OTLP only with OTEL_EXPORTER_OTLP_ENDPOINT (server/otlp.ts). */
function buildMetrics(service: string) {
  const telemetry = telemetryFromEnv(service);
  const builds = telemetry.histogram("hypeplay.build.duration", { description: "Duração das compilações, por resultado", unit: "s", bounds: BUILD_SECONDS });
  // (docker stop: the build going on is lost either way, and starts over at the next start; out now, not in 10 s)
  for (const signal of ["SIGTERM", "SIGINT"] as const)
    process.on(signal, () => void telemetry.shutdown().finally(() => process.exit(0)));
  return builds;
}

if (import.meta.main) {
  const data = process.env.DATA ?? "/app/data";
  const builder = createPs2Builder({
    work: join(data, "ps2-work"),
    repo: process.env.RECOMP ?? "/opt/recomp",
    run: spawnRunner,
    commit: process.env.RECOMP_COMMIT ?? "",
    rounds: Number(process.env.PS2_ROUNDS ?? 4),
    frames: Number(process.env.PS2_FRAMES ?? 3600),
    builds: buildMetrics("hypeplay-ps2-builder"),
  });
  const { jobs: from, where } = jobsFromEnv(data);
  // (one builder per volume: a disc there now is a stopped build's)
  await clearDiscs(join(data, "ps2-work"));
  // (the container's heartbeat, docker-compose.yml's healthcheck: touched whenever the queue answers, idle or building)
  const touch = <T>(v: T) => (void beatHeartbeat().catch(() => undefined), v);
  const jobs: Jobs = { ...from, claim: (image) => from.claim(image).then(touch), beat: (c, status) => from.beat(c, status).then(touch) };
  await beatHeartbeat();
  console.log(`ps2-builder: taking jobs from ${where}`);
  for (;;) {
    const built = await builder.next(jobs).catch((err) => (console.error("ps2-builder:", err), false));
    if (!built) await Bun.sleep(LOOK_MS);
  }
}
