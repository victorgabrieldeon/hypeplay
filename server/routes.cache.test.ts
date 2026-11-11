import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { versionOf } from "./http";
import { createLibrary } from "./library";
import type { Passes } from "./pass";
import { createApp } from "./routes";

// What the browser (and Discord's proxy) may keep: only what is versioned by its address, and only that very version.
const IMMUTABLE = "public, max-age=31536000, immutable";
const ANA = "Ana-body.Ana_mac";
const passes: Passes = { issue: () => ANA, verify: async (p) => (p === ANA ? { id: "42", name: "Ana", exp: Infinity } : null) };
const SCRIPTS = { "pad.js": "/* pad */", "overlay.js": "/* overlay */", "ps2play.js": "/* ps2play */", "fastplay.js": "/* fast */", "iso.js": "/* iso */", "padmap.js": "/* padmap */", "disccache.js": "/* cache */" };
const ENGINE_BUILD = "385757d8e81d";

let root: string;
let app: ReturnType<typeof createApp>;
let library: ReturnType<typeof createLibrary>;
let id: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cordplay-routes-cache-"));
  const engine = join(root, "engine");
  await mkdir(engine, { recursive: true });
  await writeFile(join(engine, "index.html"), await Bun.file(join(import.meta.dir, "fixtures", "tabstation-index.html")).text());
  for (const f of ["pcsx2-wasm.wasm", "style.css", "disc-worker.js"]) await writeFile(join(engine, f), `engine ${f}`);
  library = createLibrary(root, { min: 1024 });
  app = createApp({ dir: root, pageDir: join(import.meta.dir, "..", "page"), entryJs: "/* entry */", passes, discord: { signIn: async () => ({ id: "42", name: "Ana", accessToken: "t" }) }, library, ps2Engine: engine, scripts: SCRIPTS });
  const r = await ana("ps2", { method: "POST", body: JSON.stringify({ serial: "SLES-50000", name: "Jogo" }), headers: { "content-type": "application/json" } });
  id = ((await r.json()) as { id: string }).id;
});
afterAll(() => rm(root, { recursive: true, force: true }));

const req = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init)) as Promise<Response>;
const ana = (rest: string, init?: RequestInit) => req(`/p/${ANA}/${rest}`, init);
const cache = (r: Response) => r.headers.get("cache-control");

test("the bundled scripts: pages ask for them by version, and that version is kept for good", async () => {
  const home = await (await ana("")).text();
  expect(home).toContain(`<script src="iso.js?v=${versionOf(SCRIPTS["iso.js"])}"></script>`);
  expect(home).toContain(`<script src="padmap.js?v=${versionOf(SCRIPTS["padmap.js"])}"></script>`);
  const v = versionOf(SCRIPTS["pad.js"]);
  expect(cache(await ana(`pad.js?v=${v}`))).toBe(IMMUTABLE);
  // (an old page's version, or none, is asked again: it would otherwise keep the new script under the old address)
  expect(cache(await ana("pad.js?v=000000000000"))).toBe("no-cache");
  expect(cache(await ana("pad.js"))).toBe("no-cache");
  // the entry page, outside the pass: the same
  const entry = await (await req("/")).text();
  const ev = versionOf("/* entry */");
  expect(entry).toContain(`src="entry.js?v=${ev}"`);
  const js = await req(`/entry.js?v=${ev}`);
  expect(cache(js)).toBe(IMMUTABLE);
  expect(js.headers.get("content-security-policy")).toContain("frame-ancestors");
});

test("the emulator's page: its scripts versioned, its files immutable only with its build's ?v=", async () => {
  const page = await ana(`ps2/${id}/game/`);
  expect(cache(page)).toBe("no-cache");
  const html = await page.text();
  expect(html).toContain(`src="../../../ps2play.js?v=${versionOf(SCRIPTS["ps2play.js"])}"`);
  expect(html).toContain(`src="../../../pad.js?v=${versionOf(SCRIPTS["pad.js"])}"`);
  expect(html).toContain(`src="../../../overlay.js?v=${versionOf(SCRIPTS["overlay.js"])}"`);
  const wasm = await ana(`ps2/${id}/game/pcsx2-wasm.wasm?v=${ENGINE_BUILD}`);
  expect(cache(wasm)).toBe(IMMUTABLE);
  expect(wasm.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(wasm.headers.get("content-type")).toBe("application/wasm");
  expect(cache(await ana(`ps2/${id}/game/pcsx2-wasm.wasm?v=older`))).toBe("no-cache");
  expect(cache(await ana(`ps2/${id}/game/style.css`))).toBe("no-cache");
  // (the disc reader holds our cache at its end, which changes without the build: never immutable)
  const worker = await ana(`ps2/${id}/game/disc-worker.js?v=${ENGINE_BUILD}`);
  expect(cache(worker)).toBe("no-cache");
  expect(await worker.text()).toEndWith("/* cache */");
});

test("the versão rápida: ps2web.js versioned in its page, its files immutable with that version", async () => {
  const build = join(library.paths(id).fast, "build");
  await mkdir(build, { recursive: true });
  await writeFile(join(build, "ps2web.html"), '<!doctypehtml><html><head><title>ps2-web-recomp</title></head><body><template id=engine><script async src="ps2web.js"></script></template></body></html>');
  for (const f of ["ps2web.js", "ps2web.wasm", "ps2web.data"]) await writeFile(join(build, f), f);
  await writeFile(join(build, "ps2web.wasm.gz"), "wasm.gz");
  const versionIn = async () => /src="ps2web\.js\?v=(\w+)"/.exec(await (await ana(`ps2/${id}/fast/`)).text())?.[1];
  const v = (await versionIn())!;
  expect(v).toMatch(/^\w{12}$/);
  expect(await (await ana(`ps2/${id}/fast/`)).text()).toContain(`src="../../../fastplay.js?v=${versionOf(SCRIPTS["fastplay.js"])}"`);
  for (const f of ["ps2web.js", "ps2web.data", "ps2web.wasm"]) {
    const r = await ana(`ps2/${id}/fast/${f}?v=${v}`);
    expect(cache(r)).toBe(IMMUTABLE);
    expect(r.headers.get("vary")).toBe("Accept-Encoding");
  }
  const gz = await ana(`ps2/${id}/fast/ps2web.wasm?v=${v}`, { headers: { "accept-encoding": "gzip" } });
  expect(gz.headers.get("content-encoding")).toBe("gzip");
  expect(cache(gz)).toBe(IMMUTABLE);
  expect(cache(await ana(`ps2/${id}/fast/ps2web.wasm`))).toBe("no-cache");
  // a new build (swapped in whole) is a new version: the old one's address is asked again
  await utimes(join(build, "ps2web.wasm"), new Date(), new Date(Date.now() + 60_000));
  const next = await versionIn();
  expect(next).not.toBe(v);
  expect(cache(await ana(`ps2/${id}/fast/ps2web.wasm?v=${v}`))).toBe("no-cache");
  expect(cache(await ana(`ps2/${id}/fast/ps2web.wasm?v=${next}`))).toBe(IMMUTABLE);
  // (without its .data, no version: the page as it is)
  await rm(join(build, "ps2web.data"));
  expect(await (await ana(`ps2/${id}/fast/`)).text()).toContain('src="ps2web.js"');
});

test("covers: their address carries their version, kept by anyone on the way", async () => {
  const games = (await (await ana("games")).json()) as { games: { key: string; cover: string }[] };
  const cover = games.games.find((g) => g.key === `ps2/${id}`)!.cover;
  expect(cover).toMatch(/\?v=/);
  expect(cache(await ana(cover))).toBe(IMMUTABLE);
});

test("with an edge, the emulator's page of a game whose disc is in R2 gets its edge address; one here doesn't", async () => {
  const { verifyDisc } = await import("./edgetoken");
  const secret = "e".repeat(40);
  let from: "r2" | "local" = "r2";
  const edged = createApp({
    dir: root,
    pageDir: join(import.meta.dir, "..", "page"),
    entryJs: "",
    passes,
    discord: { signIn: async () => ({ id: "42", name: "Ana", accessToken: "t" }) },
    library,
    ps2Engine: join(root, "engine"),
    scripts: SCRIPTS,
    edge: { base: "/p/edge", secret },
    discs: async () => ({ size: 10, file: new Blob(["0123456789"]), from, version: "10:123", read: (s, e) => new Blob(["0123456789".slice(s, e)]) }),
  });
  const html = async (rest: string) => (await (edged.handle(new Request(`http://localhost/p/${ANA}/ps2/${id}/${rest}`)) as Promise<Response>)).text();
  const meta = (h: string) => /<meta name="hypeplay-disc" content="([^"]+)">/.exec(h)?.[1]?.replace(/&amp;/g, "&");
  const url = new URL(meta(await html("game/"))!, "https://x");
  expect(url.pathname).toBe(`/p/edge/ps2/${id}/game/disc.iso`);
  expect(await verifyDisc(secret, { key: `ps2/${id}/disc.iso`, size: 10, version: "10:123" }, url.searchParams.get("t"))).toBe(true);
  // (the versão rápida reads its disc from here, through the browser's blocks it shares with the emulator: fastdisc.ts)
  expect(meta(await html("fast/"))).toBeUndefined();
  from = "local";
  expect(meta(await html("game/"))).toBeUndefined();
  // (and without an edge, never)
  expect(await (await ana(`ps2/${id}/game/`)).text()).not.toContain("hypeplay-disc");
});
