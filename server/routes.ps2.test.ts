import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Mapping } from "../page/padmap";
import { createLibrary } from "./library";
import type { Passes } from "./pass";
import { createPeople } from "./people";
import { createApp } from "./routes";
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

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cordplay-routes-ps2-"));
  await mkdir(join(root, "bt3", "build"), { recursive: true });
  await writeFile(join(root, "bt3", "disc.iso"), "iso");
  await writeFile(join(root, "bt3", "build", "index.html"), "<html><head></head><body>bt3</body></html>");
  library = createLibrary(root, { min: 1024 });
  app = createApp({
    dir: root,
    pageDir: PAGE_DIR,
    entryJs: "",
    passes,
    discord,
    library,
    saves: createSaves(root),
    people: createPeople(root),
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
  expect(bt3).toMatchObject({ kind: "port", id: "bt3", cover: "cover/bt3", open: [], status: { state: "ready" } });
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
  expect(await (await ana("ps2/sles-22222/status")).json()).toEqual({ state: "offline" });
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

  expect((await ana("ps2/sles-44444/rebuild", { method: "POST" })).status).toBe(204);
  expect((await ana("ps2/sles-44444", { method: "DELETE" })).status).toBe(204);
  expect((await ana("ps2/sles-44444/status")).status).toBe(404);
  expect((await catalog()).games.some((g) => g.id === "sles-44444")).toBe(false);
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

test("PS2 routes 404 for unknown ids and without a library", async () => {
  for (const path of ["ps2/slus-00000/status", "ps2/SLUS-00000/status", "ps2/..%2fbt3/status", "ps2/sles-11111/nope", "cover/ps2/slus-00000", "cover/nope"])
    expect((await ana(path)).status).toBe(404);
  const bare = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "", passes, discord });
  for (const path of ["ps2/sles-11111/status", "pad", "cover/ps2/sles-11111"])
    expect(((await bare.handle(new Request(`http://localhost/p/${ANA}/${path}`))) as Response).status).toBe(404);
  const games = (await ((await bare.handle(new Request(`http://localhost/p/${ANA}/games`))) as Response).json()) as { games: Entry[] };
  expect(games.games.map((g) => g.key)).toEqual(["bt3"]);
});
