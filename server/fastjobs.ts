/**
 * The PS2 "versão rápida"'s jobs on the side that holds the volume: what a worker needs to know about the game it
 * claimed, and where its build goes. Used by ps2-builder on this machine (straight) and by workers.ts for the workers
 * elsewhere (the same calls, over HTTP). The queue (queue.ts) says who builds what; the game's folder keeps the rest:
 *
 *   ps2/<id>/fast/request      asked (library.ts): without it the job is dropped
 *   ps2/<id>/fast/misses.txt   code the players met untranslated
 *   ps2/<id>/fast/build.log    the worker's output
 *   ps2/<id>/fast/build/       the build, swapped in whole; or, made elsewhere, in R2 under the job's `build` prefix
 */
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { S3Client } from "bun";
import { markedSize } from "./discs";
import type { Claimed, Image, Queue, R2Build } from "./queue";

/** A library game's id (library.ts' ID). */
const ID = /^[a-z]{4}-\d{5}(?:-\d{1,2})?$/;
/** The log a worker elsewhere sends with each beat: its last part, kept as build.log. */
export const LOG_MAX = 256 * 1024;
/** The page's files a build publishes (the server serves these and their .gz). */
export const PUBLISHED = ["ps2web.html", "ps2web.js", "ps2web.wasm", "ps2web.data"];

/** What a worker is told with a job. */
export interface FastGame {
  id: string;
  /** "Tentar de novo": the code is redone too. */
  retry: boolean;
  /** misses.txt as it is. */
  misses: string;
  /** A build is there (here or in R2), and what it was built with. */
  built: boolean;
  shell?: string;
  recomp?: string;
  /** Where its disc is: this machine's disk or R2 (discs.ts). */
  disc: "local" | "r2";
}

export interface FastClaim {
  job: Pick<Claimed, "key" | "token" | "attempts">;
  game: FastGame;
}

const exists = (path: string) => stat(path).then(() => true, () => false);

export const fastKey = (id: string) => `ps2/${id}`;
export const idOf = (key: string) => {
  const id = key.startsWith("ps2/") ? key.slice(4) : "";
  return ID.test(id) ? id : null;
};

export function fastPaths(dir: string, id: string) {
  if (!ID.test(id)) throw new Error(`not a game id: ${id}`);
  const root = join(dir, "ps2", id);
  const fast = join(root, "fast");
  return {
    json: join(root, "game.json"),
    iso: join(root, "disc.iso"),
    fast,
    request: join(fast, "request"),
    misses: join(fast, "misses.txt"),
    log: join(fast, "build.log"),
    build: join(fast, "build"),
    tmp: join(fast, "build.tmp"),
    old: join(fast, "build.old"),
  };
}

/** A build in R2 a worker says it made: under its game's fast/, only the page's files. */
export function validR2Build(id: string, b: unknown): b is R2Build {
  const r = b as R2Build | null;
  const allowed = new Set(PUBLISHED.flatMap((f) => [f, `${f}.gz`]));
  return (
    !!r &&
    typeof r.prefix === "string" &&
    new RegExp(`^ps2/${id}/fast/[0-9a-z-]{1,40}$`).test(r.prefix) &&
    Array.isArray(r.files) &&
    PUBLISHED.every((f) => r.files.includes(f)) &&
    r.files.every((f) => typeof f === "string" && allowed.has(f))
  );
}

/** R2's keys of a build there (each file and its .gz). */
export const r2Keys = (b: R2Build) => b.files.map((f) => `${b.prefix}/${f}`);

/** A build in R2 goes (replaced, or its game removed). */
export async function dropR2Build(r2: S3Client | null, b: R2Build | null | undefined) {
  if (!r2 || !b) return;
  await Promise.all(r2Keys(b).map((k) => r2.file(k).delete().catch((err) => console.error(`R2: ${k} stays there:`, err))));
}

/** Whether the game is still asked for: its game.json and its request. */
const alive = async (dir: string, id: string) => {
  const p = fastPaths(dir, id);
  return (await exists(p.json)) && (await exists(p.request));
};

/**
 * The next PS2 job for this worker, with what it needs to know. A job whose game went (or lost its disc) is dropped on
 * the way: never handed out. A disc only on this disk still builds elsewhere: workers.ts sends it.
 */
export async function claimFast(dir: string, queue: Queue, worker: string, image?: Image): Promise<FastClaim | null> {
  for (;;) {
    const c = queue.claim(worker, { kinds: ["ps2"], image });
    if (!c) return null;
    const id = idOf(c.key);
    if (!id || !(await alive(dir, id))) {
      queue.drop(c.key);
      continue;
    }
    const p = fastPaths(dir, id);
    const disc = (await exists(p.iso)) ? "local" : (await markedSize(p.iso)) ? "r2" : null;
    if (!disc) {
      queue.fail(c.key, c.token, { status: { state: "failed", message: "O jogo não tem a ISO no servidor" } });
      continue;
    }
    const built = (await exists(join(p.build, "ps2web.html"))) || !!c.build;
    return {
      job: { key: c.key, token: c.token, attempts: c.attempts },
      game: {
        id,
        retry: c.retry,
        misses: await readFile(p.misses, "utf8").catch(() => ""),
        built,
        // (what the build there was made with: only a build done sets these, a failure since keeps them)
        ...(built && c.shell !== null ? { shell: c.shell } : {}),
        ...(built && c.recomp !== null ? { recomp: c.recomp } : {}),
        disc,
      },
    };
  }
}

/** The worker's output so far, for reading on the server (a failed write only loses lines). */
export async function writeFastLog(dir: string, id: string, text: string) {
  const p = fastPaths(dir, id);
  if (await exists(p.fast)) await writeFile(p.log, text).catch(() => undefined);
}

/**
 * A build made here: the page's files from `web` into build.tmp/, swapped in as build/, then the job done. A build in R2
 * before it goes. False when the job isn't this worker's any more, or the game went: nothing published.
 */
export async function finishLocal(dir: string, queue: Queue, r2: S3Client | null, key: string, token: string, web: string, report: { status: object; shell?: string; recomp?: string }) {
  const id = idOf(key)!;
  const p = fastPaths(dir, id);
  const gone = async () => !queue.mine(key, token) || !(await alive(dir, id));
  if (await gone()) return false;
  await rm(p.tmp, { recursive: true, force: true });
  await mkdir(p.tmp, { recursive: true });
  try {
    for (const f of PUBLISHED) {
      await cp(join(web, f), join(p.tmp, f));
      if (await exists(join(web, `${f}.gz`))) await cp(join(web, `${f}.gz`), join(p.tmp, `${f}.gz`));
    }
    if (await gone()) return false;
    await rm(p.old, { recursive: true, force: true });
    if (await exists(p.build)) await rename(p.build, p.old);
    await rename(p.tmp, p.build);
    await rm(p.old, { recursive: true, force: true });
  } finally {
    await rm(p.tmp, { recursive: true, force: true });
  }
  const before = queue.done(key, token, { ...report, build: null });
  if (!before) return false;
  await dropR2Build(r2, before.build);
  return true;
}

/**
 * A build a worker elsewhere put in R2 (workers.ts): the job done, pointing there; the one before (here or in R2) goes.
 * False when the job wasn't that worker's any more (the caller removes what it sent).
 */
export async function finishR2(dir: string, queue: Queue, r2: S3Client | null, key: string, token: string, build: R2Build, report: { status: object; shell?: string; recomp?: string }) {
  const id = idOf(key)!;
  if (!(await alive(dir, id))) {
    queue.drop(key);
    return false;
  }
  const before = queue.done(key, token, { ...report, build });
  if (!before) return false;
  await rm(fastPaths(dir, id).build, { recursive: true, force: true });
  if (before.build?.prefix !== build.prefix) await dropR2Build(r2, before.build);
  return true;
}
