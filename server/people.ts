/**
 * What the server keeps per person, in the database (db.ts): their controller maps (pads, by the browser's gamepad
 * id), their keys for the PS2 games (keys), the last game they opened (last_played, for the home's spotlight), and
 * their volume and screen filter (prefs). The files they were in before (pads/<id>.json, keys/, users/, prefs/) are
 * imported once and left there.
 */
import type { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { validKeyMap, type KeyMap } from "../page/keymap";
import { validMapping, type Mapping } from "../page/padmap";
import { importOnce, openDb } from "./db";
import { USER } from "./saves";

/** A person's volume (0–1) and screen filter in the games (overlay.js). */
export interface Prefs {
  volume: number;
  filter: "off" | "crt" | "scan";
}
const DEFAULT_PREFS: Prefs = { volume: 0.7, filter: "off" };
const FILTERS = new Set(["off", "crt", "scan"]);

/** More than this many controllers for one person is not a person. */
const MOST_PADS = 16;

const parse = (text: string | null): unknown => {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
};
const isMaps = (m: unknown): m is Record<string, Mapping> => !!m && typeof m === "object" && !Array.isArray(m);
const isPrefs = (o: Partial<Prefs> | null): o is Prefs =>
  !!o && typeof o.volume === "number" && o.volume >= 0 && o.volume <= 1 && typeof o.filter === "string" && FILTERS.has(o.filter);

/** The old files of one kind (<dir>/<folder>/<id>.json), once: each one that reads, as `put` takes it. */
function importFiles(db: Database, dir: string, folder: string, put: (user: string, value: unknown) => void) {
  importOnce(db, `${folder}/`, () => {
    let names: string[] = [];
    try {
      names = readdirSync(join(dir, folder));
    } catch {
      return;
    }
    for (const name of names) {
      const user = name.slice(0, -".json".length);
      if (!name.endsWith(".json") || !USER.test(user)) continue;
      let text: string | null = null;
      try {
        text = readFileSync(join(dir, folder, name), "utf8");
      } catch {
        continue;
      }
      const value = parse(text);
      if (value !== null) put(user, value);
    }
  });
}

export function createPeople(dir: string) {
  const db = openDb(dir);
  const q = {
    pads: db.query<{ maps: string }, [string]>("SELECT maps FROM pads WHERE user = ?"),
    setPads: db.query("INSERT INTO pads (user, maps) VALUES (?, ?) ON CONFLICT (user) DO UPDATE SET maps = excluded.maps"),
    keys: db.query<{ map: string }, [string]>("SELECT map FROM keys WHERE user = ?"),
    setKeys: db.query("INSERT INTO keys (user, map) VALUES (?, ?) ON CONFLICT (user) DO UPDATE SET map = excluded.map"),
    dropKeys: db.query("DELETE FROM keys WHERE user = ?"),
    prefs: db.query<Prefs, [string]>("SELECT volume, filter FROM prefs WHERE user = ?"),
    setPrefs: db.query("INSERT INTO prefs (user, volume, filter) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET volume = excluded.volume, filter = excluded.filter"),
    last: db.query<{ key: string }, [string]>("SELECT key FROM last_played WHERE user = ?"),
    played: db.query("INSERT INTO last_played (user, key, at) VALUES (?, ?, ?) ON CONFLICT (user) DO UPDATE SET key = excluded.key, at = excluded.at"),
  };
  // (the files' contents as they were: read back through the same checks as anything else)
  importFiles(db, dir, "pads", (user, m) => isMaps(m) && q.setPads.run(user, JSON.stringify(m)));
  importFiles(db, dir, "keys", (user, m) => validKeyMap(m) && q.setKeys.run(user, JSON.stringify(m)));
  importFiles(db, dir, "prefs", (user, p) => isPrefs(p as Partial<Prefs>) && q.setPrefs.run(user, (p as Prefs).volume, (p as Prefs).filter));
  importFiles(db, dir, "users", (user, u) => {
    const { last, at } = (u ?? {}) as { last?: unknown; at?: unknown };
    if (typeof last === "string") q.played.run(user, last, typeof at === "number" ? at : 0);
  });

  return {
    async pads(user: string): Promise<Record<string, Mapping>> {
      if (!USER.test(user)) return {};
      const maps = parse(q.pads.get(user)?.maps ?? null);
      return isMaps(maps) ? maps : {};
    },

    async setPads(user: string, maps: unknown): Promise<boolean> {
      if (!USER.test(user) || !isMaps(maps)) return false;
      const entries = Object.entries(maps);
      if (entries.length > MOST_PADS || !entries.every(([id, m]) => id.length <= 200 && validMapping(m))) return false;
      q.setPads.run(user, JSON.stringify(maps));
      return true;
    },

    async keys(user: string): Promise<KeyMap | null> {
      const m = USER.test(user) ? parse(q.keys.get(user)?.map ?? null) : null;
      return validKeyMap(m) ? m : null;
    },

    /** null forgets them. */
    async setKeys(user: string, m: unknown): Promise<boolean> {
      if (!USER.test(user) || (m !== null && !validKeyMap(m))) return false;
      if (m === null) q.dropKeys.run(user);
      else q.setKeys.run(user, JSON.stringify(m));
      return true;
    },

    async prefs(user: string): Promise<Prefs> {
      const p = USER.test(user) ? q.prefs.get(user) : null;
      return p ? { volume: p.volume, filter: p.filter } : { ...DEFAULT_PREFS };
    },

    async setPrefs(user: string, p: unknown): Promise<boolean> {
      const o = p as Partial<Prefs> | null;
      const ok = USER.test(user) && isPrefs(o);
      if (ok) q.setPrefs.run(user, o.volume, o.filter);
      return ok;
    },

    async last(user: string): Promise<string | null> {
      if (!USER.test(user)) return null;
      return q.last.get(user)?.key ?? null;
    },

    async played(user: string, key: string) {
      if (!USER.test(user)) return;
      q.played.run(user, key, Date.now());
    },
  };
}

export type People = ReturnType<typeof createPeople>;
