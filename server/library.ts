/**
 * The PS2 library: games anyone sent, kept for everyone, each playing in TabStationToo as soon as its disc is in. One
 * folder per game, named by its disc's serial (another copy of the same game, when someone asks for one: the serial,
 * -2, -3…), in the data folder:
 *
 *   ps2/<id>/game.json          { id, serial, name, by, at, cover }   written here
 *   ps2/<id>/cover.webp         its cover, when someone sent one
 *   ps2/<id>/upload/, disc.iso  as BT3's (upload.ts); a game sent with R2 on: disc.iso.r2 instead, its disc in R2 (discs.ts)
 *   ps2/<id>/fast/              its "versão rápida", when someone asked for one: request and misses.txt written here,
 *                               build.log and build/ by ps2-builder/ (or its build in R2, made elsewhere); its place in
 *                               line and how it went in the builds' queue (queue.ts, fastjobs.ts)
 *   ps2-work/<id>/              port.sh's intermediate files (ps2-builder's)
 *   saves/<id>/                 memory cards (saves.ts): outside the game's folder, so removing a game keeps them
 *
 * An id only ever comes from here (ID): routes look games up, they never build paths from addresses.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { S3Client } from "bun";
import { dropFromR2, markOf, moveToR2 } from "./discs";
import { dropR2Build, fastKey } from "./fastjobs";
import { BT3_SERIAL, fileRead, readDiscId } from "./iso9660";
import type { Pass } from "./pass";
import { createQueue, PRIORITY, type Queue } from "./queue";
import { createDiscStore, type DiscStore } from "./upload";

export interface Ps2Game {
  id: string;
  serial: string;
  name: string;
  by: { id: string; name: string };
  at: number;
  cover: boolean;
  /** When the cover was last sent (always later than the one before): part of its address. */
  coverAt?: number;
}

/** Some PS2 games came on CD: smaller than BT3's floor. */
export const PS2_MIN = 100 * 1024 ** 2;
export const PS2_MAX = 9 * 1024 ** 3;
/** A game reserved and never sent goes after this long. */
export const ABANDONED_MS = 24 * 60 * 60_000;
export const ID = /^[a-z]{4}-\d{5}(?:-\d{1,2})?$/;
/** Copies of one serial at most (its id's suffix). */
const COPIES = 99;
const SERIAL = /^[A-Z]{4}-\d{5}$/;

export type Reserve = { ok: true; game: Ps2Game } | { ok: false; exists: string };

/** ps2-builder's report of a build (its FastStatus, kept in the queue), as far as the app reads it. */
interface FastFile {
  state: "idle" | "building" | "ready" | "failed";
  step?: number;
  total?: number;
  label?: string;
  startedAt?: number;
  learning?: boolean;
  updating?: boolean;
  message?: string;
  reason?: string;
}

/** A game's "versão rápida", for the library (`playable`: a build is there to play, the one before this). */
export type Fast =
  | { state: "off" }
  | { state: "queued" }
  | { state: "building"; step: number; total: number; label: string; elapsed: number; learning: boolean; updating: boolean; playable: boolean }
  | { state: "ready" }
  | { state: "failed"; message: string; reason?: string; playable: boolean }
  | { state: "offline" };

/** A pc a game's page met untranslated (its halt message's form), and how many are kept per game. */
const MISS = /^[0-9A-F]{8}$/;
const MISSES_MAX = 256;

const exists = (path: string) => stat(path).then(() => true, () => false);

/**
 * `port`: BT3's port is in the catalog (routes.ts' games); without it BT3's disc is a PS2 game like any other. `queue`:
 * the builds' (queue.ts), <dir>/queue.db in index.ts; one of its own in memory by default.
 */
export function createLibrary(
  dir: string,
  { now = () => Date.now(), min = PS2_MIN, max = PS2_MAX, r2 = null as S3Client | null, port = true, queue = null as Queue | null } = {},
) {
  const jobs = queue ?? createQueue(":memory:", { now });
  const stores = new Map<string, DiscStore>();
  /** Reservations between making their folder and writing their game.json: not orphans. */
  const reserving = new Set<string>();

  function paths(id: string) {
    if (!ID.test(id)) throw new Error(`not a game id: ${id}`);
    const root = join(dir, "ps2", id);
    return {
      root,
      game: join(root, "game.json"),
      build: join(root, "build"),
      iso: join(root, "disc.iso"),
      cover: join(root, "cover.webp"),
      fast: join(root, "fast"),
      work: join(dir, "ps2-work", id),
    };
  }

  const nameOr = (name: string, serial: string) => {
    const n = name.trim();
    return n && n.length <= 80 ? n : serial;
  };

  async function get(id: string): Promise<Ps2Game | null> {
    if (!ID.test(id)) return null;
    try {
      return JSON.parse(await readFile(paths(id).game, "utf8")) as Ps2Game;
    } catch {
      return null;
    }
  }

  async function save(game: Ps2Game) {
    const p = paths(game.id);
    await writeFile(`${p.game}.tmp`, JSON.stringify(game));
    await rename(`${p.game}.tmp`, p.game);
  }

  async function update(id: string, change: (g: Ps2Game) => Ps2Game): Promise<boolean> {
    const g = await get(id);
    if (!g) return false;
    await save(change(g));
    return true;
  }

  function disc(id: string): DiscStore {
    let s = stores.get(id);
    if (!s) stores.set(id, (s = createDiscStore(paths(id).root, { now, min, max, page: "ps2web.html", alive: () => exists(paths(id).game) })));
    return s;
  }

  /** Its disc here or in R2. */
  const hasDisc = async (id: string) => (await exists(paths(id).iso)) || (await exists(markOf(paths(id).iso)));

  /**
   * A disc just in and checked goes to R2, in the background (minutes for a DVD); until it's there it plays from here.
   * shortcut: a move cut short (a deploy, an error) leaves the game here for good; a sweep at startup would retry them.
   */
  function settle(id: string) {
    if (!r2) return;
    void moveToR2(r2, dir, paths(id).iso, () => exists(paths(id).game))
      .then((moved) => console.log(`R2: ${id} ${moved ? "moved" : "removed meanwhile"}`))
      .catch((err) => console.error(`R2: ${id} stays here:`, err));
  }

  async function remove(id: string) {
    if (!ID.test(id)) return;
    const p = paths(id);
    stores.delete(id);
    await dropFromR2(r2, dir, p.iso).catch((err) => console.error(`R2: ${id}'s disc stays there:`, err));
    await dropR2Build(r2, jobs.drop(fastKey(id))?.build);
    await rm(p.root, { recursive: true, force: true });
    await rm(p.work, { recursive: true, force: true });
  }

  /** Reserved, nothing sent, nothing arriving: abandoned. */
  async function abandoned(g: Ps2Game) {
    if (now() - g.at <= ABANDONED_MS) return false;
    const p = paths(g.id);
    return !(await hasDisc(g.id)) && !(await exists(join(p.root, "upload")));
  }

  return {
    paths,
    get,
    disc,
    remove,
    hasDisc,

    settle,

    async list(): Promise<Ps2Game[]> {
      const ids = await readdir(join(dir, "ps2")).catch(() => [] as string[]);
      const games: Ps2Game[] = [];
      for (const id of ids.filter((i) => ID.test(i))) {
        const g = await get(id);
        if (!g) {
          // a folder left without its game.json (a reservation that died halfway): it would block its serial
          if (!reserving.has(id) && !(await exists(paths(id).game))) await remove(id);
          continue;
        }
        if (await abandoned(g)) await remove(id);
        else games.push(g);
      }
      return games.sort((a, b) => b.at - a.at);
    },

    /**
     * A new game for this serial. Without `copy`, the game already there wins (BT3's port, or the library's); with it,
     * another copy (BT3's disc beside its port, a mod that keeps its game's serial): the first free id of serial, -2, -3…
     */
    async reserve(pass: Pass, serial: string, name: string, { copy = false } = {}): Promise<Reserve> {
      if (!SERIAL.test(serial)) throw new Error(`not a serial: ${serial}`);
      if (port && serial === BT3_SERIAL && !copy) return { ok: false, exists: "bt3" };
      const base = serial.toLowerCase();
      await mkdir(join(dir, "ps2"), { recursive: true });
      for (let n = 1; n <= COPIES; n++) {
        const id = n === 1 ? base : `${base}-${n}`;
        const taken = { ok: false as const, exists: `ps2/${id}` };
        // One reservation of an id at a time, in this process; the folder settles it between processes.
        if (reserving.has(id)) {
          if (copy) continue;
          return taken;
        }
        reserving.add(id);
        try {
          let made = false;
          for (let tries = 0; !made; tries++) {
            try {
              // Not recursive: of two reserving the same id at once, only one makes the folder.
              await mkdir(paths(id).root);
              made = true;
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
              // an orphan folder (no game.json) is cleared once; a real game is a real game
              if (tries > 0 || (await exists(paths(id).game))) break;
              await remove(id);
            }
          }
          if (!made) {
            if (copy) continue;
            return taken;
          }
          const game: Ps2Game = { id, serial, name: nameOr(name, serial), by: { id: pass.id, name: pass.name }, at: now(), cover: false };
          await save(game);
          return { ok: true, game };
        } finally {
          reserving.delete(id);
        }
      }
      return { ok: false, exists: `ps2/${base}` };
    },

    /** The whole disc arrived: is it the game reserved? If not, the game goes, and its image with it. */
    async verify(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
      const g = await get(id);
      const found = g && (await readDiscId(fileRead(paths(id).iso)));
      if (g && found?.serial === g.serial) {
        settle(id);
        return { ok: true };
      }
      await remove(id);
      return { ok: false, message: found ? "A ISO não é do jogo escolhido" : "Isso não parece um disco de PS2" };
    },

    rename: (id: string, name: string) => update(id, (g) => ({ ...g, name: nameOr(name, g.serial) })),
    setCover: (id: string, has: boolean) => update(id, (g) => ({ ...g, cover: has, coverAt: Math.max(now(), (g.coverAt ?? 0) + 1) })),

    /** The game's "versão rápida": its job in the queue and its build (here, or in R2). */
    async fast(id: string): Promise<Fast> {
      const f = paths(id).fast;
      if (!(await exists(join(f, "request")))) return { state: "off" };
      const job = jobs.get(fastKey(id));
      const s = (job?.status ?? null) as FastFile | null;
      const built = !!job?.build || (await exists(join(f, "build", "ps2web.html")));
      if (job?.state === "failed") return { state: "failed", message: s?.message ?? "", ...(s?.reason ? { reason: s.reason } : {}), playable: built };
      // (a worker that stopped renewing its lease isn't building any more: the job goes back in line)
      if (job?.state === "running" && (job.leaseUntil ?? 0) >= now() && s?.state === "building")
        return {
          state: "building",
          step: s.step ?? 1,
          total: s.total ?? 1,
          label: s.label ?? "",
          elapsed: Math.max(0, now() - (s.startedAt ?? now())),
          learning: !!s.learning,
          updating: !!s.updating,
          playable: built,
        };
      // (a build plays whether or not a worker is up)
      if (built) return { state: "ready" };
      return jobs.online("ps2") ? { state: "queued" } : { state: "offline" };
    },

    /** A file of the "versão rápida"'s build: here, or in R2 when a worker elsewhere made it (`from` says which). */
    async fastFile(id: string, name: string): Promise<{ file: Blob; from: "local" | "r2" } | null> {
      const local = Bun.file(join(paths(id).fast, "build", name));
      if (await local.exists()) return { file: local, from: "local" };
      const b = jobs.get(fastKey(id))?.build;
      return r2 && b?.files.includes(name) ? { file: r2.file(`${b.prefix}/${name}`), from: "r2" } : null;
    },

    /** "Compilar versão rápida", or "Tentar de novo" after it failed: in line for a worker (queue.ts). */
    async askFast(id: string) {
      if (!(await get(id)) || !(await hasDisc(id))) return false;
      const f = paths(id).fast;
      await mkdir(f, { recursive: true });
      const failed = jobs.get(fastKey(id))?.state === "failed";
      await writeFile(join(f, "request"), "");
      jobs.enqueue(fastKey(id), "ps2", { priority: PRIORITY.ask, retry: failed });
      return true;
    },

    /**
     * The volume's requests from before the queue, in it (once each: the queue keeps what it knows). A ready build stays
     * done, a failure stays failed (unless "Tentar de novo" was left for it), the rest waits in line.
     */
    async importFast() {
      let adopted = 0;
      for (const id of (await readdir(join(dir, "ps2")).catch(() => [] as string[])).filter((i) => ID.test(i))) {
        const f = paths(id).fast;
        if (!(await exists(join(f, "request"))) || jobs.get(fastKey(id))) continue;
        const raw = await readFile(join(f, "status.json"), "utf8").then((t) => JSON.parse(t) as FastFile & { at?: number; shell?: string; recomp?: string }, () => null);
        const { at: _, ...status } = raw ?? { state: "idle" as const };
        const retry = await exists(join(f, "retry"));
        const built = await exists(join(f, "build", "ps2web.html"));
        // (code the players met may still be unlearned: in line, the worker sees whether it is)
        const state = retry ? "queued" : status.state === "failed" ? "failed" : built && status.state === "ready" && !(await exists(join(f, "misses.txt"))) ? "done" : "queued";
        if (jobs.adopt(fastKey(id), "ps2", state, { retry, status: raw ? status : null, shell: status.shell ?? null, recomp: status.recomp ?? null })) adopted++;
        await rm(join(f, "retry"), { force: true });
      }
      return adopted;
    },

    /** The "versão rápida" goes, with its files (and its build in R2); the game stays, in the emulator. */
    async removeFast(id: string) {
      if (!ID.test(id)) return;
      await dropR2Build(r2, jobs.drop(fastKey(id))?.build);
      // (the builder may be writing its log in there right now: a file made mid-removal is retried, not an error)
      const again = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
      await rm(paths(id).fast, again);
      await rm(paths(id).work, again);
    },

    /** The builds' queue it puts the "versão rápida" in. */
    queue: jobs,

    /** Code a player's page met untranslated (`pc` as its halt message gives it): ps2-builder builds it in. */
    async fastMiss(id: string, pc: string) {
      const f = paths(id).fast;
      const t = pc.trim().toUpperCase();
      if (!MISS.test(t) || !(await exists(join(f, "request")))) return false;
      const file = join(f, "misses.txt");
      const kept = (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean);
      if (kept.includes(t) || kept.length >= MISSES_MAX) return true;
      await writeFile(file, `${[...kept, t].join("\n")}\n`);
      // (first in line; a failed build keeps it for "Tentar de novo")
      jobs.enqueue(fastKey(id), "ps2", { priority: PRIORITY.miss, revive: false });
      return true;
    },
  };
}

export type Library = ReturnType<typeof createLibrary>;
