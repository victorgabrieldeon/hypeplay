import { expect, test } from "bun:test";
import type { BlockStore } from "./disccache";
import { cachedFetch, parseRange, sharedDiscUrl } from "./fastdisc";

const URL_ = "https://hp.example/p/pass/ps2/abc/fast/disc.iso";
const SIZE = 10 * 4 + 3;
const disc = Uint8Array.from({ length: SIZE }, (_, i) => i);

/** The server: the disc by Range (206), anything else 200, and what it was asked. */
function server() {
  const asked: { url: string; method: string; range: string | null }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const range = new Headers(init?.headers).get("range");
    asked.push({ url, method, range });
    if (method === "HEAD") return new Response(null, { headers: { "Content-Length": String(SIZE) } });
    const m = range && /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!m) return new Response("other");
    return new Response(disc.slice(Number(m[1]), Number(m[2]) + 1), { status: 206 });
  }) as typeof fetch;
  return { f, asked };
}

function memStore() {
  const kept = new Map<number, Uint8Array>();
  const keys: string[] = [];
  const make = (url: string, size: number): BlockStore => (
    keys.push(`${url}|${size}`),
    { get: async (n) => kept.get(n) ?? null, put: async (n, b) => void kept.set(n, b), keptBlocks: async () => new Set(kept.keys()) }
  );
  return { kept, keys, make };
}

const read = (f: ReturnType<typeof cachedFetch>, start: number, end: number, url = URL_) => f(url, { headers: { Range: `bytes=${start}-${end}` } });

test("a Range of the page's disc comes through the cache: 206 with just those bytes, the block kept", async () => {
  const s = server();
  const store = memStore();
  const f = cachedFetch(s.f, { size: () => SIZE, block: 10, store: store.make });
  const r = await read(f, 12, 15);
  expect(r.status).toBe(206);
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([12, 13, 14, 15]);
  expect(s.asked.map((a) => a.range)).toEqual(["bytes=10-19"]);
  await new Promise((ok) => setTimeout(ok, 5));
  expect([...store.kept.keys()]).toEqual([1]);
  // (kept under the emulator's address for the same disc)
  expect(store.keys).toEqual(["https://hp.example/p/pass/ps2/abc/game/disc.iso|43"]);
});

test("the next opening reads the kept blocks: nothing goes to the server", async () => {
  const store = memStore();
  const first = server();
  await (await read(cachedFetch(first.f, { size: () => SIZE, block: 10, store: store.make }), 0, 9)).arrayBuffer();
  await new Promise((ok) => setTimeout(ok, 5));
  const again = server();
  const r = await read(cachedFetch(again.f, { size: () => SIZE, block: 10, store: store.make }), 2, 5);
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([2, 3, 4, 5]);
  expect(again.asked).toEqual([]);
});

test("the page's 256 KB pieces at once in one block: one request", async () => {
  const s = server();
  const f = cachedFetch(s.f, { size: () => SIZE, block: 10, store: memStore().make });
  const got = await Promise.all([0, 3, 6].map((o) => read(f, o, o + 1).then(async (r) => [...new Uint8Array(await r.arrayBuffer())])));
  expect(got).toEqual([[0, 1], [3, 4], [6, 7]]);
  expect(s.asked.map((a) => a.range)).toEqual(["bytes=0-9"]);
});

test("without the page's size, a HEAD asks for it", async () => {
  const s = server();
  const f = cachedFetch(s.f, { size: () => 0, block: 10, store: memStore().make });
  expect([...new Uint8Array(await (await read(f, 41, 42)).arrayBuffer())]).toEqual([41, 42]);
  expect(s.asked.map((a) => [a.method, a.range])).toEqual([["HEAD", null], ["GET", "bytes=40-42"]]);
});

test("anything else goes as it was: other addresses, no Range, a HEAD, a PUT", async () => {
  const s = server();
  const f = cachedFetch(s.f, { size: () => SIZE, block: 10, store: memStore().make });
  expect(await (await read(f, 0, 3, "https://hp.example/p/pass/ps2/abc/game/disc.iso")).arrayBuffer()).toBeDefined();
  await f(URL_);
  await f(URL_, { method: "HEAD" });
  await f("https://hp.example/p/pass/ps2/abc/save", { method: "PUT", body: "x" });
  expect(s.asked.map((a) => [a.method, a.range])).toEqual([["GET", "bytes=0-3"], ["GET", null], ["HEAD", null], ["PUT", null]]);
});

test("the cache failing is only the old way: the page's request to the server", async () => {
  const s = server();
  let n = 0;
  const failing = (async (input: RequestInfo | URL, init?: RequestInit) => (n++ === 0 ? Promise.reject(new Error("rede")) : s.f(input, init))) as typeof fetch;
  const f = cachedFetch(failing, { size: () => SIZE, block: 10, store: memStore().make });
  const r = await read(f, 12, 15);
  expect(r.status).toBe(206);
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([12, 13, 14, 15]);
  expect(s.asked.map((a) => a.range)).toEqual(["bytes=12-15"]);
});

test("Range and the shared address", () => {
  expect(parseRange("bytes=0-262143")).toEqual([0, 262143]);
  expect(parseRange("bytes=10-")).toBeNull();
  expect(parseRange("bytes=0-1,4-5")).toBeNull();
  expect(parseRange(null)).toBeNull();
  expect(sharedDiscUrl("https://x/p/a/ps2/g/fast/disc.iso")).toBe("https://x/p/a/ps2/g/game/disc.iso");
});

test("the page's burst (many pieces at once, a disk that takes a while): each block goes out once", async () => {
  const BLOCK = 40;
  const size = BLOCK * 12;
  const whole = Uint8Array.from({ length: size }, (_, i) => i % 256);
  const perBlock = new Map<number, number>();
  const f = async (_: RequestInfo | URL, init?: RequestInit) => {
    const [, s, e] = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init?.headers).get("range") ?? "")!.map(Number) as [number, number, number];
    for (let b = Math.floor(s / BLOCK); b <= Math.floor(e / BLOCK); b++) perBlock.set(b, (perBlock.get(b) ?? 0) + 1);
    await new Promise((ok) => setTimeout(ok, 20));
    return new Response(whole.slice(s, e + 1), { status: 206 });
  };
  const kept = new Map<number, Uint8Array>();
  const slowStore = (): BlockStore => ({
    get: async (n) => (await new Promise((ok) => setTimeout(ok, 2)), kept.get(n) ?? null),
    put: async (n, b) => void kept.set(n, b),
    keptBlocks: async () => new Set(kept.keys()),
  });
  // (the options the page gets, but its size and disk)
  const cached = cachedFetch(f, { size: () => size, block: BLOCK, store: slowStore });
  const got = await Promise.all(Array.from({ length: 16 }, (_, i) => read(cached, i * 10, i * 10 + 9).then(async (r) => [...new Uint8Array(await r.arrayBuffer())])));
  got.forEach((b, i) => expect(b).toEqual([...whole.slice(i * 10, i * 10 + 10)]));
  await new Promise((ok) => setTimeout(ok, 100));
  expect([...perBlock].sort((a, b) => a[0] - b[0])).toEqual([[0, 1], [1, 1], [2, 1], [3, 1]]);
});
