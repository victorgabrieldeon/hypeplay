import { expect, test } from "bun:test";
import { edgeDiscUrl, edgeFromEnv, signDisc, verifyDisc, type EdgeDisc } from "../server/edgetoken";
import { CHUNK, handler, parseRange, type Bucket } from "./worker";

const SECRET = "s".repeat(40);
const KEY = "ps2/sles-50000/disc.iso";
const SIZE = 2 * CHUNK + 100;
const DISC: EdgeDisc = { key: KEY, size: SIZE, version: `${SIZE}:1700000000000` };
const disc = new Uint8Array(SIZE).map((_, i) => (i * 13) & 0xff);

/** R2's binding, with every piece asked; and a data center's cache. */
function setup() {
  const gets: number[] = [];
  const bucket: Bucket = {
    get: async (key, { range: { offset, length } }) => {
      gets.push(offset);
      return key === KEY ? { arrayBuffer: async () => disc.slice(offset, offset + length).buffer } : null;
    },
  };
  const kept = new Map<string, Uint8Array>();
  const cache = {
    match: async (k: string) => (kept.has(k) ? new Response(kept.get(k)!.slice()) : undefined),
    put: async (k: string, r: Response) => void kept.set(k, new Uint8Array(await r.arrayBuffer())),
  } as unknown as Cache;
  const later: Promise<unknown>[] = [];
  const worker = handler(() => cache);
  const env = { DISCS: bucket, DISC_EDGE_SECRET: SECRET };
  const ask = (url: string, init?: RequestInit) => worker.fetch(new Request(`https://disc-edge.example.com${url}`, init), env, { waitUntil: (p) => void later.push(p) });
  return { gets, kept, ask, settle: () => Promise.all(later) };
}

const edge = { base: "/p/edge", secret: SECRET };
const signed = (d: EdgeDisc = DISC, now = Date.now()) => edgeDiscUrl(edge, d, now);

test("the token: for its disc (key, size, version), until it expires, with the secret only", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const t = await signDisc(SECRET, DISC, exp);
  expect(await verifyDisc(SECRET, DISC, t)).toBe(true);
  for (const other of [{ ...DISC, key: "ps2/sles-50001/disc.iso" }, { ...DISC, size: SIZE + 1 }, { ...DISC, version: "1:2" }]) expect(await verifyDisc(SECRET, other, t)).toBe(false);
  expect(await verifyDisc("x".repeat(40), DISC, t)).toBe(false);
  expect(await verifyDisc(SECRET, DISC, t, (exp + 1) * 1000)).toBe(false);
  expect(await verifyDisc(SECRET, DISC, `${exp + 1}.${t.split(".")[1]}`)).toBe(false);
  for (const bad of [null, "", "abc", `${exp}.`, `${exp}.${"A".repeat(43)}`]) expect(await verifyDisc(SECRET, DISC, bad)).toBe(false);
  expect(await verifyDisc(SECRET, { ...DISC, size: Number.NaN }, t)).toBe(false);
});

test("the server's side: off without env, both or neither, a path; the address carries all in its query", async () => {
  expect(edgeFromEnv({})).toBeNull();
  expect(() => edgeFromEnv({ DISC_EDGE_URL: "/p/edge" })).toThrow("vão juntos");
  // (a path of the page's origin, ending in /p/<name>: the disc keeps its name in the browser's cache)
  for (const bad of ["https://elsewhere.example/p/edge", "/edge", "/p/edge/more", "/p/"]) expect(() => edgeFromEnv({ DISC_EDGE_URL: bad, DISC_EDGE_SECRET: SECRET })).toThrow("/p/<nome>");
  expect(() => edgeFromEnv({ DISC_EDGE_URL: "/p/edge", DISC_EDGE_SECRET: "short" })).toThrow("32");
  expect(edgeFromEnv({ DISC_EDGE_URL: "/p/edge/", DISC_EDGE_SECRET: SECRET })).toEqual(edge);
  expect(edgeFromEnv({ DISC_EDGE_URL: "/.proxy/p/edge", DISC_EDGE_SECRET: SECRET })?.base).toBe("/.proxy/p/edge");
  const url = new URL(await signed(), "https://x");
  // (the emulator's own path after the base: page/disccache.ts names the disc /ps2/<id>/game/disc.iso either way)
  expect(url.pathname).toBe("/p/edge/ps2/sles-50000/game/disc.iso");
  expect(url.pathname.replace(/^\/p\/[^/]+\//, "/")).toBe("/ps2/sles-50000/game/disc.iso");
  expect(url.searchParams.get("s")).toBe(String(SIZE));
  expect(url.searchParams.get("v")).toBe(DISC.version);
  expect(await verifyDisc(SECRET, DISC, url.searchParams.get("t"))).toBe(true);
});

test("by range across pieces, from R2 once, then from the data center's cache with no trip to R2", async () => {
  const { gets, kept, ask, settle } = setup();
  const url = await signed();
  const r = await ask(url, { headers: { range: `bytes=${CHUNK - 10}-${CHUNK + 9}` } });
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe(`bytes ${CHUNK - 10}-${CHUNK + 9}/${SIZE}`);
  expect(r.headers.get("content-length")).toBe("20");
  expect(r.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(new Uint8Array(await r.arrayBuffer())).toEqual(disc.slice(CHUNK - 10, CHUNK + 10));
  expect(gets).toEqual([0, CHUNK]);
  await settle();
  const v = encodeURIComponent(DISC.version);
  expect([...kept.keys()]).toEqual([`https://disc-edge.example.com/__disc-piece/${KEY}/${v}/0`, `https://disc-edge.example.com/__disc-piece/${KEY}/${v}/1`]);
  // (someone else, another token: the same pieces, and R2 isn't asked anything)
  const again = await ask(await signed(DISC, Date.now() + 5000), { headers: { range: `bytes=0-${CHUNK + 1}` } });
  expect(new Uint8Array(await again.arrayBuffer())).toEqual(disc.slice(0, CHUNK + 2));
  expect(gets).toHaveLength(2);
  // the last piece, shorter; the whole disc; HEAD reads nothing
  expect(new Uint8Array(await (await ask(url, { headers: { range: "bytes=-50" } })).arrayBuffer())).toEqual(disc.slice(SIZE - 50));
  const whole = await ask(url);
  expect(whole.status).toBe(200);
  expect(new Uint8Array(await whole.arrayBuffer())).toEqual(disc);
  const n = gets.length;
  const head = await ask(url, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe(String(SIZE));
  expect(gets).toHaveLength(n);
  // (a new disc under the same key, a new version: its own pieces)
  await ask(await signed({ ...DISC, version: `${SIZE}:1800000000000` }), { headers: { range: "bytes=0-0" } }).then((r) => r.arrayBuffer());
  expect(gets).toHaveLength(n + 1);
});

test("what it refuses: no token or an expired one, another file, a size or version changed, a bad range, other methods", async () => {
  const { ask, gets } = setup();
  expect((await ask("/p/edge/ps2/sles-50000/game/disc.iso")).status).toBe(403);
  expect((await ask(await signed(DISC, Date.now() - 13 * 3600_000))).status).toBe(403);
  const url = new URL(await signed(), "https://x");
  const q = (set: Record<string, string>) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(set)) u.searchParams.set(k, v);
    return `${u.pathname}?${u.searchParams}`;
  };
  // (a token for one disc doesn't open another, nor a longer one)
  expect((await ask(q({}).replace("sles-50000", "sles-50001"))).status).toBe(403);
  expect((await ask(q({ s: String(SIZE * 2) }))).status).toBe(403);
  expect((await ask(q({ v: "1:1" }))).status).toBe(403);
  expect((await ask(q({}).replace("disc.iso", "save"))).status).toBe(404);
  expect((await ask(q({}).replace("/game/disc.iso", "/disc.iso"))).status).toBe(404);
  const bad = await ask(q({}), { headers: { range: "bytes=1-2,5-6" } });
  expect(bad.status).toBe(416);
  expect(bad.headers.get("content-range")).toBe(`bytes */${SIZE}`);
  expect((await ask(q({}), { method: "PUT", body: "x" })).status).toBe(405);
  expect(gets).toEqual([]);
  // (a disc no longer in R2: the read fails, nothing is served as if it were there)
  const gone = await ask(await signed({ ...DISC, key: "ps2/sles-59999/disc.iso" }), { headers: { range: "bytes=0-9" } });
  expect(gone.status).toBe(206);
  await expect(gone.arrayBuffer()).rejects.toThrow();
});

test("parseRange: the same rules as the server's rangeResponse", () => {
  expect(parseRange(null, 100)).toBeNull();
  expect(parseRange("bytes=10-19", 100)).toEqual([10, 19]);
  expect(parseRange("bytes=90-", 100)).toEqual([90, 99]);
  expect(parseRange("bytes=90-500", 100)).toEqual([90, 99]);
  expect(parseRange("bytes=-10", 100)).toEqual([90, 99]);
  for (const bad of ["bytes=-0", "bytes=100-", "bytes=5-2", "bytes=-", "items=0-1"]) expect(parseRange(bad, 100)).toBe("bad");
});
