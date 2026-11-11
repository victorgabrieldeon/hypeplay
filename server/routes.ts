/**
 * HypePlay's server, the Discord Activity.
 *
 *   /, entry.js, /icon.svg                 public: the entry page signs in with Discord (page/entry.html, entry.ts)
 *   /token                                 POST { code }: the Discord code for a pass (discord.ts, pass.ts)
 *   /login, /auth                          from a browser: Discord's sign-in page and back with a pass
 *   /p/<pass>/                             the home (page/index.html), framed by the entry page
 *             games                        the catalog (games.ts), each game with its state (304 to its ETag)
 *             home/ws                      the same, pushed as it changes, and who's here while it's open (homefeed.ts)
 *             cover/<key>                  a game's cover (cover.ts): the one sent, or one drawn from its serial
 *             pad, keys, played            the person's controller maps, keys and last game (people.ts)
 *             favorites                    PUT { key, on }: star a game of the library (on) or unstar it (people.ts)
 *             here                         POST: a game's page is still open (its path; empty, it closed): presence.ts
 *             ps2                          POST: reserve a PS2 game by its serial (library.ts)
 *             ps2/<id>/                    PATCH name, DELETE; status, upload, cover, save
 *             ps2/<id>/fast-build          POST: ask for its "versão rápida" (or try again); DELETE: remove it
 *             ps2/<id>/fast/<file>         the "versão rápida" (ps2-builder/), its disc, and the code it met untranslated
 *             vimm                         POST { link, title?, box? }: download a PS2 game from vimm.net into the library (with
 *                                          its box art as the cover); GET: how it goes (vimm.ts); vimm/ws: the same, pushed
 *             friends/<id>                 POST: ask (or accept); DELETE: unfriend, decline or cancel (social.ts)
 *             profile/<id>, users?q=       someone's profile (hours, games, badges); people to add, by name
 *             invite, invite/<id>          POST { to, key }: come play (with my room); POST { accept }: take it or dismiss it
 *             status                       PUT { status, note }: online, away, busy (no invites), invisible
 *             vimm/store, vimm/search?q=   the "loja": Vimm's PS2 lists (month's top, best rated) and search (a letter lists it)
 *             vimm/art/<box|snap>/<file>   a game's box art or screenshot (libretro-thumbnails); vimm/cover/<id>: one drawn
 *
 * A game's key is "ps2/<id>", a PS2 game of the library.
 *
 * Everything runs as an opaque origin (CSP sandbox), even opened straight from the address bar. That makes every
 * fetch cross-origin, hence the CORS headers. The entry page is the exception: the Discord SDK needs a real origin.
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Bios } from "./bios";
import { COVER_MAX, coverVersion, generatedCover, imageType, normalizeCover } from "./cover";
import { createDiscs, type Discs } from "./discs";
import { edgeDiscUrl, type Edge } from "./edgetoken";
import { cacheFor, FRAME_ANCESTORS, IMMUTABLE, injectPad, ISOLATED, rangeResponse, versionOf, withVersions } from "./http";
import { type CloudflareTurn, iceServers, STUN } from "./ice";
import { authorizeUrl, type Discord } from "./discord";
import { FAST_STEPS } from "./games";
import { ID, PS2_MAX, PS2_MIN, type Fast, type Library, type Ps2Game } from "./library";
import { CALL, type Pass, type Passes } from "./pass";
import type { People } from "./people";
import type { Social } from "./social";
import { gameFrom, Presence } from "./presence";
import { createHomeFeed, etagOf, unchanged, type HomeData, type HomeSocket, type HomeView } from "./homefeed";
import { log } from "./log";
import { CAPACITY, decodeList, encodeList, KEY_BYTES, mergeLists } from "../page/pipelines";
import { patchTabStation } from "./ps2page";
import { INBOX, MESSAGE_MAX, type Ps2Rooms } from "./ps2rooms";
import { Relay } from "./relay";
import { CARD_BYTES, type Saves } from "./saves";
import { MAX_PIECE, type DiscStore, type Status } from "./upload";
import type { Vimm } from "./vimm";

/** The "versão rápida"'s files besides its page (ps2-builder's PUBLISHED), with their types. */
const FAST_FILES: Record<string, string> = {
  "ps2web.js": "text/javascript; charset=utf-8",
  "ps2web.wasm": "application/wasm",
  "ps2web.data": "application/octet-stream",
};

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
const HOME_FILES = new Set(["app.js", "ask.js", "library.js", "drawer.js", "wizard.js", "controller.js", "pads.js", "settings.js", "intro.js", "gamepadnav.js", "store.js", "friends.js", "feed.js", "shell.js"]);
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
  "host-grotesk-latin-wght-normal.woff2": "@fontsource-variable/host-grotesk",
  "host-grotesk-latin-ext-wght-normal.woff2": "@fontsource-variable/host-grotesk",
};

/** (also ops.ts': its 429s and /health go to the same sandboxed pages, CORS and all) */
export const HEADERS = {
  "Content-Security-Policy": `sandbox allow-scripts allow-forms allow-popups allow-downloads; ${FRAME_ANCESTORS}`,
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, POST, PATCH, DELETE, OPTIONS",
  // (games' ETag, homefeed.ts: the home's poll reads it back; if-none-match, for whoever asks with it)
  "Access-Control-Allow-Headers": "content-type, if-none-match",
  "Access-Control-Expose-Headers": "ETag",
  "Cache-Control": "no-cache",
};

const ENTRY_HEADERS = { "Content-Security-Policy": FRAME_ANCESTORS, "Cache-Control": "no-cache" };

/** The intro played before a game (intro.mp4 in the data folder): an MP4 up to this size. */
const INTRO_MAX = 64 * 1024 ** 2;
/** An MP4 (ISO media) starts with its "ftyp" box: 4 bytes of size, then "ftyp". */
const isMp4 = (b: Uint8Array) => b.length > 12 && String.fromCharCode(...b.subarray(4, 8)) === "ftyp";

export type NetData = { game: string } & (
  | { kind: "relay"; room: string; role: "host" | "guest"; me: string; watch: boolean }
  /** the vimm download as it goes (vimm.ts watch): `off` once open */
  | { kind: "vimm"; off?: () => void }
  /** the home's feed (homefeed.ts) */
  | ({ kind: "home" } & HomeData)
);

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
  now?: () => number;
  /** The PS2 library (library.ts) and what's kept per person; without them, the PS2 routes answer 404. */
  library?: Library;
  saves?: Saves;
  people?: People;
  /** Friends, hours played and invites (social.ts); without it, those routes answer 404. */
  social?: Social;
  ps2Rooms?: Ps2Rooms;
  /** The app's public address (PUBLIC_URL), for "Abrir no navegador" and signing in from a browser (/login, /auth). */
  publicUrl?: string;
  /** The Discord app's id: a browser's sign-in goes to its page (discord.ts' authorizeUrl). */
  clientId?: string;
  /** TabStationToo's files, emulator/ps2/ by default (emulator/ps2-fetch.ts). */
  ps2Engine?: string;
  /** The PS2 BIOS, sent once for the whole server (bios.ts); without it the PS2 games wait for one. */
  bios?: Bios;
  /** A TURN relay for the PS2 games' online (TURN_URL, TURN_SECRET): the reserve, when Cloudflare's doesn't answer. */
  turn?: { url: string; secret: string };
  /** Cloudflare's TURN (TURN_CF_KEY_ID, TURN_CF_TOKEN; ice.ts), the one the players get when it answers. */
  cloudflare?: CloudflareTurn;
  /** The page's bundled scripts by name (iso.js, pad.js…), served under /p/<pass>/. */
  scripts?: Record<string, string>;
  /** Downloads from vimm.net into the library (vimm.ts); without it, /vimm answers 404. */
  vimm?: Vimm;
  /** Where the discs are played from (discs.ts): R2 when index.ts says so, the local file by default. */
  discs?: Discs;
  /** The optional edge for the R2 discs (edgetoken.ts, edge/worker.ts): their pages get its address. */
  edge?: Edge | null;
}

/** One game of the home's catalog: a PS2 game of the library. */
export interface CatalogEntry {
  key: string;
  kind: "recomp";
  id: string;
  name: string;
  serial?: string;
  platform: string;
  tags: string[];
  disc?: string;
  steps: string[];
  minIso: number;
  maxIso: number;
  cover: string;
  status: Status;
  rooms: number;
  open: { code: string; host: string; since: number; busy: boolean; watchers?: number }[];
  by?: string;
  /** (PS2 games) its "versão rápida" */
  fast?: Fast;
}

const PS2_DISC = "Um disco de PS2 que você tem. Roda no TabStationToo (PCSX2 no navegador), em teste.";

export function createApp({
  dir,
  pageDir,
  entryJs,
  passes,
  discord,
  now = () => Date.now(),
  library,
  saves,
  people,
  social,
  ps2Rooms,
  publicUrl = "",
  clientId = "",
  turn,
  cloudflare,
  scripts = {},
  bios,
  ps2Engine = join(import.meta.dir, "..", "emulator", "ps2"),
  vimm,
  discs = createDiscs(dir, null),
  edge = null,
}: AppOptions) {
  const presence = new Presence(now);
  // (each bundled script by its version: the pages ask for <name>.js?v=<it>, kept immutable; http.ts' withVersions)
  const versions: Record<string, string> = Object.fromEntries(Object.entries({ ...scripts, "entry.js": entryJs }).map(([n, s]) => [n, versionOf(s)]));
  const feed = createHomeFeed({
    view: homeView,
    now,
    connect: (p) => (presence.connect(p), social?.seen(p)),
    disconnect: (p) => (presence.disconnect(p), social?.seen(p)),
  });
  // (a game in from vimm.net: the wizard's "Jogar" looks for it in the library right after)
  let vimmState = "";
  vimm?.watch((job) => {
    if (job.state !== vimmState) feed.nudge();
    vimmState = job.state;
  });
  function respond(body: ConstructorParameters<typeof Response>[0], status = 200, headers: Record<string, string> = {}) {
    return new Response(body, { status, headers: { ...HEADERS, ...headers } });
  }
  const text = (body: string, status: number) => respond(body, status, { "Content-Type": "text/plain; charset=utf-8" });
  const json = (body: unknown, status = 200) => respond(JSON.stringify(body), status, { "Content-Type": TYPES.json! });

  async function file(path: string, type = typeOf(path), headers: Record<string, string> = {}) {
    const f = Bun.file(path);
    return (await f.exists()) ? respond(f, 200, { "Content-Type": type, ...headers }) : text("Não encontrado", 404);
  }

  /**
   * The app's address for "Abrir no navegador": PUBLIC_URL, or without it the name this request came to. Discord's
   * proxy asks the mapped address by its name (and Traefik routes by it), so through Discord, even from Discord's own
   * address in a browser tab, that's the real one. Never a local name, an IP or Discord's own address (none, then).
   * Per request, never kept: a request that lies about its name only fools itself.
   */
  function publicFor(req: Request): string {
    if (publicUrl) return publicUrl;
    const { hostname, host } = new URL(req.url);
    if (!hostname.includes(".") || hostname.startsWith("[") || /^[\d.]+$/.test(hostname) || /(^|\.)discordsays\.com$/.test(hostname)) return "";
    return `${req.headers.get("x-forwarded-proto") === "http" ? "http" : "https"}://${host}`;
  }

  let warned = false;
  /**
   * A game's page with pad.js (the mapped controller) and overlay.js (volume, screen filter) slipped in; `pad` is the
   * relative address of pad.js, overlay.js sits next to it. Without a </head>, the page as it is. `source`: its file, or
   * its bytes already found (a "versão rápida" built elsewhere, in R2).
   */
  async function page(req: Request, source: string | Blob, pad: string, headers: Record<string, string>, adjust: (html: string) => string = (h) => h) {
    const path = typeof source === "string" ? source : "a build in R2";
    const f = typeof source === "string" ? Bun.file(source) : source;
    if (typeof source === "string" && !(await Bun.file(source).exists())) return text("Não encontrado", 404);
    let html: string;
    try {
      html = adjust(await f.text());
    } catch (err) {
      log.error("game page patch failed", { path, err });
      return new Response(`O emulador mudou e a página dele precisa de revisão (server/ps2page.ts).`, { status: 500, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
    }
    // (the app's public address: overlay.js' "Abrir no navegador" shows the link itself, Discord may never answer)
    const pub = publicFor(req);
    if (pub) html = html.replace(/<\/head>/i, `<meta name="hypeplay-public" content="${pub.replace(/[&"<>]/g, "")}">$&`);
    // (each goes in just before </head>: pad.js first, then overlay.js)
    const withPad = injectPad(html, pad);
    const both = withPad && injectPad(withPad, pad.replace(/pad\.js$/, "overlay.js"));
    if (both === null && !warned) {
      warned = true;
      log.warn("game page without </head>: served without pad.js and overlay.js", { path });
    }
    return new Response(withVersions(both ?? html, versions), { headers: { ...headers, "Content-Type": TYPES.html! } });
  }

  /** PUT ps2/<id>/upload; `done` runs once the whole image is in. */
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
    if (s.state !== "ready") return s;
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
      // (its "versão rápida"'s builder: the emulator itself compiles nothing)
      steps: FAST_STEPS,
      minIso: PS2_MIN,
      maxIso: PS2_MAX,
      cover: `cover/ps2/${g.id}?v=${g.cover ? `${g.coverAt ?? g.at}-c` : coverVersion(g.serial, g.name)}`,
      status,
      rooms: open.length,
      open,
      by: g.by.name,
      fast: await library!.fast(g.id),
    };
  }

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

  /** Nobody's: the shared catalog's statuses, where an upload is no one's own (`mine`). */
  const NOBODY: Pass = { id: "", name: "", exp: Infinity };
  /**
   * The catalog's games, the same for everyone: one walk of the library for all the homes open (homefeed.ts' shared).
   * Each with its status for whoever looks, made again only while it uploads (`mine` is the one sending it).
   */
  const sharedGames = feed.shared(async () =>
    library ? Promise.all((await library.list()).map(async (g) => ({ entry: await ps2Entry(g, NOBODY), status: (p: Pass) => ps2Status(g.id, p) }))) : [],
  );

  /** One person's home: what `games` answers and the feed pushes. */
  async function homeView(pass: Pass, publicUrl: string): Promise<HomeView & { games: CatalogEntry[] }> {
    const games = await Promise.all(
      (await sharedGames()).map(async ({ entry, status }) => (entry.status.state === "uploading" ? { ...entry, status: await status(pass) } : entry)),
    );
    social?.seen(pass);
    const around = new Set(presence.others(pass.id).map((p) => p.id));
    return {
      me: pass.name,
      last: (await people?.last(pass.id)) ?? null,
      // (a removed game's star stays behind, unseen: only the library's keys)
      favorites: (await people?.favorites(pass.id))?.filter((k) => games.some((g) => g.key === k)) ?? [],
      publicUrl,
      games,
      people: peopleFor(pass),
      social: social?.view(pass.id, (id) => around.has(id)) ?? null,
    };
  }

  /** GET games, the poll (the feed's reserve): here for a while, and the home as it is, or 304 when it's the same. */
  async function catalog(pass: Pass, req: Request) {
    presence.library(pass);
    const body = JSON.stringify(await homeView(pass, publicFor(req)));
    const tag = etagOf(body);
    return unchanged(req, tag) ? respond(null, 304, { ETag: tag }) : respond(body, 200, { "Content-Type": TYPES.json!, ETag: tag });
  }

  /**
   * The home's "Pessoas": who else is around, those in the same Discord call first, each with the game open and the
   * room they host (a PS2 game's: to join as player 2, or watch). The room says the game even without its page's beat.
   */
  function peopleFor(pass: Pass) {
    return presence
      .others(pass.id)
      .filter((p) => social?.statusOf(p.id) !== "invisible")
      .map((p) => {
        const r = ps2Rooms?.byHost(p.id)[0];
        const room = r ? { key: `ps2/${r.game}`, code: r.code, busy: r.busy, watchers: r.watchers } : null;
        return { id: p.id, name: p.name, call: !!pass.call && p.call === pass.call, game: p.game, room };
      })
      .sort((a, b) => Number(b.call) - Number(a.call) || a.name.localeCompare(b.name));
  }

  /** A game's page saying it's open (overlay.ts): its path, the game and its name from it; anything else, not a game. */
  async function here(req: Request, pass: Pass): Promise<Response> {
    if (req.method !== "POST") return text("Método não permitido", 405);
    const path = (await req.text()).slice(0, 300);
    const g = gameFrom(path);
    const title = g ? await titleOf(g.key) : null;
    const game = g && title ? { key: g.key, title, watch: g.watch } : null;
    presence.playing(pass, game);
    social?.beat(pass, game, game ? presence.others(pass.id).filter((p) => p.game?.key === game.key).map((p) => p.id) : []);
    return respond(null, 204);
  }

  /** A game's name by its key, when the catalog has it. */
  async function titleOf(key: string): Promise<string | null> {
    return key.startsWith("ps2/") && library ? ((await library.get(key.slice(4)))?.name ?? null) : null;
  }

  /** friends/<id>, profile/<id>, users, invite, status: social.ts. */
  async function friends(req: Request, pass: Pass, path: string): Promise<Response> {
    const s = social!;
    const who = /^\/(friends|profile|invite)\/([\w-]{1,40})$/.exec(path);
    if (who?.[1] === "friends") {
      if (req.method === "DELETE") return s.remove(pass.id, who[2]!) ? respond(null, 204) : text("Não encontrado", 404);
      if (req.method !== "POST") return text("Método não permitido", 405);
      const r = s.add(pass.id, who[2]!);
      return r === "bad" ? text("Pedido inválido", 400) : json({ result: r });
    }
    if (who?.[1] === "profile") {
      const p = s.profile(pass.id, who[2]!);
      return p ? json(p) : text("Não encontrado", 404);
    }
    if (who?.[1] === "invite") {
      if (req.method !== "POST") return text("Método não permitido", 405);
      const accept = (await body<{ accept?: unknown }>(req))?.accept === true;
      const inv = s.answer(pass.id, who[2]!, accept);
      return inv ? json(inv) : text("Esse convite já venceu", 410);
    }
    if (path === "/users") return json(s.search(pass.id, (new URL(req.url).searchParams.get("q") ?? "").slice(0, 40)));
    if (path === "/invite") {
      if (req.method !== "POST") return text("Método não permitido", 405);
      const b = await body<{ to?: unknown; key?: unknown }>(req);
      const title = typeof b?.key === "string" ? await titleOf(b.key) : null;
      if (typeof b?.to !== "string" || !title) return json({ error: "Pedido inválido" }, 400);
      const key = b.key as string;
      // (a room I host in that game goes along: accepting it joins me)
      const code = ps2Rooms?.byHost(pass.id).find((r) => `ps2/${r.game}` === key)?.code;
      const r = s.invite(pass.id, b.to, { key, title, ...(code ? { code } : {}) });
      return r.ok ? respond(null, 204) : json({ error: r.error }, r.status);
    }
    if (path === "/status") {
      if (req.method !== "PUT") return text("Método não permitido", 405);
      const b = await body<{ status?: unknown; note?: unknown }>(req);
      return b && s.setStatus(pass.id, b) ? respond(null, 204) : text("Pedido inválido", 400);
    }
    return text("Não encontrado", 404);
  }

  async function cover(key: string): Promise<Response> {
    // (its address carries its version: catalog's coverAt)
    const immutable = IMMUTABLE;
    /** A sent cover, with its own type (WebP once sharp made it one; as sent where sharp couldn't load). */
    const sent = async (path: string) => {
      const f = Bun.file(path);
      if (!(await f.exists())) return null;
      const type = imageType(new Uint8Array(await f.slice(0, 12).arrayBuffer())) ?? "image/webp";
      return respond(f, 200, { "Content-Type": type, ...immutable });
    };
    const id = /^ps2\/(.+)$/.exec(key)?.[1];
    const g = id && library ? await library.get(id) : null;
    if (!g) return text("Não encontrado", 404);
    return (g.cover && (await sent(library!.paths(g.id).cover))) || respond(generatedCover(g.serial, g.name), 200, { "Content-Type": TYPES.svg!, ...immutable });
  }

  /**
   * The disc's edge address for its page (`<meta name="hypeplay-disc">`, read by page/edgedisc.ts), when there's an
   * edge and the disc is in R2; nothing otherwise, and the page reads disc.iso from here as before.
   */
  async function edgeMeta(id: string): Promise<string> {
    const iso = library!.paths(id).iso;
    const d = edge && (await discs(iso));
    if (!edge || !d || d.from !== "r2") return "";
    const url = await edgeDiscUrl(edge, { key: relative(dir, iso), size: d.size, version: d.version }, now());
    return `<meta name="hypeplay-disc" content="${url.replace(/&/g, "&amp;")}">`;
  }

  let engineId: Promise<string> | undefined;
  /** TabStationToo's build id, the ?v= its page puts on app.js and app.js on the files it loads ("" without one). */
  function engineBuild(): Promise<string> {
    return (engineId ??= Bun.file(join(ps2Engine, "index.html"))
      .text()
      .then((html) => /\bapp\.js\?v=(\w+)/.exec(html)?.[1] ?? "", () => "")
      .then((id) => {
        if (!id) engineId = undefined;
        return id;
      }));
  }

  /**
   * The "versão rápida"'s version: its files' times and sizes (a build is swapped in whole), or a build in R2's own
   * prefix (new for each build); undefined without either.
   */
  async function fastVersion(id: string): Promise<string | undefined> {
    const build = join(library!.paths(id).fast, "build");
    const all = await Promise.all(Object.keys(FAST_FILES).map((f) => stat(join(build, f)).then((s) => `${f}:${s.mtimeMs}:${s.size}`, () => null)));
    if (all.every(Boolean)) return versionOf(all.join("|"));
    const r2 = library!.fastR2(id);
    return r2 ? versionOf(r2.prefix) : undefined;
  }

  /** ps2/<id>/game/…: TabStationToo with the game's disc, its online rooms. All isolated (http.ts). */
  async function ps2Game(req: Request, id: string, rest: string): Promise<Response | undefined> {
    const p = library!.paths(id);
    const isolated = (body: ConstructorParameters<typeof Response>[0], status: number, type: string) =>
      new Response(body, { status, headers: { ...ISOLATED, "Content-Type": type } });
    const notFound = () => isolated("Não encontrado", 404, "text/plain; charset=utf-8");
    if (rest === "" || rest === "index.html") {
      const name = (await library!.get(id))?.name ?? id;
      const meta = await edgeMeta(id);
      return page(req, join(ps2Engine, "index.html"), "../../../pad.js", ISOLATED, (html) => patchTabStation(html, name).replace(/<\/head>/i, (h) => meta + h));
    }
    if (ENGINE_FILES.has(rest)) {
      const f = Bun.file(join(ps2Engine, rest));
      if (!(await f.exists())) return notFound();
      // (the disc reader, with our block cache at its end: page/disccache-worker.ts)
      const cache = rest === "disc-worker.js" ? scripts["disccache.js"] : undefined;
      // (what app.js asks with its build's ?v= is that build's: immutable; disc-worker.js also holds ours, so it isn't)
      const keep = cache ? {} : cacheFor(req, await engineBuild());
      return new Response(cache ? `${await f.text()}\n${cache}` : f, { headers: { ...ISOLATED, "Content-Type": typeOf(rest), ...keep } });
    }
    if (rest === "disc.iso") {
      const d = await discs(p.iso);
      return d ? rangeResponse(req, d, { ...ISOLATED, "Content-Type": TYPES.bin!, "X-Disc-Source": d.from }) : notFound();
    }
    if (rest === "pipelines") return pipelines(req, join(p.root, "pipelines.bin"));
    return notFound();
  }

  /**
   * ps2/<id>/fast/…: the game's "versão rápida" (ps2-builder/), isolated like the emulator's page (http.ts). Its page
   * reads ../save like the emulator's, the same card; disc.iso is the game's disc; miss takes the code it met untranslated.
   */
  async function ps2Fast(req: Request, id: string, rest: string): Promise<Response> {
    const p = library!.paths(id);
    // (its build here, or in R2 when a worker elsewhere made it: streamed, as a disc piece is)
    const built = (name: string) => library!.fastFile(id, name);
    const body = (b: { file: Blob; from: string }) => (b.from === "r2" ? b.file.stream() : b.file);
    const isolated = (body: ConstructorParameters<typeof Response>[0], status: number, h: Record<string, string> = {}) =>
      new Response(body, { status, headers: { ...ISOLATED, "Content-Type": "text/plain; charset=utf-8", ...h } });
    if (rest === "" || rest === "index.html") {
      const name = ((await library!.get(id))?.name ?? id).replace(/[&<>"]/g, "");
      const start = await built("ps2web.html");
      if (!start) return isolated("Não encontrado", 404);
      const v = await fastVersion(id);
      // (its online and its disc kept in the browser: fastplay.js, before the pad.js and overlay.js page() adds and before
      // the page's own scripts, whose fetch it wraps; the online waits for the page, by then both ran. ps2web.js with
      // its version: the page (ps2-builder/patch.ts) gives the .wasm and .data the same one)
      return page(req, start.file, "../../../pad.js", ISOLATED, (html) =>
        html
          .replace("<title>ps2-web-recomp</title>", `<title>${name} · HypePlay</title>`)
          .replace(/<\/head>/i, '<script src="../../../fastplay.js"></script>$&')
          .replace(/(\bsrc=["']?)ps2web\.js(?=["'\s>])/, (_, src: string) => (v ? `${src}ps2web.js?v=${v}` : `${src}ps2web.js`)),
      );
    }
    const type = FAST_FILES[rest];
    if (type) {
      const keep = { ...cacheFor(req, await fastVersion(id)), Vary: "Accept-Encoding" };
      // (the build keeps a gzip copy of each: a third of the 15 MB of the engine through the Discord proxy)
      const gz = /\bgzip\b/.test(req.headers.get("accept-encoding") ?? "") ? await built(`${rest}.gz`) : null;
      if (gz) return isolated(body(gz), 200, { "Content-Type": type, "Content-Encoding": "gzip", ...keep });
      const f = await built(rest);
      return f ? isolated(body(f), 200, { "Content-Type": type, ...keep }) : isolated("Não encontrado", 404);
    }
    if (rest === "disc.iso") {
      const d = await discs(p.iso);
      return d ? rangeResponse(req, d, { ...ISOLATED, "Content-Type": TYPES.bin!, "X-Disc-Source": d.from }) : isolated("Não encontrado", 404);
    }
    if (rest === "miss") {
      if (req.method !== "POST") return isolated("Método não permitido", 405);
      return (await library!.fastMiss(id, (await req.text()).slice(0, 16))) ? isolated(null, 204) : isolated("Pedido inválido", 400);
    }
    return isolated("Não encontrado", 404);
  }

  // One write at a time per list: two players saving at once would each merge into the list before the other's.
  const pipelineWrites = new Map<string, Promise<unknown>>();
  /**
   * A PS2 game's pipeline list (page/pipelines.ts): what everyone's browser has seen the game draw, so a browser that
   * never played it creates those pipelines ahead of time instead of stuttering on each the first time.
   */
  async function pipelines(req: Request, path: string): Promise<Response> {
    const headers = { ...ISOLATED, "Cache-Control": "no-store" };
    // (fetched by the game's page: isolated like the rest of it, not the home's sandbox)
    const respond = (b: ConstructorParameters<typeof Response>[0], status: number, h: Record<string, string>) => new Response(b, { status, headers: h });
    if (req.method === "GET") {
      const f = Bun.file(path);
      return (await f.exists()) ? respond(f, 200, { ...headers, "Content-Type": TYPES.bin! }) : respond("Não encontrado", 404, headers);
    }
    if (req.method !== "PUT") return respond("Método não permitido", 405, headers);
    if (Number(req.headers.get("content-length") ?? 0) > 8 + CAPACITY * KEY_BYTES) return respond("Lista grande demais", 400, headers);
    const sent = decodeList(new Uint8Array(await req.arrayBuffer()));
    if (!sent) return respond("Não é uma lista", 400, headers);
    const write = (pipelineWrites.get(path) ?? Promise.resolve()).then(async () => {
      const f = Bun.file(path);
      const kept = (await f.exists()) ? decodeList(new Uint8Array(await f.arrayBuffer())) : null;
      // (the same version: everyone's keys; another build's list is replaced by this one's)
      const merged = kept && kept.version[0] === sent.version[0] && kept.version[1] === sent.version[1] ? mergeLists(kept, sent)! : sent;
      await Bun.write(path, encodeList(merged));
    });
    pipelineWrites.set(path, write.catch(() => {}));
    await write;
    return respond(null, 204, headers);
  }

  /** ps2/<id>/room…, ice: the online's setting up, for the host's game page and the guest's page (rooms.ts' cousin). */
  async function ps2Room(req: Request, pass: Pass, id: string, rest: string, server?: Server<NetData>): Promise<Response | undefined> {
    if (rest === "ice") {
      // One TURN at a time: Cloudflare's (anycast, near the player) when it answers, else the coturn, else STUN only.
      const cf = await cloudflare?.ice();
      return json(cf ? [{ urls: STUN }, cf] : iceServers({ turnUrl: turn?.url, turnSecret: turn?.secret, user: pass.id, now: now() }));
    }
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
    // The relay (relay.ts), when WebRTC can't link them: before the inboxes, as "relay" is a good inbox name too
    const relayed = /^room\/([A-Z2-9]{6})\/relay$/.exec(rest);
    if (relayed) {
      const code = relayed[1]!;
      const q = new URL(req.url).searchParams;
      const role = q.get("role");
      const me = q.get("me") ?? "";
      // (`me`, either side: the guest, the host opening one socket per guest)
      if ((role !== "host" && role !== "guest") || !INBOX.test(me)) return text("Pedido inválido", 400);
      const host = ps2Rooms.hostOf(code);
      if (host === null) return text("Não encontrado", 404);
      const guest = ps2Rooms.guestOf(code, me, pass.id);
      if (role === "host" ? host !== pass.id : !guest) return text("Esta sala não é sua", 403);
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) return text("Só WebSocket", 426);
      const data: NetData = { game: id, kind: "relay", room: code, role, me, watch: guest === "watch" };
      return server.upgrade(req, { data }) ? undefined : text("Não deu para abrir a conexão", 400);
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
    return ps2Rooms.post(code!, who!, message, pass.id) ? json({}) : json({ error: "no such room" }, 404);
  }

  /** Everything under ps2/<id>/ but the game itself. */
  async function ps2(req: Request, pass: Pass, id: string, rest: string, server?: Server<NetData>): Promise<Response | undefined> {
    const lib = library!;
    if (!(await lib.get(id))) return text("Não encontrado", 404);
    const p = lib.paths(id);
    const disc = lib.disc(id);
    if (rest === "game") return respond(null, 301, { Location: "game/" });
    if (rest.startsWith("game/")) return ps2Game(req, id, rest.slice("game/".length));
    if (rest === "fast") return respond(null, 301, { Location: "fast/" });
    if (rest.startsWith("fast/")) return ps2Fast(req, id, rest.slice("fast/".length));
    if (rest === "ice" || rest === "room" || rest.startsWith("room/")) return ps2Room(req, pass, id, rest, server);
    // The online guest's page: only video and their pad, so neither isolated (it opens inside Discord) nor sandboxed.
    if (rest === "watch") return respond(null, 301, { Location: "watch/" });
    if (rest === "watch/") return page(req, join(pageDir, "watch.html"), "../../../pad.js", ENTRY_HEADERS);
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
      case "fast-build":
        if (req.method === "POST") return (await lib.askFast(id)) ? respond(null, 204) : text("O jogo ainda não tem a ISO", 409);
        if (req.method === "DELETE") {
          await lib.removeFast(id);
          return respond(null, 204);
        }
        return text("Método não permitido", 405);
      case "cover":
        return coverUpload(req, p.cover, (on) => lib.setCover(id, on));
      case "save": {
        if (!saves) return text("Não encontrado", 404);
        // (a card that can't be read or kept now is 503, never 404: the page only makes a blank card on a 404)
        try {
          if (req.method === "GET") {
            const card = await saves.get(id, pass.id);
            return card ? respond(card, 200, { "Content-Type": TYPES.bin!, "Cache-Control": "no-store" }) : text("Sem save", 404);
          }
          if (req.method !== "PUT") return text("Método não permitido", 405);
          if (Number(req.headers.get("content-length") ?? 0) > CARD_BYTES) return json({ error: "Isso não é um memory card de PS2" }, 413);
          const r = await saves.put(id, pass.id, new Uint8Array(await req.arrayBuffer()));
          return r.ok ? respond(null, 204) : json({ error: r.error }, 400);
        } catch (err) {
          log.error("save unavailable", { game: id, user: pass.id, err });
          return text("O save não está disponível agora", 503);
        }
      }
    }
    return text("Não encontrado", 404);
  }

  async function token(req: Request): Promise<Response> {
    if (req.method !== "POST") return text("Método não permitido", 405);
    const sent = (await req.json().catch(() => null)) as { code?: unknown; call?: unknown } | null;
    const code = sent?.code;
    if (typeof code !== "string" || !code || code.length > 200) return json({ error: "Pedido inválido" }, 400);
    // (the voice channel the Activity runs in, as the SDK says: who's "na mesma call"; only a grouping, not a right)
    const call = typeof sent?.call === "string" && CALL.test(sent.call) ? sent.call : undefined;
    try {
      const user = { ...(await discord.signIn(code)), call };
      // (the access token goes back to the entry page, which authenticates the Discord SDK with it: opening a link
      // outside Discord, for one, needs that), and the app's public address, what that link opens (publicFor)
      return json({ pass: passes.issue(user), access_token: user.accessToken, public_url: publicFor(req) });
    } catch (err) {
      log.error("discord sign-in failed", { err });
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
      log.error("discord sign-in failed", { from: "browser", err });
      return text("Não deu para entrar pelo Discord. Volte e tente de novo.", 502);
    }
  }

  /**
   * Every request; one that may have changed something (any method but GET) tells the home's feed once answered. Not
   * an upload's pieces nor a game's beat: many, and the feed's next tick shows them as soon as the poll did.
   */
  async function handle(req: Request, server?: Server<NetData>): Promise<Response | undefined> {
    const res = await route(req, server);
    if (req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS" && !/\/(upload|here)$/.test(new URL(req.url).pathname)) feed.nudge();
    return res;
  }

  async function route(req: Request, server?: Server<NetData>): Promise<Response | undefined> {
    const { pathname } = new URL(req.url);
    if (req.method === "OPTIONS") return respond(null, 204);
    if (pathname === "/icon.svg") return file(join(pageDir, "icon.svg"));
    if (pathname === "/") return new Response(withVersions(await Bun.file(join(pageDir, "entry.html")).text(), versions), { headers: { ...ENTRY_HEADERS, "Content-Type": TYPES.html! } });
    if (pathname === "/entry.js") return new Response(entryJs, { headers: { ...ENTRY_HEADERS, "Content-Type": TYPES.js!, ...cacheFor(req, versions["entry.js"]) } });
    if (pathname === "/token") return token(req);
    if (pathname === "/login") return login();
    if (pathname === "/auth") return auth(req);
    const m = /^\/p\/([\w.-]+)(\/.*)?$/.exec(pathname);
    if (!m) return text("Não encontrado", 404);
    const pass = await passes.verify(m[1]!);
    if (!pass) return text("Acesso vencido: feche e abra a atividade de novo.", 403);
    const path = m[2];
    if (path === undefined) return respond(null, 301, { Location: slashed(pathname) });
    if (path === "/") return respond(withVersions(await Bun.file(join(pageDir, "index.html")).text(), versions), 200, { "Content-Type": TYPES.html! });
    if (path === "/games") return catalog(pass, req);
    if (path === "/home/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) return text("Só WebSocket", 426);
      const data: NetData = { game: "", kind: "home", pass, publicUrl: publicFor(req) };
      return server.upgrade(req, { data }) ? undefined : text("Não deu para abrir a conexão", 400);
    }
    if (path === "/here") return here(req, pass);
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
    if (script && Object.hasOwn(scripts, script)) return respond(scripts[script]!, 200, { "Content-Type": TYPES.js!, ...cacheFor(req, versions[script]) });
    const font = /^\/fonts\/([\w-]+\.woff2)$/.exec(path)?.[1];
    if (font && Object.hasOwn(FONTS, font))
      return file(join(import.meta.dir, "..", "node_modules", FONTS[font]!, "files", font), TYPES.woff2, { "Cache-Control": "private, max-age=31536000, immutable" });
    if (path.startsWith("/cover/")) return cover(path.slice("/cover/".length));
    if (path === "/pad" && people) {
      if (req.method === "GET") return json(await people.pads(pass.id));
      if (req.method !== "PUT") return text("Método não permitido", 405);
      return (await people.setPads(pass.id, await body(req))) ? respond(null, 204) : text("Pedido inválido", 400);
    }
    if (path === "/keys" && people) {
      if (req.method === "GET") return json(await people.keys(pass.id));
      if (req.method === "DELETE") return (await people.setKeys(pass.id, null)) ? respond(null, 204) : text("Pedido inválido", 400);
      if (req.method !== "PUT") return text("Método não permitido", 405);
      const m = await body(req);
      return m !== null && (await people.setKeys(pass.id, m)) ? respond(null, 204) : text("Pedido inválido", 400);
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
    if (path === "/favorites" && people) {
      if (req.method !== "PUT") return text("Método não permitido", 405);
      const b = await body<{ key?: unknown; on?: unknown }>(req);
      if (typeof b?.key !== "string" || typeof b.on !== "boolean") return text("Pedido inválido", 400);
      // (unstarring a game removed meanwhile is fine)
      if (b.on && !(await titleOf(b.key))) return text("Pedido inválido", 400);
      return (await people.setFavorite(pass.id, b.key, b.on)) ? respond(null, 204) : text("Pedido inválido", 400);
    }
    if (path === "/played" && people) {
      if (req.method !== "POST") return text("Método não permitido", 405);
      const key = (await body<{ key?: unknown }>(req))?.key;
      const known = typeof key === "string" && !!(await titleOf(key));
      if (!known) return text("Pedido inválido", 400);
      await people.played(pass.id, key as string);
      return respond(null, 204);
    }
    if (social && /^\/(friends|profile|invite)\/[^/]+$|^\/(users|invite|status)$/.test(path)) return friends(req, pass, path);
    if (library && path === "/ps2") {
      if (req.method !== "POST") return text("Método não permitido", 405);
      const b = await body<{ serial?: unknown; name?: unknown; copy?: unknown }>(req);
      if (typeof b?.serial !== "string" || !/^[A-Z]{4}-\d{5}$/.test(b.serial)) return json({ error: "Pedido inválido" }, 400);
      if (b.copy !== undefined && typeof b.copy !== "boolean") return json({ error: "Pedido inválido" }, 400);
      // (copy: another copy of a game the library has, asked for in the home's "Enviar outra cópia")
      const r = await library.reserve(pass, b.serial, typeof b.name === "string" ? b.name : "", { copy: b.copy === true });
      return r.ok ? json({ key: `ps2/${r.game.id}`, id: r.game.id }, 201) : json({ exists: r.exists }, 409);
    }
    if (vimm && path === "/vimm") {
      if (req.method === "GET") return json(vimm.status());
      if (req.method !== "POST") return text("Método não permitido", 405);
      const b = await body<{ link?: unknown; title?: unknown; box?: unknown }>(req);
      const str = (v: unknown) => (typeof v === "string" ? v : "");
      const r = vimm.start(pass, str(b?.link), { title: str(b?.title), box: str(b?.box) });
      return r.ok ? json(vimm.status(), 202) : json({ error: r.error }, r.status);
    }
    if (vimm && path === "/vimm/ws") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !server) return text("Só WebSocket", 426);
      return server.upgrade(req, { data: { game: "", kind: "vimm" } }) ? undefined : text("Não deu para abrir a conexão", 400);
    }
    const failed = (err: unknown) => (log.warn("loja: vimm.net failed", { err }), json({ error: "O vimm.net não respondeu. Tente de novo." }, 502));
    if (vimm && path === "/vimm/store") return vimm.vault.home().then(json, failed);
    if (vimm && path === "/vimm/search") {
      const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
      if (!q) return json({ error: "Digite o nome de um jogo" }, 400);
      return vimm.vault.search(q).then((games) => json({ games }), failed);
    }
    const shot = vimm && /^\/vimm\/art\/(box|snap)\/(.{1,200})$/.exec(path);
    if (shot) {
      const res = await vimm!.vault.art(shot[1] as "box" | "snap", decodeURIComponent(shot[2]!)).catch(() => null);
      // shortcut: every look asks GitHub (the browser keeps it a year); kept on disk here if that ever gets slow
      return res ? respond(res.body, 200, { "Content-Type": "image/png", "Cache-Control": "private, max-age=31536000, immutable" }) : text("Não encontrado", 404);
    }
    // the "loja"'s covers: drawn here (cover.ts), never vimm's art; the id seeds the colors, the name is the title
    const art = vimm && /^\/vimm\/cover\/(\d{1,9})$/.exec(path);
    if (art) {
      const name = (new URL(req.url).searchParams.get("name") ?? "").slice(0, 120);
      return respond(generatedCover(`VIMM ${art[1]}`, name), 200, { "Content-Type": TYPES.svg!, "Cache-Control": "private, max-age=31536000, immutable" });
    }
    const sony = library && /^\/ps2\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (sony) return ID.test(sony[1]!) ? ps2(req, pass, sony[1]!, sony[2] ?? "", server) : text("Não encontrado", 404);
    return text("Não encontrado", 404);
  }

  // the PS2 games' online relay: one for the whole app, rooms by code
  const relay = new Relay();
  /** A home's socket, for the feed: its data is the home's. */
  const homeOf = (ws: ServerWebSocket<NetData>) => ws as unknown as HomeSocket;
  const websocket: WebSocketHandler<NetData> = {
    open(ws) {
      const d = ws.data;
      if (d.kind === "home") feed.open(homeOf(ws));
      else if (d.kind === "vimm") {
        ws.send(JSON.stringify(vimm!.status()));
        d.off = vimm!.watch((job) => ws.send(JSON.stringify(job)));
      } else relay.open(ws, d.room, d.role, d.me, d.watch);
    },
    message(ws, msg) {
      if (ws.data.kind === "vimm") return;
      if (ws.data.kind === "home") feed.message(homeOf(ws), msg);
      else relay.message(ws, typeof msg === "string" ? msg : new Uint8Array(msg));
    },
    close(ws) {
      if (ws.data.kind === "vimm") ws.data.off?.();
      else if (ws.data.kind === "home") feed.close(homeOf(ws));
      else relay.close(ws);
    },
  };

  return { handle, websocket, feed, presence };
}

export type App = ReturnType<typeof createApp>;
