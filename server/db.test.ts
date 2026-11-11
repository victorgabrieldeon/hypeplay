import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mapping } from "../page/padmap";
import { openDb } from "./db";
import { createPeople } from "./people";
import { createSocial } from "./social";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const pad: Mapping = {
  buttons: Array.from({ length: 16 }, (_, i) => ({ button: i })),
  axes: [{ axis: 0 }, { axis: 1 }, { axis: 2 }, { axis: 3 }],
};
const keys = { buttons: ["KeyK", ...Array(15).fill(null)], sticks: Array(8).fill(null) };

/** A data folder as the server before the database left it. */
async function oldFolder() {
  const dir = await mkdtemp(join(tmpdir(), "cordplay-db-"));
  dirs.push(dir);
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
  return dir;
}

test("the first start imports social.json and the per-person files, and leaves them where they were", async () => {
  const dir = await oldFolder();
  const before = await readFile(join(dir, "social.json"), "utf8");
  const social = createSocial(dir);
  const people = createPeople(dir);

  expect(openDb(dir).query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
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
  const dir = await oldFolder();
  const social = createSocial(dir);
  const people = createPeople(dir);
  social.setStatus("1", { status: "away", note: "já volto" });
  social.remove("1", "2");
  await social.flush();
  expect(await people.setKeys("1", null)).toBe(true);
  await people.setPrefs("1", { volume: 1, filter: "off" });

  // (a restart: the same folder, the files still there)
  const again = createSocial(dir);
  const people2 = createPeople(dir);
  expect(again.profile("1", "1")).toMatchObject({ status: "away", note: "já volto", friends: 0 });
  expect(again.view("2", () => true)!.friends).toEqual([]);
  expect(await people2.keys("1")).toBeNull();
  expect(await people2.prefs("1")).toEqual({ volume: 1, filter: "off" });
  expect(openDb(dir).query("SELECT source FROM imported ORDER BY source").all()).toEqual(
    ["keys/", "pads/", "prefs/", "social.json", "users/"].map((source) => ({ source })),
  );
});

test("an unreadable social.json isn't marked imported: fixed, it comes in at the next start", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cordplay-db-"));
  dirs.push(dir);
  await writeFile(join(dir, "social.json"), "{ cut");
  expect(createSocial(dir).search("9", "a")).toEqual([]);
  await writeFile(join(dir, "social.json"), JSON.stringify({ users: { "1": { name: "Ana", since: 1, seen: 1, status: "online", note: "", games: {}, recent: [], friends: [], incoming: [], outgoing: [], with: {} } } }));
  expect(createSocial(dir).search("9", "a")).toEqual([{ id: "1", name: "Ana", relation: "none" }]);
});
