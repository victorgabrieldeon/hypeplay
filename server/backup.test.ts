import { afterEach, expect, test as plain } from "bun:test";
import type { SQL } from "bun";
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup, createBackups, dumpDb, EVERY_MS, FILE_MAX, FIRST_MS, latest, listBackups, nameOf, nextIn, prune, restore, timeOf, volumeFiles } from "./backup";
import { captureLog } from "./log";
import { createTelemetry } from "./otlp";
import { createQueue, type R2Build } from "./queue";
import { needsPg as test, testDb } from "./testing/pg";
import { fakeR2 } from "./testing/r2";

let done: (() => unknown)[] = [];
afterEach(async () => {
  for (const d of done.reverse()) await d();
  done = [];
});

const T = Date.UTC(2026, 10, 11, 14, 30);
const exists = (path: string) => stat(path).then(() => true, () => false);

async function folder() {
  const dir = await mkdtemp(join(tmpdir(), "hypeplay-backup-test-"));
  done.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
async function db() {
  const t = await testDb();
  done.push(t.close);
  return t.sql;
}
function r2() {
  const r = fakeR2();
  done.push(r.stop);
  return r;
}
async function put(dir: string, rel: string, body: string | Uint8Array = rel) {
  await mkdir(join(dir, rel, ".."), { recursive: true });
  await writeFile(join(dir, rel), body);
}

/** A volume as the server leaves it: what goes in the backup, and what never does. */
async function volume(dir: string) {
  const game = { id: "slus-20001", serial: "SLUS-20001", name: "Jogo", by: { id: "42", name: "Ana" }, at: 1, cover: true };
  await put(dir, "ps2/slus-20001/game.json", JSON.stringify(game));
  await put(dir, "ps2/slus-20001/cover.webp", new Uint8Array([1, 2, 3]));
  await put(dir, "ps2/slus-20001/disc.iso.r2", "123456789");
  await put(dir, "ps2/slus-20001/fast/request", "");
  await put(dir, "ps2/slus-20001/fast/misses.txt", "00100000\n");
  await put(dir, "ps2/slus-20001/fast/build/ps2web.html", "the build");
  // (its disc only here: lost with the machine)
  await put(dir, "ps2/slus-20002/game.json", JSON.stringify({ ...game, id: "slus-20002", serial: "SLUS-20002" }));
  await put(dir, "ps2/slus-20002/disc.iso", "a disc");
  await put(dir, "ps2/slus-20002/upload/part", "uploading");
  await put(dir, "bios/bios.bin", "bios");
  await put(dir, "bios/bios.json", "{}");
  await put(dir, "saves/slus-20001/42.ps2", "card");
  await put(dir, "social.json", "{}");
  await put(dir, "intro.mp4", "video");
  await put(dir, "vimm/x.7z", "archive");
  await put(dir, "ps2-work/slus-20001/a.o", "work");
  await put(dir, "ps2/slus-20001/disc.iso.part", "half");
  await put(dir, "big.bin", "");
  await truncate(join(dir, "big.bin"), FILE_MAX + 1);
}
const KEPT = ["ps2/slus-20001/game.json", "ps2/slus-20001/cover.webp", "ps2/slus-20001/disc.iso.r2", "ps2/slus-20001/fast/request", "ps2/slus-20001/fast/misses.txt", "ps2/slus-20002/game.json", "bios/bios.bin", "bios/bios.json", "saves/slus-20001/42.ps2", "social.json"];
const LEFT = ["ps2/slus-20001/fast/build/ps2web.html", "ps2/slus-20002/disc.iso", "ps2/slus-20002/upload/part", "intro.mp4", "vimm/x.7z", "ps2-work/slus-20001/a.o", "ps2/slus-20001/disc.iso.part", "big.bin"];

/** A bit of everything in the database, the identity column and a reserved word's column among it. */
async function rows(sql: SQL) {
  await sql`INSERT INTO profiles (id, name, since, seen, status, note) VALUES ('42', 'Ana', 1, 2, 'online', ''), ('43', 'Bia', 3, 4, 'busy', 'oi')`;
  await sql`INSERT INTO pads (person, maps) VALUES ('42', '{"a":1}')`;
  await sql`INSERT INTO prefs (person, volume, filter) VALUES ('42', 0.5, 'crt')`;
  await sql`INSERT INTO links (person, other, kind, pos) VALUES ('42', '43', 'friends', 0), ('43', '42', 'friends', 0)`;
  await sql`INSERT INTO played (person, key, pos, title, ms, sessions, last) VALUES ('42', 'ps2/slus-20001', 0, 'Jogo', 12345678901234, 3, 5)`;
  await sql`INSERT INTO recent (person, pos, key, title, start, "end") VALUES ('42', 0, 'ps2/slus-20001', 'Jogo', 10, 20)`;
  await sql`INSERT INTO favorites (person, key, at) VALUES ('42', 'ps2/slus-20001', 7)`;
  await sql`INSERT INTO imported (source, at) VALUES ('social.json', 1)`;
}

/** The jobs: a build made here (lost with the machine), one made elsewhere (in R2), one waiting. */
function jobs(dir: string) {
  const q = createQueue(join(dir, "queue.db"));
  const made: [string, R2Build | null][] = [["ps2/slus-20001", null], ["ps2/slus-20003", { prefix: "ps2/slus-20003/fast/v1", files: ["ps2web.html"] }]];
  for (const [key, build] of made) {
    q.enqueue(key, "ps2");
    const c = q.claim("w", { kinds: ["ps2"] })!;
    q.done(c.key, c.token, { status: { state: "ready" }, build });
  }
  q.enqueue("ps2/slus-20004", "ps2");
  return q;
}

const sorted = (d: Record<string, Record<string, unknown>[]>) =>
  Object.fromEntries(Object.entries(d).map(([t, r]) => [t, r.map((x) => JSON.stringify(x)).sort()]));

test("backup, then restore into an empty volume and database: the same rows, queue and small files; nothing big", async () => {
  const [dir, sql, to, sql2, { client, objects }] = [await folder(), await db(), await folder(), await db(), r2()];
  await volume(dir);
  await rows(sql);
  const q = jobs(dir);
  // (the queue still open, its latest writes maybe only in its WAL)
  const m = await backup({ dir, sql, r2: client, now: T });
  q.close();
  expect(m.name).toBe("2026-11-11T1430");
  expect(m.tables.profiles).toBe(2);
  expect(m.skipped).toEqual(["big.bin"]);
  expect([...objects.keys()].sort()).toEqual(["data.tar.gz", "manifest.json", "postgres.json", "queue.db"].map((f) => `backup/2026-11-11T1430/${f}`));

  const r = await restore({ dir: to, sql: sql2, r2: client });
  expect(r.name).toBe(m.name);
  expect(sorted(await dumpDb(sql2))).toEqual(sorted(await dumpDb(sql)));
  for (const f of KEPT) expect(await readFile(join(to, f))).toEqual(await readFile(join(dir, f)));
  for (const f of LEFT) expect(await exists(join(to, f))).toBe(false);
  // the identity goes on from where it was, not from 1
  const [{ n }] = await sql2`INSERT INTO profiles (id, name, since, seen, status, note) VALUES ('44', 'Cris', 5, 5, 'online', '') RETURNING n`;
  const [{ max }] = await sql`SELECT max(n) AS max FROM profiles`;
  expect(Number(n)).toBeGreaterThan(Number(max));

  const back = createQueue(join(to, "queue.db"));
  const states = Object.fromEntries(back.list().map((j) => [j.key, j.state]));
  back.close();
  // the build made here went with the disk: back in line; the one in R2 is still there
  expect(states).toEqual({ "ps2/slus-20001": "queued", "ps2/slus-20003": "done", "ps2/slus-20004": "queued" });
  expect(r.requeued).toEqual(["ps2/slus-20001"]);
  expect(r.discless).toEqual(["slus-20002"]);
});

test("restore refuses a database or a volume in use, unless forced: then it's the backup's", async () => {
  const [dir, sql, { client }] = [await folder(), await db(), r2()];
  await volume(dir);
  await rows(sql);
  jobs(dir).close();
  await backup({ dir, sql, r2: client, now: T });

  // (a startup on an empty database only marks `imported`: still empty)
  const [to, sql2] = [await folder(), await db()];
  await sql2`INSERT INTO imported (source, at) VALUES ('pads/', 9)`;
  await sql2`INSERT INTO pads (person, maps) VALUES ('99', '{}')`;
  await expect(restore({ dir: to, sql: sql2, r2: client })).rejects.toThrow("not empty (pads)");
  await sql2`DELETE FROM pads`;
  await put(to, "ps2/slus-29999/game.json", "{}");
  await expect(restore({ dir: to, sql: sql2, r2: client })).rejects.toThrow("not empty (ps2/slus-29999)");
  await sql2`INSERT INTO pads (person, maps) VALUES ('99', '{}')`;
  await restore({ dir: to, sql: sql2, r2: client, force: true });
  expect(sorted(await dumpDb(sql2))).toEqual(sorted(await dumpDb(sql)));
  expect(await readFile(join(to, "ps2/slus-20001/game.json"), "utf8")).toBe(await readFile(join(dir, "ps2/slus-20001/game.json"), "utf8"));
});

test("a backup that fails halfway is never the latest; the next good one's pruning takes it away", async () => {
  const [dir, sql, r] = [await folder(), await db(), r2()];
  await volume(dir);
  await rows(sql);
  await backup({ dir, sql, r2: r.client, now: T });
  r.fail = (key) => key.endsWith("/data.tar.gz");
  await expect(backup({ dir, sql, r2: r.client, now: T + EVERY_MS })).rejects.toThrow();
  r.fail = null;
  const half = nameOf(T + EVERY_MS);
  expect((await listBackups(r.client)).map((b) => [b.name, b.done])).toEqual([[nameOf(T), true], [half, false]]);
  expect(await latest(r.client)).toBe(nameOf(T));
  await expect(restore({ dir: await folder(), sql: await db(), r2: r.client, name: half })).rejects.toThrow(`no finished backup ${half}`);
  await backup({ dir, sql, r2: r.client, now: T + 2 * EVERY_MS });
  expect(await prune(r.client)).toEqual([half]);
  expect((await listBackups(r.client)).map((b) => b.name)).toEqual([nameOf(T), nameOf(T + 2 * EVERY_MS)]);
});

test("the timer's run: a failure is logged and counted, never thrown; while shutting down, none starts", async () => {
  const [dir, sql, r] = [await folder(), await db(), r2()];
  const sent: any[] = [];
  const telemetry = createTelemetry({ endpoint: "http://otel", service: "t", timers: false, fetch: async (url, init) => (url.endsWith("/v1/metrics") && sent.push(JSON.parse(String(init.body))), new Response(null)) });
  let draining = false;
  const b = createBackups({ dir, sql, r2: r.client, telemetry, draining: () => draining, now: () => T });
  done.push(() => b.stop());
  const logs = captureLog();
  done.push(logs.restore);
  r.fail = () => true;
  expect(await b.run()).toBeNull();
  expect(logs.lines.some((l) => l.msg === "backup failed")).toBe(true);
  r.fail = null;
  expect((await b.run())?.name).toBe(nameOf(T));
  await telemetry.flush();
  const metrics = Object.fromEntries(sent.at(-1).resourceMetrics[0].scopeMetrics[0].metrics.map((m: any) => [m.name, m]));
  expect(metrics["hypeplay.backup.failures"].sum.dataPoints[0].asDouble).toBe(1);
  expect(metrics["hypeplay.backup.last_ok"].gauge.dataPoints[0].asDouble).toBe(T / 1000);
  draining = true;
  r.objects.clear();
  expect(await b.run()).toBeNull();
  expect(r.objects.size).toBe(0);
});

const manifest = (name: string) => [`backup/${name}/manifest.json`, new TextEncoder().encode("{}")] as const;

plain("retention: the 14 newest finished stay; older ones and stale unfinished ones go, nothing outside backup/", async () => {
  const { client, objects } = r2();
  const names = Array.from({ length: 17 }, (_, i) => nameOf(T + i * EVERY_MS));
  for (const n of names) {
    objects.set(...manifest(n));
    objects.set(`backup/${n}/postgres.json`, new Uint8Array(1));
  }
  // unfinished: one older than the newest (stale), one newer (maybe on its way)
  objects.set(`backup/${nameOf(T + 15 * EVERY_MS + 60_000)}/postgres.json`, new Uint8Array(1));
  objects.set(`backup/${nameOf(T + 20 * EVERY_MS)}/postgres.json`, new Uint8Array(1));
  for (const k of ["ps2/slus-20001/disc.iso", "saves/slus-20001/42.ps2", "backup-notes.txt"]) objects.set(k, new Uint8Array(1));
  expect(await prune(client)).toEqual([...names.slice(0, 3), nameOf(T + 15 * EVERY_MS + 60_000)]);
  const left = await listBackups(client);
  expect(left.filter((b) => b.done).map((b) => b.name)).toEqual(names.slice(3));
  expect(left.filter((b) => !b.done).map((b) => b.name)).toEqual([nameOf(T + 20 * EVERY_MS)]);
  for (const k of ["ps2/slus-20001/disc.iso", "saves/slus-20001/42.ps2", "backup-notes.txt"]) expect(objects.has(k)).toBe(true);
});

plain("when the next one goes: 10 min after starting when the latest is a day old or there's none, else at its day", () => {
  expect(nextIn(null, T)).toBe(FIRST_MS);
  expect(nextIn(T - EVERY_MS, T)).toBe(FIRST_MS);
  expect(nextIn(T - 2 * EVERY_MS, T)).toBe(FIRST_MS);
  expect(nextIn(T - 60 * 60_000, T)).toBe(EVERY_MS - 60 * 60_000);
  expect(nextIn(T - EVERY_MS + 60_000, T)).toBe(FIRST_MS);
  expect(timeOf(nameOf(T))).toBe(T);
});

plain("at startup, the latest finished backup in R2 is the last ok (so a deploy doesn't look like a missed one)", async () => {
  const { client, objects } = r2();
  objects.set(...manifest(nameOf(T - 60 * 60_000)));
  objects.set(`backup/${nameOf(T)}/postgres.json`, new Uint8Array(1));
  const logs = captureLog();
  done.push(logs.restore);
  const b = createBackups({ dir: "/nowhere", sql: {} as SQL, r2: client, telemetry: createTelemetry({ endpoint: "http://otel", service: "t", timers: false }), draining: () => false, now: () => T });
  done.push(() => b.stop());
  await b.start();
  expect(b.lastOk).toBe(T - 60 * 60_000);
  expect(logs.lines.find((l) => l.msg === "backup: scheduled")?.in_min).toBe((EVERY_MS - 60 * 60_000) / 60_000);
});

plain("past the volume's budget the rest stays out, the memory cards first (they go last)", async () => {
  const dir = await folder();
  for (const f of ["bios/bios.bin", "ps2/slus-20001/game.json", "saves/slus-20001/42.ps2", "saves/slus-20001/43.ps2"]) await put(dir, f, "x".repeat(10));
  const { files, skipped } = await volumeFiles(dir, 25);
  expect(files).toEqual(["bios/bios.bin", "ps2/slus-20001/game.json"]);
  expect(skipped.sort()).toEqual(["saves/slus-20001/42.ps2", "saves/slus-20001/43.ps2"]);
  expect((await volumeFiles(dir)).skipped).toEqual([]);
});
