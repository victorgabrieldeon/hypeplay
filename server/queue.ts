/**
 * The builds' queue: which game builds next and which worker has it, in its own SQLite file (<DATA_DIR>/queue.db, WAL).
 * The app enqueues (library.ts: "Compilar versão rápida", "Tentar de novo", code the players met), the workers claim
 * (ps2-builder/): those on this machine open the file, those elsewhere ask the app (workers.ts), which asks it.
 *
 * One row per game (its key, "ps2/<id>"; its kind says which workers build it), so asking twice never builds twice:
 *
 *   queued   waiting, best priority first, then oldest; `run_after` holds a retry back a little
 *   running  one worker's, by its `token`, for as long as it keeps renewing its lease (beat); a lease gone quiet
 *            (the worker died, a deploy) puts the job back in line, `attempts` times at most, then it fails
 *   done     built, or nothing to build; `status` says how it went (the page reads it), `shell`/`recomp` what with
 *   failed   a build that failed: it waits for "Tentar de novo" (it would fail the same way again)
 *
 * A claim is one write transaction (BEGIN IMMEDIATE): of any number of workers, in any number of processes, only one
 * gets a job. Everything a worker says afterwards carries its token: a worker that lost its job (another took it over,
 * or the game was removed) is told so, and publishes nothing.
 */
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";

/** A lease the worker didn't renew for this long is gone (the same quiet as an upload's, upload.ts). */
export const LEASE_MS = 2 * 60_000;
/** Claims of a job at most before it fails (a worker dying on it each time, or errors that weren't the build's). */
export const ATTEMPTS = 3;
/** A worker seen this recently is up: the page says "offline" without one. */
export const SEEN_MS = 2 * 60_000;

/** The order the jobs go in: a player stopped on missing code first, then what someone asked, then new images. */
export const PRIORITY = { miss: 30, ask: 20, update: 10 } as const;

export type JobState = "queued" | "running" | "done" | "failed";

/** A build published in R2 rather than here (by a worker elsewhere): its prefix and its files. */
export interface R2Build {
  prefix: string;
  files: string[];
}

export interface Job {
  key: string;
  kind: string;
  state: JobState;
  priority: number;
  queuedAt: number;
  attempts: number;
  /** "Tentar de novo": redo the code too. */
  retry: boolean;
  worker: string | null;
  leaseUntil: number | null;
  /** The worker's own report of the build (ps2-builder's FastStatus), as the page reads it. */
  status: Record<string, unknown> | null;
  build: R2Build | null;
  shell: string | null;
  recomp: string | null;
}

/** A job claimed: `token` goes with everything its worker says about it. */
export interface Claimed extends Job {
  token: string;
}

interface Row {
  key: string;
  kind: string;
  state: JobState;
  priority: number;
  queued_at: number;
  run_after: number;
  attempts: number;
  retry: number;
  again: number;
  worker: string | null;
  token: string | null;
  lease_until: number | null;
  status: string | null;
  build: string | null;
  shell: string | null;
  recomp: string | null;
}

const parse = <T>(text: string | null): T | null => {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
};

const job = (r: Row): Job => ({
  key: r.key,
  kind: r.kind,
  state: r.state,
  priority: r.priority,
  queuedAt: r.queued_at,
  attempts: r.attempts,
  retry: !!r.retry,
  worker: r.worker,
  leaseUntil: r.lease_until,
  status: parse(r.status),
  build: parse(r.build),
  shell: r.shell,
  recomp: r.recomp,
});

/** The image a worker builds with: a ready build made with another is brought up to date (ps2-builder). */
export interface Image {
  shell: string;
  recomp: string;
}

export interface EnqueueOptions {
  priority?: number;
  /** "Tentar de novo" */
  retry?: boolean;
  /** A job running: run it once more after (code met meanwhile). Off: it's already being taken care of. */
  rerun?: boolean;
  /** A failed job back in line. Off: it waits for "Tentar de novo" (the code the players met is kept for then). */
  revive?: boolean;
}

export interface QueueOptions {
  now?: () => number;
  lease?: number;
  attempts?: number;
  /** A failed attempt (not the build's own failure) waits this long times 2^attempts before the next. */
  backoff?: number;
}

export function createQueue(path: string, { now = () => Date.now(), lease = LEASE_MS, attempts: max = ATTEMPTS, backoff = 30_000 }: QueueOptions = {}) {
  const db = new Database(path, { create: true });
  // (several processes on the same file: readers never wait for the writer, and a writer waits its turn)
  db.exec("PRAGMA busy_timeout = 10000");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      queued_at INTEGER NOT NULL,
      run_after INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      retry INTEGER NOT NULL DEFAULT 0,
      again INTEGER NOT NULL DEFAULT 0,
      worker TEXT,
      token TEXT,
      lease_until INTEGER,
      status TEXT,
      build TEXT,
      shell TEXT,
      recomp TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS jobs_next ON jobs (state, kind, priority DESC, queued_at);
    CREATE TABLE IF NOT EXISTS workers (id TEXT PRIMARY KEY, kinds TEXT NOT NULL, seen_at INTEGER NOT NULL);
  `);

  const one = db.query<Row, [string]>("SELECT * FROM jobs WHERE key = ?");
  const mine = db.query<Row, [string, string]>("SELECT * FROM jobs WHERE key = ? AND token = ? AND state = 'running'");
  const seenQ = db.query("INSERT INTO workers (id, kinds, seen_at) VALUES (?, ?, ?) ON CONFLICT (id) DO UPDATE SET kinds = excluded.kinds, seen_at = excluded.seen_at");

  function seen(worker: string, kinds: string[]) {
    seenQ.run(worker, `,${kinds.join(",")},`, now());
  }

  function enqueue(key: string, kind: string, { priority = PRIORITY.ask, retry = false, rerun = true, revive = true }: EnqueueOptions = {}): Job {
    return db
      .transaction(() => {
        const t = now();
        const r = one.get(key);
        if (!r) {
          db.query("INSERT INTO jobs (key, kind, state, priority, queued_at, retry, updated_at) VALUES (?, ?, 'queued', ?, ?, ?, ?)").run(key, kind, priority, t, retry ? 1 : 0, t);
        } else if (r.state === "running") {
          db.query("UPDATE jobs SET again = MAX(again, ?), retry = MAX(retry, ?), priority = MAX(priority, ?), updated_at = ? WHERE key = ?").run(rerun ? 1 : 0, retry ? 1 : 0, priority, t, key);
        } else if (r.state === "queued") {
          // (asked again while waiting: keeps its place, at the better of the two priorities, and now, not after a pause)
          db.query("UPDATE jobs SET retry = MAX(retry, ?), priority = MAX(priority, ?), run_after = CASE WHEN ? THEN 0 ELSE run_after END, updated_at = ? WHERE key = ?").run(retry ? 1 : 0, priority, retry ? 1 : 0, t, key);
        } else if (r.state === "done" || revive || retry) {
          db.query("UPDATE jobs SET state = 'queued', priority = ?, queued_at = ?, run_after = 0, attempts = 0, retry = ?, again = 0, updated_at = ? WHERE key = ?").run(priority, t, retry ? 1 : 0, t, key);
        }
        return job(one.get(key)!);
      })
      .immediate();
  }

  /** A job as it was in the volume before the queue (library.ts' import): only when the queue doesn't know it yet. */
  function adopt(key: string, kind: string, state: JobState, { priority = PRIORITY.ask, retry = false, status = null as object | null, shell = null as string | null, recomp = null as string | null } = {}) {
    const t = now();
    return (
      db
        .query("INSERT OR IGNORE INTO jobs (key, kind, state, priority, queued_at, retry, status, shell, recomp, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(key, kind, state, priority, t, retry ? 1 : 0, status ? JSON.stringify(status) : null, shell, recomp, t).changes > 0
    );
  }

  /**
   * The next job for this worker, or null. With `image`, when nothing waits, a ready build of `update` made with another
   * image is brought up to date (last in line, so asking always comes first).
   */
  function claim(worker: string, { kinds, image, update = "ps2" }: { kinds: string[]; image?: Image; update?: string }): Claimed | null {
    if (!kinds.length) return null;
    return db
      .transaction(() => {
        const t = now();
        seen(worker, kinds);
        // leases gone quiet: back in line, or failed after too many
        const stopped = { state: "failed", message: `O compilador parou no meio da compilação ${max} vezes` };
        db.query("UPDATE jobs SET state = 'failed', token = NULL, worker = NULL, lease_until = NULL, again = 0, status = ?, updated_at = ? WHERE state = 'running' AND lease_until < ? AND attempts >= ?").run(
          JSON.stringify(stopped),
          t,
          t,
          max,
        );
        db.query("UPDATE jobs SET state = 'queued', token = NULL, worker = NULL, lease_until = NULL, updated_at = ? WHERE state = 'running' AND lease_until < ?").run(t, t);
        const marks = kinds.map(() => "?").join(", ");
        let r = db
          .query<Row, (string | number)[]>(`SELECT * FROM jobs WHERE state = 'queued' AND run_after <= ? AND kind IN (${marks}) ORDER BY priority DESC, queued_at, key LIMIT 1`)
          .get(t, ...kinds);
        let fresh = false;
        if (!r && image?.shell && kinds.includes(update)) {
          r = db
            .query<Row, [string, string, string]>(
              "SELECT * FROM jobs WHERE state = 'done' AND kind = ? AND json_extract(status, '$.state') = 'ready' AND (shell IS NOT ? OR recomp IS NOT ?) ORDER BY queued_at, key LIMIT 1",
            )
            .get(update, image.shell, image.recomp);
          fresh = !!r;
        }
        if (!r) return null;
        const token = randomBytes(16).toString("hex");
        db.query(
          "UPDATE jobs SET state = 'running', worker = ?, token = ?, lease_until = ?, attempts = CASE WHEN ? THEN 1 ELSE attempts + 1 END, priority = CASE WHEN ? THEN ? ELSE priority END, again = 0, updated_at = ? WHERE key = ?",
        ).run(worker, token, t + lease, fresh ? 1 : 0, fresh ? 1 : 0, PRIORITY.update, t, r.key);
        return { ...job(one.get(r.key)!), token };
      })
      .immediate();
  }

  /** The job's still this worker's: its lease renewed, its report kept. False when it isn't any more. */
  function beat(key: string, token: string, status?: object, worker?: string): boolean {
    const t = now();
    const ok =
      db
        .query("UPDATE jobs SET lease_until = ?, status = COALESCE(?, status), updated_at = ? WHERE key = ? AND token = ? AND state = 'running'")
        .run(t + lease, status ? JSON.stringify(status) : null, t, key, token).changes > 0;
    if (ok && worker) db.query("UPDATE workers SET seen_at = ? WHERE id = ?").run(t, worker);
    return ok;
  }

  /**
   * Built (or nothing to build). `build`: where it was published, R2's, or null for here; left out, it stays as it was.
   * Returns the job as it was, for what it replaces (R2's old build), or null when it wasn't this worker's any more.
   */
  function done(key: string, token: string, { status, shell, recomp, build }: { status?: object; shell?: string; recomp?: string; build?: R2Build | null } = {}): Job | null {
    return db
      .transaction(() => {
        const r = mine.get(key, token);
        if (!r) return null;
        const t = now();
        // (asked again while it built: back in line, where it was)
        db.query(
          `UPDATE jobs SET state = CASE WHEN again THEN 'queued' ELSE 'done' END, token = NULL, worker = NULL, lease_until = NULL, attempts = 0, retry = 0,
             again = 0, run_after = 0, status = COALESCE(?, status), shell = COALESCE(?, shell), recomp = COALESCE(?, recomp), build = ?, updated_at = ? WHERE key = ?`,
        ).run(status ? JSON.stringify(status) : null, shell ?? null, recomp ?? null, build === undefined ? r.build : build ? JSON.stringify(build) : null, t, key);
        return job(r);
      })
      .immediate();
  }

  /**
   * It failed. `final`: the build's own failure (waits for "Tentar de novo"); otherwise (R2 down, the disk) it goes back
   * in line after a pause, until its attempts run out. False when it wasn't this worker's any more.
   */
  function fail(key: string, token: string, { status, final = true }: { status?: object; final?: boolean } = {}): boolean {
    return db
      .transaction(() => {
        const r = mine.get(key, token);
        if (!r) return false;
        const t = now();
        const last = final || r.attempts >= max;
        db.query(
          "UPDATE jobs SET state = ?, token = NULL, worker = NULL, lease_until = NULL, again = 0, retry = CASE WHEN ? THEN 0 ELSE retry END, run_after = ?, status = COALESCE(?, status), updated_at = ? WHERE key = ?",
        ).run(last ? "failed" : "queued", last ? 1 : 0, last ? 0 : t + backoff * 2 ** (r.attempts - 1), status ? JSON.stringify(status) : null, t, key);
        return true;
      })
      .immediate();
  }

  /** The job goes (its game, or its fast version, removed): a worker on it is told so on its next beat. */
  function drop(key: string): Job | null {
    return db
      .transaction(() => {
        const r = one.get(key);
        if (r) db.query("DELETE FROM jobs WHERE key = ?").run(key);
        return r ? job(r) : null;
      })
      .immediate();
  }

  return {
    enqueue,
    adopt,
    claim,
    beat,
    done,
    fail,
    drop,
    seen,
    get: (key: string): Job | null => {
      const r = one.get(key);
      return r ? job(r) : null;
    },
    /** The job this token claimed, while it's still that worker's. */
    mine: (key: string, token: string): Job | null => {
      const r = mine.get(key, token);
      return r ? job(r) : null;
    },
    /** Whether a worker for `kind` was seen lately (else the page says "offline"). */
    online: (kind: string, within = SEEN_MS) =>
      !!db.query("SELECT 1 FROM workers WHERE seen_at >= ? AND instr(kinds, ?) > 0 LIMIT 1").get(now() - within, `,${kind},`),
    list: (): Job[] => db.query<Row, []>("SELECT * FROM jobs ORDER BY state, priority DESC, queued_at").all().map(job),
    close: () => db.close(),
  };
}

export type Queue = ReturnType<typeof createQueue>;
