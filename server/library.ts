/**
 * The PS2 library: games anyone sent, kept for everyone, each playing in TabStationToo as soon as its disc is in. One
 * folder per game, named by its disc's serial (another copy of the same game, when someone asks for one: the serial,
 * -2, -3…), in the data folder:
 *
 *   ps2/<id>/game.json          { id, serial, name, by, at, cover }   written here
 *   ps2/<id>/cover.webp         its cover, when someone sent one
 *   ps2/<id>/upload/, disc.iso  the upload (upload.ts); a game sent with R2 on: disc.iso.r2 instead, its disc in R2 (discs.ts)
 *   ps2/<id>/fast/              its "versão rápida", when someone asked for one: request and misses.txt written here,
 *                               build.log and build/ by ps2-builder/ (or its build in R2, made elsewhere); its place in
 *                               line and how it went in the builds' queue (queue.ts, fastjobs.ts)
 *   ps2-work/<id>/              port.sh's intermediate files, and a disc from R2 while it builds (ps2-builder's)
 *   saves/<id>/                 memory cards (saves.ts): outside the game's folder, so removing a game keeps them
 *
 * An id only ever comes from here (ID): routes look games up, they never build paths from addresses.
 *
 * game.json stays the source (the builders read the folder), but the list is read from an index in memory, made from
 * the folders once and kept up to date by everything here that writes or removes a game. Clearing what was left
 * behind (abandoned reservations and uploads, folders without game.json, discs that didn't reach R2) is `sweep`, on a
 * timer (index.ts), not on the way to the list; it also puts the index back in line with the folders, if anything
 * changed them from outside. The sweep only ever clears this disk: R2 loses a disc when someone removes its game.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { S3Client } from "bun";
import { dropFromR2, markOf, moveToR2 } from "./discs";
import { dropR2Build, fastKey } from "./fastjobs";
import { fileRead, readDiscId } from "./iso9660";
import type { Pass } from "./pass";
import { createQueue, PRIORITY, type Queue } from "./queue";
import { createDiscStore, type DiscStore } from "./upload";
import { log } from "./log";

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

/** Some PS2 games came on CD: a floor well under a DVD. */
export const PS2_MIN = 100 * 1024 ** 2;
export const PS2_MAX = 9 * 1024 ** 3;
/** A game reserved and never sent goes after this long, and one whose upload stopped this long ago. */
export const ABANDONED_MS = 24 * 60 * 60_000;
/** A disc here this long and not in R2: its move was cut short (a deploy, an error), the sweep sends it again. */
export const RESETTLE_MS = 10 * 60_000;
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
/** For what clears files: only "not there" is no (a disk error isn't, it throws). */
const found = (path: string) =>
  stat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return false;
      throw err;
    },
  );

/**
 * `queue`: the builds' (queue.ts), <dir>/queue.db in index.ts; one of its own in memory by default. `room`: whether a
 * disc this big fits on the disk (discs.ts' hasRoom, in index.ts); without it, anything does.
 */
export function createLibrary(
  dir: string,
  {
    now = () => Date.now(),
    min = PS2_MIN,
    max = PS2_MAX,
    r2 = null as S3Client | null,
    queue = null as Queue | null,
    room = null as ((bytes: number) => Promise<boolean>) | null,
  } = {},
) {
  const jobs = queue ?? createQueue(":memory:", { now });
  const stores = new Map<string, DiscStore>();
  /** Reservations between making their folder and writing their game.json: not orphans. */
  const reserving = new Set<string>();
  /** Every game, by id: what's in the game.json files. */
  const index = new Map<string, Ps2Game>();
  let loaded: Promise<void> | null = null;
  /** While a sweep runs: the games written or removed meanwhile (what the sweep saw of them is old). */
  let touched: Set<string> | null = null;

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

  async function read(id: string): Promise<Ps2Game | null> {
    try {
      return JSON.parse(await readFile(paths(id).game, "utf8")) as Ps2Game;
    } catch {
      return null;
    }
  }

  /** The folders' ids (the ones that can be games). */
  const folders = async () => (await readdir(join(dir, "ps2")).catch(() => [] as string[])).filter((i) => ID.test(i));

  /** The index, made from the folders the first time it's needed (everything waits for it: none of it is lost). */
  function ready() {
    return (loaded ??= (async () => {
      for (const id of await folders()) {
        const g = await read(id);
        if (g) index.set(id, g);
      }
    })());
  }

  async function get(id: string): Promise<Ps2Game | null> {
    if (!ID.test(id)) return null;
    await ready();
    return index.get(id) ?? null;
  }

  async function save(game: Ps2Game) {
    const p = paths(game.id);
    await ready();
    await writeFile(`${p.game}.tmp`, JSON.stringify(game));
    await rename(`${p.game}.tmp`, p.game);
    index.set(game.id, game);
    touched?.add(game.id);
  }

  async function update(id: string, change: (g: Ps2Game) => Ps2Game): Promise<boolean> {
    const g = await get(id);
    if (!g) return false;
    await save(change(g));
    return true;
  }

  function disc(id: string): DiscStore {
    let s = stores.get(id);
    if (!s) stores.set(id, (s = createDiscStore(paths(id).root, { now, min, max, alive: () => exists(paths(id).game), ...(room ? { room } : {}) })));
    return s;
  }

  /** Its disc here or in R2 (`is`: found, for what clears files). */
  const hasDisc = async (id: string, is = exists) => (await is(paths(id).iso)) || (await is(markOf(paths(id).iso)));

  /** The games whose disc is on its way to R2 (one move each, whoever asks: verify, vimm, the sweep). */
  const moving = new Set<string>();

  /** A disc just in and checked goes to R2, in the background (minutes for a DVD); until it's there it plays from here. */
  function settle(id: string): Promise<void> {
    if (!r2 || moving.has(id)) return Promise.resolve();
    moving.add(id);
    return moveToR2(r2, dir, paths(id).iso, () => exists(paths(id).game))
      .then((moved) => log.info(moved ? "R2: disc moved" : "R2: game removed meanwhile", { game: id }))
      .catch((err) => log.error("R2: disc stays here", { game: id, err }))
      .finally(() => moving.delete(id));
  }

  /**
   * A game's folder and its build's files off this disk. `everywhere` (someone removed it): its disc and build in R2
   * too. Without it (the sweep, a reservation over an orphan folder) nothing in R2 is touched.
   */
  async function discard(id: string, everywhere: boolean) {
    if (!ID.test(id)) return;
    const p = paths(id);
    await ready();
    stores.delete(id);
    index.delete(id);
    touched?.add(id);
    const job = jobs.drop(fastKey(id));
    if (everywhere) {
      await dropFromR2(r2, dir, p.iso).catch((err) => log.error("R2: disc stays there", { game: id, err }));
      await dropR2Build(r2, job?.build);
    } else if (job?.build) log.warn("R2: a build left there", { game: id, prefix: job.build.prefix });
    await rm(p.root, { recursive: true, force: true });
    await rm(p.work, { recursive: true, force: true });
  }

  const remove = (id: string) => discard(id, true);

  /** Reserved and nothing sent, or an upload stopped (its last piece, not the reservation, a day old): abandoned. */
  async function abandoned(g: Ps2Game) {
    const p = paths(g.id);
    if (await hasDisc(g.id, found)) return false;
    if (!(await found(join(p.root, "upload")))) return now() - g.at > ABANDONED_MS;
    const up = await readFile(join(p.root, "upload", "state.json"), "utf8").then((t) => JSON.parse(t) as { at?: number }, () => null);
    // (no state yet: a first piece may be on its way, and the folder's time says when it began)
    const last = typeof up?.at === "number" ? up.at : (await stat(join(p.root, "upload"))).mtimeMs;
    return now() - last > ABANDONED_MS;
  }

  /** A worker building it now (its disc may be read from here). */
  const building = (id: string) => {
    const j = jobs.get(fastKey(id));
    return j?.state === "running" && (j.leaseUntil ?? 0) >= now();
  };

  /**
   * A game's disc as it should be: what a build left in its folder goes (ps2-builder's old ones fetched discs there),
   * a copy here of a disc in R2 goes, and with R2 on, a disc that never got there is sent again (one at a time).
   */
  async function tidy(id: string) {
    if (moving.has(id) || building(id)) return;
    const p = paths(id);
    await rm(`${p.iso}.part`, { force: true });
    // (without R2 a disc here is the one there is, mark or not)
    if (!r2 || !(await found(p.iso))) return;
    if (await found(markOf(p.iso))) {
      await rm(p.iso, { force: true });
      log.info("disc: the copy here of one in R2 removed", { game: id });
      return;
    }
    if (moving.size || (await found(join(p.root, "upload")))) return;
    // (one just in is still being checked: verify sends it, vimm its own)
    if (Date.now() - (await stat(p.iso)).mtimeMs < RESETTLE_MS) return;
    log.info("R2: disc sent again", { game: id });
    void settle(id);
  }

  return {
    paths,
    get,
    disc,
    remove,
    hasDisc: (id: string) => hasDisc(id),

    settle,
    /** Whether a disc this big fits on the disk (vimm asks too). */
    room: async (bytes: number) => !room || (await room(bytes)),

    async list(): Promise<Ps2Game[]> {
      await ready();
      return [...index.values()].sort((a, b) => b.at - a.at);
    },

    /**
     * What was left behind goes, from this disk only: folders without their game.json (a reservation that died
     * halfway: it would block its serial) unless they hold a disc, reservations never sent and uploads stopped, and
     * what a disc's move or a build left (tidy). And the index is put back in line with the folders.
     */
    async sweep() {
      await ready();
      if (touched) return;
      const mine = (touched = new Set());
      try {
        const seen = new Set(await folders());
        for (const id of seen) {
          if (reserving.has(id)) continue;
          try {
            const g = await read(id);
            if (!g) {
              if (reserving.has(id) || mine.has(id) || (await found(paths(id).game))) continue;
              // (a disc is never a reservation's leftover: a folder copied in halfway, a restore. It waits for a person)
              if (await hasDisc(id, found)) log.warn("library: a disc without its game.json, kept", { game: id });
              else await discard(id, false);
              continue;
            }
            if (await abandoned(g)) {
              if (!mine.has(id)) await discard(id, false);
              continue;
            }
            if (!index.has(id) && !mine.has(id)) index.set(id, g);
            await tidy(id);
          } catch (err) {
            log.warn("library sweep: skipped", { game: id, err });
          }
        }
        for (const id of [...index.keys()]) if (!seen.has(id) && !reserving.has(id) && !mine.has(id)) index.delete(id);
      } finally {
        touched = null;
      }
    },

    /**
     * A new game for this serial. Without `copy`, the game already there wins; with it, another copy (a mod that keeps
     * its game's serial): the first free id of serial, -2, -3…
     */
    async reserve(pass: Pass, serial: string, name: string, { copy = false } = {}): Promise<Reserve> {
      if (!SERIAL.test(serial)) throw new Error(`not a serial: ${serial}`);
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
              // an orphan folder (no game.json) is cleared once, here only; a real game, or a disc, stays
              if (tries > 0 || (await found(paths(id).game)) || (await hasDisc(id, found))) break;
              await discard(id, false);
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
        void settle(id);
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

    /** Its build in R2, when a worker elsewhere made the one there is (null: here, or none). */
    fastR2: (id: string) => jobs.get(fastKey(id))?.build ?? null,

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
