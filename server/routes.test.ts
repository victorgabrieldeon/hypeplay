import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Passes } from "./pass";
import { createApp } from "./routes";

const PAGE_DIR = join(import.meta.dir, "..", "page");
// The one valid pass, issued to whoever signs in with code "ana" (Discord is faked: discord.test.ts covers it).
const pass = "Ana-body.Ana_mac";
/** What the last pass was issued for. */
let issued: unknown = null;
const passes: Passes = {
  issue: (u) => ((issued = u), pass),
  verify: async (p) => (p === pass ? { id: "42", name: "Ana", exp: Infinity } : null),
};
const discord = {
  signIn: async (code: string) => {
    if (code !== "ana") throw new Error("discord refused the code");
    return { id: "42", name: "Ana", accessToken: "tok-ana" };
  },
};
let root: string;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cordplay-routes-"));
  app = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "/* entry */", passes, discord });
});
afterAll(() => rm(root, { recursive: true, force: true }));

const get = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init)) as Promise<Response>;
const home = (rest: string) => `/p/${pass}/${rest}`;

const FRAME_ANCESTORS = "frame-ancestors https://discord.com https://*.discord.com https://*.discordsays.com";

test("the entry page, its script and the icon are public, framed only by Discord, not sandboxed (the SDK needs an origin)", async () => {
  const entry = await get("/");
  expect(await entry.text()).toMatch(/src="entry\.js\?v=\w{12}"/);
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
  for (const path of [`/p/${forged}/`, `/p/${forged}/games`, `/p/${forged}/ps2/slus-21678/game/`, "/p/nopass/games"])
    expect((await get(path)).status).toBe(403);
  expect((await get("/elsewhere")).status).toBe(404);
});

test("token: a Discord code for a pass", async () => {
  const post = (body: unknown) => get("/token", { method: "POST", body: JSON.stringify(body) });
  const ok = await post({ code: "ana" });
  expect(ok.status).toBe(200);
  // (the access token goes back too: the entry page authenticates the Discord SDK with it, which opening links needs)
  expect(await ok.json()).toEqual({ pass, access_token: "tok-ana", public_url: "" });
  // (and the app's public address, for "Abrir no navegador": the name the request came to, without PUBLIC_URL)
  const named = await (app.handle(new Request("http://hype.example/token", { method: "POST", body: JSON.stringify({ code: "ana" }) })) as Promise<Response>);
  expect(((await named.json()) as { public_url: string }).public_url).toBe("https://hype.example");
  expect((await post({ code: "forged" })).status).toBe(502);
  for (const bad of [{}, { code: 1 }, { code: "" }, { code: "x".repeat(201) }]) expect((await post(bad)).status).toBe(400);
  expect((await get("/token")).status).toBe(405);
  // the voice channel goes into the pass when it looks like one
  await post({ code: "ana", call: "123456789012345678" });
  expect(issued).toMatchObject({ id: "42", call: "123456789012345678" });
  await post({ code: "ana", call: "../x" });
  expect(issued).toMatchObject({ call: undefined });
});

test("the home, with the sandbox and CORS headers; the trailing slash is added", async () => {
  const res = await get(home(""));
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("HypePlay");
  const csp = res.headers.get("content-security-policy")!;
  expect(csp).toStartWith("sandbox allow-scripts allow-forms allow-popups allow-downloads;");
  expect(csp).not.toContain("allow-same-origin");
  expect(csp).toEndWith(FRAME_ANCESTORS);
  expect(res.headers.get("access-control-allow-origin")).toBe("*");
  expect(res.headers.get("cache-control")).toBe("no-cache");
  const bare = await get(`/p/${pass}`);
  expect(bare.status).toBe(301);
  expect(bare.headers.get("location")).toBe(`${pass}/`);
  // Preflight of the upload's PUT.
  const pre = await get(home("ps2/slus-21678/upload"), { method: "OPTIONS" });
  expect(pre.status).toBe(204);
  expect(pre.headers.get("access-control-allow-methods")).toContain("PUT");
});

test("every script of the home (page/home/*.js) is served: one left out breaks the whole home, as they import each other", async () => {
  const scripts = (await readdir(join(PAGE_DIR, "home"))).filter((f) => f.endsWith(".js"));
  expect(scripts).toContain("app.js");
  for (const f of scripts) expect([f, (await get(home(`home/${f}`))).status]).toEqual([f, 200]);
});

test("anything else is 404: a path never reaches the disk", async () => {
  // ("../" never gets here: the URL is normalized before routing.)
  for (const path of ["nope/status", "nope/game/", "..%2fbt3/status", "bt3/game/", "work/secret.txt", "status", "upload"])
    expect((await get(home(path))).status).toBe(404);
});

test("without PUBLIC_URL, the public address is the one each request came to (Discord's proxy and Traefik ask by name), never a local one or Discord's own", async () => {
  const at = async (url: string, headers: Record<string, string> = {}) =>
    ((await (await (app.handle(new Request(url + home("games"), { headers })) as Promise<Response>)).json()) as { publicUrl: string }).publicUrl;
  expect(await at("http://hype.example", { "x-forwarded-proto": "https" })).toBe("https://hype.example");
  // (no word on the protocol: Discord only maps to https addresses)
  expect(await at("http://hype.example")).toBe("https://hype.example");
  expect(await at("http://hype.example:8443", { "x-forwarded-proto": "http" })).toBe("http://hype.example:8443");
  for (const local of ["http://localhost:3913", "http://127.0.0.1:3913", "http://192.168.0.10:3913", "http://[::1]:3913", "https://1565741822813409280.discordsays.com"])
    expect(await at(local)).toBe("");
  // a PUBLIC_URL set stands, whatever the request's address
  const web = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "", passes, discord, publicUrl: "https://hype.example" });
  const body = (await (await (web.handle(new Request(`http://other.example${home("games")}`)) as Promise<Response>)).json()) as { publicUrl: string };
  expect(body.publicUrl).toBe("https://hype.example");
});

test("in a browser: Entrar com o Discord goes to Discord, and back here with a pass", async () => {
  const codes: (string | undefined)[][] = [];
  const web = createApp({
    dir: root, pageDir: PAGE_DIR, entryJs: "", passes, clientId: "app", publicUrl: "https://hype.example",
    discord: {
      signIn: async (code: string, redirectUri?: string) => {
        codes.push([code, redirectUri]);
        if (code !== "ana") throw new Error("discord refused the code");
        return { id: "42", name: "Ana", accessToken: "tok-ana" };
      },
    },
  });
  const go = (path: string) => web.handle(new Request(`https://hype.example${path}`)) as Promise<Response>;
  const stateOf = async () => new URL((await go("/login")).headers.get("location")!).searchParams.get("state")!;
  const login = await go("/login");
  expect(login.status).toBe(302);
  const to = new URL(login.headers.get("location")!);
  expect(to.origin + to.pathname).toBe("https://discord.com/oauth2/authorize");
  expect(to.searchParams.get("redirect_uri")).toBe("https://hype.example/auth");
  const state = to.searchParams.get("state")!;
  expect((await go("/auth?code=ana&state=forged")).status).toBe(400);
  const back = await go(`/auth?code=ana&state=${state}`);
  expect(back.status).toBe(302);
  expect(back.headers.get("location")).toBe(`/p/${pass}/`);
  expect(codes.at(-1)).toEqual(["ana", "https://hype.example/auth"]);
  // a state is good once
  expect((await go(`/auth?code=ana&state=${state}`)).status).toBe(400);
  // cancelled on Discord's page: back to the start
  const cancelled = await go(`/auth?error=access_denied&state=${await stateOf()}`);
  expect([cancelled.status, cancelled.headers.get("location")]).toEqual([302, "/"]);
  expect((await go(`/auth?code=forged&state=${await stateOf()}`)).status).toBe(502);
});

test("without PUBLIC_URL there's no signing in from a browser", async () => {
  expect((await get("/login")).status).toBe(404);
});

test("vimm/ws pushes the download's status: now on open, then each change, until it closes", async () => {
  const listeners = new Set<(j: unknown) => void>();
  const vimm = {
    status: () => ({ state: "idle" }),
    watch: (fn: (j: unknown) => void) => (listeners.add(fn), () => void listeners.delete(fn)),
  } as unknown as NonNullable<Parameters<typeof createApp>[0]["vimm"]>;
  const web = createApp({ dir: root, pageDir: PAGE_DIR, entryJs: "", passes, discord, vimm });
  const server = Bun.serve({ port: 0, fetch: (req, s) => web.handle(req, s), websocket: web.websocket });
  try {
    expect((await (web.handle(new Request(`http://x${home("vimm/ws")}`)) as Promise<Response>)).status).toBe(426);
    // (the home's feed follows the download too, for good: homefeed.ts)
    const before = listeners.size;
    const ws = new WebSocket(`ws://localhost:${server.port}${home("vimm/ws")}`);
    const got: unknown[] = [];
    const next = () => new Promise<void>((ok) => (ws.onmessage = (e) => (got.push(JSON.parse(e.data)), ok())));
    await next();
    const more = next();
    for (const fn of listeners) fn({ state: "downloading", received: 5, size: 10 });
    await more;
    expect(got).toEqual([{ state: "idle" }, { state: "downloading", received: 5, size: 10 }]);
    ws.close();
    for (let i = 0; i < 50 && listeners.size > before; i++) await Bun.sleep(10);
    expect(listeners.size).toBe(before);
  } finally {
    server.stop(true);
  }
});
