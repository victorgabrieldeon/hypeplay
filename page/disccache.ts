// The PS2 disc, read through a cache. TabStationToo's disc worker reads the game's disc from the server by byte
// ranges, as the game asks, with no cache: every read the game makes (a menu's voice, a new screen) waits for the
// network, and through Discord's proxy that's long, so the game runs at full speed standing still and stutters as soon
// as it reads. Here the disc goes in 1 MB blocks: the recent ones in memory, every one on the browser's disk (Cache
// Storage: the next time, no network at all), and the next ones read ahead. And, when asked (fill), the rest of the
// disc to the browser's disk in the background, a few blocks per request, giving way to the game's own reads: then
// no read the game makes waits on the network at all.

/** Blocks kept on disk, by number. Failing is only slower: the network still answers. */
export interface BlockStore {
  get(n: number): Promise<Uint8Array | null>;
  put(n: number, bytes: Uint8Array): Promise<void>;
  has(n: number): Promise<boolean>;
}

/** The filling: blocks on disk out of the disc's, and whether it's checking, filling, done, out of room or off. */
export interface FillProgress {
  have: number;
  total: number;
  state: "off" | "checking" | "filling" | "done" | "full";
}

export interface BlockCacheOptions {
  /** The disc's size in bytes. */
  size: number;
  fetchBlock: (start: number, length: number) => Promise<Uint8Array>;
  /** Block size in bytes (1 MB). */
  block?: number;
  /** Blocks kept in memory (128: 128 MB). */
  keep?: number;
  /** Blocks read ahead of each read (4). */
  ahead?: number;
  store?: BlockStore;
  /** Blocks per request while filling (4). */
  batch?: number;
  onProgress?: (p: FillProgress) => void;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export function createBlockCache(opts: BlockCacheOptions) {
  const { size, fetchBlock, block = 1 << 20, keep = 128, ahead = 4, store, batch = 4, onProgress } = opts;
  const blocks = Math.ceil(size / block);
  // (a Map keeps insertion order: the first is the least recently used)
  const mem = new Map<number, Uint8Array>();
  const coming = new Map<number, Promise<Uint8Array>>();

  function remember(n: number, bytes: Uint8Array) {
    mem.delete(n);
    mem.set(n, bytes);
    while (mem.size > keep) mem.delete(mem.keys().next().value!);
  }

  function get(n: number): Promise<Uint8Array> {
    const held = mem.get(n);
    if (held) {
      remember(n, held);
      return Promise.resolve(held);
    }
    const already = coming.get(n);
    if (already) return already;
    const start = n * block;
    const p = (async () => {
      const kept = await store?.get(n).catch(() => null);
      if (kept && kept.length === Math.min(block, size - start)) return kept;
      const bytes = await fetchBlock(start, Math.min(block, size - start));
      void store?.put(n, bytes).then(() => mark(n), () => {});
      return bytes;
    })();
    coming.set(n, p);
    p.then((bytes) => remember(n, bytes), () => {}).finally(() => coming.delete(n));
    return p;
  }

  // ---- the filling
  const onDisk = new Uint8Array(blocks);
  let have = 0;
  let state: FillProgress["state"] = "off";
  let wantFill = false;
  let running = false;
  /** Game reads waiting: the filling gives way to them. */
  let waiting = 0;
  /** Where the game last read: the filling goes on from there. */
  let cursor = 0;
  const progress = (): FillProgress => ({ have, total: blocks, state });
  const say = (s: FillProgress["state"]) => {
    state = s;
    onProgress?.(progress());
  };
  function mark(n: number) {
    if (onDisk[n]) return;
    onDisk[n] = 1;
    have++;
    if (running) onProgress?.(progress());
  }

  async function fillLoop() {
    running = true;
    try {
      say("checking");
      for (let n = 0; n < blocks && wantFill; n++) if (!onDisk[n] && (await store!.has(n).catch(() => false))) mark(n);
      if (wantFill) say("filling");
      // (a browser short of room may drop blocks it said it kept: before "done", what's really there is counted again,
      // and a count that doesn't grow between two of those means no room)
      let counted = -1;
      while (wantFill) {
        if (have >= blocks) {
          for (let n = 0; n < blocks; n++)
            if (!(await store!.has(n).catch(() => false))) {
              onDisk[n] = 0;
              have--;
            }
          if (have >= blocks) return say("done");
          if (have <= counted) {
            wantFill = false;
            return say("full");
          }
          counted = have;
          say("filling");
        }
        if (waiting > 0) {
          await sleep(50);
          continue;
        }
        let n = cursor;
        while (onDisk[n]) n = (n + 1) % blocks;
        let count = 1;
        while (count < batch && n + count < blocks && !onDisk[n + count]) count++;
        const start = n * block;
        let bytes: Uint8Array;
        try {
          bytes = await fetchBlock(start, Math.min(count * block, size - start));
        } catch {
          await sleep(5000); // (the network: again in a while)
          continue;
        }
        try {
          for (let i = 0; i < count; i++) {
            await store!.put(n + i, bytes.slice(i * block, (i + 1) * block));
            mark(n + i);
          }
        } catch {
          wantFill = false;
          return say("full");
        }
        cursor = (n + count) % blocks;
      }
      say("off");
    } finally {
      running = false;
    }
  }

  return {
    /** The rest of the disc to the browser's disk, in the background (on), or no more of it (off). */
    fill(on: boolean) {
      wantFill = on && !!store && blocks > 0;
      if (wantFill && !running) void fillLoop();
    },
    progress,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const end = Math.min(size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      const first = Math.floor(offset / block);
      const last = Math.floor((end - 1) / block);
      cursor = last;
      // (what the game waits for goes out first, then the read ahead)
      waiting++;
      const wanted = Promise.all(Array.from({ length: last - first + 1 }, (_, i) => get(first + i))).finally(() => waiting--);
      for (let n = last + 1; n <= Math.min(blocks - 1, last + ahead); n++) if (!mem.has(n)) get(n).catch(() => {});
      const parts = await wanted;
      if (parts.length === 1) return parts[0]!.subarray(offset - first * block, end - first * block);
      const out = new Uint8Array(end - offset);
      let at = 0;
      parts.forEach((bytes, i) => {
        const from = i === 0 ? offset - first * block : 0;
        const to = first + i === last ? end - (first + i) * block : bytes.length;
        out.set(bytes.subarray(from, to), at);
        at += to - from;
      });
      return out;
    },
  };
}

/** The disc's address without the person's pass (which changes): /ps2/<id>/game/disc.iso. */
export const discPath = (url: string) => new URL(url).pathname.replace(/^\/p\/[^/]+\//, "/");

/** Blocks on the browser's disk, under the disc's own address. */
export function cacheStorageStore(url: string, size: number): BlockStore | undefined {
  if (typeof caches === "undefined") return undefined;
  const key = (n: number) => `${new URL(url).origin}/__hypeplay-disc${discPath(url)}?size=${size}&block=${n}`;
  const open = caches.open("hypeplay-disc-1");
  return {
    async get(n) {
      const r = await (await open).match(key(n));
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    async put(n, bytes) {
      await (await open).put(key(n), new Response(bytes as BodyInit));
    },
    async has(n) {
      return !!(await (await open).match(key(n)));
    },
  };
}
