/**
 * The R2 discs' bytes kept in this server's memory, in 1 MiB pieces aligned on the disc, the least recently used going
 * first once the pieces pass a size in bytes (DISC_CACHE_MB, index.ts). From the VPS a GET to R2 waits 85–140 ms before
 * its first byte: two people in the same game, or one coming back to a menu, read the same pieces, and only the first
 * read of each goes to R2. A piece being fetched is shared too: two reads of it at once make one GET.
 *
 * A read streams its pieces in order, each fetched on its own (a range of 4 MiB is 4 GETs at once, so the first MiB
 * goes out while the rest still arrive), never more than AHEAD ahead of what was sent: a whole disc read from the start
 * neither asks R2 for thousands of pieces at once nor holds them all.
 */

export const CHUNK = 1024 * 1024;
/** Pieces fetched ahead of the one being sent. */
const AHEAD = 4;

/** Bytes [start, end) of the object, from R2. */
export type Load = (start: number, end: number) => Promise<Uint8Array>;

export interface ChunkCacheStats {
  /** Bytes kept, and in how many pieces. */
  bytes: number;
  chunks: number;
  /** Pieces read from memory (or from a GET already under way), and from R2. */
  hits: number;
  misses: number;
}

export interface ChunkCache {
  /**
   * Bytes [start, end) of the object `key` (`size` bytes), from memory where kept and from `load` piece by piece
   * otherwise. `key` must change when the object does: a piece is never checked against R2 again.
   */
  read(key: string, size: number, start: number, end: number, load: Load): ReadableStream<Uint8Array>;
  stats(): ChunkCacheStats;
}

export function createChunkCache({ maxBytes, chunk = CHUNK }: { maxBytes: number; chunk?: number }): ChunkCache {
  // (a Map keeps insertion order: the first is the least recently used)
  const kept = new Map<string, Uint8Array>();
  const fetching = new Map<string, Promise<Uint8Array>>();
  let bytes = 0;
  let hits = 0;
  let misses = 0;

  function keep(name: string, piece: Uint8Array) {
    if (piece.length > maxBytes) return;
    const old = kept.get(name);
    if (old) bytes -= old.length;
    kept.delete(name);
    kept.set(name, piece);
    bytes += piece.length;
    for (const [n, p] of kept) {
      if (bytes <= maxBytes) break;
      kept.delete(n);
      bytes -= p.length;
    }
  }

  function piece(key: string, size: number, i: number, load: Load): Promise<Uint8Array> {
    const name = `${key}#${i}`;
    const have = kept.get(name);
    if (have) {
      hits++;
      kept.delete(name);
      kept.set(name, have);
      return Promise.resolve(have);
    }
    const under = fetching.get(name);
    if (under) {
      hits++;
      return under;
    }
    misses++;
    const from = i * chunk;
    const to = Math.min(size, from + chunk);
    const p = load(from, to).then(
      (got) => {
        fetching.delete(name);
        if (got.length !== to - from) throw new Error(`${key}: ${got.length} bytes at ${from}, ${to - from} asked`);
        // (its own copy: a view into a larger buffer would keep that whole buffer alive past its count here)
        const own = got.byteOffset === 0 && got.byteLength === got.buffer.byteLength ? got : got.slice();
        keep(name, own);
        return own;
      },
      (err) => {
        fetching.delete(name);
        throw err;
      },
    );
    fetching.set(name, p);
    return p;
  }

  return {
    read(key, size, start, end, load) {
      end = Math.min(end, size);
      const first = Math.floor(start / chunk);
      const last = end > start ? Math.floor((end - 1) / chunk) : first - 1;
      const asked: Promise<Uint8Array>[] = [];
      let next = first;
      /** Pieces under way up to AHEAD past `i`. */
      const ask = (i: number) => {
        for (; next <= last && next < i + AHEAD; next++) {
          const p = piece(key, size, next, load);
          // (a read stopped early leaves its later pieces unread: their failure is no one's)
          p.catch(() => {});
          asked[next - first] = p;
        }
      };
      let at = first;
      return new ReadableStream<Uint8Array>({
        start() {
          ask(first);
        },
        async pull(c) {
          if (at > last) return c.close();
          ask(at);
          const bytes = await asked[at - first]!;
          delete asked[at - first];
          const base = at * chunk;
          c.enqueue(bytes.subarray(Math.max(start, base) - base, Math.min(end, base + bytes.length) - base));
          at++;
          if (at > last) c.close();
        },
      });
    },
    stats: () => ({ bytes, chunks: kept.size, hits, misses }),
  };
}

/** DISC_CACHE_MB: megabytes of disc pieces kept in memory (256 by default; 0 keeps none). */
export function discCacheBytes(env = process.env): number {
  const raw = env.DISC_CACHE_MB?.trim();
  const mb = raw ? Number(raw) : 256;
  if (!Number.isFinite(mb) || mb < 0) throw new Error(`DISC_CACHE_MB: ${raw} não é um número de megabytes`);
  return Math.floor(mb * 1024 * 1024);
}
