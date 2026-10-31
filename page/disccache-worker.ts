// disccache.js (bundled at startup, server/index.ts): put by the server at the end of TabStationToo's disc-worker.js,
// where its UrlSource class is in scope. A disc read from the server (the "async" reader, the one for URLs) goes
// through the block cache (disccache.ts); the others (a file, the browser's disk) are already local.
//
// The game's panel (perf.ts) and this worker talk over a BroadcastChannel: the panel says whether the whole disc goes
// to the browser ({t: "fill", disc, on}), the worker how far it is ({t: "progress", disc, have, total, state}), and asks
// for the panel's choice when its disc opens ({t: "hello", disc}).
import { cacheStorageStore, createBlockCache, discPath } from "./disccache";

interface Source {
  mode: string;
  url: string;
  size: number;
  readAsync(offset: number, length: number, request: object): Promise<Uint8Array>;
  read(offset: number, length: number, request: object): Promise<Uint8Array> | Uint8Array;
  cpCache?: ReturnType<typeof createBlockCache>;
}
declare const UrlSource: { prototype: Source };

const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("hypeplay-disc") : null;
const open = new Map<string, ReturnType<typeof createBlockCache>>();
channel?.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as { t?: string; disc?: string; on?: boolean } | null;
  if (m?.t === "fill" && typeof m.disc === "string") open.get(m.disc)?.fill(!!m.on);
});

const original = UrlSource.prototype.read;
UrlSource.prototype.read = function (this: Source, offset, length, request) {
  if (this.mode !== "async") return original.call(this, offset, length, request);
  if (!this.cpCache) {
    const disc = discPath(this.url);
    this.cpCache = createBlockCache({
      size: this.size,
      store: cacheStorageStore(this.url, this.size),
      // (its own reader for each block: the retries, the time limit and the errors the worker knows)
      fetchBlock: (start, n) => this.readAsync(start, n, {}),
      onProgress: (p) => channel?.postMessage({ t: "progress", disc, ...p }),
    });
    open.set(disc, this.cpCache);
    channel?.postMessage({ t: "hello", disc });
  }
  return this.cpCache.read(offset, length);
};
