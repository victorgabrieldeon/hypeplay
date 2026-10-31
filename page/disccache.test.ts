import { expect, test } from "bun:test";
import { createBlockCache, type BlockStore } from "./disccache";

const SIZE = 10 * 4 + 3; // four whole blocks of 10 bytes and a short last one
const disc = Uint8Array.from({ length: SIZE }, (_, i) => i);

function setup(opts: { keep?: number; ahead?: number; store?: BlockStore } = {}) {
  const asked: number[] = [];
  const cache = createBlockCache({
    size: SIZE,
    block: 10,
    keep: opts.keep ?? 8,
    ahead: opts.ahead ?? 0,
    store: opts.store,
    fetchBlock: async (start, length) => {
      asked.push(start);
      return disc.slice(start, start + length);
    },
  });
  return { cache, asked };
}

const settle = () => new Promise((ok) => setTimeout(ok, 5));

test("a read across two blocks fetches each block once, whole, and gives back exactly the bytes asked for", async () => {
  const { cache, asked } = setup();
  expect([...(await cache.read(7, 6))]).toEqual([7, 8, 9, 10, 11, 12]);
  expect(asked).toEqual([0, 10]);
  expect([...(await cache.read(2, 3))]).toEqual([2, 3, 4]);
  expect(asked).toEqual([0, 10]);
});

test("the last block is short, and a read past the end stops at the disc's end", async () => {
  const { cache, asked } = setup();
  expect([...(await cache.read(41, 10))]).toEqual([41, 42]);
  expect(asked).toEqual([40]);
  expect((await cache.read(SIZE, 4)).length).toBe(0);
});

test("two reads of the same block at once fetch it once", async () => {
  const { cache, asked } = setup();
  const [a, b] = await Promise.all([cache.read(0, 2), cache.read(5, 2)]);
  expect([...a, ...b]).toEqual([0, 1, 5, 6]);
  expect(asked).toEqual([0]);
});

test("only the most recently used blocks stay in memory", async () => {
  const { cache, asked } = setup({ keep: 2 });
  await cache.read(0, 1);
  await cache.read(10, 1);
  await cache.read(0, 1); // block 0 is the most recent now
  await cache.read(20, 1); // so block 1 goes
  await cache.read(0, 1);
  await cache.read(10, 1);
  expect(asked).toEqual([0, 10, 20, 10]);
});

test("the next blocks are read ahead, in the background", async () => {
  const { cache, asked } = setup({ ahead: 2 });
  await cache.read(0, 1);
  await settle();
  expect(asked).toEqual([0, 10, 20]);
  // (blocks 1 and 2 were read ahead: only the two after them go out)
  await cache.read(15, 10);
  await settle();
  expect(asked).toEqual([0, 10, 20, 30, 40]);
});

test("blocks kept on disk are read from there, and what comes from the network is kept there", async () => {
  const kept = new Map<number, Uint8Array>([[1, disc.slice(10, 20)]]);
  const store: BlockStore = { get: async (n) => kept.get(n) ?? null, put: async (n, bytes) => void kept.set(n, bytes), has: async (n) => kept.has(n) };
  const { cache, asked } = setup({ store });
  expect([...(await cache.read(12, 2))]).toEqual([12, 13]);
  expect(asked).toEqual([]);
  await cache.read(0, 1);
  await settle();
  expect(asked).toEqual([0]);
  expect([...kept.get(0)!]).toEqual([...disc.slice(0, 10)]);
});

test("a store that fails is only a slower way: the network still answers", async () => {
  const store: BlockStore = { get: async () => { throw new Error("quota"); }, put: async () => { throw new Error("quota"); }, has: async () => false };
  const { cache, asked } = setup({ store });
  expect([...(await cache.read(3, 2))]).toEqual([3, 4]);
  expect(asked).toEqual([0]);
});

test("a block that fails to come is asked again next time", async () => {
  let fail = true;
  const cache = createBlockCache({
    size: SIZE, block: 10, keep: 8, ahead: 0,
    fetchBlock: async (start, length) => {
      if (fail) throw new Error("network");
      return disc.slice(start, start + length);
    },
  });
  await expect(cache.read(0, 2)).rejects.toThrow("network");
  fail = false;
  expect([...(await cache.read(0, 2))]).toEqual([0, 1]);
});

function memStore(kept = new Map<number, Uint8Array>(), opts: { full?: boolean } = {}): BlockStore & { kept: Map<number, Uint8Array> } {
  return {
    kept,
    get: async (n) => kept.get(n) ?? null,
    has: async (n) => kept.has(n),
    put: async (n, bytes) => {
      if (opts.full) throw new DOMException("no room", "QuotaExceededError");
      kept.set(n, bytes);
    },
  };
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await settle();
};

test("the whole disc to the browser's disk in the background, a few blocks per request, skipping what's there", async () => {
  const store = memStore(new Map([[1, disc.slice(10, 20)]]));
  const ranges: [number, number][] = [];
  const seen: { have: number; total: number; state: string }[] = [];
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 0, batch: 2, store,
    fetchBlock: async (start, length) => {
      ranges.push([start, length]);
      return disc.slice(start, start + length);
    },
    onProgress: (p) => seen.push(p),
  });
  cache.fill(true);
  await until(() => seen.at(-1)?.state === "done");
  expect(seen.at(-1)).toEqual({ have: 5, total: 5, state: "done" });
  // (block 1 was there; blocks 2 and 3 go together; the short last one alone)
  expect(ranges).toEqual([[0, 10], [20, 20], [40, 3]]);
  for (let n = 0; n < 5; n++) expect([...store.kept.get(n)!]).toEqual([...disc.slice(n * 10, n * 10 + 10)]);
  // the game's reads come from the disk now, and the filling kept nothing in memory to evict the game's blocks with
  expect([...(await cache.read(25, 3))]).toEqual([25, 26, 27]);
  expect(ranges.length).toBe(3);
});

test("no room left in the browser: the filling stops and says so", async () => {
  const seen: string[] = [];
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 0, batch: 2, store: memStore(new Map(), { full: true }),
    fetchBlock: async (start, length) => disc.slice(start, start + length),
    onProgress: (p) => seen.push(p.state),
  });
  cache.fill(true);
  await until(() => seen.includes("full"));
  expect(seen.at(-1)).toBe("full");
});

test("turned off, the filling stops after the request under way", async () => {
  const store = memStore();
  let calls = 0;
  const cache = createBlockCache({
    size: SIZE, block: 10, ahead: 0, batch: 1, store,
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
  const first = createBlockCache({ size: SIZE, block: 10, ahead: 0, batch: 2, store: flaky, fetchBlock: async (s, l) => disc.slice(s, s + l), onProgress: (p) => a.push(p.state) });
  first.fill(true);
  await until(() => a.at(-1) === "done");
  expect(first.progress()).toEqual({ have: 5, total: 5, state: "done" });
  expect(once.kept.size).toBe(5);

  // a disk that never keeps block 4: out of room, not done
  const never = memStore();
  const leaky: BlockStore = { ...never, put: async (n, b) => (n === 4 ? undefined : never.put(n, b)) };
  const b: string[] = [];
  const second = createBlockCache({ size: SIZE, block: 10, ahead: 0, batch: 2, store: leaky, fetchBlock: async (s, l) => disc.slice(s, s + l), onProgress: (p) => b.push(p.state) });
  second.fill(true);
  await until(() => b.at(-1) === "full" || b.at(-1) === "done");
  expect(b.at(-1)).toBe("full");
  expect(second.progress().have).toBe(4);
});
