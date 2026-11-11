import { readFile, rename, rm, statfs, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { S3Client } from "bun";
import type { ChunkCache } from "./chunkcache";

/**
 * The PS2 library's discs in R2. A game sent (or downloaded from vimm) is checked on this disk, then moved to R2: its
 * disc.iso goes, disc.iso.r2 (its size) stays as the sign it's there, under the same key as its path in the data folder
 * (ps2/<id>/disc.iso). A disc still on this disk after a while (its move cut short) is sent again by the library's
 * sweep (library.ts). Without S3_BUCKET, nothing moves.
 */

/** A disc image to play: its size, its bytes and where they come from. */
export interface Disc {
  size: number;
  file: Blob;
  from: "r2" | "local";
  /** Changes when the disc does (a new file, or sent to R2 again under the same name): its size and time. */
  version: string;
  /**
   * Bytes [start, end): a slice of the local file; from R2, streamed (as it is, an R2 file would answer with a redirect
   * to R2, which Discord's proxy and the isolation headers don't allow) and through the memory cache when there's one.
   */
  read(start: number, end: number): Blob | ReadableStream<Uint8Array>;
}
export type Discs = (path: string) => Promise<Disc | null>;

/** The sign a disc is in R2: next to where its disc.iso was, holding its size. */
export const markOf = (iso: string) => `${iso}.r2`;

/** R2's client from S3_* (Bun's names), or null without S3_BUCKET. */
export function r2FromEnv(env = process.env): S3Client | null {
  if (!env.S3_BUCKET) return null;
  const { S3_BUCKET: bucket, S3_ENDPOINT: endpoint, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("S3_BUCKET without S3_ENDPOINT, S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY");
  return new S3Client({ bucket, endpoint, accessKeyId, secretAccessKey });
}

/** The size its mark holds, or null when the disc isn't in R2. */
export async function markedSize(iso: string): Promise<number | null> {
  const size = Number(await readFile(markOf(iso), "utf8").catch(() => ""));
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

/**
 * Where a disc is read from: R2 when its mark says so, else the local file when it's here. `cache`: R2's pieces kept in
 * memory (chunkcache.ts), by key, size and the mark's time, so a disc sent again under the same name is a new one.
 */
export function createDiscs(dir: string, client: S3Client | null = null, cache: ChunkCache | null = null): Discs {
  return async (path) => {
    // (the mark first: a copy here of a disc in R2 is a leftover, about to go)
    const size = client && (await markedSize(path));
    if (!size) {
      const f = Bun.file(path);
      return (await f.exists()) ? { size: f.size, file: f, from: "local", version: `${f.size}:${f.lastModified}`, read: (start, end) => f.slice(start, end) } : null;
    }
    const key = relative(dir, path);
    const file = client.file(key);
    const load = async (start: number, end: number) => new Uint8Array(await file.slice(start, end).arrayBuffer());
    const version = `${size}:${Bun.file(markOf(path)).lastModified}`;
    return {
      size,
      file,
      from: "r2",
      version,
      read: (start, end) => (cache ? cache.read(`${key}:${version}`, size, start, end, load) : file.slice(start, end).stream()),
    };
  };
}

/**
 * Bytes to R2 under `key`, in parts (one PUT stops at 5 GiB, a DVD-9 is more). Bun's writer never waits in write(): it
 * would take a whole disc into memory faster than the VPS sends it. A flush every two parts holds it to a few.
 */
export async function sendToR2(client: S3Client, key: string, from: AsyncIterable<Uint8Array>, partSize = 64 * 1024 ** 2) {
  const w = client.file(key).writer({ partSize, queueSize: 4, retry: 3 });
  let held = 0;
  for await (const chunk of from) {
    w.write(chunk);
    held += chunk.length;
    if (held >= 2 * partSize) {
      await w.flush();
      held = 0;
    }
  }
  await w.end();
}

/**
 * The local disc to R2, then its mark, then the local file goes: never a moment without one or the other. `alive`:
 * whether its game is still there once sent (it may have been removed meanwhile; then R2's copy goes too).
 */
export async function moveToR2(
  client: S3Client,
  dir: string,
  iso: string,
  alive: () => Promise<boolean>,
  /** (a build reading the copy here: it stays until the sweep's next look) */
  keep: () => boolean = () => false,
): Promise<boolean> {
  const key = relative(dir, iso);
  const size = Bun.file(iso).size;
  await sendToR2(client, key, Bun.file(iso).stream());
  const sent = (await client.file(key).stat()).size;
  if (sent !== size) throw new Error(`R2 ${key}: ${sent} bytes of ${size}`);
  if (!(await alive())) {
    await client.file(key).delete();
    return false;
  }
  await writeFile(`${markOf(iso)}.tmp`, String(size));
  await rename(`${markOf(iso)}.tmp`, markOf(iso));
  if (!keep()) await rm(iso, { force: true });
  return true;
}

/** R2's copy of a disc, when its mark says there is one (a game removed). */
export async function dropFromR2(client: S3Client | null, dir: string, iso: string) {
  if (client && (await markedSize(iso))) await client.file(relative(dir, iso)).delete();
}

/** A disc in R2 back on a disk at `to` (ps2-builder needs the file), through a temporary name. */
export async function fetchFromR2(client: S3Client, dir: string, iso: string, to: string) {
  await Bun.write(`${to}.part`, client.file(relative(dir, iso)));
  await rename(`${to}.part`, to);
}

/**
 * Whether `bytes` more fit on a disk (statfs' numbers), keeping max(2 GB, 5% of it) free: the database and the builds'
 * queue live on it too.
 */
export const fits = (disk: { bavail: number; bsize: number; blocks: number }, bytes: number) =>
  disk.bavail * disk.bsize - bytes >= Math.max(2 * 1024 ** 3, 0.05 * disk.blocks * disk.bsize);

/** Whether `bytes` more fit on `dir`'s disk (fits). */
export const hasRoom = async (dir: string, bytes: number) => fits(await statfs(dir), bytes);

/** A disc that doesn't fit, for the page (an upload's 507, vimm's failure, a build's). */
export const NO_ROOM = "O servidor está sem espaço em disco para esse jogo agora. Tente mais tarde ou avise quem cuida do servidor.";
