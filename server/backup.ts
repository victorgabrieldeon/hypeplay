/**
 * The daily backup, to R2, of what lives only on this machine: the database, the builds' queue and the volume's small
 * files (what says what the discs, builds and saves in R2 are). Each one a folder of its own, by its UTC time:
 *
 *   backup/<AAAA-MM-DDTHHMM>/postgres.json   every table of the database's schema, found at the time, row by row
 *   backup/<…>/queue.db                      the builds' queue (queue.ts), a consistent copy (VACUUM INTO)
 *   backup/<…>/data.tar.gz                   from the volume: ps2/<id>/{game.json,cover.webp,disc.iso.r2}, fast/ but
 *                                            its build/ (recompiled when lost), bios/, saves/ (the cards from before
 *                                            R2) and the root's own files. Never the discs, uploads, vimm/, ps2-work/,
 *                                            intro.mp4 (sent again from the app), nor a file over FILE_MAX, nor
 *                                            past VOLUME_MAX in all (made in memory: the saves go last)
 *   backup/<…>/manifest.json                 written last: without it the backup is unfinished, never "the latest"
 *
 * index.ts runs it (createBackups): 10 min after starting when the latest is a day old (or there's none), then every
 * day; the 14 newest stay. Never of an app without games or without people (a new machine, a volume or a database
 * lost): such a one would push the good ones out. `restore` (scripts/restore.ts) brings one back into an empty volume
 * and database.
 */
import { Database } from "bun:sqlite";
import type { S3Client, SQL } from "bun";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "./db";
import { log } from "./log";
import type { Telemetry } from "./otlp";
import { r2Keys } from "./fastjobs";
import { createQueue, PRIORITY, type R2Build } from "./queue";

export const PREFIX = "backup/";
/** Finished backups kept. */
export const KEEP = 14;
export const EVERY_MS = 24 * 60 * 60_000;
/** After starting: past the startup's own work, and a deploy that's undone quickly doesn't back up twice. */
export const FIRST_MS = 10 * 60_000;
/** A backup that failed (R2 away, say) is tried again after this. */
export const RETRY_MS = 60 * 60_000;
/** A volume file bigger than this stays out (logged): a memory card (8.6 MB, saves.ts) still goes. */
export const FILE_MAX = 16 * 1024 ** 2;
/** The volume's files in all, at most (the tar is made in memory): past it, the rest stays out (logged). */
export const VOLUME_MAX = 256 * 1024 ** 2;

const FILES = ["postgres.json", "queue.db", "data.tar.gz"] as const;
const NAME = /^\d{4}-\d{2}-\d{2}T\d{4}$/;
/** The root's files that stay out: the queue goes apart, the intro is sent again, the rest is half-written. */
const ROOT_OUT = /^(queue\.db(-wal|-shm|-journal)?|intro\.mp4)$|\.(part|tmp)$/;
/** In a game's fast/: its build (here, recompiled when lost) and the swaps of one. */
const BUILDS = new Set(["build", "build.tmp", "build.old"]);

export interface Manifest {
  name: string;
  at: number;
  /** Rows per table. */
  tables: Record<string, number>;
  files: Partial<Record<(typeof FILES)[number], { size: number; sha256: string }>>;
  /** Volume files in the tar. */
  volume: number;
  /** Games (ps2/<id>/game.json) among them. */
  games: number;
  /** Left out for their size. */
  skipped: string[];
}

export interface Backup {
  name: string;
  /** Its manifest is there. */
  done: boolean;
  keys: string[];
}

/** The folder's name for a time (UTC, to the minute): their order is the names'. */
export const nameOf = (t: number) => new Date(t).toISOString().slice(0, 16).replace(":", "");
export const timeOf = (name: string) => Date.parse(`${name.slice(0, 13)}:${name.slice(13)}:00Z`);

const sha256 = (b: Uint8Array) => new Bun.CryptoHasher("sha256").update(b).digest("hex");
const quote = (id: string) => `"${id.replaceAll('"', '""')}"`;

/** The tables of the schema in use (the tests' own, the app's public). */
async function tables(sql: SQL): Promise<string[]> {
  const rows = await sql`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`;
  return rows.map((r: { table_name: string }) => r.table_name);
}

/** Every table's rows, as one moment saw them. */
export async function dumpDb(sql: SQL): Promise<Record<string, Record<string, unknown>[]>> {
  return sql.begin("isolation level repeatable read read only", async (tx) => {
    const out: Record<string, Record<string, unknown>[]> = {};
    for (const t of await tables(tx)) out[t] = [...(await tx`SELECT * FROM ${tx(t)}`)];
    return out;
  });
}

/** The queue's file as it is now, whole (its WAL in), as bytes; null without one. */
async function copyQueue(path: string, tmp: string): Promise<Uint8Array | null> {
  if (!existsSync(path)) return null;
  const to = join(tmp, "queue.db");
  const db = new Database(path);
  try {
    db.exec("PRAGMA busy_timeout = 10000");
    db.query("VACUUM INTO ?").run(to);
  } finally {
    db.close();
  }
  return Bun.file(to).bytes();
}

/** The volume's files that go in the tar, relative to it; and those left out for their size (or the whole's). */
export async function volumeFiles(dir: string, budget = VOLUME_MAX): Promise<{ files: string[]; skipped: string[] }> {
  const files: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  const list = (rel: string) => readdir(join(dir, rel), { withFileTypes: true }).catch(() => []);
  const add = async (rel: string) => {
    const s = await stat(join(dir, rel)).catch(() => null);
    if (!s?.isFile()) return;
    if (s.size > FILE_MAX || total + s.size > budget) return void skipped.push(rel);
    total += s.size;
    files.push(rel);
  };
  const walk = async (rel: string, skipDir = (_: string) => false) => {
    for (const e of await list(rel)) {
      const r = `${rel}/${e.name}`;
      if (e.isDirectory() && !skipDir(e.name)) await walk(r, skipDir);
      else if (e.isFile() && !e.name.endsWith(".tmp") && !e.name.endsWith(".part")) await add(r);
    }
  };
  for (const e of await list("")) if (e.isFile() && !ROOT_OUT.test(e.name)) await add(e.name);
  await walk("bios");
  for (const e of await list("ps2")) {
    if (!e.isDirectory()) continue;
    for (const f of ["game.json", "cover.webp", "disc.iso.r2"]) await add(`ps2/${e.name}/${f}`);
    await walk(`ps2/${e.name}/fast`, (name) => BUILDS.has(name));
  }
  // (last: the cards left here since R2 can be many, and R2 has each one read since)
  await walk("saves");
  return { files, skipped };
}

/**
 * One backup now: everything made here first, then sent, the manifest last. `now`: its time (and its folder's name).
 */
export async function backup({ dir, sql, r2, now = Date.now(), budget }: { dir: string; sql: SQL; r2: S3Client; now?: number; budget?: number }): Promise<Manifest> {
  const name = nameOf(now);
  const tmp = await mkdtemp(join(tmpdir(), "hypeplay-backup-"));
  try {
    const db = await dumpDb(sql);
    const parts: Partial<Record<(typeof FILES)[number], Uint8Array>> = {};
    // (BIGINT comes as a string already; a bigint, if a client ever gives one, as one too)
    parts["postgres.json"] = new TextEncoder().encode(JSON.stringify({ tables: db }, (_, v) => (typeof v === "bigint" ? String(v) : v)));
    const queue = await copyQueue(join(dir, "queue.db"), tmp);
    if (queue) parts["queue.db"] = queue;
    const { files, skipped } = await volumeFiles(dir, budget);
    const entries: Record<string, Uint8Array> = {};
    // (one gone meanwhile, a game removed, just isn't in it)
    for (const f of files) {
      const b = await readFile(join(dir, f)).catch(() => null);
      if (b) entries[f] = b;
    }
    parts["data.tar.gz"] = await new Bun.Archive(entries, { compress: "gzip" }).bytes();
    const kept = Object.keys(entries);
    const manifest: Manifest = { name, at: now, tables: {}, files: {}, volume: kept.length, games: kept.filter((f) => /^ps2\/[^/]+\/game\.json$/.test(f)).length, skipped };
    for (const [t, rows] of Object.entries(db)) manifest.tables[t] = rows.length;
    for (const f of FILES) {
      const b = parts[f];
      if (!b) continue;
      await r2.write(`${PREFIX}${name}/${f}`, b);
      manifest.files[f] = { size: b.length, sha256: sha256(b) };
    }
    await r2.write(`${PREFIX}${name}/manifest.json`, JSON.stringify(manifest));
    return manifest;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/** The backups in R2, oldest first. */
export async function listBackups(r2: S3Client): Promise<Backup[]> {
  const by = new Map<string, Backup>();
  let token: string | undefined;
  do {
    const page = await r2.list({ prefix: PREFIX, ...(token ? { continuationToken: token } : {}) });
    for (const { key } of page.contents ?? []) {
      const [name = "", file] = key.slice(PREFIX.length).split("/");
      if (!NAME.test(name)) continue;
      const b = by.get(name) ?? { name, done: false, keys: [] };
      b.keys.push(key);
      if (file === "manifest.json") b.done = true;
      by.set(name, b);
    }
    token = page.isTruncated ? page.nextContinuationToken : undefined;
  } while (token);
  return [...by.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** The latest finished backup's name, or null. */
export const latest = async (r2: S3Client) => (await listBackups(r2)).filter((b) => b.done).at(-1)?.name ?? null;

/**
 * The `keep` newest finished backups stay; the older ones go, and the unfinished ones older than the newest (one newer
 * may still be on its way). Each one's manifest first: a backup half removed is never taken for a whole one.
 */
export async function prune(r2: S3Client, keep = KEEP): Promise<string[]> {
  const all = await listBackups(r2);
  const done = all.filter((b) => b.done);
  const newest = done.at(-1)?.name;
  if (!newest) return [];
  const kept = new Set(done.slice(-keep).map((b) => b.name));
  const old = all.filter((b) => !kept.has(b.name) && b.name < newest);
  for (const b of old) {
    const keys = [...b.keys].sort((a, c) => Number(c.endsWith("/manifest.json")) - Number(a.endsWith("/manifest.json")));
    for (const k of keys) await r2.file(k).delete();
  }
  return old.map((b) => b.name);
}

/** How long until the next backup: soon after starting when the latest is a day old (or none), else when it will be. */
export const nextIn = (last: number | null, now: number) => (last === null || now - last >= EVERY_MS ? FIRST_MS : Math.max(FIRST_MS, last + EVERY_MS - now));

export interface BackupsOptions {
  dir: string;
  sql: SQL;
  r2: S3Client;
  telemetry: Telemetry;
  /** Shutting down (ops.ts): no backup starts then. */
  draining: () => boolean;
  now?: () => number;
}

/**
 * The backups on a timer, in the app: never a failure out of here (logged, counted, tried again in an hour). Its
 * metrics: hypeplay.backup.last_ok (when the latest finished one was made, Unix seconds; from R2 at startup) and
 * hypeplay.backup.failures.
 */
export function createBackups({ dir, sql, r2, telemetry, draining, now = () => Date.now() }: BackupsOptions) {
  let lastOk: number | null = null;
  // (R2 not listed at startup: when the latest was is unknown, and last_ok says nothing rather than 0)
  let unknown = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const failures = telemetry.counter("hypeplay.backup.failures", { description: "Backups para o R2 que falharam" });
  telemetry.gauge("hypeplay.backup.last_ok", { description: "Quando foi feito o último backup completo no R2", unit: "s" }, () => {
    if (unknown) throw new Error("unknown");
    return Math.floor((lastOk ?? 0) / 1000);
  });

  const schedule = (ms: number) => {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => void run(), ms);
  };

  /** One backup now (unless shutting down, or there's nothing to keep), then the next one on the timer. */
  async function run(): Promise<Manifest | null> {
    if (stopped || draining()) return null;
    const started = performance.now();
    try {
      const [n, people] = [await games(dir), await dbInUse(sql)];
      if (!n || !people) {
        // (neither a failure nor a backup: last_ok ages, and its alert says so)
        log.warn("backup: skipped, no games or no people here", { games: n, db: people });
        schedule(EVERY_MS);
        return null;
      }
      const m = await backup({ dir, sql, r2, now: now() });
      lastOk = m.at;
      unknown = false;
      const dropped = await prune(r2).catch((err) => (log.warn("backup: the old ones stay", { err }), []));
      const bytes = Object.values(m.files).reduce((n, f) => n + f.size, 0);
      log.info("backup: done", { name: m.name, ms: Math.round(performance.now() - started), bytes, rows: Object.values(m.tables).reduce((a, b) => a + b, 0), volume: m.volume, dropped: dropped.length });
      if (m.skipped.length) log.warn("backup: files too big, left out", { files: m.skipped });
      schedule(EVERY_MS);
      return m;
    } catch (err) {
      failures.add(1);
      log.error("backup failed", { err, retry_min: RETRY_MS / 60_000 });
      schedule(RETRY_MS);
      return null;
    }
  }

  return {
    run,
    /** The first one on its timer, after the latest in R2 (an R2 away at startup: as if there were none). */
    async start() {
      try {
        const name = await latest(r2);
        lastOk = name ? timeOf(name) : null;
      } catch (err) {
        unknown = true;
        log.warn("backup: R2 not listed at startup", { err });
      }
      const ms = nextIn(lastOk, now());
      log.info("backup: scheduled", { last: lastOk ? new Date(lastOk).toISOString() : null, in_min: Math.round(ms / 60_000) });
      schedule(ms);
    },
    /** No more (shutdown): one going on is left to fail, unfinished (its manifest never written). */
    stop() {
      stopped = true;
      clearTimeout(timer);
    },
    get lastOk() {
      return lastOk;
    },
  };
}

export type Backups = ReturnType<typeof createBackups>;

/** What's already in the database: the first table (but `imported`, which any startup fills) with rows, or null. */
async function dbInUse(sql: SQL) {
  for (const t of await tables(sql)) if (t !== "imported" && (await sql`SELECT 1 FROM ${sql(t)} LIMIT 1`).length) return t;
  return null;
}

/** The volume's games: ps2/<id>/game.json. */
async function games(dir: string) {
  return (await readdir(join(dir, "ps2")).catch(() => [] as string[])).filter((id) => existsSync(join(dir, "ps2", id, "game.json"))).length;
}

/** A backup worth restoring by default: with games, and people in the database. */
const hasData = (m: Manifest) => m.games > 0 && Object.entries(m.tables).some(([t, n]) => t !== "imported" && n > 0);

/** What's already in the volume: a game, or a job in the queue; null when empty. */
async function volumeInUse(dir: string) {
  for (const id of await readdir(join(dir, "ps2")).catch(() => [] as string[])) if (existsSync(join(dir, "ps2", id, "game.json"))) return `ps2/${id}`;
  const q = join(dir, "queue.db");
  if (!existsSync(q)) return null;
  const db = new Database(q);
  try {
    return (db.query("SELECT count(*) AS n FROM jobs").get() as { n: number }).n ? "queue.db" : null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** The rows back, a table at a time (the identity columns as they were: profiles' n), then the sequences after them. */
async function insertAll(tx: SQL, db: Record<string, Record<string, unknown>[]>) {
  for (const [table, rows] of Object.entries(db)) {
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]!);
    // (well under Postgres' 65535 parameters a statement)
    const per = Math.max(1, Math.floor(30_000 / cols.length));
    for (let i = 0; i < rows.length; i += per) {
      const params: unknown[] = [];
      const values = rows.slice(i, i + per).map((r) => `(${cols.map((c) => `$${params.push(typeof r[c] === "object" && r[c] !== null ? JSON.stringify(r[c]) : (r[c] ?? null))}`).join(", ")})`);
      await tx.unsafe(`INSERT INTO ${quote(table)} (${cols.map(quote).join(", ")}) OVERRIDING SYSTEM VALUE VALUES ${values.join(", ")} ON CONFLICT DO NOTHING`, params);
    }
  }
  const seqs = await tx`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = current_schema() AND (is_identity = 'YES' OR column_default LIKE 'nextval(%')`;
  for (const { table_name: t, column_name: c } of seqs as { table_name: string; column_name: string }[])
    await tx.unsafe(`SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${quote(c)}) FROM ${quote(t)}), 0) + 1, false)`, [quote(t), c]);
}

/** Whether every key is in R2 (one that can't be asked about counts as there: nothing is undone on a doubt). */
const inR2 = async (r2: S3Client, keys: string[]) => (await Promise.all(keys.map((k) => r2.file(k).exists().catch(() => true)))).every(Boolean);

export interface Restored {
  name: string;
  tables: Record<string, number>;
  volume: number;
  /** "Versão rápida" builds made here, lost with the machine: back in line. */
  requeued: string[];
  /** Games whose disc is neither here nor in R2 (only on the lost disk, or gone from R2 since): to send again. */
  discless: string[];
  /** Newer backups passed over (no games, or no people): restored only by name. */
  passed: string[];
}

/**
 * A backup (`name`, or the latest finished one with games and people) back into the volume and the database, with the
 * app stopped. Refused when either already holds something, unless `force`: then the database's tables are emptied
 * first, and the volume's files written over. What it says is in R2 is checked: a build gone from there goes back in
 * line, a game whose disc is gone loses its mark (the app's sweep then removes it).
 */
export async function restore({ dir, sql, r2, name, force = false }: { dir: string; sql: SQL; r2: S3Client; name?: string; force?: boolean }): Promise<Restored> {
  const all = (await listBackups(r2)).filter((b) => b.done);
  const manifestOf = async (n: string) => (await r2.file(`${PREFIX}${n}/manifest.json`).json()) as Manifest;
  const passed: string[] = [];
  let chosen = name;
  let manifest: Manifest | undefined;
  if (chosen) {
    if (!all.some((b) => b.name === chosen)) throw new Error(`no finished backup ${chosen} in R2 (finished: ${all.map((b) => b.name).join(", ") || "none"})`);
    manifest = await manifestOf(chosen);
  } else {
    if (!all.length) throw new Error("no finished backup in R2");
    for (const b of [...all].reverse()) {
      const m = await manifestOf(b.name);
      if (hasData(m)) [chosen, manifest] = [b.name, m];
      else passed.push(b.name);
      if (chosen) break;
    }
    if (!chosen || !manifest) throw new Error(`no backup with games and people in R2: pick one with --from (finished: ${all.map((b) => b.name).join(", ")})`);
  }
  const at = `${PREFIX}${chosen}/`;
  await migrate(sql);
  if (!force) {
    const used = (await dbInUse(sql)) ?? (await volumeInUse(dir));
    if (used) throw new Error(`not empty (${used}): restore with --force to write over it (as after a restore that stopped halfway)`);
  }
  const parts: Partial<Record<(typeof FILES)[number], Uint8Array>> = {};
  for (const f of FILES) {
    const want = manifest.files[f];
    if (!want) continue;
    const b = await r2.file(`${at}${f}`).bytes();
    if (b.length !== want.size || sha256(b) !== want.sha256) throw new Error(`${at}${f}: not what its manifest says`);
    parts[f] = b;
  }
  const db = (JSON.parse(new TextDecoder().decode(parts["postgres.json"])) as { tables: Record<string, Record<string, unknown>[]> }).tables;
  const here = new Set(await tables(sql));
  const missing = Object.keys(db).filter((t) => !here.has(t));
  if (missing.length) throw new Error(`tables this version doesn't have: ${missing.join(", ")}`);
  await sql.begin(async (tx) => {
    if (force) await tx.unsafe(`TRUNCATE ${Object.keys(db).map(quote).join(", ")}`);
    await insertAll(tx, db);
  });

  await mkdir(dir, { recursive: true });
  const volume = parts["data.tar.gz"] ? await new Bun.Archive(parts["data.tar.gz"]).extract(dir) : 0;
  const requeued: string[] = [];
  if (parts["queue.db"]) {
    const q = join(dir, "queue.db");
    // (a WAL of another file over this one would spoil it)
    for (const end of ["", "-wal", "-shm", "-journal"]) await rm(q + end, { force: true });
    await Bun.write(`${q}.restore`, parts["queue.db"]);
    await rename(`${q}.restore`, q);
    // (a build in R2 removed since the backup, replaced or its game gone: none, so it's built again)
    const raw = new Database(q);
    try {
      for (const { key, build } of raw.query("SELECT key, build FROM jobs WHERE build IS NOT NULL").all() as { key: string; build: string }[]) {
        if (!(await inR2(r2, r2Keys(JSON.parse(build) as R2Build)))) raw.query("UPDATE jobs SET build = NULL WHERE key = ?").run(key);
      }
    } finally {
      raw.close();
    }
    const queue = createQueue(q);
    try {
      for (const j of queue.list()) {
        const id = j.key.startsWith("ps2/") ? j.key.slice(4) : "";
        if (j.state === "done" && !j.build && !existsSync(join(dir, "ps2", id, "fast", "build", "ps2web.html"))) {
          queue.enqueue(j.key, j.kind, { priority: PRIORITY.update });
          requeued.push(j.key);
        }
      }
    } finally {
      queue.close();
    }
  }
  const discless: string[] = [];
  for (const id of await readdir(join(dir, "ps2")).catch(() => [] as string[])) {
    const p = join(dir, "ps2", id);
    if (!existsSync(join(p, "game.json")) || existsSync(join(p, "disc.iso"))) continue;
    // (a mark whose disc left R2 since, "Remover": the mark goes too, or the sweep would keep a game that never opens)
    if (existsSync(join(p, "disc.iso.r2")) && !(await inR2(r2, [`ps2/${id}/disc.iso`]))) await rm(join(p, "disc.iso.r2"), { force: true });
    if (!existsSync(join(p, "disc.iso.r2"))) discless.push(id);
  }
  return { name: chosen, tables: manifest.tables, volume, requeued, discless, passed };
}
