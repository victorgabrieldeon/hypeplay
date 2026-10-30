/**
 * Small HTTP pieces the routes share: files answered by byte ranges (the PS2 games read their disc that way, and the
 * intro video seeks), the cross-origin isolation headers the PS2 games need for their threads, and pad.js slipped into
 * a game's page.
 */
import type { BunFile } from "bun";

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

/** A file, whole or by one `Range: bytes=…`; anything else in Range (several, malformed, outside) is 416. */
export function rangeResponse(req: Request, file: BunFile, headers: Record<string, string>): Response {
  const size = file.size;
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
  const body = req.method === "HEAD" ? null : partial ? file.slice(start, end + 1) : file;
  return new Response(body, { status: partial ? 206 : 200, headers: out });
}

/** The page with `<script src>` just before its </head>, or null when it has none. */
export function injectPad(html: string, src: string): string | null {
  const at = html.search(/<\/head>/i);
  if (at < 0) return null;
  return `${html.slice(0, at)}<script src="${src}"></script>${html.slice(at)}`;
}
