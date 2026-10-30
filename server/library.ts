/**
 * The PS2 library: games anyone sent, each built once by ps2-builder/ and kept for everyone. One folder per game,
 * named by its disc's serial, in the data folder:
 *
 *   ps2/<id>/game.json          { id, serial, name, by, at, cover }   written here
 *   ps2/<id>/cover.webp         its cover, when someone sent one
 *   ps2/<id>/upload/, disc.iso, retry, status.json, build/   as BT3's (upload.ts; status.json is the builder's)
 *   ps2-work/<id>/              port.sh's intermediate files (the builder's)
 *   saves/<id>/                 memory cards (saves.ts): outside the game's folder, so removing a game keeps them
 *
 * An id only ever comes from here (ID): routes look games up, they never build paths from addresses.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BT3_SERIAL, fileRead, readDiscId } from "./iso9660";
import type { Pass } from "./pass";
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
export const ID = /^[a-z]{4}-\d{5}$/;
const SERIAL = /^[A-Z]{4}-\d{5}$/;

export type Reserve = { ok: true; game: Ps2Game } | { ok: false; exists: string };

const exists = (path: string) => stat(path).then(() => true, () => false);

export function createLibrary(dir: string, { now = () => Date.now(), min = PS2_MIN, max = PS2_MAX } = {}) {
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

  async function remove(id: string) {
    if (!ID.test(id)) return;
    const p = paths(id);
    stores.delete(id);
    await rm(p.root, { recursive: true, force: true });
    await rm(p.work, { recursive: true, force: true });
  }

  /** Reserved, nothing sent, nothing arriving: abandoned. */
  async function abandoned(g: Ps2Game) {
    if (now() - g.at <= ABANDONED_MS) return false;
    const p = paths(g.id);
    return !(await exists(p.iso)) && !(await exists(join(p.root, "upload")));
  }

  return {
    paths,
    get,
    disc,
    remove,

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

    async reserve(pass: Pass, serial: string, name: string): Promise<Reserve> {
      if (!SERIAL.test(serial)) throw new Error(`not a serial: ${serial}`);
      if (serial === BT3_SERIAL) return { ok: false, exists: "bt3" };
      const id = serial.toLowerCase();
      // One reservation of a serial at a time, in this process; the folder settles it between processes.
      if (reserving.has(id)) return { ok: false, exists: `ps2/${id}` };
      reserving.add(id);
      try {
        await mkdir(join(dir, "ps2"), { recursive: true });
        for (let tries = 0; ; tries++) {
          try {
            // Not recursive: of two reserving the same game at once, only one makes the folder.
            await mkdir(paths(id).root);
            break;
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
            // an orphan folder (no game.json) is cleared once; a real game is a real game
            if (tries > 0 || (await exists(paths(id).game))) return { ok: false, exists: `ps2/${id}` };
            await remove(id);
          }
        }
        const game: Ps2Game = { id, serial, name: nameOr(name, serial), by: { id: pass.id, name: pass.name }, at: now(), cover: false };
        await save(game);
        return { ok: true, game };
      } finally {
        reserving.delete(id);
      }
    },

    /** The whole disc arrived: is it the game reserved? If not, the game goes, and its image with it. */
    async verify(id: string): Promise<{ ok: true } | { ok: false; message: string }> {
      const g = await get(id);
      const found = g && (await readDiscId(fileRead(paths(id).iso)));
      if (g && found?.serial === g.serial) return { ok: true };
      await remove(id);
      return { ok: false, message: found ? "A ISO não é do jogo escolhido" : "Isso não parece um disco de PS2" };
    },

    rename: (id: string, name: string) => update(id, (g) => ({ ...g, name: nameOr(name, g.serial) })),
    setCover: (id: string, has: boolean) => update(id, (g) => ({ ...g, cover: has, coverAt: Math.max(now(), (g.coverAt ?? 0) + 1) })),

  };
}

export type Library = ReturnType<typeof createLibrary>;
