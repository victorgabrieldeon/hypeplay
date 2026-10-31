import { expect, test } from "bun:test";
import { createBlockCache, type BlockStore } from "./disccache";

const SIZE = 10 * 4 + 3; // four whole blocks of 10 bytes and a short last one
const disc = Uint8Array.from({ length: SIZE }, (_, i) => i);
const settle = () => new Promise((ok) => setTimeout(ok, 5));
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 400 && !ok(); i++) await settle();
};

/** The game's own reader (what the disc worker passes): a record of what it was asked. */
function gameReader() {
  const asked: [number, number][] = [];
  return { asked, read: async (start: number, length: number) => (asked.push([start, length]), disc.slice(start, start + length)) };
}

function memStore(kept = new Map<number, Uint8Array>(), opts: { full?: boolean } = {}): BlockStore & { kept: Map<number, Uint8Array> } {
  return {
    kept,
    get: async (n) => kept.get(n) ?? null,
    keptBlocks: async () => new Set(kept.keys()),
    put: async (n, bytes) => {
      if (opts.full) throw new DOMException("no room", "QuotaExceededError");
      kept.set(n, bytes);
    },
  };
}

function setup(opts: { keep?: number; ahead?: number; store?: BlockStore } = {}) {
  const blocks: number[] = [];
  const cache = createBlockCache({
    size: SIZE, block: 10, keep: opts.keep ?? 8, ahead: opts.ahead ?? 0, idle: 0, store: opts.store,
    fetchBlock: async (start, length) => (blocks.push(start), disc.slice(start, start + length)),
  });
  return { cache, blocks };
}

test("blocks not kept yet come whole, in one request by the game's own reader, and serve the reads after", async () => {
  const { cache, blocks } = setup();
  const game = gameReader();
  expect([...(await cache.read(7, 6, game.read))]).toEqual([7, 8, 9, 10, 11, 12]);
  expect(game.asked).toEqual([[0, 20]]);
  expect([...(await cache.read(2, 3, game.read))]).toEqual([2, 3, 4]);
  expect([...(await cache.read(8, 4, game.read))]).toEqual([8, 9, 10, 11]);
  expect(game.asked.length).toBe(1);
  expect(blocks).toEqual([]);
});

test("the last block is short, and a read past the end stops at the disc's end", async () => {
  const { cache, blocks } = setup();
  expect([...(await cache.read(41, 10))]).toEqual([41, 42]);
  expect(blocks).toEqual([40]);
  expect((await cache.read(SIZE, 4)).length).toBe(0);
});

test("only the most recently used blocks stay in memory", async () => {
  const { cache } = setup({ keep: 2 });
  const game = gameReader();
  await cache.read(0, 1, game.read);
  await cache.read(10, 1, game.read);
  await cache.read(0, 1, game.read); // block 0 is the most recent now
  await cache.read(20, 1, game.read); // so block 1 goes
  await cache.read(10, 1, game.read);
  expect(game.asked.map(([o]) => o)).toEqual([0, 10, 20, 10]);
});

test("the next blocks are read ahead, in the background", async () => {
  const { cache, blocks } = setup({ ahead: 2 });
  const game = gameReader();
  await cache.read(0, 1, game.read);
  await until(() => blocks.length === 2);
  expect(blocks).toEqual([10, 20]);
  expect([...(await cache.read(15, 10, game.read))]).toEqual([15, 16, 17, 18, 19, 20, 21, 22, 23, 24]);
  expect(game.asked.length).toBe(1);
});

test("blocks kept on disk are read from there, and what comes from the network is kept there", async () => {
  const store = memStore(new Map([[1, disc.slice(10, 20)]]));
  const { cache } = setup({ store });
  const game = gameReader();
  expect([...(await cache.read(12, 2, game.read))]).toEqual([12, 13]);
  expect(game.asked).toEqual([]);
  await cache.read(0, 1, game.read);
  await until(() => store.kept.has(0));
  expect([...store.kept.get(0)!]).toEqual([...disc.slice(0, 10)]);
});

test("a store that fails is only a slower way: the network still answers", async () => {
  const store: BlockStore = { get: async () => { throw new Error("quota"); }, put: async () => { throw new Error("quota"); }, keptBlocks: async () => new Set() };
  const { cache } = setup({ store });
  const game = gameReader();
  expect([...(await cache.read(3, 2, game.read))]).toEqual([3, 4]);
});

test("a game read that fails: the game hears it, and the next one asks again", async () => {
  const { cache } = setup();
  await expect(cache.read(0, 2, async () => { throw new Error("network"); })).rejects.toThrow("network");
  const game = gameReader();
  expect([...(await cache.read(0, 2, game.read))]).toEqual([0, 1]);
});

test("the background gives way: a game read from the network stops the request under way, which comes again later", async () => {
  const background: number[] = [];
  let hang = true;
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 1, idle: 0,
    fetchBlock: async (start, length, signal) => {
      background.push(start);
      if (hang && signal) {
        hang = false;
        await new Promise((_, fail) => signal.addEventListener("abort", () => fail(new Error("aborted"))));
      }
      return disc.slice(start, start + length);
    },
  });
  const game = gameReader();
  await cache.read(0, 1, game.read);
  await until(() => background.length === 1); // block 1 read ahead, and hanging
  expect([...(await cache.read(25, 1, game.read))]).toEqual([25]);
  await until(() => background.length === 3);
  // (block 1 stopped for the game's block 2, then again, then block 3 read ahead)
  expect(game.asked).toEqual([[0, 10], [20, 10]]);
  expect(background).toEqual([10, 10, 30]);
});

test("a block the background is already bringing: the game waits for it instead of asking again", async () => {
  const background: number[] = [];
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 1, idle: 0,
    fetchBlock: async (start, length) => {
      background.push(start);
      await new Promise((ok) => setTimeout(ok, 30));
      return disc.slice(start, start + length);
    },
  });
  const game = gameReader();
  await cache.read(0, 1, game.read);
  await until(() => background.length === 1); // block 1 under way
  expect([...(await cache.read(15, 2, game.read))]).toEqual([15, 16]);
  expect(game.asked).toEqual([[0, 10]]);
  // (block 1 once; what follows is block 2, read ahead of the game's read of block 1)
  expect(background.filter((at) => at === 10)).toEqual([10]);
});

test("the whole disc to the browser's disk in the background, a few blocks per request, skipping what's there", async () => {
  const store = memStore(new Map([[1, disc.slice(10, 20)]]));
  const ranges: [number, number][] = [];
  const seen: { have: number; total: number; state: string }[] = [];
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 0, batch: 2, idle: 0, store,
    fetchBlock: async (start, length) => (ranges.push([start, length]), disc.slice(start, start + length)),
    onProgress: (p) => seen.push(p),
  });
  cache.fill(true);
  await until(() => seen.at(-1)?.state === "done");
  expect(seen.at(-1)).toEqual({ have: 5, total: 5, state: "done" });
  // (block 1 was there; blocks 2 and 3 go together; the short last one alone)
  expect(ranges).toEqual([[0, 10], [20, 20], [40, 3]]);
  for (let n = 0; n < 5; n++) expect([...store.kept.get(n)!]).toEqual([...disc.slice(n * 10, n * 10 + 10)]);
  const game = gameReader();
  expect([...(await cache.read(25, 3, game.read))]).toEqual([25, 26, 27]);
  expect(game.asked).toEqual([]);
});

test("the filling waits while the game waits on the network", async () => {
  const store = memStore();
  const background: number[] = [];
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 0, batch: 2, idle: 0, store,
    fetchBlock: async (start, length) => (background.push(start), disc.slice(start, start + length)),
  });
  let release = () => {};
  const gate = new Promise<void>((ok) => (release = ok));
  const reading = cache.read(0, 1, async (start, length) => (await gate, disc.slice(start, start + length)));
  cache.fill(true);
  await settle();
  await settle();
  expect(background).toEqual([]);
  release();
  await reading;
  await until(() => cache.progress().state === "done");
  expect(store.kept.size).toBe(5);
});

test("no room left in the browser: the filling stops and says so", async () => {
  const seen: string[] = [];
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 0, batch: 2, idle: 0, store: memStore(new Map(), { full: true }),
    fetchBlock: async (start, length) => disc.slice(start, start + length),
    onProgress: (p) => seen.push(p.state),
  });
  cache.fill(true);
  await until(() => seen.includes("full"));
  expect(seen.at(-1)).toBe("full");
});

test("turned off, the filling stops after the request under way", async () => {
  let calls = 0;
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 0, batch: 1, idle: 0, store: memStore(),
    fetchBlock: async (start, length) => {
      calls++;
      cache.fill(false);
      return disc.slice(start, start + length);
    },
  });
  cache.fill(true);
  await until(() => calls > 0);
  await settle();
  await settle();
  expect(calls).toBe(1);
  expect(cache.progress().state).toBe("off");
});

test("without a disk to keep blocks in, there is nothing to fill", () => {
  const { cache } = setup();
  cache.fill(true);
  expect(cache.progress().state).toBe("off");
});

test("blocks the browser drops quietly are filled again, and a browser that keeps dropping them is out of room", async () => {
  // a disk that drops block 2 the first time only: filled again, then done
  const once = memStore();
  let dropped = false;
  const flaky: BlockStore = { ...once, put: async (n, b) => (n === 2 && !dropped ? void (dropped = true) : once.put(n, b)) };
  const a: string[] = [];
  const first = createBlockCache({ size: SIZE, block: 10, ahead: 0, batch: 2, idle: 0, store: flaky, fetchBlock: async (s, l) => disc.slice(s, s + l), onProgress: (p) => a.push(p.state) });
  first.fill(true);
  await until(() => a.at(-1) === "done");
  expect(first.progress()).toEqual({ have: 5, total: 5, state: "done" });
  expect(once.kept.size).toBe(5);

  // a disk that never keeps block 4: out of room, not done
  const never = memStore();
  const leaky: BlockStore = { ...never, put: async (n, b) => (n === 4 ? undefined : never.put(n, b)) };
  const b: string[] = [];
  const second = createBlockCache({ size: SIZE, block: 10, ahead: 0, batch: 2, idle: 0, store: leaky, fetchBlock: async (s, l) => disc.slice(s, s + l), onProgress: (p) => b.push(p.state) });
  second.fill(true);
  await until(() => b.at(-1) === "full" || b.at(-1) === "done");
  expect(b.at(-1)).toBe("full");
  expect(second.progress().have).toBe(4);
});
