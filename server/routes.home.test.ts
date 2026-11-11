// The home's feed through the app (routes.ts + homefeed.ts): games' ETag and 304, home/ws, and who's here by it.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "./library";
import type { Passes } from "./pass";
import { QUIET_MS } from "./presence";
import { createApp } from "./routes";
import { createSocial } from "./social";

const PAGE_DIR = join(import.meta.dir, "..", "page");
const ANA = "ana-pass";
const BIA = "bia-pass";
const passes: Passes = {
  issue: () => ANA,
  verify: async (p) => (p === ANA ? { id: "42", name: "Ana", exp: Infinity } : p === BIA ? { id: "7", name: "Bia", exp: Infinity } : null),
};
const discord = { signIn: async () => ({ id: "42", name: "Ana", accessToken: "" }) };

let root: string;
let t = 1_000_000;
let app: ReturnType<typeof createApp>;
let library: ReturnType<typeof createLibrary>;
let game = "";
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cordplay-home-"));
  // (a PS2 game with no disc yet: someone can send it)
  library = createLibrary(root, { now: () => t, min: 1024 });
  const r = await library.reserve({ id: "42", name: "Ana", exp: Infinity }, "SLUS-21678", "Jogo");
  game = r.ok ? r.game.id : "";
  app = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "", passes, discord, library, now: () => t, social: createSocial(join(root, "social"), () => t) });
  server = Bun.serve({ port: 0, fetch: (req, s) => app.handle(req, s), websocket: app.websocket });
});
afterAll(async () => {
  server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const get = (pass: string, rest: string, init?: RequestInit) => app.handle(new Request(`http://localhost/p/${pass}/${rest}`, init)) as Promise<Response>;

/** A home socket: its messages as they come. */
async function open(pass: string) {
  const ws = new WebSocket(`ws://localhost:${server.port}/p/${pass}/home/ws`);
  const got: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => {
    got.push(JSON.parse(e.data));
    waiters.splice(0).forEach((w) => w());
  };
  const next = async (pred: (m: Record<string, unknown>) => boolean = () => true) => {
    for (let i = 0; i < 100; i++) {
      const m = got.find(pred);
      if (m) return (got.splice(got.indexOf(m), 1), m);
      await new Promise<void>((ok) => (waiters.push(ok), setTimeout(ok, 30)));
    }
    throw new Error("no such message");
  };
  await next((m) => "games" in m).then((m) => got.unshift(m));
  return { ws, got, next };
}

test("games has an ETag, answers 304 to it, as ?v= or If-None-Match (with the CORS headers)", async () => {
  const first = await get(ANA, "games");
  const tag = first.headers.get("etag")!;
  expect(first.status).toBe(200);
  expect(tag).toMatch(/^"[0-9a-z]+"$/);
  // (an opaque origin: the page reads the ETag only if it's exposed, and may send If-None-Match only if allowed)
  expect(first.headers.get("access-control-expose-headers")).toContain("ETag");
  const preflight = await get(ANA, "games", { method: "OPTIONS", headers: { "access-control-request-headers": "if-none-match" } });
  expect(preflight.headers.get("access-control-allow-headers")).toContain("if-none-match");
  // (the page sends it as ?v=: no preflight from its opaque origin)
  expect((await get(ANA, `games?v=${encodeURIComponent(tag)}`)).status).toBe(304);
  expect((await get(ANA, `games?v=${encodeURIComponent('"old"')}`)).status).toBe(200);
  const same = await get(ANA, "games", { headers: { "if-none-match": tag } });
  expect(same.status).toBe(304);
  expect(await same.text()).toBe("");
  expect(same.headers.get("etag")).toBe(tag);
  expect(same.headers.get("access-control-allow-origin")).toBe("*");
  // something changed (Bia around): the whole home again, with another tag
  await get(BIA, "games");
  const changed = await get(ANA, "games", { headers: { "if-none-match": tag } });
  expect(changed.status).toBe(200);
  expect(changed.headers.get("etag")).not.toBe(tag);
  expect(((await changed.json()) as { people: { name: string }[] }).people.map((p) => p.name)).toEqual(["Bia"]);
});

test("home/ws only as a WebSocket, behind the pass", async () => {
  expect((await get(ANA, "home/ws")).status).toBe(426);
  expect((await get("forged", "home/ws")).status).toBe(403);
});

test("home/ws: the whole home on opening, then another's upload as it goes, `mine` only for the one sending", async () => {
  const ana = await open(ANA);
  const whole = ana.got.shift()!;
  expect(whole.me).toBe("Ana");
  expect((whole.games as { key: string; status: { state: string } }[]).map((g) => [g.key, g.status.state])).toEqual([[`ps2/${game}`, "empty"]]);
  // Bia starts sending its disc: Ana's home gets that game alone, not hers
  const size = 4096;
  const put = await get(BIA, `ps2/${game}/upload?offset=0&size=${size}`, { method: "PUT", body: new Uint8Array(1000) });
  expect(put.status).toBe(200);
  const m = await ana.next((x) => "game" in x);
  expect(m.game).toEqual([{ ...(whole.games as object[])[0], status: { state: "uploading", received: 1000, size, by: "Bia", mine: false, stale: false } }]);
  expect("games" in m).toBe(false);
  // and Bia's own home says it's hers
  const bia = await open(BIA);
  const hers = bia.got.shift()!;
  expect((hers.games as { status: { mine: boolean } }[])[0]!.status.mine).toBe(true);
  // a sync: answered, fresh
  bia.ws.send(JSON.stringify({ sync: 3 }));
  expect((await bia.next((x) => x.sync === 3)).sync).toBe(3);
  ana.ws.close();
  bia.ws.close();
});

test("who's here goes by the open socket, not by the time since a poll; closed, the usual quiet while", async () => {
  t += 10 * QUIET_MS;
  const ana = await open(ANA);
  ana.got.length = 0;
  // long after any poll, Ana is still around for Bia while her home's socket is open
  t += 10 * QUIET_MS;
  const around = async () => ((await (await get(BIA, "games")).json()) as { people: { name: string }[] }).people.map((p) => p.name);
  expect(await around()).toEqual(["Ana"]);
  ana.ws.close();
  for (let i = 0; i < 100 && app.feed.size; i++) await Bun.sleep(10);
  expect(app.feed.size).toBe(0);
  // closed (a reload, a game opened from it): around a while longer, then gone
  t += QUIET_MS - 1;
  expect(await around()).toEqual(["Ana"]);
  t += 2;
  expect(await around()).toEqual([]);
});

test("Bia arriving shows in Ana's Pessoas without Ana asking", async () => {
  t += 10 * QUIET_MS;
  const ana = await open(ANA);
  ana.got.length = 0;
  const bia = await open(BIA);
  const m = await ana.next((x) => "people" in x);
  expect((m.people as { name: string }[]).map((p) => p.name)).toEqual(["Bia"]);
  ana.ws.close();
  bia.ws.close();
  for (let i = 0; i < 100 && app.feed.size; i++) await Bun.sleep(10);
});
