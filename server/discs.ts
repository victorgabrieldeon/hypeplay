import { relative } from "node:path";
import { S3Client } from "bun";

/** A disc image to play: its size, its bytes and where they come from. */
export interface Disc {
  size: number;
  file: Blob;
  from: "r2" | "local";
}
export type Discs = (path: string) => Promise<Disc | null>;

/** R2's client from S3_*, given explicitly: a client left to find them itself didn't, and every disc went local unseen. */
function fromEnv(env = process.env): S3Client | null {
  if (!env.S3_BUCKET) return null;
  const { S3_BUCKET: bucket, S3_ENDPOINT: endpoint, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
  if (!endpoint || !accessKeyId || !secretAccessKey) throw new Error("S3_BUCKET without S3_ENDPOINT, S3_ACCESS_KEY_ID or S3_SECRET_ACCESS_KEY");
  return new S3Client({ bucket, endpoint, accessKeyId, secretAccessKey });
}

/** A disc R2 didn't have is asked again after this long (the upload to R2 may have finished meanwhile). */
const MISS_MS = 5 * 60_000;

/**
 * Where the players' discs are read from. With S3_BUCKET (and S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY,
 * Bun's own names), R2 first, under the path's key in the data folder (ps2/<id>/disc.iso, bt3/disc.iso), and the local
 * file when R2 doesn't have it; without S3_BUCKET, only the local file. Only for playing: the uploads, vimm and the
 * builders still write and read the local file.
 */
export function createDiscs(dir: string, client: S3Client | null = fromEnv(), now = Date.now): Discs {
  // (a disc never changes once in: its size is asked once, not on every piece)
  const sizes = new Map<string, { size: number | null; at: number }>();
  async function local(path: string): Promise<Disc | null> {
    const f = Bun.file(path);
    return (await f.exists()) ? { size: f.size, file: f, from: "local" } : null;
  }
  return async (path) => {
    if (!client) return local(path);
    const key = relative(dir, path);
    let known = sizes.get(key);
    if (!known || (known.size === null && now() - known.at > MISS_MS)) {
      const size = await client
        .file(key)
        .stat()
        .then(
          (s) => s.size,
          (err) => {
            if (err?.code !== "NoSuchKey") console.warn(`R2 ${key}: ${err?.code ?? err}, reading the local file`);
            return null;
          },
        );
      sizes.set(key, (known = { size, at: now() }));
    }
    return known.size === null ? local(path) : { size: known.size, file: client.file(key), from: "r2" };
  };
}
