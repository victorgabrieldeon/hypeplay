import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mapping } from "../page/padmap";
import { Database } from "bun:sqlite";
import { importOld } from "./db";
import { createPeople } from "./people";
import { createSocial } from "./social";
import { needsPg as test, testDb } from "./testing/pg";

let done: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(done.map((d) => d()));
  done = [];
});

/** An empty data folder and an empty database. */
async function fresh() {
  const dir = await mkdtemp(join(tmpdir(), "cordplay-db-"));
  const { sql, close } = await testDb();
  done.push(close, () => rm(dir, { recursive: true, force: true }));
  return { dir, sql };
}

const pad: Mapping = {
  buttons: Array.from({ length: 16 }, (_, i) => ({ button: i })),
  axes: [{ axis: 0 }, { axis: 1 }, { axis: 2 }, { axis: 3 }],
};
const keys = { buttons: ["KeyK", ...Array(15).fill(null)], sticks: Array(8).fill(null) };

/** A data folder as the server before the database left it. */
async function oldFolder() {
  const { dir, sql } = await fresh();
  const t = 1_000_000;
  const profile = (name: string, more: object = {}) => ({ name, since: t, seen: t + 5, status: "online", note: "", games: {}, recent: [], friends: [], incoming: [], outgoing: [], with: {}, ...more });
  const social = {
    users: {
      "1": profile("Ana", {
        status: "busy",
        note: "procurando alguém pro BT3",
        games: { bt3: { title: "BT3", ms: 7_200_000, sessions: 2, last: t + 9 }, "ps2/sles-12345": { title: "Outro", ms: 60_000, sessions: 1, last: t + 1 } },
        // (newest first)
        recent: [
          { key: "bt3", title: "BT3", start: t + 8, end: t + 9 },
          { key: "ps2/sles-12345", title: "Outro", start: t + 1, end: t + 2 },
        ],
        friends: ["2"],
        outgoing: ["3"],
        with: { "2": t + 9 },
      }),
      "2": profile("Bia", { friends: ["1"], games: { bt3: { title: "BT3", ms: 1000, sessions: 1, last: t } } }),
      "3": profile("Caio", { incoming: ["1"] }),
      "../x": profile("nope"),
    },
  };
  await writeFile(join(dir, "social.json"), JSON.stringify(social));
  for (const [folder, files] of Object.entries({
    pads: { "1": { "USB Joystick": pad }, "2": "{" },
    keys: { "1": keys },
    users: { "1": { last: "ps2/sles-12345", at: t } },
    prefs: { "1": { volume: 0.35, filter: "crt" }, "2": { volume: 5, filter: "crt" } },
  })) {
    await mkdir(join(dir, folder));
    for (const [id, v] of Object.entries(files)) await writeFile(join(dir, folder, `${id}.json`), typeof v === "string" ? v : JSON.stringify(v));
  }
  return { dir, sql };
}

test("the first start imports social.json and the per-person files, and leaves them where they were", async () => {
  const { dir, sql } = await oldFolder();
  const before = await readFile(join(dir, "social.json"), "utf8");
  const social = await createSocial(sql, dir);
  const people = createPeople(sql, dir);
  const ana = social.profile("1", "1")!;
  expect(ana).toMatchObject({ name: "Ana", status: "busy", note: "procurando alguém pro BT3", since: 1_000_000, seen: 1_000_005, total: 7_260_000, friends: 1, relation: "self" });
  expect(ana.games.map((g) => g.key)).toEqual(["bt3", "ps2/sles-12345"]);
  expect(ana.recent.map((r) => r.key)).toEqual(["bt3", "ps2/sles-12345"]);
  expect(ana.badges.map((b) => b.id)).toEqual(["first"]);
  expect(social.profile("2", "1")!.with).toEqual([{ id: "2", name: "Bia", at: 1_000_009 }]);
  expect(social.profile("2", "1")!.common).toEqual([{ key: "bt3", title: "BT3", mine: 1000, theirs: 7_200_000 }]);
  const view = social.view("1", () => true)!;
  expect(view.friends.map((f) => f.name)).toEqual(["Bia"]);
  expect(view.outgoing).toEqual([{ id: "3", name: "Caio" }]);
  expect(social.view("3", () => true)!.incoming).toEqual([{ id: "1", name: "Ana" }]);
  expect(social.search("9", "a").map((u) => u.name)).toEqual(["Ana", "Bia", "Caio"]);

  expect(await people.pads("1")).toEqual({ "USB Joystick": pad });
  expect(await people.pads("2")).toEqual({}); // (a corrupted file: skipped, the others still come)
  expect(await people.keys("1")).toEqual(keys);
  expect(await people.last("1")).toBe("ps2/sles-12345");
  expect(await people.prefs("1")).toEqual({ volume: 0.35, filter: "crt" });
  expect(await people.prefs("2")).toEqual({ volume: 0.7, filter: "off" }); // (out of range: not taken)

  expect(await readFile(join(dir, "social.json"), "utf8")).toBe(before);
  expect(await readFile(join(dir, "pads", "2.json"), "utf8")).toBe("{");
});

test("once imported, the database wins: a change stays, a deleted key doesn't come back from its old file", async () => {
  const { dir, sql } = await oldFolder();
  const social = await createSocial(sql, dir);
  const people = createPeople(sql, dir);
  social.setStatus("1", { status: "away", note: "já volto" });
  social.remove("1", "2");
  await social.flush();
  expect(await people.setKeys("1", null)).toBe(true);
  await people.setPrefs("1", { volume: 1, filter: "off" });

  // (a restart: the same folder, the files still there)
  const again = await createSocial(sql, dir);
  const people2 = createPeople(sql, dir);
  expect(again.profile("1", "1")).toMatchObject({ status: "away", note: "já volto", friends: 0 });
  expect(again.view("2", () => true)!.friends).toEqual([]);
  expect(await people2.keys("1")).toBeNull();
  expect(await people2.prefs("1")).toEqual({ volume: 1, filter: "off" });
  expect([...(await sql`SELECT source FROM imported ORDER BY source`)]).toEqual(
    ["keys/", "pads/", "prefs/", "social.json", "users/"].map((source) => ({ source })),
  );
});

test("an unreadable social.json isn't marked imported: fixed, it comes in at the next start", async () => {
  const { dir, sql } = await fresh();
  await writeFile(join(dir, "social.json"), "{ cut");
  expect((await createSocial(sql, dir)).search("9", "a")).toEqual([]);
  await writeFile(join(dir, "social.json"), JSON.stringify({ users: { "1": { name: "Ana", since: 1, seen: 1, status: "online", note: "", games: {}, recent: [], friends: [], incoming: [], outgoing: [], with: {} } } }));
  expect((await createSocial(sql, dir)).search("9", "a")).toEqual([{ id: "1", name: "Ana", relation: "none" }]);
});

/** The tables of the SQLite file the server kept for a few hours (hypeplay.db), as they were. */
const SQLITE_SCHEMA = `
CREATE TABLE IF NOT EXISTS imported (source TEXT PRIMARY KEY, at INTEGER NOT NULL);

CREATE TABLE IF NOT EXISTS pads (user TEXT PRIMARY KEY, maps TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS keys (user TEXT PRIMARY KEY, map TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS last_played (user TEXT PRIMARY KEY, key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS prefs (user TEXT PRIMARY KEY, volume REAL NOT NULL, filter TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, since INTEGER NOT NULL, seen INTEGER NOT NULL,
  status TEXT NOT NULL, note TEXT NOT NULL
);
-- friend, incoming (a request they got), outgoing (one they sent); pos: the order they came in
CREATE TABLE IF NOT EXISTS links (
  user TEXT NOT NULL, other TEXT NOT NULL, kind TEXT NOT NULL, pos INTEGER NOT NULL,
  PRIMARY KEY (user, kind, other)
);
CREATE TABLE IF NOT EXISTS played (
  user TEXT NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, ms INTEGER NOT NULL, sessions INTEGER NOT NULL,
  last INTEGER NOT NULL, PRIMARY KEY (user, key)
);
-- pos 0: the newest
CREATE TABLE IF NOT EXISTS recent (
  user TEXT NOT NULL, pos INTEGER NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, start INTEGER NOT NULL,
  "end" INTEGER NOT NULL, PRIMARY KEY (user, pos)
);
CREATE TABLE IF NOT EXISTS played_with (user TEXT NOT NULL, other TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user, other));
`;

test("hypeplay.db (the SQLite of before) comes in whole and wins over the JSON files it had imported", async () => {
  const { dir, sql } = await oldFolder();
  // what the SQLite version left: the JSON files imported, then changes (Ana away, no longer Bia's friend, her keys
  // deleted, her volume up; Duda new)
  const old = new Database(join(dir, "hypeplay.db"));
  old.run(SQLITE_SCHEMA);
  for (const source of ["keys/", "pads/", "prefs/", "social.json", "users/"]) old.query("INSERT INTO imported VALUES (?, 1)").run(source);
  old.query("INSERT INTO pads VALUES (?, ?)").run("1", JSON.stringify({ "USB Joystick": pad }));
  old.query("INSERT INTO prefs VALUES (?, ?, ?)").run("1", 1, "off");
  old.query("INSERT INTO last_played VALUES (?, ?, ?)").run("1", "bt3", 5);
  const profile = old.query("INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?)");
  profile.run("1", "Ana", 1_000_000, 2_000_000, "away", "");
  profile.run("2", "Bia", 1_000_000, 1_000_005, "online", "");
  profile.run("4", "Duda", 1_500_000, 1_500_000, "online", "oi");
  old.query("INSERT INTO links VALUES (?, ?, ?, ?)").run("1", "3", "outgoing", 0);
  old.query("INSERT INTO links VALUES (?, ?, ?, ?)").run("3", "1", "incoming", 0);
  const played = old.query("INSERT INTO played VALUES (?, ?, ?, ?, ?, ?)");
  played.run("1", "bt3", "BT3", 7_300_000, 3, 2_000_000);
  played.run("1", "ps2/sles-12345", "Outro", 60_000, 1, 1_000_001);
  old.query('INSERT INTO recent VALUES (?, ?, ?, ?, ?, ?)').run("1", 0, "bt3", "BT3", 1_900_000, 2_000_000);
  old.query("INSERT INTO played_with VALUES (?, ?, ?)").run("1", "2", 1_000_009);
  old.close();

  await importOld(sql, dir);
  await importOld(sql, dir); // (a second start: nothing again)
  const social = await createSocial(sql, dir);
  const people = createPeople(sql, dir);
  expect(social.profile("1", "1")).toMatchObject({ status: "away", seen: 2_000_000, total: 7_360_000, friends: 0 });
  expect(social.profile("1", "1")!.games.map((g) => [g.key, g.sessions])).toEqual([["bt3", 3], ["ps2/sles-12345", 1]]);
  expect(social.profile("1", "1")!.recent).toEqual([{ key: "bt3", title: "BT3", start: 1_900_000, end: 2_000_000 }]);
  expect(social.profile("2", "1")!.with).toEqual([{ id: "2", name: "Bia", at: 1_000_009 }]);
  expect(social.view("3", () => true)).toBeNull(); // (Caio was only in social.json: not there, not brought back)
  expect(social.search("9", "a").map((u) => u.name)).toEqual(["Ana", "Bia", "Duda"]);
  expect(await people.pads("1")).toEqual({ "USB Joystick": pad });
  expect(await people.keys("1")).toBeNull();
  expect(await people.prefs("1")).toEqual({ volume: 1, filter: "off" });
  expect(await people.last("1")).toBe("bt3");
  expect((await sql`SELECT count(*)::int AS n FROM profiles`)[0].n).toBe(3);
  expect(await Bun.file(join(dir, "hypeplay.db")).exists()).toBe(true);
});
