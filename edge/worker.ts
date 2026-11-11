/**
 * The PS2 discs from R2, served near the players (optional; README "Edge para os discos"). A Cloudflare Worker with
 * the discs' bucket bound as DISCS: it answers GET and HEAD of …/ps2/<id>/game/disc.iso?s=…&v=…&t=… (the R2 key
 * ps2/<id>/disc.iso) by byte range,
 * signed by the app's server (server/edgetoken.ts, the same code), and keeps the disc in 1 MiB pieces in the Cache API
 * of the data center that served it. A second player in the same region, or a menu read again, gets the piece from
 * there: the size and version come signed in the address, so a kept piece needs no trip to R2's region at all, much
 * less to the app's server in Canada.
 *
 * Inside Discord the page reaches it by its URL Mappings (a path of <client id>.discordsays.com, say /edge, to this
 * Worker), so for the page it's the same origin: no CORS, and the isolation (COEP) the emulator needs holds.
 */
import { edgeDiscOf, keyOfGamePath, verifyDisc } from "../server/edgetoken";

export const CHUNK = 1024 * 1024;
/** Pieces asked ahead of the one being sent. */
const AHEAD = 4;
/** The emulator's path for a disc (server/edgetoken.ts' gamePath). */
const PATH = /\/(ps2\/[a-z]{4}-\d{5}(?:-\d{1,2})?\/game\/disc\.iso)$/;

/** What the Worker uses of R2's binding (R2Bucket). */
export interface Bucket {
  get(key: string, opts: { range: { offset: number; length: number } }): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
}
export interface Env {
  DISCS: Bucket;
  DISC_EDGE_SECRET: string;
}
interface Ctx {
  waitUntil(p: Promise<unknown>): void;
}

const HEADERS = {
  "Accept-Ranges": "bytes",
  "Content-Type": "application/octet-stream",
  // (the page's own copy is on its disk, page/disccache.ts; and the token changes)
  "Cache-Control": "no-cache",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const text = (body: string, status: number, h: Record<string, string> = {}) => new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...h } });

/** [start, end] of one `bytes=` range, null for none, "bad" for anything this doesn't serve (416). */
export function parseRange(range: string | null, size: number): [number, number] | null | "bad" {
  if (!range) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!m || (!m[1] && !m[2])) return "bad";
  let start: number;
  let end = size - 1;
  if (!m[1]) {
    const n = Number(m[2]);
    if (n <= 0) return "bad";
    start = Math.max(0, size - n);
  } else {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? "bad" : [start, end];
}

/** The data center's cache (caches.default in a Worker); a stand-in in the tests. */
export function handler(cache: () => Cache) {
  return {
    async fetch(req: Request, env: Env, ctx: Ctx): Promise<Response> {
      if (req.method !== "GET" && req.method !== "HEAD") return text("Método não permitido", 405, { Allow: "GET, HEAD" });
      const url = new URL(req.url);
      const path = PATH.exec(url.pathname)?.[1];
      if (!path) return text("Não encontrado", 404);
      const key = keyOfGamePath(path);
      const disc = edgeDiscOf(url, key);
      if (!(await verifyDisc(env.DISC_EDGE_SECRET, disc, url.searchParams.get("t")))) return text("Acesso vencido", 403);
      const { size, version } = disc;
      const r = parseRange(req.headers.get("range"), size);
      if (r === "bad") return new Response(null, { status: 416, headers: { ...HEADERS, "Content-Range": `bytes */${size}` } });
      const [start, end] = r ?? [0, size - 1];
      const headers = { ...HEADERS, "Content-Length": String(end - start + 1), ...(r ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) };
      if (req.method === "HEAD") return new Response(null, { status: r ? 206 : 200, headers });

      // (a piece's place in the cache, under the Worker's own name, the zone the Cache API keeps; the disc's version
      // in it, so a disc sent again under the same key is a new one)
      const at = (i: number) => `${url.origin}/__disc-piece/${key}/${encodeURIComponent(version)}/${i}`;
      async function piece(i: number): Promise<Uint8Array> {
        const kept = await cache().match(at(i));
        if (kept) return new Uint8Array(await kept.arrayBuffer());
        const offset = i * CHUNK;
        const length = Math.min(CHUNK, size - offset);
        const got = await env.DISCS.get(key!, { range: { offset, length } });
        if (!got) throw new Error(`R2 ${key}: no piece ${i} (removed?)`);
        const bytes = new Uint8Array(await got.arrayBuffer());
        if (bytes.length !== length) throw new Error(`R2 ${key}: ${bytes.length} bytes of ${length} at piece ${i}`);
        ctx.waitUntil(cache().put(at(i), new Response(bytes, { headers: { "Cache-Control": "public, max-age=31536000, immutable" } })).catch(() => {}));
        return bytes;
      }
      const first = Math.floor(start / CHUNK);
      const last = Math.floor(end / CHUNK);
      const asked = new Map<number, Promise<Uint8Array>>();
      let next = first;
      const ask = (i: number) => {
        for (; next <= last && next < i + AHEAD; next++) {
          const p = piece(next);
          p.catch(() => {});
          asked.set(next, p);
        }
      };
      let i = first;
      const body = new ReadableStream<Uint8Array>({
        async pull(c) {
          ask(i);
          const bytes = await asked.get(i)!;
          asked.delete(i);
          const base = i * CHUNK;
          c.enqueue(bytes.subarray(Math.max(start, base) - base, Math.min(end + 1, base + bytes.length) - base));
          if (++i > last) c.close();
        },
      });
      return new Response(body, { status: r ? 206 : 200, headers });
    },
  };
}

export default handler(() => (caches as unknown as { default: Cache }).default);
