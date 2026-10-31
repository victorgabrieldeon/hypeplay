// disccache.js (bundled at startup, server/index.ts): put by the server at the end of TabStationToo's disc-worker.js,
// where its UrlSource class is in scope. A disc read from the server (the "async" reader, the one for URLs) goes
// through the block cache (disccache.ts); the others (a file, the browser's disk) are already local.
import { cacheStorageStore, createBlockCache } from "./disccache";

interface Source {
  mode: string;
  url: string;
  size: number;
  readAsync(offset: number, length: number, request: object): Promise<Uint8Array>;
  read(offset: number, length: number, request: object): Promise<Uint8Array> | Uint8Array;
  cpCache?: ReturnType<typeof createBlockCache>;
}
declare const UrlSource: { prototype: Source };

const original = UrlSource.prototype.read;
UrlSource.prototype.read = function (this: Source, offset, length, request) {
  if (this.mode !== "async") return original.call(this, offset, length, request);
  this.cpCache ??= createBlockCache({
    size: this.size,
    store: cacheStorageStore(this.url, this.size),
    // (its own reader for each block: the retries, the time limit and the errors the worker knows)
    fetchBlock: (start, n) => this.readAsync(start, n, {}),
  });
  return this.cpCache.read(offset, length);
};
