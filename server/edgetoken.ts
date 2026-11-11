/**
 * The optional edge (edge/worker.ts, a Cloudflare Worker near the players) serves the R2 discs only to whom this server
 * lets: a disc's address there carries `?s=<size>&v=<version>&t=<exp>.<mac>`, an HMAC of its R2 key, size, version and
 * expiry with a secret both share (DISC_EDGE_SECRET). The size and version signed here spare the Worker asking R2 for
 * them at each read: a piece kept in its data center is then served with no trip to R2 at all. Only WebCrypto, so the
 * same code runs here (Bun) and in the Worker.
 *
 * Off unless DISC_EDGE_URL and DISC_EDGE_SECRET are set (README "Edge para os discos"): then the PS2 games' pages get
 * their disc's edge address (routes.ts), and inside Discord read it from there (page/edgedisc.ts).
 */

/** How long a disc's edge address works: as long as a pass (pass.ts). */
export const EDGE_TTL_S = 12 * 60 * 60;

export interface Edge {
  /**
   * The edge's address as the page sees it: a path of the page's own origin, Discord's URL Mapping to the Worker, of
   * the form /p/<name> (/p/edge), like a pass: page/disccache.ts names a disc by its path without /p/<…>/, so the disc
   * read from the edge keeps the name, and the blocks on the browser's disk, it has read from here.
   */
  base: string;
  secret: string;
}

/** DISC_EDGE_URL and DISC_EDGE_SECRET, or null without them (off). */
export function edgeFromEnv(env = process.env): Edge | null {
  const base = env.DISC_EDGE_URL?.trim().replace(/\/+$/, "");
  const secret = env.DISC_EDGE_SECRET?.trim();
  if (!base && !secret) return null;
  if (!base || !secret) throw new Error("DISC_EDGE_URL e DISC_EDGE_SECRET vão juntos (README, Edge para os discos)");
  if (!/^(?:\/[\w.-]+)*\/p\/[\w-]+$/.test(base)) throw new Error(`DISC_EDGE_URL: ${base} precisa ser um caminho terminado em /p/<nome> (/p/edge), o da URL Mapping do Discord`);
  if (secret.length < 32) throw new Error("DISC_EDGE_SECRET: 32 caracteres ou mais");
  return { base, secret };
}

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A disc as the edge serves it: its R2 key, its size and its version (discs.ts: a new disc, a new version). */
export interface EdgeDisc {
  key: string;
  size: number;
  version: string;
}

async function mac(secret: string, { key, size, version }: EdgeDisc, exp: number): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", k, enc.encode(`${key}\n${size}\n${version}\n${exp}`)));
}

/** The token for `disc`, good until `exp` (seconds since the epoch). */
export async function signDisc(secret: string, disc: EdgeDisc, exp: number): Promise<string> {
  return `${exp}.${await mac(secret, disc, exp)}`;
}

/** Whether `token` lets `disc` (its key, and the size and version its address says) be read at `now` (ms). */
export async function verifyDisc(secret: string, disc: EdgeDisc, token: string | null, now = Date.now()): Promise<boolean> {
  const m = /^(\d{1,12})\.([\w-]{43})$/.exec(token ?? "");
  if (!m || !Number.isSafeInteger(disc.size) || disc.size <= 0 || !/^[\w.:-]{1,64}$/.test(disc.version)) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= now) return false;
  const want = await mac(secret, disc, exp);
  // (same length always: compared whole, not stopping at the first difference)
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0;
}

/** The emulator's path for the disc with this R2 key (ps2/<id>/disc.iso → ps2/<id>/game/disc.iso), and back. */
export const gamePath = (key: string) => key.replace(/\/disc\.iso$/, "/game/disc.iso");
export const keyOfGamePath = (path: string) => path.replace(/\/game\/disc\.iso$/, "/disc.iso");

/**
 * A disc's edge address: <base>/ps2/<id>/game/disc.iso?s=<size>&v=<version>&t=<token>, the emulator's own path after
 * the base, and the rest in the query: page/disccache.ts keeps the disc's blocks under /ps2/<id>/game/disc.iso, the
 * same as read from here and the same at every sign-in, whatever the token.
 */
export async function edgeDiscUrl(edge: Edge, disc: EdgeDisc, now = Date.now()): Promise<string> {
  const exp = Math.floor(now / 1000) + EDGE_TTL_S;
  const q = new URLSearchParams({ s: String(disc.size), v: disc.version, t: await signDisc(edge.secret, disc, exp) });
  return `${edge.base}/${gamePath(disc.key)}?${q}`;
}

/** The disc an edge address names (its path's R2 key, its s= and v=), for the Worker to check against its t=. */
export function edgeDiscOf(url: URL, key: string): EdgeDisc {
  return { key, size: Number(url.searchParams.get("s")), version: url.searchParams.get("v") ?? "" };
}
