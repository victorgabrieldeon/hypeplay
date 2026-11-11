/**
 * The server's database: <dir>/hypeplay.db (SQLite, WAL), what's kept per person (people.ts) and the friends, hours
 * and status of everyone (social.ts). One connection per folder, shared by both. The saves and the discs stay files.
 *
 * Before it there were JSON files (social.json, pads/, keys/, users/, prefs/): each is imported once, the first time
 * its module opens the database, and left where it is (`imported` says it's done, so a deleted key never comes back
 * from its old file).
 */
import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
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

const open = new Map<string, Database>();

export function openDb(dir: string): Database {
  const file = join(dir, "hypeplay.db");
  let db = open.get(file);
  if (db) return db;
  mkdirSync(dir, { recursive: true });
  db = new Database(file, { create: true, strict: true });
  db.run("PRAGMA journal_mode = WAL");
  // (WAL: a commit without fsync can only be lost with the machine, never corrupt the file)
  db.run("PRAGMA synchronous = NORMAL");
  db.run("PRAGMA busy_timeout = 5000");
  db.run(SCHEMA);
  open.set(file, db);
  return db;
}

/** Runs `load` once ever per `source` (an old file to import), in one transaction with its mark. */
export function importOnce(db: Database, source: string, load: () => void) {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM imported WHERE source = ?").get(source)) return;
    load();
    db.query("INSERT INTO imported (source, at) VALUES (?, ?)").run(source, Date.now());
  })();
}
