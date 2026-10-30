import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Mapping } from "../page/padmap";
import { COVER_ART } from "./cover";
import { createLibrary } from "./library";
import type { Passes } from "./pass";
import { createPeople } from "./people";
import { Ps2Rooms } from "./ps2rooms";
import { createApp } from "./routes";
import { createBios } from "./bios";
import { fakeBios } from "./testing/bios";
import { CARD_BYTES, CARD_MAGIC, createSaves } from "./saves";
import { makeIso } from "./testing/iso";

const PAGE_DIR = join(import.meta.dir, "..", "page");
const ANA = "Ana-body.Ana_mac";
const BIA = "Bia-body.Bia_mac";
const passes: Passes = {
  issue: () => ANA,
  verify: async (p) => (p === ANA ? { id: "42", name: "Ana", exp: Infinity } : p === BIA ? { id: "43", name: "Bia", exp: Infinity } : null),
};
const discord = { signIn: async () => ({ id: "42", name: "Ana" }) };

let root: string;
let app: ReturnType<typeof createApp>;
let library: ReturnType<typeof createLibrary>;
let engine: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cordplay-routes-ps2-"));
  await mkdir(join(root, "bt3", "build"), { recursive: true });
  await writeFile(join(root, "bt3", "disc.iso"), "iso");
  await writeFile(join(root, "bt3", "build", "index.html"), "<html><head></head><body>bt3</body></html>");
  library = createLibrary(root, { min: 1024 });
  // TabStationToo's files (emulator/ps2/): its real page, and stand-ins for the rest
  engine = join(root, "engine");
  await mkdir(join(engine, "fonts"), { recursive: true });
  await writeFile(join(engine, "index.html"), await Bun.file(join(import.meta.dir, "fixtures", "tabstation-index.html")).text());
  for (const f of ["pcsx2-wasm.wasm", "style.css", "fonts/archivo.woff2", "secret.txt"]) await writeFile(join(engine, f), `engine ${f}`);
  app = createApp({
    dir: root,
    pageDir: PAGE_DIR,
    entryJs: "",
    passes,
    discord,
    library,
    saves: createSaves(root),
    people: createPeople(root),
    ps2Rooms: new Ps2Rooms(),
    bios: createBios(root),
    ps2Engine: engine,
  });
});
afterAll(() => rm(root, { recursive: true, force: true }));

const req = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init)) as Promise<Response>;
const ana = (rest: string, init?: RequestInit) => req(`/p/${ANA}/${rest}`, init);
const bia = (rest: string, init?: RequestInit) => req(`/p/${BIA}/${rest}`, init);
const json = (body: unknown, method = "POST"): RequestInit => ({ method, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const exists = (path: string) => stat(path).then(() => true, () => false);
const cnf = (program: string) => `BOOT2 = cdrom0:\\${program};1\r\n`;

type Entry = { key: string; kind: string; id: string; name: string; cover: string; status: { state: string }; open: unknown[]; by?: string };
const catalog = async () => (await (await ana("games")).json()) as { me: string; last: string | null; games: Entry[] };

async function send(id: string, disc: Uint8Array<ArrayBuffer>, who = ana) {
  return who(`ps2/${id}/upload?offset=0&size=${disc.length}`, { method: "PUT", body: disc });
}

test("games lists BT3 and the PS2 games, each with its key, cover and state", async () => {
  expect((await ana("ps2", json({ serial: "SLES-11111", name: "Jogo Um" }))).status).toBe(201);
  const body = await catalog();
  expect(body.me).toBe("Ana");
  const bt3 = body.games.find((g) => g.key === "bt3")!;
  expect(bt3).toMatchObject({ kind: "port", id: "bt3", cover: expect.stringMatching(/^cover\/bt3\?v=/), open: [], status: { state: "ready" } });
  const one = body.games.find((g) => g.key === "ps2/sles-11111")!;
  expect(one).toMatchObject({ kind: "recomp", id: "sles-11111", name: "Jogo Um", status: { state: "empty" }, open: [], by: "Ana" });
  expect(one.cover).toStartWith("cover/ps2/sles-11111?v=");
  expect(one).not.toHaveProperty("files");
});

test("reserve, upload in pieces and the disc is checked when complete", async () => {
  const r = await ana("ps2", json({ serial: "SLES-22222", name: "Dois" }));
  expect(r.status).toBe(201);
  expect(await r.json()).toEqual({ key: "ps2/sles-22222", id: "sles-22222" });
  expect((await ana("ps2", json({ serial: "SLES-22222", name: "de novo" }))).status).toBe(409);
  expect(await (await ana("ps2", json({ serial: "SLUS-21678", name: "bt3" }))).json()).toEqual({ exists: "bt3" });
  for (const bad of [{ serial: "slus-1" }, { serial: 5 }, {}]) expect((await ana("ps2", json(bad))).status).toBe(400);

  const disc = makeIso({ "SYSTEM.CNF": cnf("SLES_222.22") }, { pad: 64 * 1024 });
  expect(await (await ana("ps2/sles-22222/upload")).json()).toEqual({ received: 0, size: null, done: false });
  const half = disc.length / 2;
  expect((await ana(`ps2/sles-22222/upload?offset=0&size=${disc.length}`, { method: "PUT", body: disc.slice(0, half) })).status).toBe(200);
  // Bia can't take over a live upload
  expect((await bia(`ps2/sles-22222/upload?offset=${half}&size=${disc.length}`, { method: "PUT", body: disc.slice(half) })).status).toBe(409);
  const done = await ana(`ps2/sles-22222/upload?offset=${half}&size=${disc.length}`, { method: "PUT", body: disc.slice(half) });
  expect(await done.json()).toEqual({ received: disc.length, done: true });
  // (no BIOS on this server yet)
  expect(await (await ana("ps2/sles-22222/status")).json()).toEqual({ state: "needs-bios" });
  expect(await exists(library.paths("sles-22222").iso)).toBe(true);
});

test("a disc with another serial is dropped after the upload", async () => {
  await ana("ps2", json({ serial: "SLES-33333", name: "Três" }));
  const res = await send("sles-33333", makeIso({ "SYSTEM.CNF": cnf("SLES_999.99") }, { pad: 4096 }));
  expect(res.status).toBe(400);
  expect(await res.json()).toMatchObject({ error: "A ISO não é do jogo escolhido", code: "disc" });
  expect((await catalog()).games.some((g) => g.id === "sles-33333")).toBe(false);
});

test("rename, cover (webp, generated, too big) and remove", async () => {
  await ana("ps2", json({ serial: "SLES-44444", name: "Quatro" }));
  expect((await bia("ps2/sles-44444", json({ name: "Quatro (editado)" }, "PATCH"))).status).toBe(204);
  expect((await catalog()).games.find((g) => g.id === "sles-44444")!.name).toBe("Quatro (editado)");

  const svg = await ana("cover/ps2/sles-44444");
  expect(svg.headers.get("content-type")).toBe("image/svg+xml");
  expect(await svg.text()).toContain("Quatro (editado)");
  expect((await ana("cover/bt3")).headers.get("content-type")).toBe("image/svg+xml");

  const png = await sharp({ create: { width: 300, height: 300, channels: 3, background: "#7655ff" } }).png().toBuffer();
  expect((await ana("ps2/sles-44444/cover", { method: "PUT", body: png })).status).toBe(204);
  const webp = await ana("cover/ps2/sles-44444");
  expect(webp.headers.get("content-type")).toBe("image/webp");
  expect(webp.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  expect((await ana("ps2/sles-44444/cover", { method: "PUT", body: "not an image" })).status).toBe(400);
  expect((await ana("ps2/sles-44444/cover", { method: "PUT", body: new Uint8Array(5 * 1024 ** 2 + 1) })).status).toBe(413);
  expect((await ana("ps2/sles-44444/cover", { method: "DELETE" })).status).toBe(204);
  expect((await ana("cover/ps2/sles-44444")).headers.get("content-type")).toBe("image/svg+xml");

  expect((await ana("ps2/sles-44444/rebuild", { method: "POST" })).status).toBe(404);
  expect((await ana("ps2/sles-44444", { method: "DELETE" })).status).toBe(204);
  expect((await ana("ps2/sles-44444/status")).status).toBe(404);
  expect((await catalog()).games.some((g) => g.id === "sles-44444")).toBe(false);
});

test("a cover's address changes whenever its picture does (it is kept a year): a rename, each cover sent, a new drawing", async () => {
  await ana("ps2", json({ serial: "SLES-56565", name: "Antes" }));
  const coverOf = async (key = "ps2/sles-56565") => (await catalog()).games.find((g) => g.key === key)!.cover;
  const drawn = await coverOf();
  expect(drawn).toContain(`g${COVER_ART}`);
  expect(await coverOf("bt3")).toContain(`g${COVER_ART}`);
  await ana("ps2/sles-56565", json({ name: "Depois" }, "PATCH"));
  const renamed = await coverOf();
  expect(renamed).not.toBe(drawn);
  const image = (background: string) => sharp({ create: { width: 300, height: 300, channels: 3, background } }).png().toBuffer();
  await ana("ps2/sles-56565/cover", { method: "PUT", body: await image("#7655ff") });
  const first = await coverOf();
  expect(first).not.toBe(renamed);
  await ana("ps2/sles-56565/cover", { method: "PUT", body: await image("#3ddc84") });
  expect(await coverOf()).not.toBe(first);
  await ana("ps2/sles-56565", { method: "DELETE" });
});

test("saves: one per person, never another's", async () => {
  await ana("ps2", json({ serial: "SLES-55555", name: "Cinco" }));
  const card = new Uint8Array(CARD_BYTES).fill(9);
  card.set(new TextEncoder().encode(CARD_MAGIC));
  expect((await ana("ps2/sles-55555/save")).status).toBe(404);
  expect((await ana("ps2/sles-55555/save", { method: "PUT", body: card })).status).toBe(204);
  const back = new Uint8Array(await (await ana("ps2/sles-55555/save")).arrayBuffer());
  expect(back.length).toBe(CARD_BYTES);
  expect(back[1000]).toBe(9);
  expect((await bia("ps2/sles-55555/save")).status).toBe(404);
  expect((await ana("ps2/sles-55555/save", { method: "PUT", body: new Uint8Array(10) })).status).toBe(400);
  expect((await ana("ps2/slus-00000/save")).status).toBe(404);
});

test("pad maps and the last game played round-trip", async () => {
  const m: Mapping = { buttons: Array.from({ length: 16 }, (_, i) => ({ button: i })), axes: [{ axis: 0 }, { axis: 1 }, { axis: 2 }, { axis: 3 }] };
  expect(await (await ana("pad")).json()).toEqual({});
  expect((await ana("pad", json({ "Pad X": m }, "PUT"))).status).toBe(204);
  expect(await (await ana("pad")).json()).toEqual({ "Pad X": m });
  expect((await ana("pad", json({ "Pad X": { buttons: [] } }, "PUT"))).status).toBe(400);
  expect(await (await bia("pad")).json()).toEqual({});

  expect((await ana("played", json({ key: "bt3" }))).status).toBe(204);
  expect((await catalog()).last).toBe("bt3");
  expect((await ana("played", json({ key: "ps2/slus-00000" }))).status).toBe(400);
  expect((await ana("played", json({ key: "../x" }))).status).toBe(400);
});

/** A PS2 game with its disc in: all it takes to play (with the BIOS). */
async function built(serial: string, program: string) {
  const id = serial.toLowerCase();
  await ana("ps2", json({ serial, name: serial }));
  await writeFile(library.paths(id).iso, makeIso({ "SYSTEM.CNF": cnf(program) }, { pad: 8192 }));
  return id;
}

const ISOLATION = {
  "document-isolation-policy": "isolate-and-require-corp",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
  "cross-origin-resource-policy": "same-origin",
};

test("a PS2 game is TabStationToo's page, patched and isolated, with its files from the fixed list", async () => {
  const id = await built("SLES-66666", "SLES_666.66");
  expect((await ana(`ps2/${id}/game`)).headers.get("location")).toBe("game/");
  const page = await ana(`ps2/${id}/game/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-type")).toStartWith("text/html");
  for (const [k, v] of Object.entries(ISOLATION)) expect(page.headers.get(k)).toBe(v);
  const csp = page.headers.get("content-security-policy")!;
  expect(csp).not.toContain("sandbox");
  expect(csp).toContain("frame-ancestors https://discord.com");
  const html = await page.text();
  expect(html).toContain("<title>SLES-66666 · CordPlay</title>");
  expect(html).toContain('<script src="../../../ps2play.js"></script>');
  expect(html).toContain('<script src="../../../pad.js"></script><script src="../../../overlay.js"></script></head>');

  const wasm = await ana(`ps2/${id}/game/pcsx2-wasm.wasm`);
  expect(wasm.headers.get("content-type")).toBe("application/wasm");
  expect(wasm.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(await wasm.text()).toBe("engine pcsx2-wasm.wasm");
  expect((await ana(`ps2/${id}/game/style.css`)).headers.get("content-type")).toStartWith("text/css");
  expect((await ana(`ps2/${id}/game/fonts/archivo.woff2`)).headers.get("content-type")).toBe("font/woff2");
  for (const f of ["secret.txt", "../game.json", "status.json", "ps2web.wasm", "fonts/../secret.txt"]) expect((await ana(`ps2/${id}/game/${f}`)).status).toBe(404);
});

test("a PS2 game whose disc is in plays once the server has the BIOS, which is sent once and served isolated", async () => {
  const id = await built("SLES-12121", "SLES_121.21");
  expect(await (await ana(`ps2/${id}/status`)).json()).toEqual({ state: "needs-bios" });
  expect(await (await ana("bios")).json()).toEqual({ present: false });
  expect((await ana("bios.bin")).status).toBe(404);
  expect((await ana("bios", { method: "PUT", body: new Uint8Array(10) })).status).toBe(400);
  expect((await ana("bios", { method: "PUT", body: fakeBios(1) })).status).toBe(204);
  expect(await (await ana("bios")).json()).toMatchObject({ present: true, by: "Ana" });
  expect((await bia("bios", { method: "PUT", body: fakeBios(2) })).status).toBe(409);
  expect((await bia("bios?replace=1", { method: "PUT", body: fakeBios(2) })).status).toBe(204);
  expect(await (await ana(`ps2/${id}/status`)).json()).toEqual({ state: "ready" });
  expect((await catalog()).games.find((g) => g.id === id)!.status).toEqual({ state: "ready" });
  const head = await ana("bios.bin", { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe(String(4 * 1024 * 1024));
  expect(head.headers.get("document-isolation-policy")).toBe("isolate-and-require-corp");
  const part = await ana("bios.bin", { headers: { range: "bytes=0-3" } });
  expect(part.status).toBe(206);
  expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([2, 2, 2, 2]);
  expect((await req("/p/forged.mac/bios.bin")).status).toBe(403);
});

test("the disc of a PS2 game answers Range and HEAD", async () => {
  const id = await built("SLES-77777", "SLES_777.77");
  const size = (await stat(library.paths(id).iso)).size;
  const head = await ana(`ps2/${id}/game/disc.iso`, { method: "HEAD" });
  expect(head.headers.get("content-length")).toBe(String(size));
  expect(head.headers.get("document-isolation-policy")).toBe("isolate-and-require-corp");
  const part = await ana(`ps2/${id}/game/disc.iso`, { headers: { range: "bytes=32768-32772" } });
  expect(part.status).toBe(206);
  expect(new TextDecoder().decode(await part.arrayBuffer())).toBe("\x01CD00");
  expect((await ana(`ps2/${id}/game/disc.iso`, { headers: { range: "bytes=5000000000-" } })).status).toBe(416);
});

test("BT3's page gets pad.js, everything else of BT3 is as before", async () => {
  const page = await ana("bt3/game/");
  expect(await page.text()).toBe('<html><head><script src="../../pad.js"></script><script src="../../overlay.js"></script></head><body>bt3</body></html>');
  expect(page.headers.get("content-security-policy")).toStartWith("sandbox ");
});

test("a removed game's routes 404 while open", async () => {
  const id = await built("SLES-88888", "SLES_888.88");
  expect((await ana(`ps2/${id}/game/disc.iso`, { method: "HEAD" })).status).toBe(200);
  await ana(`ps2/${id}`, { method: "DELETE" });
  for (const f of ["game/", "game/disc.iso", "game/pcsx2-wasm.wasm", "status"]) expect((await ana(`ps2/${id}/${f}`)).status).toBe(404);
  expect((await ana("games")).status).toBe(200);
});

test("rooms: create, post, wait, listed in games; ice with and without TURN", async () => {
  const id = await built("SLES-99999", "SLES_999.99");
  const made = await ana(`ps2/${id}/room`, { method: "POST" });
  const { room } = (await made.json()) as { room: string };
  expect(room).toMatch(/^[A-Z2-9]{6}$/);
  expect((await bia(`ps2/${id}/room/${room}/host`, json({ type: "join", from: "g1" }))).status).toBe(200);
  expect(await (await ana(`ps2/${id}/room/${room}/host?after=0`)).json()).toEqual({ messages: [{ type: "join", from: "g1" }], next: 1 });
  expect((await bia(`ps2/${id}/room/ZZZZZZ/host`, json({ type: "join" }))).status).toBe(404);
  expect((await bia(`ps2/${id}/room/${room}/HOST!`, json({ type: "x" }))).status).toBe(404);
  expect((await bia(`ps2/${id}/room/${room}/host`, { method: "POST", body: "[1]" })).status).toBe(400);
  expect((await bia(`ps2/${id}/room/${room}/host`, { method: "POST", body: "x".repeat(65_537) })).status).toBe(413);
  const entry = (await catalog()).games.find((g) => g.id === id)!;
  expect(entry.open).toEqual([{ code: room, host: "Ana", since: expect.any(Number), busy: true }]);

  // only its host closes it, and then it's gone
  expect((await bia(`ps2/${id}/room/${room}`, { method: "DELETE" })).status).toBe(404);
  expect((await ana(`ps2/${id}/room/${room}`, { method: "DELETE" })).status).toBe(204);
  expect((await catalog()).games.find((g) => g.id === id)!.open).toEqual([]);

  expect(await (await ana(`ps2/${id}/ice`)).json()).toEqual([{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }]);
  const turned = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "", passes, discord, library, turn: { url: "turn:t.exemplo.com:3478", secret: "s" } });
  const ice = (await ((await turned.handle(new Request(`http://localhost/p/${ANA}/ps2/${id}/ice`))) as Response).json()) as { username?: string }[];
  expect(ice[1]!.username).toEndWith(":42");
});

test("the guest's page: ours, framed by Discord, not isolated and not sandboxed, with pad.js", async () => {
  const id = await built("SLES-14141", "SLES_141.41");
  const page = await ana(`ps2/${id}/watch/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toBe("frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com");
  expect(page.headers.get("cross-origin-embedder-policy")).toBeNull();
  const html = await page.text();
  expect(html).toContain('<script src="../../../watch.js"></script>');
  expect(html).toContain('<script src="../../../pad.js"></script>');
  expect((await ana(`ps2/${id}/watch`)).headers.get("location")).toBe("watch/");
  expect((await ana(`ps2/${id}/game/room`, { method: "POST" })).status).toBe(404);
});

test("intro with Range, 404 without the file", async () => {
  expect((await ana("intro.mp4")).status).toBe(404);
  await writeFile(join(root, "intro.mp4"), "0123456789");
  const part = await ana("intro.mp4", { headers: { range: "bytes=2-4" } });
  expect(part.status).toBe(206);
  expect(await part.text()).toBe("234");
  expect(part.headers.get("content-type")).toBe("video/mp4");
});

test("the page's scripts and fonts", async () => {
  const withScripts = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "", passes, discord, scripts: { "iso.js": "/* iso */" } });
  const get = (path: string) => withScripts.handle(new Request(`http://localhost/p/${ANA}/${path}`)) as Promise<Response>;
  const iso = await get("iso.js");
  expect(await iso.text()).toBe("/* iso */");
  expect(iso.headers.get("content-type")).toStartWith("text/javascript");
  expect((await get("nope.js")).status).toBe(404);
  for (const name of ["unbounded", "manrope", "jetbrains-mono"]) {
    const font = await get(`fonts/${name}-latin-wght-normal.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get("content-type")).toBe("font/woff2");
  }
  expect((await get("fonts/inter-latin-wght-normal.woff2")).status).toBe(404);
  expect((await get("fonts/../package.json")).status).toBe(404);
});

test("prefs: the person's volume and filter round-trip", async () => {
  expect(await (await ana("prefs")).json()).toEqual({ volume: 0.7, filter: "off" });
  expect((await ana("prefs", json({ volume: 0.4, filter: "scan" }, "PUT"))).status).toBe(204);
  expect(await (await ana("prefs")).json()).toEqual({ volume: 0.4, filter: "scan" });
  expect((await ana("prefs", json({ volume: 9, filter: "scan" }, "PUT"))).status).toBe(400);
  expect(await (await bia("prefs")).json()).toEqual({ volume: 0.7, filter: "off" });
});

test("every game page gets pad.js and then overlay.js", async () => {
  expect(await (await ana("bt3/game/")).text()).toContain('<script src="../../pad.js"></script><script src="../../overlay.js"></script></head>');
  const id = await built("SLES-13131", "SLES_131.31");
  expect(await (await ana(`ps2/${id}/game/`)).text()).toContain('<script src="../../../pad.js"></script><script src="../../../overlay.js"></script></head>');
  expect(await (await ana("play/")).text()).toContain('<script src="../pad.js"></script><script src="../overlay.js"></script></head>');
});

test("the homebrew player gets pad.js too, and keeps the home's sandbox", async () => {
  const play = await ana("play/");
  expect(play.status).toBe(200);
  expect(await play.text()).toContain('<script src="../pad.js"></script><script src="../overlay.js"></script></head>');
  expect(play.headers.get("content-security-policy")).toStartWith("sandbox ");
});

test("the home's own scripts, from a fixed list, with the home's headers", async () => {
  const app = await ana("home/app.js");
  expect(app.status).toBe(200);
  expect(app.headers.get("content-type")).toStartWith("text/javascript");
  expect(app.headers.get("content-security-policy")).toStartWith("sandbox ");
  expect(app.headers.get("access-control-allow-origin")).toBe("*");
  for (const f of ["home/nope.js", "home/../index.html", "home/app.ts", "home/"]) expect((await ana(f)).status).toBe(404);
});

test("PS2 routes 404 for unknown ids and without a library", async () => {
  for (const path of ["ps2/slus-00000/status", "ps2/SLUS-00000/status", "ps2/..%2fbt3/status", "ps2/sles-11111/nope", "cover/ps2/slus-00000", "cover/nope"])
    expect((await ana(path)).status).toBe(404);
  const bare = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "", passes, discord });
  for (const path of ["ps2/sles-11111/status", "pad", "cover/ps2/sles-11111"])
    expect(((await bare.handle(new Request(`http://localhost/p/${ANA}/${path}`))) as Response).status).toBe(404);
  const games = (await ((await bare.handle(new Request(`http://localhost/p/${ANA}/games`))) as Response).json()) as { games: Entry[] };
  expect(games.games.map((g) => g.key)).toEqual(["bt3"]);
});
