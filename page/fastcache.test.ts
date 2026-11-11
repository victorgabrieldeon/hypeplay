import { expect, test } from "bun:test";
import { cacheKey, cachedFetch, openCache } from "./fastcache";

const WASM = "https://123.discordsays.com/.proxy/p/pass-one.mac/ps2/sles-50000/fast/ps2web.wasm?v=aaaaaaaaaaaa";

/** Cache Storage's one cache, in memory: what was put, by address. */
function memoryCache() {
  const kept = new Map<string, { body: Uint8Array; type: string }>();
  const cache = {
    async match(key: string) {
      const k = kept.get(key);
      return k && new Response(k.body.slice(), { headers: { "Content-Type": k.type } });
    },
    async put(key: string, res: Response) {
      kept.set(key, { body: new Uint8Array(await res.arrayBuffer()), type: res.headers.get("content-type") ?? "" });
    },
    async keys() {
      return [...kept.keys()].map((k) => new Request(k));
    },
    async delete(r: Request) {
      return kept.delete(r.url);
    },
  };
  return { kept, cache: cache as unknown as Cache };
}

function network(body = "wasm bytes") {
  const asked: string[] = [];
  const base = (async (input: RequestInfo | URL) => {
    asked.push(String(input));
    return new Response(body, { headers: { "Content-Type": "application/wasm", "Content-Encoding": "gzip" } });
  }) as typeof fetch;
  return { asked, base };
}

const settle = () => Bun.sleep(5);

test("the key is the address without the pass, for the .wasm and .data with a version only", () => {
  // (Discord's proxy prefix is part of the path: the pass is still found after it)
  expect(cacheKey(WASM)?.key).toBe("https://123.discordsays.com/hypeplay-fast/ps2/sles-50000/fast/ps2web.wasm?v=aaaaaaaaaaaa");
  const direct = "https://app.example/p/pass-one.mac/ps2/sles-50000/fast/ps2web.wasm?v=aaaaaaaaaaaa";
  expect(cacheKey(direct)).toEqual({ key: "https://app.example/hypeplay-fast/ps2/sles-50000/fast/ps2web.wasm?v=aaaaaaaaaaaa", family: "https://app.example/hypeplay-fast/ps2/sles-50000/fast/ps2web.wasm" });
  expect(cacheKey(direct.replace("pass-one.mac", "pass-two.mac"))?.key).toBe(cacheKey(direct)!.key);
  expect(cacheKey(direct.replace("wasm", "data"))?.key).toEndWith("ps2web.data?v=aaaaaaaaaaaa");
  for (const no of [direct.replace("?v=aaaaaaaaaaaa", ""), direct.replace("ps2web.wasm", "ps2web.js"), `${direct}&x=1`, direct.replace("/fast/", "/game/"), direct.replace("v=aaaaaaaaaaaa", "v=../x"), "not a url"])
    expect(cacheKey(no)).toBeNull();
});

const ORIGIN = "https://app.example/p/pass-one.mac/ps2/sles-50000/fast/";

test("first from the network, kept whole; then from the cache, at another sign-in too", async () => {
  const { kept, cache } = memoryCache();
  const net = network();
  const f = cachedFetch(net.base, async () => cache, () => ORIGIN);
  const first = await f("ps2web.wasm?v=v1");
  expect(first.headers.get("content-type")).toBe("application/wasm");
  expect(await first.text()).toBe("wasm bytes");
  await settle();
  expect([...kept.keys()]).toEqual(["https://app.example/hypeplay-fast/ps2/sles-50000/fast/ps2web.wasm?v=v1"]);
  // (what's kept has only its type: the gzip the network said is already undone)
  expect(kept.values().next().value!.type).toBe("application/wasm");
  const other = cachedFetch(net.base, async () => cache, () => ORIGIN.replace("pass-one", "pass-two"));
  const again = await other("ps2web.wasm?v=v1");
  expect(await again.text()).toBe("wasm bytes");
  expect(again.headers.get("content-type")).toBe("application/wasm");
  expect(net.asked).toEqual(["ps2web.wasm?v=v1"]);
});

test("a new version replaces the old one; other requests go straight to the network", async () => {
  const { kept, cache } = memoryCache();
  const net = network();
  const f = cachedFetch(net.base, async () => cache, () => ORIGIN);
  await (await f("ps2web.data?v=v1")).text();
  await (await f("ps2web.wasm?v=v1")).text();
  await settle();
  await (await f("ps2web.data?v=v2")).text();
  await settle();
  expect([...kept.keys()].map((k) => k.slice(k.lastIndexOf("/") + 1)).sort()).toEqual(["ps2web.data?v=v2", "ps2web.wasm?v=v1"]);
  net.asked.length = 0;
  await f("disc.iso", { method: "HEAD" });
  await f("ps2web.wasm?v=v1", { method: "HEAD" });
  await f("ps2web.wasm?v=v1", { headers: { range: "bytes=0-1" } });
  await f("../save");
  expect(net.asked).toEqual(["disc.iso", "ps2web.wasm?v=v1", "ps2web.wasm?v=v1", "../save"]);
});

test("no cache, a cache that fails, or a failed answer: the network as before, nothing kept", async () => {
  const net = network();
  expect(await (await cachedFetch(net.base, async () => null, () => ORIGIN)("ps2web.wasm?v=v1")).text()).toBe("wasm bytes");
  const broken = { match: async () => Promise.reject(new Error("blocked")), put: async () => Promise.reject(new Error("full")), keys: async () => [], delete: async () => false } as unknown as Cache;
  expect(await (await cachedFetch(net.base, async () => broken, () => ORIGIN)("ps2web.wasm?v=v1")).text()).toBe("wasm bytes");
  await settle();
  const { kept, cache } = memoryCache();
  const missing = (async () => new Response("Não encontrado", { status: 404 })) as unknown as typeof fetch;
  expect((await cachedFetch(missing, async () => cache, () => ORIGIN)("ps2web.wasm?v=v1")).status).toBe(404);
  await settle();
  expect(kept.size).toBe(0);
  // (Cache Storage absent, or refused, as an opaque origin's)
  expect(await openCache(undefined)()).toBeNull();
  expect(await openCache({ open: () => Promise.reject(new DOMException("no", "SecurityError")) } as unknown as CacheStorage)()).toBeNull();
});
