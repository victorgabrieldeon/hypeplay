// The PS2 disc, read through a cache. TabStationToo's disc worker reads the game's disc from the server by byte
// ranges, as the game asks, with no cache: every read the game makes (a menu's voice, a new screen) waits for the
// network, and through Discord's proxy that's long, so the game runs at full speed standing still and stutters as soon
// as it reads. Here the disc is kept in 1 MB blocks: the recent ones in memory, every one on the browser's disk (Cache
// Storage: the next time, no network at all). And, when asked (fill), the whole disc to the browser's disk in the
// background: then no read the game makes waits on the network at all.
//
// The game's own reads come first: a block it needs and isn't kept comes whole (one wait serves the many small reads a
// game makes in a row) by the worker's own reader, with its deadline (past 10 s the emulator gives the disc up). The
// next blocks are read ahead at once, in one request, beside the game's own (a game streaming a video or music reads
// on and on: waiting for it to stop would leave every read to the network). The filling gives way: it goes on only
// while the game isn't on the network, and what it has under way stops for the game, unless it's that very block,
// which the game then takes from it.

/** Blocks kept on disk, by number. Failing is only slower: the network still answers. */
export interface BlockStore {
  get(n: number): Promise<Uint8Array | null>;
  put(n: number, bytes: Uint8Array): Promise<void>;
  /** Every block kept, in one look. */
  keptBlocks(): Promise<Set<number>>;
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
  /** A range from the network, in the background (`signal`: the game's turn, stop). */
  fetchBlock: (start: number, length: number, signal?: AbortSignal) => Promise<Uint8Array>;
  /** Block size in bytes (1 MB). */
  block?: number;
  /** Blocks kept in memory (128: 128 MB). */
  keep?: number;
  /** Blocks read ahead of each read, in one request (4). */
  ahead?: number;
  store?: BlockStore;
  /** Blocks per request while filling (4: a 4 MB request costs not much more than a 1 MB one, far from the server). */
  batch?: number;
  /** How long the game has had nothing from the network before the filling goes on (150 ms). */
  idle?: number;
  /**
   * How long the game waits on a background request bringing its block before that stops and the game asks for its
   * own (3 s: a stuck one would otherwise hold the game past the emulator's 10 s, and again at each of its retries).
   */
  wait?: number;
  onProgress?: (p: FillProgress) => void;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
/** (what the background keeps waiting for: the next blocks the game will want; only so many) */
const QUEUE_MAX = 64;

export function createBlockCache(opts: BlockCacheOptions) {
  const { size, fetchBlock, block = 1 << 20, keep = 128, ahead = 4, store, batch = 4, idle = 150, wait = 3000, onProgress } = opts;
  const blocks = Math.ceil(size / block);
  const lengthOf = (n: number) => Math.min(block, size - n * block);

  // ---- memory: a Map keeps insertion order, the first is the least recently used
  const mem = new Map<number, Uint8Array>();
  function remember(n: number, bytes: Uint8Array) {
    mem.delete(n);
    mem.set(n, bytes);
    while (mem.size > keep) mem.delete(mem.keys().next().value!);
  }

  // ---- on disk, and the filling's progress
  const onDisk = new Uint8Array(blocks);
  let have = 0;
  let state: FillProgress["state"] = "off";
  let wantFill = false;
  let checked = false;
  /** Blocks on disk at the last recount (a count that doesn't grow between two: no room). */
  let counted = -1;
  const progress = (): FillProgress => ({ have, total: blocks, state });
  const say = (s: FillProgress["state"]) => {
    state = s;
    onProgress?.(progress());
  };
  function mark(n: number) {
    if (onDisk[n]) return;
    onDisk[n] = 1;
    have++;
    onProgress?.(progress());
  }

  /** A block from memory or the browser's disk; null when it has to come from the network. */
  async function local(n: number): Promise<Uint8Array | null> {
    const held = mem.get(n);
    if (held) {
      remember(n, held);
      return held;
    }
    const kept = await store?.get(n).catch(() => null);
    if (!kept || kept.length !== lengthOf(n)) return null;
    remember(n, kept);
    mark(n);
    return kept;
  }

  // ---- the background: the game's blocks and what it'll read next (queue), then the filling
  const queue: number[] = [];
  /** Game reads under way (from the start: even a look at the cache), and when the last one from the network ended. */
  let reading = 0;
  let lastNetwork = Number.NEGATIVE_INFINITY;
  /** Where the game last read: the filling goes on from there. */
  let cursor = 0;
  /**
   * The background's request under way: which blocks, whether it's the filling (which gives way to the game), how to
   * stop it, and when it's over, with its blocks (null: it failed or was stopped).
   */
  let under: { n: number; count: number; fill: boolean; stop: AbortController; over: Promise<Map<number, Uint8Array> | null> } | null = null;
  let pumping = false;
  const gameIdle = () => reading === 0 && performance.now() - lastNetwork >= idle;
  const wanted = (n: number) => !mem.has(n) && !onDisk[n];
  /** A background request's blocks for the game, or null when it takes past `wait` (then it stops). */
  function waitOn(u: NonNullable<typeof under>): Promise<Map<number, Uint8Array> | null> {
    return new Promise((ok) => {
      const late = setTimeout(() => {
        u.stop.abort();
        ok(null);
      }, wait);
      void u.over.then((got) => {
        clearTimeout(late);
        ok(got);
      });
    });
  }
  /** A block out of the queue, wherever it is in it (the game's newest wishes go in front). */
  function drop(n: number) {
    const at = queue.indexOf(n);
    if (at >= 0) queue.splice(at, 1);
  }

  function nextFill(): { n: number; count: number } | null {
    if (!wantFill || state !== "filling" || have >= blocks) return null;
    let n = cursor;
    while (onDisk[n]) n = (n + 1) % blocks;
    let count = 1;
    while (count < batch && n + count < blocks && !onDisk[n + count]) count++;
    return { n, count };
  }

  /** Read ahead from block n: it and the ones after it still wanted, in one request. */
  function nextAhead(n: number): { n: number; count: number } {
    let count = 1;
    while (count < ahead && n + count < blocks && wanted(n + count)) count++;
    return { n, count };
  }

  /** Before "done": what's really on disk (a browser short of room may drop blocks it said it kept). */
  async function recount() {
    const kept = (await store!.keptBlocks().catch(() => null)) ?? new Set<number>();
    onDisk.fill(0);
    have = 0;
    for (const n of kept) if (n >= 0 && n < blocks && !onDisk[n]) (onDisk[n] = 1), have++;
    if (have >= blocks) return say("done");
    if (have <= counted) {
      wantFill = false;
      return say("full");
    }
    counted = have;
    say("filling");
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        while (queue.length && !wanted(queue[0]!)) queue.shift();
        if (!queue.length && wantFill && state === "filling" && have >= blocks) {
          await recount();
          continue;
        }
        const fromQueue = queue.length > 0;
        const job = fromQueue ? nextAhead(queue[0]!) : nextFill();
        if (!job) return;
        // (the read-ahead goes at once; the filling waits for the game to be off the network)
        if (!fromQueue && !gameIdle()) {
          await sleep(Math.max(idle, 5));
          continue;
        }
        const { n, count } = job;
        const start = n * block;
        const stop = new AbortController();
        const fetching = fetchBlock(start, Math.min(count * block, size - start), stop.signal);
        let done: (got: Map<number, Uint8Array> | null) => void = () => {};
        under = { n, count, fill: !fromQueue, stop, over: new Promise((ok) => (done = ok)) };
        let bytes: Uint8Array;
        try {
          bytes = await fetching;
        } catch {
          under = null;
          done(null);
          // (stopped for the game: the same again later; the network failing: the next one, or a while)
          if (stop.signal.aborted) continue;
          if (fromQueue) drop(n);
          else await sleep(5000);
          continue;
        }
        for (let i = 0; i < count; i++) drop(n + i);
        // (read ahead: in memory, it's what the game reads next; the filling's only on disk, and to a game waiting on it)
        const pieces = Array.from({ length: count }, (_, i) => (count === 1 ? bytes : bytes.slice(i * block, (i + 1) * block)));
        if (fromQueue) pieces.forEach((piece, i) => remember(n + i, piece));
        under = null;
        done(new Map(pieces.map((piece, i) => [n + i, piece])));
        if (store)
          for (let i = 0; i < count; i++) {
            try {
              await store.put(n + i, pieces[i]!);
              mark(n + i);
            } catch {
              if (!fromQueue && wantFill) {
                wantFill = false;
                say("full");
              }
              break;
            }
          }
        if (!fromQueue) cursor = (n + count) % blocks;
      }
    } finally {
      pumping = false;
    }
  }

  function enqueue(ns: number[], first: boolean) {
    const fresh = ns.filter((n) => n >= 0 && n < blocks && wanted(n) && !queue.includes(n));
    if (first) queue.unshift(...fresh);
    else queue.push(...fresh);
    if (queue.length > QUEUE_MAX) queue.length = QUEUE_MAX;
  }

  function slice(parts: Uint8Array[], first: number, offset: number, end: number): Uint8Array {
    if (parts.length === 1) return parts[0]!.subarray(offset - first * block, end - first * block);
    const out = new Uint8Array(end - offset);
    let at = 0;
    parts.forEach((bytes, i) => {
      const from = i === 0 ? offset - first * block : 0;
      const to = i === parts.length - 1 ? end - (first + i) * block : bytes.length;
      out.set(bytes.subarray(from, to), at);
      at += to - from;
    });
    return out;
  }

  return {
    /** The whole disc to the browser's disk, in the background (on), or no more of it (off). */
    async fill(on: boolean) {
      wantFill = on && !!store && blocks > 0;
      if (!wantFill) {
        if (state === "checking" || state === "filling") say("off");
        return;
      }
      if (state === "done") return;
      counted = -1;
      if (!checked) {
        say("checking");
        const kept = (await store!.keptBlocks().catch(() => null)) ?? new Set<number>();
        for (const n of kept) if (n >= 0 && n < blocks) mark(n);
        checked = true;
        if (!wantFill) return;
      }
      say("filling");
      void pump();
    },
    progress,
    /** The game's read; `direct` is its own reader (the worker's, with the emulator's deadline), for what isn't kept. */
    async read(offset: number, length: number, direct?: (start: number, length: number) => Promise<Uint8Array>): Promise<Uint8Array> {
      const end = Math.min(size, offset + length);
      if (offset >= end) return new Uint8Array(0);
      const first = Math.floor(offset / block);
      const last = Math.floor((end - 1) / block);
      cursor = last;
      const ns = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => from + i);
      reading++;
      let network = false;
      try {
        const parts = new Map<number, Uint8Array>();
        const look = async () => {
          for (let n = first; n <= last; n++) if (!parts.has(n)) {
            const b = await local(n);
            if (b) parts.set(n, b);
          }
          return ns(first, last).filter((n) => !parts.has(n));
        };
        /** From the network, the game's own way: one request from the first block to the last. */
        const bring = async (want: number[]) => {
          if (!want.length) return;
          const from = want[0]!;
          const to = want.at(-1)!;
          const start = from * block;
          const bytes = await (direct ?? fetchBlock)(start, Math.min((to - from + 1) * block, size - start));
          for (let n = from; n <= to; n++) {
            const piece = from === to ? bytes : bytes.slice((n - from) * block, (n - from + 1) * block);
            if (!parts.has(n)) parts.set(n, piece);
            remember(n, piece);
            if (store) void store.put(n, piece).then(() => mark(n), () => {});
          }
        };
        const missing = await look();
        if (missing.length) {
          network = true;
          const u = under;
          const inU = (n: number) => !!u && n >= u.n && n < u.n + u.count;
          const outside = missing.filter((n) => !inU(n));
          // (what the background has under way stops for the game, unless it's bringing all the game wants, or it's
          // the read-ahead of this very stretch, what the game reads next; the read-ahead of a stretch the game left,
          // or the filling, stops)
          const following = !!u && !u.fill && u.n + u.count > first && u.n <= last + ahead;
          const giveWay = !following && outside.length > 0;
          if (giveWay) u?.stop.abort();
          // (and the blocks after these, at once, beside the game's own request)
          enqueue(ns(last + 1, Math.min(blocks - 1, last + ahead)), true);
          void pump();
          const [got] = await Promise.all([u && !giveWay && missing.some(inU) ? waitOn(u) : null, bring(giveWay ? missing : outside)]);
          for (const [n, piece] of got ?? [])
            if (n >= first && n <= last && !parts.has(n)) {
              parts.set(n, piece);
              remember(n, piece);
            }
          // (what the background was to bring and didn't: from the network after all)
          await bring(await look());
        }
        return slice(ns(first, last).map((n) => parts.get(n)!), first, offset, end);
      } finally {
        reading--;
        if (network) lastNetwork = performance.now();
        enqueue(ns(last + 1, Math.min(blocks - 1, last + ahead)), false);
        void pump();
      }
    },
  };
}

/** The disc's address without the person's pass (which changes): /ps2/<id>/game/disc.iso. */
export const discPath = (url: string) => new URL(url).pathname.replace(/^\/p\/[^/]+\//, "/");

/** Blocks on the browser's disk, under the disc's own address. */
export function cacheStorageStore(url: string, size: number): BlockStore | undefined {
  if (typeof caches === "undefined") return undefined;
  const prefix = `${new URL(url).origin}/__hypeplay-disc${discPath(url)}?size=${size}&block=`;
  const open = caches.open("hypeplay-disc-1");
  return {
    async get(n) {
      const r = await (await open).match(prefix + n);
      return r ? new Uint8Array(await r.arrayBuffer()) : null;
    },
    async put(n, bytes) {
      await (await open).put(prefix + n, new Response(bytes as BodyInit));
    },
    async keptBlocks() {
      const kept = new Set<number>();
      for (const r of await (await open).keys()) if (r.url.startsWith(prefix)) kept.add(Number(r.url.slice(prefix.length)));
      return kept;
    },
  };
}
