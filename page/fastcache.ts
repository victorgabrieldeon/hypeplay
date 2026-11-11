// The "versão rápida"'s two big files (ps2web.wasm and ps2web.data, ~15 MB) kept on the browser's disk (Cache Storage),
// by their version: opened again, even at another sign-in, the game doesn't fetch them from the server again. The page
// (ps2-builder/patch.ts) asks for them as ps2web.<ext>?v=<version> (server/routes.ts); the browser's own cache holds
// them only for a pass, since every address carries it (/p/<pass>/), so here the key is the address without the pass.
//
// Emscripten fetches both with fetch(): fastplay.js, first in the page, puts this in front of it. Without Cache Storage
// (an opaque origin, storage blocked or full), or anything else going wrong here, the file comes from the network as
// before: this only ever saves a download.

export const CACHE_NAME = "hypeplay-fast";
// (anything before /p/<pass>/: Discord's proxy may put /.proxy/ there)
const FILE = /\/p\/[^/]+\/(ps2\/[^/]+\/fast\/ps2web\.(?:wasm|data))$/;

/** Where a file is kept, and the start every version of it shares; null for what isn't kept. */
export function cacheKey(url: string): { key: string; family: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const m = FILE.exec(u.pathname);
  const v = u.searchParams.get("v");
  if (!m || !v || !/^[\w-]+$/.test(v) || [...u.searchParams.keys()].length !== 1) return null;
  const family = `${u.origin}/hypeplay-fast/${m[1]}`;
  return { key: `${family}?v=${v}`, family };
}

/** The cache, once: null where there's none (no Cache Storage, an opaque origin, storage refused). */
export function openCache(storage: CacheStorage | undefined = globalThis.caches): () => Promise<Cache | null> {
  let opened: Promise<Cache | null> | undefined;
  return () => (opened ??= storage ? storage.open(CACHE_NAME).catch(() => null) : Promise.resolve(null));
}

/**
 * `fetch` that answers the kept files from `cache` and keeps them as they come from the network (the response goes on
 * as it arrives; only a complete one is kept, then the other versions of the same file go).
 */
export function cachedFetch(base: typeof fetch, cache: () => Promise<Cache | null>, page: () => string = () => location.href): typeof fetch {
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = input instanceof Request ? input : null;
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const ranged = new Headers(init?.headers ?? req?.headers).has("range");
    let url = "";
    try {
      url = new URL(req ? req.url : String(input), page()).href;
    } catch {}
    const k = method === "GET" && !ranged ? cacheKey(url) : null;
    if (!k) return base(input, init);
    const c = await cache().catch(() => null);
    const hit = c && (await c.match(k.key).catch(() => undefined));
    if (hit) return hit;
    const res = await base(input, init);
    if (!c || res.status !== 200 || !res.body) return res;
    const [mine, kept] = res.body.tee();
    const type = res.headers.get("content-type") ?? "application/octet-stream";
    void c
      .put(k.key, new Response(kept, { headers: { "Content-Type": type } }))
      .then(async () => {
        for (const old of await c.keys()) if (old.url !== k.key && old.url.startsWith(`${k.family}?`)) await c.delete(old);
      })
      .catch(() => {});
    return new Response(mine, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
  return Object.assign(wrapped, base) as typeof fetch;
}

/** In front of the page's fetch (fastplay.ts, before Emscripten's ps2web.js runs). */
export function installFastCache(win: { fetch: typeof fetch } = globalThis) {
  win.fetch = cachedFetch(win.fetch.bind(win), openCache());
}
