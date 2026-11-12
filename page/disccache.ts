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
// on and on: waiting for it to stop would leave every read to the network). A few read-aheads go at once, and a game
// read elsewhere doesn't stop them: an open-world game streams from several places of the disc in turn (Midnight Club
// 3: its city from several at a time), and far from the server each request is mostly waiting, so one at a time, each
// stopped by the next read elsewhere, never got ahead. The filling gives way: it goes on only while the game isn't on
// the network, and what it has under way stops for the game, unless it's that very block, which the game then takes
// from it.

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
  /** Blocks read ahead of each read, in one request (2: more is mostly bytes the game never reads, in the way of its own). */
  ahead?: number;
  /** Read-ahead requests under way at once (2). */
  parallel?: number;
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
  const { size, fetchBlock, block = 1 << 20, keep = 128, ahead = 2, parallel = 2, store, batch = 4, idle = 150, wait = 3000, onProgress } = opts;
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
   * The background's requests under way: which blocks, whether it's the filling (which gives way to the game), how to
   * stop it, and when it's over, with its blocks (null: it failed or was stopped). Read-aheads, up to `parallel`; the
   * filling, one, and only with no read-ahead under way.
   */
  type Job = { n: number; count: number; fill: boolean; stop: AbortController; over: Promise<Map<number, Uint8Array> | null> };
  const jobs = new Set<Job>();
  const covering = (n: number) => [...jobs].find((j) => !j.stop.signal.aborted && n >= j.n && n < j.n + j.count);
  let pumping = false;
  /** (the filling, after the network failed it: not before then) */
  let fillPausedUntil = 0;
  /**
   * Blocks one of the game's reads is bringing from the network: another read wanting one waits for it instead of
   * asking again (the "versão rápida" reads 256 KB pieces, many at once: four of them in a block would be four blocks).
   */
  const bringing = new Map<number, Promise<Map<number, Uint8Array>>>();
  const gameIdle = () => reading === 0 && performance.now() - lastNetwork >= idle;
  const wanted = (n: number) => !mem.has(n) && !onDisk[n] && !bringing.has(n) && !covering(n);
  /** A background request's blocks for the game, or null when it takes past `wait` (then it stops). */
  function waitOn(u: Job): Promise<Map<number, Uint8Array> | null> {
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

  /**
   * Read ahead from block n: it and the ones after it still wanted, in one request; null when n was on the browser's
   * disk (now in memory). What's on disk isn't asked again, found there now if the filling hasn't counted it yet.
   */
  async function nextAhead(n: number): Promise<{ n: number; count: number } | null> {
    if (await local(n)) return null;
    let count = 1;
    while (count < ahead && n + count < blocks && wanted(n + count) && !(await local(n + count))) count++;
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

  /** A background request: its blocks to memory (read ahead) and to the browser's disk; then the next ones. */
  function start(n: number, count: number, fill: boolean) {
    const from = n * block;
    const stop = new AbortController();
    let done: (got: Map<number, Uint8Array> | null) => void = () => {};
    const job: Job = { n, count, fill, stop, over: new Promise((ok) => (done = ok)) };
    jobs.add(job);
    for (let i = 0; i < count; i++) drop(n + i);
    void fetchBlock(from, Math.min(count * block, size - from), stop.signal)
      .then(
        async (bytes) => {
          // (read ahead: in memory, it's what the game reads next; the filling's only on disk, and to a game waiting on it)
          const pieces = Array.from({ length: count }, (_, i) => (count === 1 ? bytes : bytes.slice(i * block, (i + 1) * block)));
          if (!fill) pieces.forEach((piece, i) => remember(n + i, piece));
          // (to a game waiting on it at once; but it stays under way until it's on disk: not asked again meanwhile)
          done(new Map(pieces.map((piece, i) => [n + i, piece])));
          if (store)
            for (let i = 0; i < count; i++) {
              try {
                await store.put(n + i, pieces[i]!);
                mark(n + i);
              } catch {
                if (fill && wantFill) {
                  wantFill = false;
                  say("full");
                }
                break;
              }
            }
          jobs.delete(job);
          if (fill) cursor = (n + count) % blocks;
        },
        () => {
          jobs.delete(job);
          done(null);
          // (stopped for the game: the same again later; the network failing the filling: a while)
          if (fill && !stop.signal.aborted) fillPausedUntil = performance.now() + 5000;
        },
      )
      .finally(() => void pump());
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        while (queue.length && !wanted(queue[0]!)) queue.shift();
        const reading = [...jobs].filter((j) => !j.fill).length;
        if (queue.length) {
          if (reading >= parallel) return; // (one ending calls this again)
          const head = queue[0]!;
          const job = await nextAhead(head);
          if (!job) drop(head);
          else if (wanted(job.n)) start(job.n, job.count, false);
          else drop(head);
          continue;
        }
        // (the filling: only with nothing else under way)
        if (jobs.size) return;
        if (wantFill && state === "filling" && have >= blocks) {
          await recount();
          continue;
        }
        const job = nextFill();
        if (!job) return;
        const paused = fillPausedUntil - performance.now();
        if (paused > 0 || !gameIdle()) {
          await sleep(Math.max(paused, idle, 5));
          continue;
        }
        start(job.n, job.count, true);
        return;
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
        const bring = async (asked: number[]) => {
          // (what another read is bringing: its; what it couldn't, or nobody is bringing: this read's own request)
          // (no wait when there's none: the reads at once must see each other's requests)
          const theirs = asked.filter((n) => bringing.has(n));
          if (theirs.length)
            await Promise.all(theirs.map((n) => bringing.get(n)!.then((got) => void (parts.has(n) || parts.set(n, got.get(n)!)), () => {})));
          const want = asked.filter((n) => !parts.has(n));
          if (!want.length) return;
          const from = want[0]!;
          const to = want.at(-1)!;
          const start = from * block;
          const job = (direct ?? fetchBlock)(start, Math.min((to - from + 1) * block, size - start)).then(
            (bytes) => new Map(ns(from, to).map((n) => [n, from === to ? bytes : bytes.slice((n - from) * block, (n - from + 1) * block)])),
          );
          job.catch(() => {});
          const mine = ns(from, to).filter((n) => !parts.has(n) && !bringing.has(n));
          for (const n of mine) bringing.set(n, job);
          let got: Map<number, Uint8Array>;
          try {
            got = await job;
          } finally {
            for (const n of mine) if (bringing.get(n) === job) bringing.delete(n);
          }
          for (const [n, piece] of got) {
            if (!parts.has(n)) parts.set(n, piece);
            remember(n, piece);
            if (store) void store.put(n, piece).then(() => mark(n), () => {});
          }
        };
        const missing = await look();
        if (missing.length) {
          network = true;
          // (the filling stops for the game, unless it's bringing all the game wants; the read-aheads go on: they're
          // what the game reads next, here or where it streams from too)
          if (missing.some((n) => !covering(n))) for (const j of jobs) if (j.fill) j.stop.abort();
          const theirs = [...new Set(missing.map(covering).filter((j): j is Job => !!j))];
          const outside = missing.filter((n) => !covering(n));
          // (and the blocks after these, at once, beside the game's own request)
          enqueue(ns(last + 1, Math.min(blocks - 1, last + ahead)), true);
          void pump();
          const [got] = await Promise.all([Promise.all(theirs.map(waitOn)), bring(outside)]);
          for (const m of got)
            for (const [n, piece] of m ?? [])
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
