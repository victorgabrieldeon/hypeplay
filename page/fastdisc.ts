// The "versão rápida"'s disc, through the block cache (disccache.ts). Its page (ps2-web-recomp's) reads the disc with
// the page's own fetch, 256 KB at a time by Range (ps2web_fetch, on the page's main thread), with no cache of its own
// past the 64 MB it holds in memory: every opening read it all from the server again. Here the page's fetch, for its
// disc, goes through the cache: what the game read stays on the browser's disk, and the next time it doesn't go out.
// Kept under the emulator's own address for the same disc (/game/disc.iso: the same file, same size), so what one
// brought serves the other. And, like the emulator, the whole disc to the browser in the background unless the
// player chose "Só o que o jogo lê" in the emulator's panel (perf.ts, the same choice).
import { cacheStorageStore, createBlockCache, type BlockStore } from "./disccache";

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The page's disc: ps2/<id>/fast/disc.iso. */
const DISC = /\/fast\/disc\.iso$/;
/** perf.ts' choice: anything but "0" fills. */
const FILL_PREF = "hypeplay.discFill";

/** [start, end] of a "bytes=start-end" Range; null for any other kind. */
export function parseRange(range: string | null): [number, number] | null {
  const m = /^bytes=(\d+)-(\d+)$/.exec(range?.trim() ?? "");
  if (!m) return null;
  const [start, end] = [Number(m[1]), Number(m[2])];
  return end >= start ? [start, end] : null;
}

/** Bytes [start, start + length) of the disc, from the server by Range (a whole 200 is cut; anything else fails). */
export async function readRange(f: Fetch, url: string, start: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
  const r = await f(url, { headers: { Range: `bytes=${start}-${start + length - 1}` }, signal });
  if (r.status !== 206 && r.status !== 200) throw new Error(`disco: ${r.status}`);
  let bytes = new Uint8Array(await r.arrayBuffer());
  if (r.status === 200) bytes = bytes.subarray(start, start + length);
  if (bytes.length !== length) throw new Error("disco: resposta curta");
  return bytes;
}

/** The emulator's address for the same disc: its blocks are kept under it. */
export const sharedDiscUrl = (url: string) => url.replace(DISC, "/game/disc.iso");

export interface FastDiscOptions {
  /** The disc's size (the page's Module.discSize); 0 or less: a HEAD asks. */
  size?: () => number;
  store?: (url: string, size: number) => BlockStore | undefined;
  /** Whether the whole disc goes to the browser in the background. */
  fill?: () => boolean;
  block?: number;
  keep?: number;
  ahead?: number;
}

/** The page's fetch, with its disc's Range reads through the block cache; anything else as it was. */
export function cachedFetch(original: Fetch, opts: FastDiscOptions = {}): Fetch {
  const caches = new Map<string, Promise<ReturnType<typeof createBlockCache>>>();
  const cacheFor = (url: string) => {
    let c = caches.get(url);
    if (!c) {
      c = (async () => {
        let size = opts.size?.() ?? 0;
        if (!(size > 0)) size = Number((await original(url, { method: "HEAD" })).headers.get("content-length")) || 0;
        if (!(size > 0)) throw new Error("disco: sem tamanho");
        const cache = createBlockCache({
          size,
          block: opts.block,
          // (the page keeps 64 MB of the disc itself: here only what's between it and the disk)
          keep: opts.keep ?? 16,
          // (no read-ahead of ours: the page reads ahead itself, many pieces at once, and ours would ask for them again)
          ahead: opts.ahead ?? 0,
          store: (opts.store ?? cacheStorageStore)(sharedDiscUrl(url), size),
          fetchBlock: (start, n, signal) => readRange(original, url, start, n, signal),
        });
        if (opts.fill?.()) {
          // (a disc this big is worth keeping: the browser shouldn't drop it to make room)
          void navigator.storage?.persist?.().catch(() => {});
          void cache.fill(true);
        }
        return cache;
      })();
      // (no size: the next read tries again)
      c.catch(() => caches.delete(url));
      caches.set(url, c);
    }
    return c;
  };

  return function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof input === "object" && "method" in input ? input.method : "GET")).toUpperCase();
    let url: URL;
    try {
      url = new URL(href, typeof location === "undefined" ? undefined : location.href);
    } catch {
      return original(input, init);
    }
    if (method !== "GET" || !DISC.test(url.pathname)) return original(input, init);
    const headers = new Headers(init?.headers ?? (typeof input === "object" && "headers" in input ? input.headers : undefined));
    const range = parseRange(headers.get("range"));
    if (!range) return original(input, init);
    const [start, end] = range;
    return (async () => {
      try {
        const cache = await cacheFor(url.href);
        const bytes = await cache.read(start, end - start + 1, (s, n) => readRange(original, url.href, s, n));
        // (206, never 200: on a 200 the page cuts the range out of what it takes for the whole disc)
        return new Response(bytes as BodyInit, {
          status: 206,
          headers: { "Content-Type": "application/octet-stream", "Content-Range": `bytes ${start}-${start + bytes.length - 1}/*` },
        });
      } catch {
        // (the cache failing is only the old way: straight to the server, the page's own retries after)
        return original(input, init);
      }
    })();
  };
}

/** In the page: its fetch, from now on (before the page's scripts run: fastplay.js is in its head). */
export function installFastDisc() {
  const fill = () => {
    try {
      return localStorage.getItem(FILL_PREF) !== "0";
    } catch {
      return true;
    }
  };
  const size = () => Number((window as unknown as { Module?: { discSize?: number } }).Module?.discSize) || 0;
  window.fetch = cachedFetch(window.fetch.bind(window), { size, fill }) as typeof fetch;
}
