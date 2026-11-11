/**
 * Small HTTP pieces the routes share: files answered by byte ranges (the PS2 games read their disc that way, and the
 * intro video seeks), the cross-origin isolation headers the PS2 games need for their threads, and pad.js slipped into
 * a game's page.
 */
/** Only Discord may frame it: the Activity, and in it the entry page (on *.discordsays.com). */
export const FRAME_ANCESTORS = "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com";

/**
 * The PS2 games' pages and files: no sandbox (an opaque origin can't be isolated), isolated per frame where the
 * browser knows Document-Isolation-Policy (inside Discord), and by COOP/COEP when opened as a tab of its own.
 */
export const ISOLATED = {
  "Content-Security-Policy": FRAME_ANCESTORS,
  "Document-Isolation-Policy": "isolate-and-require-corp",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-cache",
};

/** Bytes read by range (a disc, discs.ts): `read(start, end)` gives [start, end). */
export interface Ranged {
  size: number;
  read(start: number, end: number): Blob | ReadableStream<Uint8Array>;
}

/**
 * A file, whole or by one `Range: bytes=…`; anything else in Range (several, malformed, outside) is 416. `size` given
 * for an R2 file (discs.ts), whose own size isn't known until asked; a disc (Ranged) brings its own.
 */
export function rangeResponse(req: Request, file: Blob | Ranged, headers: Record<string, string>, size = file.size): Response {
  const base = { ...headers, "Accept-Ranges": "bytes" };
  const range = req.headers.get("range");
  let start = 0;
  let end = size - 1;
  let partial = false;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    const bad = () => new Response(null, { status: 416, headers: { ...base, "Content-Range": `bytes */${size}` } });
    if (!m || (!m[1] && !m[2])) return bad();
    if (!m[1]) {
      const n = Number(m[2]);
      if (n <= 0) return bad();
      start = Math.max(0, size - n);
    } else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    }
    if (start >= size || start > end) return bad();
    partial = true;
  }
  const length = end - start + 1;
  const out = {
    ...base,
    "Content-Length": String(length),
    ...(partial ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
  };
  let body: Blob | ReadableStream<Uint8Array> | null = null;
  if (req.method !== "HEAD") {
    if (!(file instanceof Blob)) body = file.read(start, end + 1);
    else {
      const part = partial ? file.slice(start, end + 1) : file;
      // (an R2 file as it is would answer with a redirect to R2: Discord's proxy and the isolation headers don't allow it)
      body = "presign" in part ? part.stream() : part;
    }
  }
  return new Response(body, { status: partial ? 206 : 200, headers: out });
}

/**
 * Kept by the browser (and any cache on the way) for a year, never asked again: only for an address that changes with
 * what it holds (a `?v=` of its version). The addresses carry the pass (/p/<pass>/), new at each sign-in: the
 * browser's own cache only lasts a pass; across them, Cache Storage (page/fastplay.ts, page/disccache.ts).
 */
export const IMMUTABLE = { "Cache-Control": "public, max-age=31536000, immutable" };

/** A short version of some content, for its address (`?v=`). */
export const versionOf = (content: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(content).digest("hex").slice(0, 12);

/** Immutable when the address asks for this very version (`?v=`); otherwise asked again each time (an old page's). */
export function cacheFor(req: Request, version: string | undefined): Record<string, string> {
  return version && new URL(req.url).searchParams.get("v") === version ? IMMUTABLE : { "Cache-Control": "no-cache" };
}

/**
 * The page with `?v=<version>` on its `src`/`href` to the scripts in `versions` (by name: pad.js, ../../../ps2play.js),
 * so each can be kept immutable and a new one is a new address.
 */
export function withVersions(html: string, versions: Record<string, string>): string {
  return html.replace(/\b((?:src|href)=["'](?:\.{1,2}\/)*)([\w-]+\.js)(["'])/g, (all, before: string, name: string, after: string) =>
    Object.hasOwn(versions, name) ? `${before}${name}?v=${versions[name]}${after}` : all,
  );
}

/** The page with `<script src>` just before its </head>, or null when it has none. */
export function injectPad(html: string, src: string): string | null {
  const at = html.search(/<\/head>/i);
  if (at < 0) return null;
  return `${html.slice(0, at)}<script src="${src}"></script>${html.slice(at)}`;
}
