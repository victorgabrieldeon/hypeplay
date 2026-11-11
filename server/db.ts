/**
 * The server's database: Postgres (DATABASE_URL; the compose's postgres service), through Bun's own client. What's
 * kept per person (people.ts) and the friends, hours and status of everyone (social.ts). The saves and the discs stay
 * files in the data folder.
 *
 * Before it, in the data folder: for a few hours a SQLite file (hypeplay.db, these same tables), and before that JSON
 * files (social.json, pads/, keys/, users/, prefs/). Each is imported once and left where it is: hypeplay.db by
 * `importOld`, at the start, the JSON files the first time their module starts (people.ts, social.ts). `imported`
 * says what's done, so a deleted key never comes back from its old file.
 */
import { Database } from "bun:sqlite";
import type { SQL } from "bun";
import { existsSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS imported (source TEXT PRIMARY KEY, at BIGINT NOT NULL);

CREATE TABLE IF NOT EXISTS pads (person TEXT PRIMARY KEY, maps TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS keys (person TEXT PRIMARY KEY, map TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS last_played (person TEXT PRIMARY KEY, key TEXT NOT NULL, at BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS prefs (person TEXT PRIMARY KEY, volume DOUBLE PRECISION NOT NULL, filter TEXT NOT NULL);

-- n: the order they came in (search's results)
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY, n BIGINT GENERATED ALWAYS AS IDENTITY, name TEXT NOT NULL, since BIGINT NOT NULL,
  seen BIGINT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL
);
-- friends, incoming (a request they got), outgoing (one they sent); pos: the order they came in
CREATE TABLE IF NOT EXISTS links (
  person TEXT NOT NULL, other TEXT NOT NULL, kind TEXT NOT NULL, pos INTEGER NOT NULL,
  PRIMARY KEY (person, kind, other)
);
CREATE TABLE IF NOT EXISTS played (
  person TEXT NOT NULL, key TEXT NOT NULL, pos INTEGER NOT NULL, title TEXT NOT NULL, ms BIGINT NOT NULL,
  sessions INTEGER NOT NULL, last BIGINT NOT NULL, PRIMARY KEY (person, key)
);
-- pos 0: the newest
CREATE TABLE IF NOT EXISTS recent (
  person TEXT NOT NULL, pos INTEGER NOT NULL, key TEXT NOT NULL, title TEXT NOT NULL, start BIGINT NOT NULL,
  "end" BIGINT NOT NULL, PRIMARY KEY (person, pos)
);
CREATE TABLE IF NOT EXISTS played_with (person TEXT NOT NULL, other TEXT NOT NULL, at BIGINT NOT NULL, PRIMARY KEY (person, other));
`;

/** The tables, made when missing. Once, before anything uses them (two at once can clash in Postgres). */
export async function migrate(sql: SQL) {
  await sql.unsafe(SCHEMA);
}

/** Runs `load` once ever per `source` (an old file to import), in one transaction with its mark. */
export async function importOnce(sql: SQL, source: string, load: (tx: SQL) => Promise<void>) {
  await sql.begin(async (tx) => {
    const marked = await tx`INSERT INTO imported (source, at) VALUES (${source}, ${Date.now()}) ON CONFLICT (source) DO NOTHING RETURNING source`;
    if (marked.length) await load(tx);
  });
}

/** hypeplay.db's tables, in the order they go (a row's columns as they were there: `user` is `person` here). */
const OLD_TABLES: [table: string, order: string][] = [
  ["imported", "source"],
  ["pads", "user"],
  ["keys", "user"],
  ["last_played", "user"],
  ["prefs", "user"],
  ["profiles", "rowid"],
  ["links", "user, kind, pos"],
  ["played", "user, rowid"],
  ["recent", "user, pos"],
  ["played_with", "user, other"],
];

/**
 * The SQLite file the server kept for a few hours (<dir>/hypeplay.db), once, whole, in one transaction: what's there
 * is newer than the JSON files, and its `imported` comes along, so those aren't imported again over it. Without the
 * file, nothing (and nothing is marked: it may still come, restored from a backup).
 */
export async function importOld(sql: SQL, dir: string) {
  const file = join(dir, "hypeplay.db");
  if (!existsSync(file)) return;
  // (read only: the file and its -wal stay as they are, the -wal not folded into it)
  const old = new Database(file, { readonly: true });
  try {
    const tables = new Set((old.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name));
    await importOnce(sql, "hypeplay.db", async (tx) => {
      for (const [table, order] of OLD_TABLES) {
        if (!tables.has(table)) continue;
        let rows = old.query(`SELECT * FROM ${table} ORDER BY ${order}`).all() as Record<string, unknown>[];
        rows = rows.map(({ user, ...r }) => (user === undefined ? r : { person: user, ...r }));
        // (played had no order of its own: the one it came in)
        if (table === "played") {
          const pos = new Map<unknown, number>();
          rows = rows.map((r) => ({ ...r, pos: pos.set(r.person, (pos.get(r.person) ?? -1) + 1).get(r.person) }));
        }
        for (let i = 0; i < rows.length; i += 1000) await tx`INSERT INTO ${tx(table)} ${tx(rows.slice(i, i + 1000))} ON CONFLICT DO NOTHING`;
      }
    });
  } finally {
    old.close();
  }
}
