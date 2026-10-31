// The PS2 disc, read through a cache. TabStationToo's disc worker reads the game's disc from the server by byte
// ranges, as the game asks, with no cache: every read the game makes (a menu's voice, a new screen) waits for the
// network, and through Discord's proxy that's long, so the game runs at full speed standing still and stutters as soon
// as it reads. Here the disc goes in 1 MB blocks: the recent ones in memory, every one on the browser's disk (Cache
// Storage: the next time, no network at all), and the next ones read ahead.

/** Blocks kept on disk, by number. Failing is only slower: the network still answers. */
export interface BlockStore {
  get(n: number): Promise<Uint8Array | null>;
  put(n: number, bytes: Uint8Array): Promise<void>;
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
}

export function createBlockCache({ size, fetchBlock, block = 1 << 20, keep = 128, ahead = 4, store }: BlockCacheOptions) {
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
      void store?.put(n, bytes).catch(() => {});
      return bytes;
    })();
    coming.set(n, p);
    p.then((bytes) => remember(n, bytes), () => {}).finally(() => coming.delete(n));
    return p;
  }

  return {
    async read(offset: number, length: number): Promise<Uint8Array> {
      const end = Math.min(size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      const first = Math.floor(offset / block);
      const last = Math.floor((end - 1) / block);
      // (what the game waits for goes out first, then the read ahead)
      const wanted = Promise.all(Array.from({ length: last - first + 1 }, (_, i) => get(first + i)));
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

/** Blocks on the browser's disk, under the disc's own address (without the person's pass, which changes). */
export function cacheStorageStore(url: string, size: number): BlockStore | undefined {
  if (typeof caches === "undefined") return undefined;
  const u = new URL(url);
  const disc = u.pathname.replace(/^\/p\/[^/]+\//, "/");
  const key = (n: number) => `${u.origin}/__hypeplay-disc${disc}?size=${size}&block=${n}`;
  const open = caches.open("hypeplay-disc-1");
  return {
    async get(n) {
      const r = await (await open).match(key(n));
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    async put(n, bytes) {
      await (await open).put(key(n), new Response(bytes as BodyInit));
    },
  };
}
