/**
 * What the server keeps per person, in Postgres (db.ts): their controller maps (pads, by the browser's gamepad
 * id), their keys for the PS2 games (keys), the last game they opened (last_played, for the home's spotlight), and
 * their volume and screen filter (prefs). The files they were in before (pads/<id>.json, keys/, users/, prefs/) are
 * imported once and left there.
 */
import type { SQL } from "bun";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validKeyMap, type KeyMap } from "../page/keymap";
import { validMapping, type Mapping } from "../page/padmap";
import { importOnce } from "./db";
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
async function importFiles(sql: SQL, dir: string, folder: string, put: (tx: SQL, user: string, value: unknown) => Promise<unknown> | false) {
  const names = await readdir(join(dir, folder)).catch(() => [] as string[]);
  const found: [string, unknown][] = [];
  for (const name of names) {
    const user = name.slice(0, -".json".length);
    if (!name.endsWith(".json") || !USER.test(user)) continue;
    const value = parse(await readFile(join(dir, folder, name), "utf8").catch(() => null));
    if (value !== null) found.push([user, value]);
  }
  await importOnce(sql, `${folder}/`, async (tx) => {
    for (const [user, value] of found) await put(tx, user, value);
  });
}

/** `sql`: the database, its tables made (db.ts' migrate); `dir`: the data folder, where the old files may be. */
export function createPeople(sql: SQL, dir: string) {
  const setPads = (tx: SQL, user: string, maps: unknown) =>
    tx`INSERT INTO pads (person, maps) VALUES (${user}, ${JSON.stringify(maps)}) ON CONFLICT (person) DO UPDATE SET maps = EXCLUDED.maps`;
  const setKeys = (tx: SQL, user: string, m: unknown) =>
    tx`INSERT INTO keys (person, map) VALUES (${user}, ${JSON.stringify(m)}) ON CONFLICT (person) DO UPDATE SET map = EXCLUDED.map`;
  const setPrefs = (tx: SQL, user: string, p: Prefs) =>
    tx`INSERT INTO prefs (person, volume, filter) VALUES (${user}, ${p.volume}, ${p.filter}) ON CONFLICT (person) DO UPDATE SET volume = EXCLUDED.volume, filter = EXCLUDED.filter`;
  const played = (tx: SQL, user: string, key: string, at: number) =>
    tx`INSERT INTO last_played (person, key, at) VALUES (${user}, ${key}, ${at}) ON CONFLICT (person) DO UPDATE SET key = EXCLUDED.key, at = EXCLUDED.at`;

  // (the files' contents as they were: through the same checks as anything else; everything waits for them)
  const ready = (async () => {
    await importFiles(sql, dir, "pads", (tx, user, m) => isMaps(m) && setPads(tx, user, m));
    await importFiles(sql, dir, "keys", (tx, user, m) => validKeyMap(m) && setKeys(tx, user, m));
    await importFiles(sql, dir, "prefs", (tx, user, p) => isPrefs(p as Partial<Prefs>) && setPrefs(tx, user, p as Prefs));
    await importFiles(sql, dir, "users", (tx, user, u) => {
      const { last, at } = (u ?? {}) as { last?: unknown; at?: unknown };
      return typeof last === "string" && played(tx, user, last, typeof at === "number" ? at : 0);
    });
  })();
  // (a failed import shows on every call, rather than the data looking empty)
  ready.catch((err) => console.error("people: the old files weren't imported:", err));
  const one = async <T>(rows: Promise<T[]>) => (await rows)[0] ?? null;

  return {
    ready,

    async pads(user: string): Promise<Record<string, Mapping>> {
      if (!USER.test(user)) return {};
      await ready;
      const maps = parse((await one<{ maps: string }>(sql`SELECT maps FROM pads WHERE person = ${user}`))?.maps ?? null);
      return isMaps(maps) ? maps : {};
    },

    async setPads(user: string, maps: unknown): Promise<boolean> {
      if (!USER.test(user) || !isMaps(maps)) return false;
      const entries = Object.entries(maps);
      if (entries.length > MOST_PADS || !entries.every(([id, m]) => id.length <= 200 && validMapping(m))) return false;
      await ready;
      await setPads(sql, user, maps);
      return true;
    },

    async keys(user: string): Promise<KeyMap | null> {
      if (!USER.test(user)) return null;
      await ready;
      const m = parse((await one<{ map: string }>(sql`SELECT map FROM keys WHERE person = ${user}`))?.map ?? null);
      return validKeyMap(m) ? m : null;
    },

    /** null forgets them. */
    async setKeys(user: string, m: unknown): Promise<boolean> {
      if (!USER.test(user) || (m !== null && !validKeyMap(m))) return false;
      await ready;
      if (m === null) await sql`DELETE FROM keys WHERE person = ${user}`;
      else await setKeys(sql, user, m);
      return true;
    },

    async prefs(user: string): Promise<Prefs> {
      if (!USER.test(user)) return { ...DEFAULT_PREFS };
      await ready;
      const p = await one<Prefs>(sql`SELECT volume, filter FROM prefs WHERE person = ${user}`);
      return p ? { volume: Number(p.volume), filter: p.filter } : { ...DEFAULT_PREFS };
    },

    async setPrefs(user: string, p: unknown): Promise<boolean> {
      const o = p as Partial<Prefs> | null;
      const ok = USER.test(user) && isPrefs(o);
      if (ok) {
        await ready;
        await setPrefs(sql, user, o);
      }
      return ok;
    },

    async last(user: string): Promise<string | null> {
      if (!USER.test(user)) return null;
      await ready;
      return (await one<{ key: string }>(sql`SELECT key FROM last_played WHERE person = ${user}`))?.key ?? null;
    },

    async played(user: string, key: string) {
      if (!USER.test(user)) return;
      await ready;
      await played(sql, user, key, Date.now());
    },
  };
}

export type People = ReturnType<typeof createPeople>;
