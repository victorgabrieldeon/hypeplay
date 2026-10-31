/**
 * HypePlay's server, the Discord Activity (docs/2026-10-29-plugin-bt3-design.md).
 *
 *   /, entry.js, /icon.svg                 public: the entry page signs in with Discord (page/entry.html, entry.ts)
 *   /token                                 POST { code }: the Discord code for a pass (discord.ts, pass.ts)
 *   /p/<pass>/                             the home (page/index.html), framed by the entry page
 *             games                        the catalog (games.ts), each game with its state
 *             <id>/status, upload, retry   a game's state, its disc image's upload, "Tentar de novo"
 *             <id>/game/<file>             the compiled game, from its fixed list
 *             <id>/game/disc/...           the disc image in 1 MiB pieces, read straight from it
 *             <id>/game/net/ws, net/queue  online rooms (rooms.ts), one set per game
 *             cover/<key>                  a game's cover (cover.ts): the one sent, or one drawn from its serial
 *             pad, played                  the person's controller maps and last game (people.ts)
 *             ps2                          POST: reserve a PS2 game by its serial (library.ts)
 *             ps2/<id>/                    PATCH name, DELETE; status, upload, retry, cover, save
 *
 * A game's key is "bt3" for BT3's port and "ps2/<id>" for the PS2 games of the library.
 *             homebrew                     the homebrew shelf (homebrew.ts): Homebrew Hub's games
 *             homebrew/<slug>/rom, cover   a homebrew game's ROM and cover, fetched the first time
 *             play/                        the emulator's page (page/play.html), for a homebrew game
 *             emulator/<file>              EmulatorJS and its cores (emulator/data/)
 *
 * Everything runs as an opaque origin (CSP sandbox), even opened straight from the address bar. That makes every
 * fetch cross-origin, hence the CORS headers. The entry page is the exception: the Discord SDK needs a real origin.
 */
import type { Server, WebSocketHandler } from "bun";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Bios } from "./bios";
import { COVER_MAX, coverVersion, generatedCover, imageType, normalizeCover } from "./cover";
import { FRAME_ANCESTORS, injectPad, ISOLATED, rangeResponse } from "./http";
import { iceServers } from "./ice";
import { authorizeUrl, type Discord } from "./discord";
import { GAMES, type Game } from "./games";
import { BT3_SERIAL } from "./iso9660";
import { ID, PS2_MAX, PS2_MIN, type Library, type Ps2Game } from "./library";
import type { Pass, Passes } from "./pass";
import type { People } from "./people";
import { patchTabStation } from "./ps2page";
import { INBOX, MESSAGE_MAX, type Ps2Rooms } from "./ps2rooms";
import { createHomebrew, type HomebrewShelf } from "./homebrew";
import { NetRooms, parseQueueParams, parseRoomParams, type QueueParams, type RoomParams } from "./rooms";
import { CARD_BYTES, type Saves } from "./saves";
import { createDiscStore, MAX_PIECE, type DiscStore, type Status } from "./upload";

export const PIECE = 1024 * 1024;

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  wasm: "application/wasm",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  json: "application/json",
  webmanifest: "application/manifest+json",
  webp: "image/webp",
  mp4: "video/mp4",
  woff2: "font/woff2",
  data: "application/octet-stream",
  bin: "application/octet-stream",
};

/** The home's own scripts (page/home/), plain ES modules. */
const HOME_FILES = new Set(["app.js", "library.js", "drawer.js", "wizard.js", "controller.js", "pads.js", "settings.js", "intro.js", "homebrew.js", "gamepadnav.js"]);
/** TabStationToo's files (emulator/ps2/, pinned by emulator/ps2-files.json): nothing else of that folder is served. */
const ENGINE_FILES = new Set(
  (JSON.parse(readFileSync(join(import.meta.dir, "..", "emulator", "ps2-files.json"), "utf8")) as { files: { path: string }[] }).files
    .map((f) => f.path)
    .filter((p) => p !== "index.html"),
);
/** The pages' typefaces (titles, text, serials), from their packages (OFL), served from here: nothing is fetched elsewhere. */
const FONTS: Record<string, string> = {
  "unbounded-latin-wght-normal.woff2": "@fontsource-variable/unbounded",
  "manrope-latin-wght-normal.woff2": "@fontsource-variable/manrope",
  "jetbrains-mono-latin-wght-normal.woff2": "@fontsource-variable/jetbrains-mono",
};

export const HEADERS = {
  "Content-Security-Policy": `sandbox allow-scripts allow-forms allow-popups allow-downloads; ${FRAME_ANCESTORS}`,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
  "Cache-Control": "no-cache",
};

/** Homebrew files and the emulator: a new version keeps the address, so a day, not forever like the disc pieces. */
const DAY = { "Cache-Control": "private, max-age=86400" };

const ENTRY_HEADERS = { "Content-Security-Policy": FRAME_ANCESTORS, "Cache-Control": "no-cache" };

/** The intro played before a game (intro.mp4 in the data folder): an MP4 up to this size. */
const INTRO_MAX = 64 * 1024 ** 2;
/** An MP4 (ISO media) starts with its "ftyp" box: 4 bytes of size, then "ftyp". */
const isMp4 = (b: Uint8Array) => b.length > 12 && String.fromCharCode(...b.subarray(4, 8)) === "ftyp";

export type NetData = { game: string } & ({ kind: "room"; params: RoomParams } | { kind: "queue"; params: QueueParams });

const typeOf = (name: string) => TYPES[name.slice(name.lastIndexOf(".") + 1)] ?? TYPES.bin!;
/** The last segment with a slash after it, relative: page addresses need the trailing slash. */
const slashed = (pathname: string) => `${pathname.slice(pathname.lastIndexOf("/") + 1)}/`;

export interface AppOptions {
  /** The data folder (/app/data/): each game's in <id>/. */
  dir: string;
  /** page/: the entry page, the game's page and the icon. */
  pageDir: string;
  /** page/entry.ts, bundled with the Discord SDK (index.ts). */
  entryJs: string;
  passes: Passes;
  discord: Pick<Discord, "signIn">;
  games?: Game[];
  /** <dir>/homebrew/ by default; index.ts starts its refreshes. */
  homebrew?: HomebrewShelf;
  /** emulator/data/, filled by emulator/fetch.ts. */
  emulatorDir?: string;
  now?: () => number;
  /** The PS2 library (library.ts) and what's kept per person; without them, the PS2 routes answer 404. */
  library?: Library;
  saves?: Saves;
  people?: People;
  ps2Rooms?: Ps2Rooms;
  /** The app's public address (PUBLIC_URL), for "Abrir no navegador" and signing in from a browser (/login, /auth). */
  publicUrl?: string;
  /** The Discord app's id: a browser's sign-in goes to its page (discord.ts' authorizeUrl). */
  clientId?: string;
  /** TabStationToo's files, emulator/ps2/ by default (emulator/ps2-fetch.ts). */
  ps2Engine?: string;
  /** The PS2 BIOS, sent once for the whole server (bios.ts); without it the PS2 games wait for one. */
  bios?: Bios;
  /** A TURN relay for the PS2 games' online (TURN_URL, TURN_SECRET). */
  turn?: { url: string; secret: string };
  /** The page's bundled scripts by name (iso.js, pad.js…), served under /p/<pass>/. */
  scripts?: Record<string, string>;
}

/** One game of the home's catalog: BT3's port or a PS2 game of the library. */
export interface CatalogEntry {
  key: string;
  kind: "port" | "recomp";
  id: string;
  name: string;
  serial?: string;
  platform: string;
  year?: number;
  tags: string[];
  blurb?: string;
  disc?: string;
  steps: string[];
  minIso: number;
  maxIso: number;
  cover: string;
  colors?: [string, string];
  status: Status;
  rooms: number;
  open: { code: string; host: string; since: number; busy: boolean }[];
  by?: string;
}

const PS2_DISC = "Um disco de PS2 que você tem. Roda no TabStationToo (PCSX2 no navegador), em teste.";

export function createApp({
  dir,
  pageDir,
  entryJs,
  passes,
  discord,
  games = GAMES,
  homebrew = createHomebrew({ dir: join(dir, "homebrew") }),
  emulatorDir = join(import.meta.dir, "..", "emulator", "data"),
  now = () => Date.now(),
  library,
  saves,
  people,
  ps2Rooms,
  publicUrl = "",
  clientId = "",
  turn,
  scripts = {},
  bios,
  ps2Engine = join(import.meta.dir, "..", "emulator", "ps2"),
}: AppOptions) {
  const shelf = new Map(
    games.map((g) => [g.id, { game: g, disc: createDiscStore(join(dir, g.id), { now, min: g.minIso, max: g.maxIso }), rooms: new NetRooms(now) }]),
  );
  type Shelf = NonNullable<ReturnType<typeof shelf.get>>;
  function respond(body: ConstructorParameters<typeof Response>[0], status = 200, headers: Record<string, string> = {}) {
    return new Response(body, { status, headers: { ...HEADERS, ...headers } });
  }
  const text = (body: string, status: number) => respond(body, status, { "Content-Type": "text/plain; charset=utf-8" });
  const json = (body: unknown, status = 200) => respond(JSON.stringify(body), status, { "Content-Type": TYPES.json! });

  async function file(path: string, type = typeOf(path), headers: Record<string, string> = {}) {
    const f = Bun.file(path);
    return (await f.exists()) ? respond(f, 200, { "Content-Type": type, ...headers }) : text("Não encontrado", 404);
  }

  let warned = false;
  /**
   * A game's page with pad.js (the mapped controller) and overlay.js (volume, screen filter) slipped in; `pad` is the
   * relative address of pad.js, overlay.js sits next to it. Without a </head>, the page as it is.
   */
  async function page(path: string, pad: string, headers: Record<string, string>, adjust: (html: string) => string = (h) => h) {
    const f = Bun.file(path);
    if (!(await f.exists())) return text("Não encontrado", 404);
    let html: string;
    try {
      html = adjust(await f.text());
    } catch (err) {
      console.error(err);
      return new Response(`O emulador mudou e a página dele precisa de revisão (server/ps2page.ts).`, { status: 500, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
    }
    // (the app's public address: overlay.js' "Abrir no navegador" shows the link itself, Discord may never answer)
    if (publicUrl) html = html.replace(/<\/head>/i, `<meta name="hypeplay-public" content="${publicUrl.replace(/[&"<>]/g, "")}">$&`);
    // (each goes in just before </head>: pad.js first, then overlay.js)
    const withPad = injectPad(html, pad);
    const both = withPad && injectPad(withPad, pad.replace(/pad\.js$/, "overlay.js"));
    if (both === null && !warned) {
      warned = true;
      console.warn(`${path}: no </head>, served without pad.js and overlay.js`);
    }
    return new Response(both ?? html, { headers: { ...headers, "Content-Type": TYPES.html! } });
  }

  async function discIndex({ disc }: Shelf) {
    const f = Bun.file(disc.paths.iso);
    return (await f.exists()) ? { size: f.size, piece: PIECE } : null;
  }

  async function game(on: Shelf, rest: string, req: Request, server: Server<NetData> | undefined): Promise<Response | undefined> {
    const { disc } = on;
    // (the port plays online from its own main menu: overlay.js says so in the game's panel)
    if (rest === "" || rest === "index.html")
      return page(join(disc.paths.build, "index.html"), "../../pad.js", HEADERS, (html) => html.replace("</head>", '<meta name="hypeplay-online" content="menu">\n</head>'));
    if (on.game.files.has(rest)) return file(join(disc.paths.build, rest));
    if (rest === "disc/index.json") {
      const index = await discIndex(on);
      return index ? json(index) : text("Sem ISO no servidor", 404);
    }
    const piece = /^disc\/(\d{5})\.bin$/.exec(rest);
    if (piece) {
      const index = await discIndex(on);
      const n = Number(piece[1]);
      if (!index || n * PIECE >= index.size) return text("Não encontrado", 404);
      const blob = Bun.file(disc.paths.iso).slice(n * PIECE, Math.min(index.size, (n + 1) * PIECE));
      return respond(blob, 200, { "Content-Type": TYPES.bin!, "Cache-Control": "private, max-age=31536000, immutable" });
    }
    if (rest === "net/ws" || rest === "net/queue") {
      const q = new URL(req.url).searchParams;
      let data: NetData;
      if (rest === "net/queue") data = { game: on.game.id, kind: "queue", params: parseQueueParams(q) };
      else {
        const params = parseRoomParams(q);
        if (!params) return text("Pedido inválido", 400);
        data = { game: on.game.id, kind: "room", params };
      }
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) return text("Só WebSocket", 426);
      return server.upgrade(req, { data }) ? undefined : text("Não deu para abrir a conexão", 400);
    }
    // the fork's match log and test statistics: not kept here
    if (rest === "net/stat" || rest === "net/log" || rest === "telemetry") return respond(null, 204);
    return text("Não encontrado", 404);
  }

  /** PUT <game>/upload, the same for BT3 and the PS2 games; `done` runs once the whole image is in. */
  async function upload(disc: DiscStore, req: Request, pass: Pass, done?: () => Promise<{ ok: true } | { ok: false; message: string }>) {
    if (req.method === "GET") return json(await disc.progress());
    if (req.method !== "PUT") return text("Método não permitido", 405);
    const q = new URL(req.url).searchParams;
    const offset = Number(q.get("offset"));
    const size = Number(q.get("size"));
    if (Number(req.headers.get("content-length") ?? 0) > MAX_PIECE) return json({ error: "Pedaço grande demais", code: "size" }, 413);
    const body = new Uint8Array(await req.arrayBuffer());
    const result = await disc.put(pass, offset, size, body);
    if (!result.ok) return json({ error: result.error, code: result.code, received: result.received }, result.status);
    if (result.done && done) {
      const checked = await done();
      if (!checked.ok) return json({ error: checked.message, code: "disc" }, 400);
    }
    return json({ received: result.received, done: result.done });
  }

  async function body<T>(req: Request): Promise<T | null> {
    return (await req.json().catch(() => null)) as T | null;
  }

  /** A PS2 game plays as soon as its disc is in and checked, once the server has the BIOS: nothing is compiled. */
  async function ps2Status(id: string, pass: Pass): Promise<Status> {
    const s = await library!.disc(id).status(pass);
    if (s.state === "empty" || s.state === "uploading" || (s.state === "failed" && s.refused)) return s;
    if (!(await Bun.file(library!.paths(id).iso).exists())) return s;
    return (await bios?.info())?.present ? { state: "ready" } : { state: "needs-bios" };
  }

  async function ps2Entry(g: Ps2Game, pass: Pass): Promise<CatalogEntry> {
    const status = await ps2Status(g.id, pass);
    const open = ps2Rooms?.list(g.id) ?? [];
    return {
      key: `ps2/${g.id}`,
      kind: "recomp",
      id: g.id,
      name: g.name,
      serial: g.serial,
      platform: "PlayStation 2",
      tags: ["Experimental"],
      disc: PS2_DISC,
      steps: [],
      minIso: PS2_MIN,
      maxIso: PS2_MAX,
      cover: `cover/ps2/${g.id}?v=${g.cover ? `${g.coverAt ?? g.at}-c` : coverVersion(g.serial, g.name)}`,
      status,
      rooms: open.length,
      open,
      by: g.by.name,
    };
  }

  /** Where a port's sent cover is kept (beside its disc image). */
  const portCover = (id: string) => join(dir, id, "cover.webp");

  /** PUT or DELETE of a game's cover, kept at `path`; `has` records whether it now has one. */
  async function coverUpload(req: Request, path: string, has: (on: boolean) => Promise<unknown>) {
    if (req.method === "DELETE") {
      await rm(path, { force: true });
      await has(false);
      return respond(null, 204);
    }
    if (req.method !== "PUT") return text("Método não permitido", 405);
    if (Number(req.headers.get("content-length") ?? 0) > COVER_MAX) return json({ error: "A capa pode ter até 5 MB" }, 413);
    const made = await normalizeCover(new Uint8Array(await req.arrayBuffer()));
    if (!made.ok) return json({ error: made.error }, made.error.includes("5 MB") ? 413 : 400);
    await writeFile(path, made.image);
    await has(true);
    return respond(null, 204);
  }

  async function catalog(pass: Pass) {
    const ports = await Promise.all(
      [...shelf.values()].map(async ({ game: { files: _, ...g }, disc, rooms }): Promise<CatalogEntry> => {
        const sent = Bun.file(portCover(g.id));
        return {
          ...g,
          key: g.id,
          kind: "port",
          cover: `cover/${g.id}?v=${(await sent.exists()) ? `${sent.lastModified}-c` : coverVersion(BT3_SERIAL, g.name)}`,
          status: await disc.status(pass),
          rooms: rooms.size,
          // (the game's own Dragon Net Battle rooms: their code is what a friend types in Join a Match)
          open: rooms.lobbies(),
        };
      }),
    );
    const ps2 = library ? await Promise.all((await library.list()).map((g) => ps2Entry(g, pass))) : [];
    return { me: pass.name, last: (await people?.last(pass.id)) ?? null, publicUrl, games: [...ports, ...ps2] };
  }

  async function cover(key: string): Promise<Response> {
    const immutable = { "Cache-Control": "private, max-age=31536000, immutable" };
    /** A sent cover, with its own type (WebP once sharp made it one; as sent where sharp couldn't load). */
    const sent = async (path: string) => {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      const type = imageType(new Uint8Array(await f.slice(0, 12).arrayBuffer())) ?? "image/webp";
      return respond(f, 200, { "Content-Type": type, ...immutable });
    };
    const port = shelf.get(key);
    if (port && key === "bt3")
      return (await sent(portCover(key))) ?? respond(generatedCover(BT3_SERIAL, port.game.name), 200, { "Content-Type": TYPES.svg!, ...immutable });
    const id = /^ps2\/(.+)$/.exec(key)?.[1];
    const g = id && library ? await library.get(id) : null;
    if (!g) return text("Não encontrado", 404);
    return (g.cover && (await sent(library!.paths(g.id).cover))) || respond(generatedCover(g.serial, g.name), 200, { "Content-Type": TYPES.svg!, ...immutable });
  }

  /** ps2/<id>/game/…: TabStationToo with the game's disc, its online rooms. All isolated (http.ts). */
  async function ps2Game(req: Request, id: string, rest: string): Promise<Response | undefined> {
    const p = library!.paths(id);
    const isolated = (body: ConstructorParameters<typeof Response>[0], status: number, type: string) =>
      new Response(body, { status, headers: { ...ISOLATED, "Content-Type": type } });
    const notFound = () => isolated("Não encontrado", 404, "text/plain; charset=utf-8");
    if (rest === "" || rest === "index.html") {
      const name = (await library!.get(id))?.name ?? id;
      return page(join(ps2Engine, "index.html"), "../../../pad.js", ISOLATED, (html) => patchTabStation(html, name));
    }
    if (ENGINE_FILES.has(rest)) {
      const f = Bun.file(join(ps2Engine, rest));
      if (!(await f.exists())) return notFound();
      // (the disc reader, with our block cache at its end: page/disccache-worker.ts)
      const cache = rest === "disc-worker.js" ? scripts["disccache.js"] : undefined;
      return isolated(cache ? `${await f.text()}\n${cache}` : f, 200, typeOf(rest));
    }
    if (rest === "disc.iso") {
      const f = Bun.file(p.iso);
      return (await f.exists()) ? rangeResponse(req, f, { ...ISOLATED, "Content-Type": TYPES.bin! }) : notFound();
    }
    return notFound();
  }

  /** ps2/<id>/room…, ice: the online's setting up, for the host's game page and the guest's page (rooms.ts' cousin). */
  async function ps2Room(req: Request, pass: Pass, id: string, rest: string): Promise<Response> {
    if (rest === "ice") return json(iceServers({ turnUrl: turn?.url, turnSecret: turn?.secret, user: pass.id, now: now() }));
    if (!ps2Rooms) return text("Não encontrado", 404);
    if (rest === "room") {
      if (req.method !== "POST") return text("Método não permitido", 405);
      return json({ room: ps2Rooms.create(id, pass) });
    }
    const closing = /^room\/([A-Z2-9]{6})$/.exec(rest);
    if (closing) {
      if (req.method !== "DELETE") return text("Método não permitido", 405);
      return ps2Rooms.close(closing[1]!, pass.id) ? respond(null, 204) : text("Não encontrado", 404);
    }
    const m = /^room\/([A-Z2-9]{6})\/([^/]+)$/.exec(rest);
    if (!m || !INBOX.test(m[2]!)) return text("Não encontrado", 404);
    const [, code, who] = m;
    if (req.method === "GET") {
      const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
      const got = await ps2Rooms.wait(code!, who!, Number.isSafeInteger(after) && after >= 0 ? after : 0);
      return got ? json(got) : json({ error: "no such room" }, 404);
    }
    if (req.method !== "POST") return text("Método não permitido", 405);
    if (Number(req.headers.get("content-length") ?? 0) > MESSAGE_MAX) return json({ error: "too big" }, 413);
    const raw = await req.text();
    if (raw.length > MESSAGE_MAX) return json({ error: "too big" }, 413);
    let message: unknown;
    try {
      message = JSON.parse(raw);
    } catch {
      return json({ error: "bad message" }, 400);
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) return json({ error: "bad message" }, 400);
    return ps2Rooms.post(code!, who!, message) ? json({}) : json({ error: "no such room" }, 404);
  }

  /** Everything under ps2/<id>/ but the game itself. */
  async function ps2(req: Request, pass: Pass, id: string, rest: string): Promise<Response | undefined> {
    const lib = library!;
    if (!(await lib.get(id))) return text("Não encontrado", 404);
    const p = lib.paths(id);
    const disc = lib.disc(id);
    if (rest === "game") return respond(null, 301, { Location: "game/" });
    if (rest.startsWith("game/")) return ps2Game(req, id, rest.slice("game/".length));
    if (rest === "ice" || rest === "room" || rest.startsWith("room/")) return ps2Room(req, pass, id, rest);
    // The online guest's page: only video and their pad, so neither isolated (it opens inside Discord) nor sandboxed.
    if (rest === "watch") return respond(null, 301, { Location: "watch/" });
    if (rest === "watch/") return page(join(pageDir, "watch.html"), "../../../pad.js", ENTRY_HEADERS);
    switch (rest) {
      case "":
        if (req.method === "PATCH") {
          const name = (await body<{ name?: unknown }>(req))?.name;
          if (typeof name !== "string") return text("Pedido inválido", 400);
          await lib.rename(id, name);
          return respond(null, 204);
        }
        if (req.method === "DELETE") {
          await lib.remove(id);
          return respond(null, 204);
        }
        return text("Método não permitido", 405);
      case "status":
        return json(await ps2Status(id, pass));
      case "upload":
        return upload(disc, req, pass, () => lib.verify(id));
      case "retry":
        if (req.method !== "POST") return text("Método não permitido", 405);
        await disc.retry();
        return respond(null, 204);
      case "cover":
        return coverUpload(req, p.cover, (on) => lib.setCover(id, on));
      case "save": {
        if (!saves) return text("Não encontrado", 404);
        if (req.method === "GET") {
          const card = await saves.get(id, pass.id);
          return card ? respond(card, 200, { "Content-Type": TYPES.bin!, "Cache-Control": "no-store" }) : text("Sem save", 404);
        }
        if (req.method !== "PUT") return text("Método não permitido", 405);
        if (Number(req.headers.get("content-length") ?? 0) > CARD_BYTES) return json({ error: "Isso não é um memory card de PS2" }, 413);
        const r = await saves.put(id, pass.id, new Uint8Array(await req.arrayBuffer()));
        return r.ok ? respond(null, 204) : json({ error: r.error }, 400);
      }
    }
    return text("Não encontrado", 404);
  }

  async function homebrewFile(slug: string, which: "rom" | "cover") {
    let path: string | null;
    try {
      path = await homebrew.file(slug, which);
    } catch (err) {
      console.error("homebrew download failed:", err);
      return text("Não deu para baixar o jogo do Homebrew Hub. Tente de novo daqui a pouco.", 502);
    }
    if (!path) return text("Não encontrado", 404);
    const name = which === "rom" ? "rom.bin" : homebrew.get(slug)!.cover!;
    return file(path, typeOf(name), DAY);
  }

  async function token(req: Request): Promise<Response> {
    if (req.method !== "POST") return text("Método não permitido", 405);
    const code = ((await req.json().catch(() => null)) as { code?: unknown } | null)?.code;
    if (typeof code !== "string" || !code || code.length > 200) return json({ error: "Pedido inválido" }, 400);
    try {
      const user = await discord.signIn(code);
      // (the access token goes back to the entry page, which authenticates the Discord SDK with it: opening a link
      // outside Discord, for one, needs that)
      return json({ pass: passes.issue(user), access_token: user.accessToken });
    } catch (err) {
      console.error("discord sign-in failed:", err);
      return json({ error: "Não deu para entrar pelo Discord. Feche e abra a atividade de novo." }, 502);
    }
  }

  // Signing in from a browser (outside Discord, where WebRTC and the PS2 games' isolation work): Discord's own page,
  // and back to <PUBLIC_URL>/auth with a code. `state` ties the two ends together: made here, good once, ten minutes.
  const states = new Map<string, number>();
  const redirectUri = `${publicUrl}/auth`;
  function login(): Response {
    if (!publicUrl || !clientId) return text("Entrar pelo navegador precisa do PUBLIC_URL no servidor.", 404);
    for (const [s, exp] of states) if (exp < now()) states.delete(s);
    const state = randomBytes(18).toString("base64url");
    states.set(state, now() + 10 * 60_000);
    return respond(null, 302, { Location: authorizeUrl(clientId, redirectUri, state) });
  }
  async function auth(req: Request): Promise<Response> {
    const q = new URL(req.url).searchParams;
    const state = q.get("state") ?? "";
    const exp = states.get(state);
    states.delete(state);
    if (!publicUrl || !exp || exp < now()) return text("Essa entrada venceu. Volte e clique em Entrar com o Discord de novo.", 400);
    const code = q.get("code");
    // (no code: cancelled on Discord's page)
    if (!code || code.length > 200) return respond(null, 302, { Location: "/" });
    try {
      return respond(null, 302, { Location: `/p/${passes.issue(await discord.signIn(code, redirectUri))}/` });
    } catch (err) {
      console.error("discord sign-in (browser) failed:", err);
      return text("Não deu para entrar pelo Discord. Volte e tente de novo.", 502);
    }
  }

  async function handle(req: Request, server?: Server<NetData>): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return respond(null, 204);
    if (pathname === "/icon.svg") return file(join(pageDir, "icon.svg"));
    if (pathname === "/") return new Response(Bun.file(join(pageDir, "entry.html")), { headers: { ...ENTRY_HEADERS, "Content-Type": TYPES.html! } });
    if (pathname === "/entry.js") return new Response(entryJs, { headers: { ...ENTRY_HEADERS, "Content-Type": TYPES.js! } });
    if (pathname === "/token") return token(req);
    if (pathname === "/login") return login();
    if (pathname === "/auth") return auth(req);
    const m = /^\/p\/([\w.-]+)(\/.*)?$/.exec(pathname);
    if (!m) return text("Não encontrado", 404);
    const pass = await passes.verify(m[1]!);
    if (!pass) return text("Acesso vencido: feche e abra a atividade de novo.", 403);
    const path = m[2];
    if (path === undefined) return respond(null, 301, { Location: slashed(pathname) });
    if (path === "/") return file(join(pageDir, "index.html"));
    if (path === "/games") return json(await catalog(pass));
    if (path === "/intro.mp4") {
      const where = join(dir, "intro.mp4");
      // sent once from the home's "Servidor" screen, for everyone (like the BIOS); anyone may replace or take it off
      if (req.method === "PUT") {
        if (Number(req.headers.get("content-length") ?? 0) > INTRO_MAX) return json({ error: "O vídeo pode ter até 64 MB" }, 413);
        const video = new Uint8Array(await req.arrayBuffer());
        if (video.length > INTRO_MAX) return json({ error: "O vídeo pode ter até 64 MB" }, 413);
        if (!isMp4(video)) return json({ error: "O vídeo precisa ser MP4" }, 400);
        await writeFile(`${where}.tmp`, video);
        await rename(`${where}.tmp`, where);
        return respond(null, 204);
      }
      if (req.method === "DELETE") {
        await rm(where, { force: true });
        return respond(null, 204);
      }
      const f = Bun.file(where);
      return (await f.exists()) ? rangeResponse(req, f, { ...HEADERS, "Content-Type": TYPES.mp4! }) : text("Sem intro", 404);
    }
    const own = /^\/home\/([\w-]+\.js)$/.exec(path)?.[1];
    if (own && HOME_FILES.has(own)) return file(join(pageDir, "home", own));
    const script = /^\/([\w-]+\.js)$/.exec(path)?.[1];
    if (script && Object.hasOwn(scripts, script)) return respond(scripts[script]!, 200, { "Content-Type": TYPES.js! });
    const font = /^\/fonts\/([\w-]+\.woff2)$/.exec(path)?.[1];
    if (font && Object.hasOwn(FONTS, font))
      return file(join(import.meta.dir, "..", "node_modules", FONTS[font]!, "files", font), TYPES.woff2, { "Cache-Control": "private, max-age=31536000, immutable" });
    if (path.startsWith("/cover/")) return cover(path.slice("/cover/".length));
    if (path === "/pad" && people) {
      if (req.method === "GET") return json(await people.pads(pass.id));
      if (req.method !== "PUT") return text("Método não permitido", 405);
      return (await people.setPads(pass.id, await body(req))) ? respond(null, 204) : text("Pedido inválido", 400);
    }
    if (path === "/bios" && bios) {
      if (req.method === "GET") return json(await bios.info());
      if (req.method !== "PUT") return text("Método não permitido", 405);
      if (Number(req.headers.get("content-length") ?? 0) > 4 * 1024 * 1024) return json({ error: "Isso não parece a BIOS de um PS2 (arquivo de 4 MB)" }, 400);
      const r = await bios.put(pass, new Uint8Array(await req.arrayBuffer()), new URL(req.url).searchParams.get("replace") === "1");
      return r.ok ? respond(null, 204) : json({ error: r.error }, r.status);
    }
    if (path === "/bios.bin" && bios) {
      const f = Bun.file(bios.path);
      return (await f.exists()) ? rangeResponse(req, f, { ...ISOLATED, "Content-Type": TYPES.bin! }) : text("Sem BIOS", 404);
    }
    if (path === "/prefs" && people) {
      if (req.method === "GET") return json(await people.prefs(pass.id));
      if (req.method !== "PUT") return text("Método não permitido", 405);
      return (await people.setPrefs(pass.id, await body(req))) ? respond(null, 204) : text("Pedido inválido", 400);
    }
    if (path === "/played" && people) {
      if (req.method !== "POST") return text("Método não permitido", 405);
      const key = (await body<{ key?: unknown }>(req))?.key;
      const known = typeof key === "string" && (shelf.has(key) || (!!library && /^ps2\//.test(key) && !!(await library.get(key.slice(4)))));
      if (!known) return text("Pedido inválido", 400);
      await people.played(pass.id, key as string);
      return respond(null, 204);
    }
    if (library && path === "/ps2") {
      if (req.method !== "POST") return text("Método não permitido", 405);
      const b = await body<{ serial?: unknown; name?: unknown }>(req);
      if (typeof b?.serial !== "string" || !/^[A-Z]{4}-\d{5}$/.test(b.serial)) return json({ error: "Pedido inválido" }, 400);
      const r = await library.reserve(pass, b.serial, typeof b.name === "string" ? b.name : "");
      return r.ok ? json({ key: `ps2/${r.game.id}`, id: r.game.id }, 201) : json({ exists: r.exists }, 409);
    }
    const sony = library && /^\/ps2\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (sony) return ID.test(sony[1]!) ? ps2(req, pass, sony[1]!, sony[2] ?? "") : text("Não encontrado", 404);
    if (path === "/homebrew") return json({ games: homebrew.list() });
    const hb = /^\/homebrew\/([\w.-]+)\/(rom|cover)$/.exec(path);
    if (hb) return homebrewFile(hb[1]!, hb[2] as "rom" | "cover");
    // (pad.js: a mapped PS2 controller plays the homebrew games too)
    if (path === "/play/") return page(join(pageDir, "play.html"), "../pad.js", HEADERS);
    // (the URL parser already folded any "..": the pattern is the second lock)
    const emu = /^\/emulator\/((?:[\w-][\w.-]*\/)*[\w-][\w.-]*)$/.exec(path);
    if (emu) return file(join(emulatorDir, emu[1]!), undefined, DAY);
    const g = /^\/([\w-]+)(\/.*)?$/.exec(path);
    const on = g && shelf.get(g[1]!);
    if (!on) return text("Não encontrado", 404);
    const sub = g![2];
    if (!sub) return text("Não encontrado", 404);
    if (sub === "/game") return respond(null, 301, { Location: slashed(pathname) });
    const rest = sub.slice(1);
    if (rest.startsWith("game/")) return game(on, rest.slice(5), req, server);
    const { disc } = on;
    switch (rest) {
      case "status":
        return json(await disc.status(pass));
      case "upload":
        return upload(disc, req, pass);
      case "cover":
        // (the address carries the file's time: nothing to record)
        await mkdir(join(dir, on.game.id), { recursive: true });
        return coverUpload(req, portCover(on.game.id), async () => {});
      case "retry":
        if (req.method !== "POST") return text("Método não permitido", 405);
        await disc.retry();
        return respond(null, 204);
    }
    return text("Não encontrado", 404);
  }

  const roomsOf = (ws: { data: NetData }) => shelf.get(ws.data.game)!.rooms;
  const websocket: WebSocketHandler<NetData> = {
    open(ws) {
      if (ws.data.kind === "room") roomsOf(ws).openRoom(ws, ws.data.params);
      else roomsOf(ws).openQueue(ws, ws.data.params);
    },
    message(ws, msg) {
      roomsOf(ws).message(ws, msg);
    },
    close(ws, code) {
      roomsOf(ws).close(ws, code);
    },
  };

  return { handle, websocket, shelf, homebrew };
}

export type App = ReturnType<typeof createApp>;
