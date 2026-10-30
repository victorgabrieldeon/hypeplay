/**
 * The PS2 library's builder (service ps2-builder in docker-compose.yml): watches the data folder the app shares with
 * it and builds each PS2 game sent, once, with ps2-web-recomp's scripts/port.sh, one game at a time, oldest first:
 *
 *   ps2/<id>/disc.iso         sent through the activity (the app checked it's the game reserved)
 *   ps2-work/<id>/            port.sh's files: games/<id>, generated/<id>, build/web-<id>, build/native-<id> of the
 *                             recompiler's folder are links into here, so nothing of a game lives in the image
 *   ps2/<id>/build/           what it publishes: ps2web.{html,js,wasm,data} (+ .gz) and shots/NN.webp, swapped in whole
 *   ps2/<id>/status.json      its state, written only here (with a heartbeat, `at`; the app shows "offline" without)
 *
 * Before the first build, the recompiler's web/shell.html gets patch.ts (saves on the server, rooms, the browser).
 */
import { cp, mkdir, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnRunner, type Runner } from "../builder/builder";
import { PS2_STEPS } from "../server/games";
import { MARK, patchShell } from "./patch";

const ID = /^[a-z]{4}-\d{5}$/;
const PUBLISHED = ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data"];
const SHOTS = 6;

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
  reason?: string;
  note?: string;
  shots?: number;
}

class StepFailed extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

/** The game was removed while it built: nothing to publish, nowhere to report. */
class Gone extends Error {}

const exists = (path: string) => stat(path).then((s) => s, () => null);
const tail = (text: string, lines = 12) => text.trimEnd().split("\n").slice(-lines).join("\n");
const noSpace = (text: string) => /No space left on device|ENOSPC/.test(text);

export interface Ps2BuilderOptions {
  /** /app/data: the app's data folder */
  data: string;
  /** the recompiler's folder (/opt/recomp), with its tools built */
  repo: string;
  run: Runner;
  python?: string;
  /** shots.py, next to this file */
  shots?: string;
  rounds?: number;
  frames?: number;
  now?: () => number;
}

export function createPs2Builder({
  data,
  repo,
  run,
  python = "python3",
  shots = join(import.meta.dir, "shots.py"),
  rounds = 4,
  frames = 3600,
  now = () => Date.now(),
}: Ps2BuilderOptions) {
  const statuses = new Map<string, Status>();
  let current: string | null = null;
  let patched = false;

  const game = (id: string) => {
    const root = join(data, "ps2", id);
    const work = join(data, "ps2-work", id);
    return {
      root,
      json: join(root, "game.json"),
      iso: join(root, "disc.iso"),
      retry: join(root, "retry"),
      status: join(root, "status.json"),
      log: join(root, "build.log"),
      build: join(root, "build"),
      tmp: join(root, "build.tmp"),
      old: join(root, "build.old"),
      work,
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
      if (!s || !(await exists(p.json))) return;
      s.at = now();
      await writeFile(`${p.status}.tmp`, JSON.stringify(s));
      await rename(`${p.status}.tmp`, p.status);
    });
    writing = next.catch(() => undefined);
    return next;
  }

  async function load(id: string): Promise<Status> {
    let s = statuses.get(id);
    if (!s) {
      s = await readFile(game(id).status, "utf8").then((t) => JSON.parse(t) as Status, () => ({ at: now(), state: "idle" as const }));
      statuses.set(id, s);
    }
    return s;
  }

  /** The games with a disc, oldest first. */
  async function games() {
    const ids = (await readdir(join(data, "ps2")).catch(() => [] as string[])).filter((id) => ID.test(id));
    const found: { id: string; at: number; iso: number }[] = [];
    for (const id of ids) {
      const p = game(id);
      const [meta, iso] = await Promise.all([readFile(p.json, "utf8").then((t) => JSON.parse(t) as { at: number }, () => null), exists(p.iso)]);
      if (meta && iso) found.push({ id, at: meta.at, iso: iso.mtimeMs });
    }
    for (const id of statuses.keys()) if (!ids.includes(id)) statuses.delete(id);
    return found.sort((a, b) => a.at - b.at);
  }

  /** Every game with a disc hears from the builder: the app shows "offline" when it doesn't. */
  async function beat() {
    for (const { id } of await games()) {
      await load(id);
      await save(id);
    }
  }

  async function prepare() {
    if (patched) return;
    const shell = join(repo, "web", "shell.html");
    const html = await readFile(shell, "utf8");
    if (!html.includes(MARK)) await writeFile(shell, patchShell(html));
    patched = true;
  }

  async function link(id: string) {
    for (const [from, to] of game(id).links) {
      await mkdir(to, { recursive: true });
      await mkdir(join(from, ".."), { recursive: true });
      await rm(from, { recursive: true, force: true });
      // (a junction on Windows, where the tests run; a plain link elsewhere)
      await symlink(to, from, "junction");
    }
  }

  async function build(id: string, iso: number) {
    const p = game(id);
    let log = `build ${new Date(now()).toISOString()}\n`;
    const say = (text: string) => {
      log += text;
      void writeFile(p.log, log).catch(() => undefined);
    };
    const status: Status = { at: now(), state: "building", iso, startedAt: now(), step: 1, total: PS2_STEPS.length, label: PS2_STEPS[0] };
    statuses.set(id, status);
    await save(id);
    await prepare();
    await link(id);

    const cmd = ["bash", "scripts/port.sh", id, p.iso, "--rounds", String(rounds), "--frames", String(frames)];
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
          Object.assign(status, { step: n, label: PS2_STEPS[n - 1] });
          void save(id);
        }
      },
    });
    if (!(await exists(p.json))) throw new Gone();
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
    const shot = await run([python, shots, join(p.work, "game", "shots"), join(p.tmp, "shots"), String(SHOTS)], { cwd: repo, log: say });
    const count = shot.code === 0 ? Number.parseInt(shot.output.trim().split("\n").pop() ?? "0", 10) || 0 : 0;
    if (!(await exists(p.json))) throw new Gone();
    await rm(p.old, { recursive: true, force: true });
    if (await exists(p.build)) await rename(p.build, p.old);
    await rename(p.tmp, p.build);
    await rm(p.old, { recursive: true, force: true });
    const note = /^\[ee\] halted: (.*)$/m.exec(explore)?.[1];
    statuses.set(id, { at: now(), state: "ready", iso, shots: count, ...(note ? { note } : {}) });
    say("\npronto\n");
  }

  /** One look at the folder: builds the oldest game waiting, if any. */
  async function tick() {
    await beat();
    for (const g of await games()) {
      const p = game(g.id);
      const retry = !!(await exists(p.retry));
      const s = await load(g.id);
      if (!retry && (await exists(join(p.build, "ps2web.html")))) {
        if (s.state !== "ready") statuses.set(g.id, { at: now(), state: "ready", iso: g.iso });
        continue;
      }
      if (!retry && s.state === "failed" && s.iso === g.iso) continue;
      if (retry) await rm(p.retry, { force: true });
      current = g.id;
      try {
        await build(g.id, g.iso);
      } catch (err) {
        if (err instanceof Gone) {
          statuses.delete(g.id);
          await rm(p.work, { recursive: true, force: true });
          await rm(p.root, { recursive: true, force: true });
          return;
        }
        const failed = err instanceof StepFailed ? err : new StepFailed(noSpace(String(err)) ? "Sem espaço no servidor" : String((err as Error)?.message ?? err));
        if (failed.message === "Sem espaço no servidor") await rm(p.work, { recursive: true, force: true });
        await rm(p.tmp, { recursive: true, force: true });
        statuses.set(g.id, { at: now(), state: "failed", iso: g.iso, message: failed.message, refused: false, ...(failed.reason ? { reason: failed.reason } : {}) });
      } finally {
        current = null;
      }
      await save(g.id);
      return;
    }
  }

  return { tick, beat, prepare, get current() { return current; } };
}

const LOOK_MS = 5000;

if (import.meta.main) {
  const builder = createPs2Builder({
    data: process.env.DATA ?? "/app/data",
    repo: process.env.RECOMP ?? "/opt/recomp",
    run: spawnRunner,
    rounds: Number(process.env.PS2_ROUNDS ?? 4),
    frames: Number(process.env.PS2_FRAMES ?? 3600),
  });
  // The heartbeat goes on during a build, which takes many minutes.
  setInterval(() => void builder.beat().catch((err) => console.error("status.json:", err)), LOOK_MS);
  console.log("ps2-builder: watching /app/data/ps2");
  for (;;) {
    await builder.tick().catch((err) => console.error("ps2-builder:", err));
    await Bun.sleep(LOOK_MS);
  }
}
