import { expect, test } from "bun:test";
import { createChunkCache, discCacheBytes, type Load } from "./chunkcache";

const CHUNK = 10;
const SIZE = 45;
const disc = new Uint8Array(SIZE).map((_, i) => i);

/** A stand-in for R2: the disc's bytes, and every range asked. */
function r2(delay = 0) {
  const asked: [number, number][] = [];
  const load: Load = async (start, end) => {
    asked.push([start, end]);
    if (delay) await Bun.sleep(delay);
    return disc.slice(start, end);
  };
  return { asked, load };
}

const bytes = async (s: ReadableStream<Uint8Array>) => new Uint8Array(await new Response(s).arrayBuffer());

test("a range across pieces, from R2 once, then from memory", async () => {
  const cache = createChunkCache({ maxBytes: 1000, chunk: CHUNK });
  const { asked, load } = r2();
  expect(await bytes(cache.read("d", SIZE, 5, 27, load))).toEqual(disc.slice(5, 27));
  expect(asked).toEqual([[0, 10], [10, 20], [20, 30]]);
  expect(await bytes(cache.read("d", SIZE, 12, 25, load))).toEqual(disc.slice(12, 25));
  expect(asked).toHaveLength(3);
  expect(cache.stats()).toMatchObject({ bytes: 30, chunks: 3, misses: 3, hits: 2 });
});

test("the last piece is shorter, and a read past the end stops at it", async () => {
  const cache = createChunkCache({ maxBytes: 1000, chunk: CHUNK });
  const { asked, load } = r2();
  expect(await bytes(cache.read("d", SIZE, 38, 100, load))).toEqual(disc.slice(38, SIZE));
  expect(asked).toEqual([[30, 40], [40, 45]]);
  expect(await bytes(cache.read("d", SIZE, 20, 20, load))).toEqual(new Uint8Array(0));
});

test("past its size in bytes the least recently used piece goes first", async () => {
  const cache = createChunkCache({ maxBytes: 25, chunk: CHUNK });
  const { asked, load } = r2();
  await bytes(cache.read("d", SIZE, 0, 10, load)); // 0
  await bytes(cache.read("d", SIZE, 10, 20, load)); // 0 1
  await bytes(cache.read("d", SIZE, 0, 1, load)); // 1 0 (0 used again)
  await bytes(cache.read("d", SIZE, 20, 30, load)); // 0 2: 1 goes
  expect(cache.stats()).toMatchObject({ bytes: 20, chunks: 2 });
  asked.length = 0;
  await bytes(cache.read("d", SIZE, 0, 10, load));
  await bytes(cache.read("d", SIZE, 20, 30, load));
  expect(asked).toEqual([]);
  await bytes(cache.read("d", SIZE, 10, 20, load));
  expect(asked).toEqual([[10, 20]]);
});

test("a piece bigger than the whole cache isn't kept; size 0 keeps nothing", async () => {
  const cache = createChunkCache({ maxBytes: 5, chunk: CHUNK });
  const { asked, load } = r2();
  await bytes(cache.read("d", SIZE, 0, 10, load));
  await bytes(cache.read("d", SIZE, 0, 10, load));
  expect(asked).toHaveLength(2);
  expect(cache.stats().bytes).toBe(0);
});

test("two reads of the same piece at once make one GET; another disc is another key", async () => {
  const cache = createChunkCache({ maxBytes: 1000, chunk: CHUNK });
  const { asked, load } = r2(20);
  const [a, b] = await Promise.all([bytes(cache.read("d", SIZE, 0, 10, load)), bytes(cache.read("d", SIZE, 3, 8, load))]);
  expect(a).toEqual(disc.slice(0, 10));
  expect(b).toEqual(disc.slice(3, 8));
  expect(asked).toEqual([[0, 10]]);
  await bytes(cache.read("other", SIZE, 0, 10, load));
  expect(asked).toHaveLength(2);
});

test("a failed GET isn't kept: the next read asks again", async () => {
  const cache = createChunkCache({ maxBytes: 1000, chunk: CHUNK });
  let fail = true;
  const load: Load = async (s, e) => {
    if (fail) throw new Error("R2 down");
    return disc.slice(s, e);
  };
  await expect(bytes(cache.read("d", SIZE, 0, 10, load))).rejects.toThrow("R2 down");
  fail = false;
  expect(await bytes(cache.read("d", SIZE, 0, 10, load))).toEqual(disc.slice(0, 10));
  // (a short answer is an error too, never kept as the piece)
  const short: Load = async (s, e) => disc.slice(s, e - 1);
  await expect(bytes(cache.read("d", SIZE, 10, 20, short))).rejects.toThrow("bytes at 10");
  expect(cache.stats().chunks).toBe(1);
});

test("a long read asks only a few pieces ahead of what was sent", async () => {
  const cache = createChunkCache({ maxBytes: 0, chunk: 1 });
  const big = new Uint8Array(100);
  const asked: number[] = [];
  const s = cache.read("d", big.length, 0, big.length, async (start, end) => {
    asked.push(start);
    return big.slice(start, end);
  });
  await Bun.sleep(5);
  expect(asked.length).toBeLessThanOrEqual(4);
  const reader = s.getReader();
  await reader.read();
  await Bun.sleep(5);
  expect(asked.length).toBeLessThanOrEqual(5);
  await reader.cancel();
});

test("DISC_CACHE_MB: 256 by default, 0 for none, a bad value is an error", () => {
  expect(discCacheBytes({})).toBe(256 * 1024 * 1024);
  expect(discCacheBytes({ DISC_CACHE_MB: "0" })).toBe(0);
  expect(discCacheBytes({ DISC_CACHE_MB: " 64 " })).toBe(64 * 1024 * 1024);
  expect(() => discCacheBytes({ DISC_CACHE_MB: "muito" })).toThrow("DISC_CACHE_MB");
  expect(() => discCacheBytes({ DISC_CACHE_MB: "-1" })).toThrow("DISC_CACHE_MB");
});
