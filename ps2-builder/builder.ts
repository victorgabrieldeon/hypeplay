/**
 * The PS2 games' "versão rápida" (service ps2-builder in docker-compose.yml). A PS2 game plays in TabStationToo (PCSX2
 * in WebAssembly) as soon as its disc is in; when someone asks, this compiles it with ps2-web-recomp's scripts/port.sh
 * into a page that is much faster in heavy games, for the games the recompiler supports. Only the games asked for, one
 * at a time, oldest request first:
 *
 *   ps2/<id>/disc.iso            the game's disc (the app checked it)
 *   ps2/<id>/fast/request        "Compilar versão rápida" (routes.ts): without it nothing is built; gone = removed
 *   ps2/<id>/fast/retry          "Tentar de novo" after a failure
 *   ps2/<id>/fast/misses.txt     code the players' pages met untranslated (routes.ts): added, then built again
 *   ps2/<id>/fast/status.json    its state, written only here (heartbeat `at`: the app says "offline" without it), and
 *                                which page (patched shell) and recompiler a ready build was made with: when either
 *                                changes (a new image), the build is brought up to date, the page alone if that's all
 *   ps2/<id>/fast/build.log      port.sh's output
 *   ps2/<id>/fast/build/         ps2web.{html,js,wasm,data} (+ .gz), swapped in whole
 *   ps2-work/<id>/               port.sh's files: games/<id>, generated/<id>, build/web-<id>, build/native-<id> of the
 *                                recompiler's folder are links into here, so nothing of a game lives in the image
 *
 * Before the first build, the recompiler's web/shell.html gets patch.ts (saves on the server, missing code, browser).
 */
import { createHash } from "node:crypto";
import { appendFile, cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnRunner, type Runner } from "../builder/builder";
import { FAST_STEPS } from "../server/games";
import { MARK, patchShell } from "./patch";

/** A library game's id (server/library.ts' ID). */
const ID = /^[a-z]{4}-\d{5}(?:-\d{1,2})?$/;
export const PUBLISHED = ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data"];
/** A missing pc a page may report: word-aligned, in the EE's main memory above the kernel. */
const MISS = /^[0-9A-F]{8}$/;
const MISS_MIN = 0x0010_0000;
const MISS_MAX = 0x0200_0000;
/** Learned in one go at most (a page reports one per halt; more means something odd). */
const LEARN_MAX = 64;

/** fast/status.json (read by server/routes.ts). */
export interface FastStatus {
  at: number;
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

class StepFailed extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The game was removed, or its fast version, while it built: nothing to publish, nowhere to report. */
class Gone extends Error {}

const exists = (path: string) => stat(path).then((s) => s, () => null);
const tail = (text: string, lines = 12) => text.trimEnd().split("\n").slice(-lines).join("\n");
const noSpace = (text: string) => /No space left on device|ENOSPC/.test(text);

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
  /** /app/data: the app's data folder */
  data: string;
  /** the recompiler's folder (/opt/recomp), with its tools built */
  repo: string;
  run: Runner;
  /** the recompiler's commit (the image's RECOMP_COMMIT) */
  commit?: string;
  rounds?: number;
  frames?: number;
  now?: () => number;
}

/** How much a build takes: all of it, code the players met, a new recompiler (or a retry), or the page alone. */
type Mode = "full" | "learn" | "recomp" | "page";

export function createPs2Builder({ data, repo, run, commit = "", rounds = 4, frames = 3600, now = () => Date.now() }: Ps2BuilderOptions) {
  const statuses = new Map<string, FastStatus>();
  /** The patched shell's hash, once patched. */
  let shell = "";

  const game = (id: string) => {
    const root = join(data, "ps2", id);
    const fast = join(root, "fast");
    const work = join(data, "ps2-work", id);
    return {
      json: join(root, "game.json"),
      iso: join(root, "disc.iso"),
      fast,
      request: join(fast, "request"),
      retry: join(fast, "retry"),
      misses: join(fast, "misses.txt"),
      status: join(fast, "status.json"),
      log: join(fast, "build.log"),
      build: join(fast, "build"),
      tmp: join(fast, "build.tmp"),
      old: join(fast, "build.old"),
      work,
      entries: join(work, "game", "entries.txt"),
      /** the recompiler's folders for this game, linked into ps2-work/<id>/ */
      links: [
        [join(repo, "games", id), join(work, "game")],
        [join(repo, "generated", id), join(work, "generated")],
        [join(repo, "build", `web-${id}`), join(work, "web")],
        [join(repo, "build", `native-${id}`), join(work, "native")],
      ] as const,
    };
  };

  // One write at a time: the heartbeat and a build share the temporary files.
  let writing: Promise<unknown> = Promise.resolve();
  function save(id: string) {
    const next = writing.then(async () => {
      const s = statuses.get(id);
      const p = game(id);
      // (removed meanwhile: no status.json brought back into a folder that's gone)
      if (!s || !(await exists(p.request))) return;
      s.at = now();
      await writeFile(`${p.status}.tmp`, JSON.stringify(s));
      // (on Windows a reader holding status.json blocks the swap for a moment)
      for (let tries = 0; ; tries++) {
        try {
          await rename(`${p.status}.tmp`, p.status);
          break;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (tries >= 20 || (code !== "EPERM" && code !== "EBUSY")) throw err;
          await Bun.sleep(5);
        }
      }
    });
    writing = next.catch(() => undefined);
    return next;
  }

  async function load(id: string): Promise<FastStatus> {
    let s = statuses.get(id);
    if (!s) {
      s = await readFile(game(id).status, "utf8").then((t) => JSON.parse(t) as FastStatus, () => ({ at: now(), state: "idle" as const }));
      statuses.set(id, s);
    }
    return s;
  }

  /** The games someone asked a fast version of, with their disc, oldest request first. */
  async function wanted() {
    const ids = (await readdir(join(data, "ps2")).catch(() => [] as string[])).filter((id) => ID.test(id));
    const found: { id: string; at: number }[] = [];
    for (const id of ids) {
      const p = game(id);
      const [meta, iso, request] = await Promise.all([exists(p.json), exists(p.iso), exists(p.request)]);
      if (meta && iso && request) found.push({ id, at: request.mtimeMs });
    }
    for (const id of statuses.keys()) if (!found.some((g) => g.id === id)) statuses.delete(id);
    return found.sort((a, b) => a.at - b.at);
  }

  /** Every game asked for hears from the builder: the app shows "offline" when it doesn't. */
  async function beat() {
    for (const { id } of await wanted()) {
      await load(id);
      await save(id);
    }
  }

  /** Code the players met that the build doesn't have yet. */
  async function newMisses(id: string) {
    const p = game(id);
    const misses = parseMisses(await readFile(p.misses, "utf8").catch(() => ""));
    if (!misses.length) return [];
    const known = new Set((await readFile(p.entries, "utf8").catch(() => "")).split(/\s+/));
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

  async function build(id: string, mode: Mode, learn: string[]) {
    const p = game(id);
    let log = `build ${new Date(now()).toISOString()} (${mode}${learn.length ? `: ${learn.join(" ")}` : ""})\n`;
    const say = (text: string) => {
      log += text;
      void writeFile(p.log, log).catch(() => undefined);
    };
    const first = mode === "page" ? FAST_STEPS.length : 1;
    const status: FastStatus = {
      at: now(),
      state: "building",
      startedAt: now(),
      step: first,
      total: FAST_STEPS.length,
      label: FAST_STEPS[first - 1],
      ...(mode === "learn" ? { learning: true } : mode === "recomp" || mode === "page" ? { updating: true } : {}),
    };
    statuses.set(id, status);
    await save(id);
    await prepare();
    await link(id);
    if (learn.length) await appendFile(p.entries, learn.map((m) => `${m}\n`).join(""));

    // (learning or a new recompiler: everything translated again with the entry points known, no test runs; a new page:
    // the page alone, from the code already built)
    const cmd =
      mode === "page"
        ? ["bash", "scripts/build_web.sh", id]
        : mode === "full"
          ? ["bash", "scripts/port.sh", id, p.iso, "--rounds", String(rounds), "--frames", String(frames)]
          : ["bash", "scripts/port.sh", id, p.iso, "--no-explore"];
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
          void save(id);
        }
      },
    });
    if (!(await exists(p.json)) || !(await exists(p.request))) throw new Gone();
    const explore = await readFile(join(p.work, "game", "explore.log"), "utf8").catch(() => "");
    if (r.code !== 0) {
      if (noSpace(r.output)) throw new StepFailed("Sem espaço no servidor");
      const reason = /^\[(?:sys\] unhandled syscall|iop\] missing ).*$/m.exec(explore)?.[0];
      throw new StepFailed(tail(r.output) || `port.sh: código ${r.code}`, reason);
    }

    const web = join(p.work, "web");
    await rm(p.tmp, { recursive: true, force: true });
    await mkdir(p.tmp, { recursive: true });
    for (const f of PUBLISHED) {
      if (!(await exists(join(web, f)))) throw new StepFailed(`O build não gerou ${f}`);
      await cp(join(web, f), join(p.tmp, f));
      if (await exists(join(web, `${f}.gz`))) await cp(join(web, `${f}.gz`), join(p.tmp, `${f}.gz`));
    }
    if (!(await exists(p.request))) throw new Gone();
    await rm(p.old, { recursive: true, force: true });
    if (await exists(p.build)) await rename(p.build, p.old);
    await rename(p.tmp, p.build);
    await rm(p.old, { recursive: true, force: true });
    statuses.set(id, { at: now(), state: "ready", shell, recomp: commit });
    say("\npronto\n");
  }

  /** One look at the folder: builds the oldest game waiting, if any. */
  async function tick() {
    await beat();
    await prepare();
    for (const g of await wanted()) {
      const p = game(g.id);
      const retry = !!(await exists(p.retry));
      const s = await load(g.id);
      // (a failure waits for "Tentar de novo", or learning the same code would fail again and again)
      if (!retry && s.state === "failed") continue;
      const built = !!(await exists(join(p.build, "ps2web.html")));
      const learn = built ? await newMisses(g.id) : [];
      // (a retry over a build redoes the code too: what failed may have been learning)
      const translated = !!(await exists(p.entries));
      let mode: Mode;
      if (!built) mode = "full";
      else if (learn.length) mode = "learn";
      else if (retry || s.recomp !== commit) mode = translated ? "recomp" : "full";
      else if (s.shell !== shell) mode = (await exists(join(p.work, "web", "build.ninja"))) ? "page" : translated ? "recomp" : "full";
      else continue;
      if (retry) await rm(p.retry, { force: true });
      try {
        await build(g.id, mode, learn);
      } catch (err) {
        if (err instanceof Gone) {
          statuses.delete(g.id);
          await rm(p.work, { recursive: true, force: true });
          await rm(p.tmp, { recursive: true, force: true });
          return;
        }
        const failed = err instanceof StepFailed ? err : new StepFailed(noSpace(String(err)) ? "Sem espaço no servidor" : String((err as Error)?.message ?? err));
        if (failed.message === "Sem espaço no servidor") await rm(p.work, { recursive: true, force: true });
        await rm(p.tmp, { recursive: true, force: true });
        statuses.set(g.id, { at: now(), state: "failed", message: failed.message, ...(failed.reason ? { reason: failed.reason } : {}) });
      }
      await save(g.id);
      return;
    }
  }

  return { tick, beat, prepare };
}

const LOOK_MS = 5000;

if (import.meta.main) {
  const builder = createPs2Builder({
    data: process.env.DATA ?? "/app/data",
    repo: process.env.RECOMP ?? "/opt/recomp",
    run: spawnRunner,
    commit: process.env.RECOMP_COMMIT ?? "",
    rounds: Number(process.env.PS2_ROUNDS ?? 4),
    frames: Number(process.env.PS2_FRAMES ?? 3600),
  });
  // The heartbeat goes on during a build, which takes many minutes.
  setInterval(() => void builder.beat().catch((err) => console.error("status.json:", err)), LOOK_MS);
  console.log("ps2-builder: watching /app/data/ps2/*/fast/request");
  for (;;) {
    await builder.tick().catch((err) => console.error("ps2-builder:", err));
    await Bun.sleep(LOOK_MS);
  }
}
