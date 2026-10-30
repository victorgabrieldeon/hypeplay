/**
 * What the server keeps per person: their controller maps (pads/<id>.json, by the browser's gamepad id), the last
 * game they opened (users/<id>.json, for the home's spotlight), and their volume and screen filter (prefs/<id>.json).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validMapping, type Mapping } from "../page/padmap";
import { USER } from "./saves";

/** A person's volume (0–1) and screen filter in the games (overlay.js). */
export interface Prefs {
  volume: number;
  filter: "off" | "crt" | "scan";
}
export const DEFAULT_PREFS: Prefs = { volume: 0.7, filter: "off" };
const FILTERS = new Set(["off", "crt", "scan"]);

/** More than this many controllers for one person is not a person. */
const MOST_PADS = 16;

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
}

export function createPeople(dir: string) {
  const pads = (user: string) => join(dir, "pads", `${user}.json`);
  const users = (user: string) => join(dir, "users", `${user}.json`);
  const prefs = (user: string) => join(dir, "prefs", `${user}.json`);

  return {
    async pads(user: string): Promise<Record<string, Mapping>> {
      if (!USER.test(user)) return {};
      const maps = await readJson<unknown>(pads(user));
      return maps && typeof maps === "object" && !Array.isArray(maps) ? (maps as Record<string, Mapping>) : {};
    },

    async setPads(user: string, maps: unknown): Promise<boolean> {
      if (!USER.test(user) || !maps || typeof maps !== "object" || Array.isArray(maps)) return false;
      const entries = Object.entries(maps);
      if (entries.length > MOST_PADS || !entries.every(([id, m]) => id.length <= 200 && validMapping(m))) return false;
      await writeJson(pads(user), maps);
      return true;
    },

    async prefs(user: string): Promise<Prefs> {
      const p = USER.test(user) ? await readJson<Prefs>(prefs(user)) : null;
      return p ?? { ...DEFAULT_PREFS };
    },

    async setPrefs(user: string, p: unknown): Promise<boolean> {
      const o = p as Partial<Prefs> | null;
      const ok = USER.test(user) && !!o && typeof o.volume === "number" && o.volume >= 0 && o.volume <= 1 && typeof o.filter === "string" && FILTERS.has(o.filter);
      if (ok) await writeJson(prefs(user), { volume: o!.volume, filter: o!.filter });
      return ok;
    },

    async last(user: string): Promise<string | null> {
      if (!USER.test(user)) return null;
      return (await readJson<{ last?: string }>(users(user)))?.last ?? null;
    },

    async played(user: string, key: string) {
      if (!USER.test(user)) return;
      await writeJson(users(user), { last: key, at: Date.now() });
    },
  };
}

export type People = ReturnType<typeof createPeople>;
