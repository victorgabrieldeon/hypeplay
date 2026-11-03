import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { relative } from "node:path";
import { S3Client } from "bun";

/**
 * The PS2 library's discs in R2. A game sent (or downloaded from vimm) is checked on this disk, then moved to R2: its
 * disc.iso goes, disc.iso.r2 (its size) stays as the sign it's there, under the same key as its path in the data folder
 * (ps2/<id>/disc.iso). The games already on this disk stay here. Without S3_BUCKET, nothing moves.
 */

/** A disc image to play: its size, its bytes and where they come from. */
export interface Disc {
  size: number;
  file: Blob;
  from: "r2" | "local";
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

/** Where a disc is read from: the local file when it's here, R2 when its mark says so. */
export function createDiscs(dir: string, client: S3Client | null = null): Discs {
  return async (path) => {
    const f = Bun.file(path);
    if (await f.exists()) return { size: f.size, file: f, from: "local" };
    const size = client && (await markedSize(path));
    return size ? { size, file: client.file(relative(dir, path)), from: "r2" } : null;
  };
}

/**
 * The local disc to R2, then its mark, then the local file goes: never a moment without one or the other. `alive`:
 * whether its game is still there once sent (it may have been removed meanwhile; then R2's copy goes too).
 */
export async function moveToR2(client: S3Client, dir: string, iso: string, alive: () => Promise<boolean>): Promise<boolean> {
  const key = relative(dir, iso);
  const size = Bun.file(iso).size;
  // (in parts: one PUT stops at 5 GiB, a DVD-9 is more)
  const w = client.file(key).writer({ partSize: 64 * 1024 ** 2, queueSize: 4, retry: 3 });
  for await (const chunk of Bun.file(iso).stream()) await w.write(chunk);
  await w.end();
  const sent = (await client.file(key).stat()).size;
  if (sent !== size) throw new Error(`R2 ${key}: ${sent} bytes of ${size}`);
  if (!(await alive())) {
    await client.file(key).delete();
    return false;
  }
  await writeFile(`${markOf(iso)}.tmp`, String(size));
  await rename(`${markOf(iso)}.tmp`, markOf(iso));
  await rm(iso, { force: true });
  return true;
}

/** R2's copy of a disc, when its mark says there is one (a game removed). */
export async function dropFromR2(client: S3Client | null, dir: string, iso: string) {
  if (client && (await markedSize(iso))) await client.file(relative(dir, iso)).delete();
}

/** A disc in R2 back on this disk at `to` (ps2-builder needs the file), through a temporary name. */
export async function fetchFromR2(client: S3Client, dir: string, iso: string, to: string) {
  await Bun.write(`${to}.part`, client.file(relative(dir, iso)));
  await rename(`${to}.part`, to);
}
