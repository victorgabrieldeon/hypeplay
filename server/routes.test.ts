import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Passes } from "./pass";
import { GAMES } from "./games";
import { createApp, PIECE } from "./routes";

const PAGE_DIR = join(import.meta.dir, "..", "page");
// The one valid pass, issued to whoever signs in with code "ana" (Discord is faked: discord.test.ts covers it).
const pass = "Ana-body.Ana_mac";
const passes: Passes = {
  issue: () => pass,
  verify: async (p) => (p === pass ? { id: "42", name: "Ana", exp: Infinity } : null),
};
const discord = {
  signIn: async (code: string) => {
    if (code !== "ana") throw new Error("discord refused the code");
    return { id: "42", name: "Ana" };
  },
};
let root: string;
let dir: string;
let app: ReturnType<typeof createApp>;
// A small stand-in for the disc image: two whole pieces and a shorter last one.
const SIZE = 2 * PIECE + 1234;
const iso = new Uint8Array(SIZE).map((_, i) => (i * 7 + (i >> 20)) & 0xff);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cordplay-routes-"));
  dir = join(root, "bt3");
  await mkdir(dir);
  await writeFile(join(dir, "disc.iso"), iso);
  await mkdir(join(dir, "build"));
  for (const f of [...GAMES[0]!.files, "bt3_node.js", "telemetry.log"]) await writeFile(join(dir, "build", f), `file ${f}`);
  await mkdir(join(dir, "work"));
  await writeFile(join(dir, "work", "secret.txt"), "intermediate");
  app = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "/* entry */", passes, discord });
});
afterAll(() => rm(root, { recursive: true, force: true }));

const get = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init)) as Promise<Response>;
const home = (rest: string) => `/p/${pass}/${rest}`;
const p = (rest: string) => home(`bt3/${rest}`);

const FRAME_ANCESTORS = "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com";

test("the entry page, its script and the icon are public, framed only by Discord, not sandboxed (the SDK needs an origin)", async () => {
  const entry = await get("/");
  expect(await entry.text()).toContain('src="entry.js"');
  expect(entry.headers.get("content-security-policy")).toBe(FRAME_ANCESTORS);
  const js = await get("/entry.js");
  expect(await js.text()).toBe("/* entry */");
  expect(js.headers.get("content-type")).toStartWith("text/javascript");
  expect(js.headers.get("content-security-policy")).toBe(FRAME_ANCESTORS);
  expect((await get("/icon.svg")).headers.get("content-type")).toBe("image/svg+xml");
  expect((await get("/hypemeet-plugin.json")).status).toBe(404);
});

test("the rest needs a valid pass", async () => {
  const forged = `${pass.split(".")[0]}.AAAA`;
  for (const path of [`/p/${forged}/`, `/p/${forged}/status`, `/p/${forged}/game/disc/00000.bin`, "/p/nopass/status"])
    expect((await get(path)).status).toBe(403);
  expect((await get(`/p/${forged}/game/index.html`)).status).toBe(403);
  expect((await get("/elsewhere")).status).toBe(404);
});

test("token: a Discord code for a pass", async () => {
  const post = (body: unknown) => get("/token", { method: "POST", body: JSON.stringify(body) });
  const ok = await post({ code: "ana" });
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ pass });
  expect((await post({ code: "forged" })).status).toBe(502);
  for (const bad of [{}, { code: 1 }, { code: "" }, { code: "x".repeat(201) }]) expect((await post(bad)).status).toBe(400);
  expect((await get("/token")).status).toBe(405);
});

test("the home, with the sandbox and CORS headers; the trailing slash is added", async () => {
  const res = await get(home(""));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("CordPlay");
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toStartWith("sandbox allow-scripts allow-forms allow-popups allow-downloads;");
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).toEndWith(FRAME_ANCESTORS);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const bare = await get(`/p/${pass}`);
  expect(bare.status).toBe(301);
  expect(bare.headers.get("location")).toBe(`${pass}/`);
  expect((await get(p("game"))).headers.get("location")).toBe("game/");
  expect((await get(home("bt3"))).status).toBe(404);
  // Preflight of the upload's PUT.
  const pre = await get(p("upload"), { method: "OPTIONS" });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
});

test("only the game's listed files, with their types", async () => {
  expect(await (await get(p("game/"))).text()).toBe("file index.html");
  const wasm = await get(p("game/bt3-jspi.wasm"));
  expect(wasm.headers.get("content-type")).toBe("application/wasm");
  expect(wasm.headers.get("access-control-allow-origin")).toBe("*");
  expect((await get(p("game/net.js"))).headers.get("content-type")).toStartWith("text/javascript");
  for (const f of ["game/bt3_node.js", "game/telemetry.log", "game/../work/secret.txt", "game/%2e%2e/work/secret.txt", "game/disc.iso", "disc.iso", "work/secret.txt"])
    expect((await get(p(f))).status).toBe(404);
});

test("the disc in 1 MiB pieces, read from the image; the last one is shorter", async () => {
  expect(await (await get(p("game/disc/index.json"))).json()).toEqual({ size: SIZE, piece: PIECE });
  for (const [n, from, to] of [[0, 0, PIECE], [1, PIECE, 2 * PIECE], [2, 2 * PIECE, SIZE]] as const) {
    const res = await get(p(`game/disc/0000${n}.bin`));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.length).toBe(to - from);
    expect(Buffer.from(body).equals(Buffer.from(iso.subarray(from, to)))).toBe(true);
  }
  expect((await get(p("game/disc/00003.bin"))).status).toBe(404);
  expect((await get(p("game/disc/1.bin"))).status).toBe(404);
});

test("status, net endpoints that keep nothing, and WebSockets only by upgrade", async () => {
  expect(await (await get(p("status"))).json()).toEqual({ state: "ready" });
  for (const f of ["game/net/stat", "game/net/log", "game/telemetry"]) expect((await get(p(f), { method: "POST", body: "{}" })).status).toBe(204);
  expect((await get(p("game/net/ws?room=ABCD&role=host"))).status).toBe(426);
  expect((await get(p("game/net/ws?room=bad&role=host"))).status).toBe(400);
});

test("the catalog, each game with its state and without its file list", async () => {
  const body = (await (await get(home("games"))).json()) as { me: string; games: Record<string, unknown>[] };
  expect(body.me).toBe("Ana");
  expect(body.games.map((g) => g.id)).toEqual(["bt3"]);
  expect(body.games[0]).toMatchObject({ name: GAMES[0]!.name, status: { state: "ready" }, rooms: 0 });
  expect(body.games[0]).not.toHaveProperty("files");
});

test("only games from the catalog: an id never reaches the disk", async () => {
  // ("../" never gets here: the URL is normalized before routing.)
  for (const path of ["nope/status", "nope/game/", "..%2fbt3/status", "bt3./status", "work/secret.txt", "status", "upload"])
    expect((await get(home(path))).status).toBe(404);
});
