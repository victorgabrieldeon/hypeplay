/**
 * What the server keeps per person: their controller maps (pads/<id>.json, by the browser's gamepad id) and the last
 * game they opened (users/<id>.json, for the home's spotlight).
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validMapping, type Mapping } from "../page/padmap";
import { USER } from "./saves";

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
