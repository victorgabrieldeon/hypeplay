/**
 * The Budokai Tenkaichi 3 Discord Activity's server (docs/2026-10-29-plugin-bt3-design.md).
 *
 *   /, entry.js, /icon.svg            public: the entry page signs in with Discord (page/entry.html, entry.ts)
 *   /token                            POST { code }: the Discord code for a pass (discord.ts, pass.ts)
 *   /p/<pass>/                        the game's page (page/index.html), framed by the entry page
 *             status, upload, retry   its state, the disc image's upload, "Tentar de novo"
 *             game/<file>             the compiled game, from a fixed list
 *             game/disc/...           the disc image in 1 MiB pieces, read straight from it
 *             game/net/ws, net/queue  online rooms (rooms.ts)
 *
 * Everything runs as an opaque origin (CSP sandbox), even opened straight from the address bar. That makes every
 * fetch cross-origin, hence the CORS headers. The entry page is the exception: the Discord SDK needs a real origin.
 */
import type { Server, WebSocketHandler } from "bun";
import { join } from "node:path";
import type { Discord } from "./discord";
import type { Passes } from "./pass";
import { NetRooms, parseQueueParams, parseRoomParams, type QueueParams, type RoomParams } from "./rooms";
import { createDiscStore, MAX_PIECE } from "./upload";

/** The compiled game's files: nothing else from build/ is ever served. */
export const GAME_FILES = new Set([
  "index.html",
  "net.js",
  "net.css",
  "bt3-jspi.js",
  "bt3-jspi.wasm",
  "bt3-async.js",
  "bt3-async.wasm",
  "icon-180.png",
  "icon-192.png",
  "icon-512.png",
  "manifest.webmanifest",
]);

export const PIECE = 1024 * 1024;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  png: "image/png",
  svg: "image/svg+xml",
  json: "application/json",
  webmanifest: "application/manifest+json",
  bin: "application/octet-stream",
};

/** Only Discord may frame it: the Activity, and in it the entry page (on *.discordsays.com). */
const FRAME_ANCESTORS = "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com";

export const HEADERS = {
  "Content-Security-Policy": `sandbox allow-scripts allow-forms allow-popups allow-downloads; ${FRAME_ANCESTORS}`,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-cache",
};

const ENTRY_HEADERS = { "Content-Security-Policy": FRAME_ANCESTORS, "Cache-Control": "no-cache" };

export type NetData = { kind: "room"; params: RoomParams } | { kind: "queue"; params: QueueParams };

const typeOf = (name: string) => TYPES[name.slice(name.lastIndexOf(".") + 1)] ?? TYPES.bin!;
/** The last segment with a slash after it, relative: page addresses need the trailing slash. */
const slashed = (pathname: string) => `${pathname.slice(pathname.lastIndexOf("/") + 1)}/`;

export interface Bt3Options {
  /** The data folder (/app/data/bt3/). */
  dir: string;
  /** page/: the entry page, the game's page and the icon. */
  pageDir: string;
  /** page/entry.ts, bundled with the Discord SDK (index.ts). */
  entryJs: string;
  passes: Passes;
  discord: Pick<Discord, "signIn">;
  now?: () => number;
}

export function createBt3({ dir, pageDir, entryJs, passes, discord, now = () => Date.now() }: Bt3Options) {
  const disc = createDiscStore(dir, { now });
  const rooms = new NetRooms(now);
  function respond(body: ConstructorParameters<typeof Response>[0], status = 200, headers: Record<string, string> = {}) {
    return new Response(body, { status, headers: { ...HEADERS, ...headers } });
  }
  const text = (body: string, status: number) => respond(body, status, { "Content-Type": "text/plain; charset=utf-8" });
  const json = (body: unknown, status = 200) => respond(JSON.stringify(body), status, { "Content-Type": TYPES.json! });

  async function file(path: string, type = typeOf(path), headers: Record<string, string> = {}) {
    const f = Bun.file(path);
    return (await f.exists()) ? respond(f, 200, { "Content-Type": type, ...headers }) : text("Não encontrado", 404);
  }

  async function discIndex() {
    const f = Bun.file(disc.paths.iso);
    return (await f.exists()) ? { size: f.size, piece: PIECE } : null;
  }

  async function game(rest: string, req: Request, server: Server<NetData> | undefined): Promise<Response | undefined> {
    if (rest === "" || GAME_FILES.has(rest)) return file(join(disc.paths.build, rest || "index.html"));
    if (rest === "disc/index.json") {
      const index = await discIndex();
      return index ? json(index) : text("Sem ISO no servidor", 404);
    }
    const piece = /^disc\/(\d{5})\.bin$/.exec(rest);
    if (piece) {
      const index = await discIndex();
      const n = Number(piece[1]);
      if (!index || n * PIECE >= index.size) return text("Não encontrado", 404);
      const blob = Bun.file(disc.paths.iso).slice(n * PIECE, Math.min(index.size, (n + 1) * PIECE));
      return respond(blob, 200, { "Content-Type": TYPES.bin!, "Cache-Control": "private, max-age=31536000, immutable" });
    }
    if (rest === "net/ws" || rest === "net/queue") {
      const q = new URL(req.url).searchParams;
      let data: NetData;
      if (rest === "net/queue") data = { kind: "queue", params: parseQueueParams(q) };
      else {
        const params = parseRoomParams(q);
        if (!params) return text("Pedido inválido", 400);
        data = { kind: "room", params };
      }
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) return text("Só WebSocket", 426);
      return server.upgrade(req, { data }) ? undefined : text("Não deu para abrir a conexão", 400);
    }
    // the fork's match log and test statistics: not kept here
    if (rest === "net/stat" || rest === "net/log" || rest === "telemetry") return respond(null, 204);
    return text("Não encontrado", 404);
  }

  async function token(req: Request): Promise<Response> {
    if (req.method !== "POST") return text("Método não permitido", 405);
    const code = ((await req.json().catch(() => null)) as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code || code.length > 200) return json({ error: "Pedido inválido" }, 400);
    try {
      return json({ pass: passes.issue(await discord.signIn(code)) });
    } catch (err) {
      console.error("discord sign-in failed:", err);
      return json({ error: "Não deu para entrar pelo Discord. Feche e abra a atividade de novo." }, 502);
    }
  }

  async function handle(req: Request, server?: Server<NetData>): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return respond(null, 204);
    if (pathname === "/icon.svg") return file(join(pageDir, "icon.svg"));
    if (pathname === "/") return new Response(Bun.file(join(pageDir, "entry.html")), { headers: { ...ENTRY_HEADERS, "Content-Type": TYPES.html! } });
    if (pathname === "/entry.js") return new Response(entryJs, { headers: { ...ENTRY_HEADERS, "Content-Type": TYPES.js! } });
    if (pathname === "/token") return token(req);
    const m = /^\/p\/([\w.-]+)(\/.*)?$/.exec(pathname);
    if (!m) return text("Não encontrado", 404);
    const pass = await passes.verify(m[1]!);
    if (!pass) return text("Acesso vencido: feche e abra a atividade de novo.", 403);
    const path = m[2];
    if (path === undefined || path === "/game") return respond(null, 301, { Location: slashed(pathname) });
    const rest = path.slice(1);
    if (rest.startsWith("game/")) return game(rest.slice(5), req, server);
    switch (rest) {
      case "":
        return file(join(pageDir, "index.html"));
      case "status":
        return json(await disc.status(pass));
      case "upload": {
        if (req.method === "GET") return json(await disc.progress());
        if (req.method !== "PUT") return text("Método não permitido", 405);
        const q = new URL(req.url).searchParams;
        const offset = Number(q.get("offset"));
        const size = Number(q.get("size"));
        if (Number(req.headers.get("content-length") ?? 0) > MAX_PIECE) return json({ error: "Pedaço grande demais", code: "size" }, 413);
        const body = new Uint8Array(await req.arrayBuffer());
        const result = await disc.put(pass, offset, size, body);
        return result.ok
          ? json({ received: result.received, done: result.done })
          : json({ error: result.error, code: result.code, received: result.received }, result.status);
      }
      case "retry":
        if (req.method !== "POST") return text("Método não permitido", 405);
        await disc.retry();
        return respond(null, 204);
    }
    return text("Não encontrado", 404);
  }

  const websocket: WebSocketHandler<NetData> = {
    open(ws) {
      if (ws.data.kind === "room") rooms.openRoom(ws, ws.data.params);
      else rooms.openQueue(ws, ws.data.params);
    },
    message(ws, msg) {
      rooms.message(ws, msg);
    },
    close(ws, code) {
      rooms.close(ws, code);
    },
  };

  return { handle, websocket, rooms, disc };
}

export type Bt3 = ReturnType<typeof createBt3>;
