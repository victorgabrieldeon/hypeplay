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
  const store: BlockStore = { get: async (n) => kept.get(n) ?? null, put: async (n, bytes) => void kept.set(n, bytes) };
  const { cache, asked } = setup({ store });
  expect([...(await cache.read(12, 2))]).toEqual([12, 13]);
  expect(asked).toEqual([]);
  await cache.read(0, 1);
  await settle();
  expect(asked).toEqual([0]);
  expect([...kept.get(0)!]).toEqual([...disc.slice(0, 10)]);
});

test("a store that fails is only a slower way: the network still answers", async () => {
  const store: BlockStore = { get: async () => { throw new Error("quota"); }, put: async () => { throw new Error("quota"); } };
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
