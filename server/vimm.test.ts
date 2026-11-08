import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "./library";
import type { Pass } from "./pass";
import { makeIso } from "./testing/iso";
import { artIndex, createMediaCatalog, createVault, createVimm, listing, parseHome, parseVault, pickArt, vaultUrl, vimmLink, vimmPage } from "./vimm";

const ana: Pass = { id: "42", name: "Ana", exp: Infinity };
const has7z = !!Bun.which("7z");

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
const temp = async () => {
  const d = await mkdtemp(join(tmpdir(), "cordplay-vimm-"));
  dirs.push(d);
  return d;
};

test("only vimm's download links, rebuilt from their parts", () => {
  expect(vimmLink(" https://dl3.vimm.net/?mediaId=12345 ")).toBe("https://dl3.vimm.net/?mediaId=12345");
  expect(vimmLink("https://dl2.vimm.net/?foo=1&mediaId=7#x")).toBe("https://dl2.vimm.net/?mediaId=7");
  expect(vimmLink("https://vimm.net/vault/8414")).toBeNull();
  expect(vimmLink("https://dl3.vimm.net.evil.com/?mediaId=1")).toBeNull();
  expect(vimmLink("https://evil.com/?x=dl3.vimm.net&mediaId=1")).toBeNull();
  expect(vimmLink("https://dl3.vimm.net/?mediaId=1abc")).toBeNull();
  expect(vimmLink("file:///dl3.vimm.net/?mediaId=1")).toBeNull();
  expect(vimmLink("12345")).toBeNull();
});

test("vault page links are canonical and never arbitrary fetch targets", () => {
  expect(vimmPage(" https://vimm.net/vault/7843?foo=bar#x ")).toBe("https://vimm.net/vault/7843");
  for (const url of ["https://evil.com/vault/7843", "https://vimm.net.evil.com/vault/7843", "https://vimm.net/vault/PS2", "file://vimm.net/vault/1", "7843"])
    expect(vimmPage(url)).toBeNull();
});

const catalogEntry = { id: "7843", name: "Adventures of Cookie & Cream, The", download_url: "https://dl2.vimm.net/?mediaId=6615" };
const catalogFetch = (seen: string[] = [], entries: unknown[] = [catalogEntry]) =>
  (async (url: string | URL | Request) => {
    seen.push(String(url));
    return Response.json(String(url).endsWith("catalog_a.json") ? entries : []);
  }) as unknown as typeof fetch;

test("public media metadata uses exact vault IDs, validates download hosts and loads once", async () => {
  const seen: string[] = [];
  const catalog = createMediaCatalog({ fetch: catalogFetch(seen, [catalogEntry, { id: "2", download_url: "https://evil.com/?mediaId=3" }, null]) });
  const [one, two] = await Promise.all([catalog(), catalog()]);
  expect(one).toBe(two);
  expect(one.get("7843")).toBe("https://dl2.vimm.net/?mediaId=6615");
  expect(one.has("2")).toBe(false);
  expect(one.has("6615")).toBe(false);
  await catalog();
  expect(seen).toHaveLength(27);
  expect(seen.every((url) => url.startsWith("https://raw.githubusercontent.com/forbenaj/ps2gd/728c7d5ce988280310a9b593e961584fbd1bd8d1/data/catalogs/"))).toBe(true);
});

test("failed catalog loads can be retried", async () => {
  let failed = true;
  const good = catalogFetch();
  const catalog = createMediaCatalog({ fetch: (async (...args: Parameters<typeof fetch>) => failed ? new Response("offline", { status: 503 }) : good(...args)) as typeof fetch });
  await expect(catalog()).rejects.toThrow();
  failed = false;
  expect((await catalog()).get("7843")).toBe(catalogEntry.download_url);
});

test("7z's listing: files after its header, folders apart", () => {
  const out = `7-Zip 25.01\n\nListing archive: x.7z\n\n--\nPath = x.7z\nType = 7z\n\n----------\nPath = Game (USA)\nSize = 0\nFolder = +\n\nPath = Game (USA)/Game (USA).iso\nSize = 1234\nFolder = -\n\n`;
  expect(listing(out)).toEqual([
    { path: "Game (USA)", size: 0, folder: true },
    { path: "Game (USA)/Game (USA).iso", size: 1234, folder: false },
  ]);
});

const served = (body: BodyInit, headers: Record<string, string>, seen: string[] = []) =>
  (async (url: string | URL | Request) => {
    seen.push(String(url));
    return new Response(body, { headers });
  }) as unknown as typeof fetch;

test("a page instead of a game fails with a message, and leaves nothing behind", async () => {
  const dir = await temp();
  const library = createLibrary(dir, { min: 10 });
  const vimm = createVimm(dir, library, { min: 10, fetch: served("<html>nope</html>", { "content-type": "text/html" }) });
  expect(vimm.start(ana, "https://evil.com/vault/1")).toMatchObject({ ok: false, status: 400 });
  const told: string[] = [];
  const off = vimm.watch((j) => told.push(j.state));
  expect(vimm.start(ana, "https://dl3.vimm.net/?mediaId=1", { title: "Naruto" })).toEqual({ ok: true });
  expect(vimm.start(ana, "https://dl3.vimm.net/?mediaId=2")).toMatchObject({ ok: false, status: 409 });
  await vimm.settled();
  expect(vimm.status()).toMatchObject({ state: "failed", title: "Naruto", message: expect.stringContaining("não entregou") });
  expect(told).toEqual(["downloading", "failed"]);
  off();
  vimm.start(ana, "https://dl3.vimm.net/?mediaId=1");
  await vimm.settled();
  expect(told).toHaveLength(2);
  expect(await readdir(dir)).toEqual([]);
});

test("a missing media mapping fails clearly without requesting the protected game page", async () => {
  const dir = await temp();
  const seen: string[] = [];
  const vimm = createVimm(dir, createLibrary(dir, { min: 10 }), { fetch: catalogFetch(seen) });
  expect(vimm.start(ana, "https://vimm.net/vault/70425")).toEqual({ ok: true });
  expect(vimm.status()).toMatchObject({ state: "resolving", by: "Ana" });
  expect(vimm.start(ana, catalogEntry.download_url)).toMatchObject({ ok: false, status: 409 });
  await vimm.settled();
  expect(vimm.status()).toMatchObject({ state: "failed", message: expect.stringContaining("link de download") });
  expect(seen.some((url) => url.startsWith("https://vimm.net/"))).toBe(false);
  expect(await readdir(dir)).toEqual([]);
});

test("store search marks only exact mapped editions as automatic, and still works if metadata is offline", async () => {
  const dir = await temp();
  const html = await Bun.file(join(import.meta.dir, "fixtures/vimm-vault.html")).text();
  const searchFetch = (offline: boolean) => (async (url: string | URL | Request) => {
    if (String(url).startsWith("https://vimm.net/")) return new Response(html);
    if (String(url).startsWith("https://api.github.com/")) return Response.json({ tree: [] });
    return offline ? new Response("offline", { status: 503 }) : catalogFetch()(url);
  }) as unknown as typeof fetch;
  const vimm = createVimm(dir, createLibrary(dir), { fetch: searchFetch(false) });
  expect(await vimm.vault.search("a")).toMatchObject([{ id: 7843, automatic: true }, { id: 70425, automatic: false }]);
  const other = await temp();
  const offline = createVimm(other, createLibrary(other), { fetch: searchFetch(true) });
  expect(await offline.vault.search("a")).toMatchObject([{ id: 7843, automatic: false }, { id: 70425, automatic: false }]);
});

test("vault home and search preserve art and share the exact-ID catalog with installation", async () => {
  const dir = await temp();
  const search = await Bun.file(join(import.meta.dir, "fixtures/vimm-vault.html")).text();
  const home = await Bun.file(join(import.meta.dir, "fixtures/vimm-ps2.html")).text();
  const seen: string[] = [];
  const get = (async (url: string | URL | Request) => {
    const u = String(url);
    seen.push(u);
    const folder = /trees\/(\w+)$/.exec(u)?.[1];
    if (folder === "master") return Response.json({ tree: ["Named_Boxarts", "Named_Snaps"].map((path) => ({ path, sha: path })) });
    if (folder) return Response.json({ tree: SET.filter((p) => p.startsWith(`${folder}/`)).map((p) => ({ path: p.slice(folder.length + 1), sha: "f" })) });
    if (u.startsWith("https://raw.githubusercontent.com/forbenaj/"))
      return catalogFetch([], [catalogEntry, { id: "8433", download_url: "https://dl3.vimm.net/?mediaId=9" }])(url);
    if (u.startsWith("https://raw.githubusercontent.com/libretro-thumbnails/")) return new Response("png");
    if (u === "https://vimm.net/vault/PS2") return new Response(home);
    if (u.includes("loadTopTen.php")) return new Response(u.endsWith("page=2") ? '<a href="7843">Cookie &amp; Cream</a>' : '<a href="6615">Other edition</a>');
    if (u === catalogEntry.download_url) return new Response("unavailable", { status: 503 });
    return new Response(search);
  }) as unknown as typeof fetch;
  const vimm = createVimm(dir, createLibrary(dir), { fetch: get });
  expect(vimm).not.toHaveProperty("search");
  const [lists, games] = await Promise.all([vimm.vault.home(), vimm.vault.search("a")]);
  expect(lists.top.map(({ id, automatic }) => ({ id, automatic }))).toEqual([
    { id: 8433, automatic: true }, { id: 8199, automatic: false }, { id: 9262, automatic: false },
    { id: 7843, automatic: true }, { id: 6615, automatic: false },
  ]);
  expect(lists.rated.map(({ id, automatic }) => ({ id, automatic }))).toEqual([
    { id: 8653, automatic: false }, { id: 9015, automatic: false }, { id: 8735, automatic: false }, { id: 8433, automatic: true },
  ]);
  expect(lists.top[0]).toMatchObject({ name: "Grand Theft Auto: San Andreas", box: expect.stringContaining("(Europe"), snap: "Grand Theft Auto - San Andreas" });
  expect(lists.rated.at(-1)).toMatchObject({ box: expect.any(String), snap: "Grand Theft Auto - San Andreas" });
  expect(games).toMatchObject([
    { id: 7843, automatic: true, regions: ["USA"], version: "3.00", rating: "8.5", box: null, snap: null },
    { id: 70425, automatic: false, box: null, snap: null },
  ]);
  await Promise.all([vimm.vault.home(), vimm.vault.search("a")]);
  expect(seen.filter((u) => u.startsWith("https://vimm.net/"))).toHaveLength(4);
  expect(seen.filter((u) => u.startsWith("https://api.github.com/"))).toHaveLength(3);
  expect(await vimm.vault.art("box", "../../etc/passwd")).toBeNull();
  expect(await (await vimm.vault.art("snap", "Grand Theft Auto - San Andreas"))!.text()).toBe("png");
  expect(vimm.start(ana, "https://vimm.net/vault/7843")).toEqual({ ok: true });
  expect(vimm.status()).toMatchObject({ state: "resolving" });
  expect(vimm.start(ana, "https://vimm.net/vault/8433")).toMatchObject({ ok: false, status: 409 });
  await vimm.settled();
  expect(vimm.status()).toMatchObject({ state: "failed", message: expect.stringContaining("não entregou") });
  expect(seen).toContain(catalogEntry.download_url);
  expect(seen).not.toContain("https://vimm.net/vault/7843");
  expect(seen.filter((u) => u.startsWith("https://raw.githubusercontent.com/forbenaj/"))).toHaveLength(27);
});

test("home metadata failures stay usable and retry without caching false availability", async () => {
  const dir = await temp();
  const home = '<table><caption>Monthly Top</caption><a href="7843">Cookie &amp; Cream</a></table><table><caption>Overall Rating</caption><a href="/vault/7843">Cookie &amp; Cream</a></table>';
  const seen: string[] = [];
  let offline = true;
  const get = (async (url: string | URL | Request) => {
    const u = String(url);
    if (u.startsWith("https://api.github.com/")) return Response.json({ tree: [] });
    if (u.startsWith("https://raw.githubusercontent.com/")) return offline ? new Response("offline", { status: 503 }) : catalogFetch()(url);
    seen.push(u);
    return new Response(u.includes("loadTopTen.php") ? "" : home);
  }) as unknown as typeof fetch;
  const vimm = createVimm(dir, createLibrary(dir), { fetch: get });
  expect(await vimm.vault.home()).toMatchObject({ top: [{ id: 7843, automatic: false }], rated: [{ id: 7843, automatic: false }] });
  expect(vimm.start(ana, "https://vimm.net/vault/7843")).toEqual({ ok: true });
  await vimm.settled();
  expect(vimm.status()).toMatchObject({ state: "failed", message: expect.stringContaining("catálogo de links") });
  offline = false;
  expect(await vimm.vault.home()).toMatchObject({ top: [{ id: 7843, automatic: true }], rated: [{ id: 7843, automatic: true }] });
  expect(seen).toHaveLength(3);
});

test.skipIf(!has7z)("a vimm archive becomes a library game, its disc in place", async () => {
  const dir = await temp();
  const src = await temp();
  const iso = makeIso({ "SYSTEM.CNF": "BOOT2 = cdrom0:\\SLUS_200.62;1\r\n" }, { pad: 64 * 1024 });
  await Bun.write(join(src, "Game (USA)", "Game (USA).iso"), iso);
  const archive = join(src, "game.7z");
  expect(await Bun.spawn(["7z", "a", archive, "Game (USA)"], { cwd: src, stdout: "ignore" }).exited).toBe(0);
  const bytes = await Bun.file(archive).bytes();

  const library = createLibrary(dir, { min: 10 });
  const seen: string[] = [];
  const headers = { "content-type": "application/x-7z-compressed", "content-length": String(bytes.length), "content-disposition": 'attachment; filename="Game (USA).7z"' };
  const png = await (await import("sharp")).default({ create: { width: 60, height: 90, channels: 3, background: "#f60" } }).png().toBuffer();
  const get = (async (url: string | URL | Request) => {
    const u = String(url);
    const folder = /trees\/(\w+)$/.exec(u)?.[1];
    if (folder) return Response.json({ tree: folder === "master" ? [{ path: "Named_Boxarts", sha: "box" }] : [{ path: "Game (USA).png", sha: "f" }] });
    if (u.startsWith("https://raw.githubusercontent.com/libretro-thumbnails/")) return new Response(png);
    return u.startsWith("https://raw.githubusercontent.com/") ? catalogFetch()(url) : served(bytes, headers, seen)(url);
  }) as unknown as typeof fetch;
  const vimm = createVimm(dir, library, { min: 10, fetch: get });
  const told: string[] = [];
  vimm.watch((j) => told.push(j.state));
  expect(vimm.start(ana, "https://vimm.net/vault/7843", { title: "Game", box: "Game (USA)" })).toEqual({ ok: true });
  await vimm.settled();
  expect(seen).toEqual([catalogEntry.download_url]);
  expect([...new Set(told)]).toEqual(["resolving", "downloading", "extracting", "done"]);
  expect(vimm.status()).toEqual({ state: "done", by: "Ana", name: "Game (USA)", key: "ps2/slus-20062", existed: false, title: "Game", cover: "vimm/art/box/Game%20(USA)" });
  const cover = (await library.get("slus-20062"))!;
  expect(cover.cover).toBe(true);
  expect((await stat(library.paths("slus-20062").cover)).size).toBeGreaterThan(0);
  expect((await library.get("slus-20062"))?.name).toBe("Game (USA)");
  expect((await stat(library.paths("slus-20062").iso)).size).toBe(iso.length);
  expect(await readdir(dir)).toEqual(["ps2"]);

  // the same game again: the one there, nothing new
  const again = createVimm(dir, library, { min: 10, fetch: served(bytes, headers) });
  again.start(ana, "https://dl3.vimm.net/?mediaId=99");
  await again.settled();
  expect(again.status()).toMatchObject({ state: "done", key: "ps2/slus-20062", existed: true });
  expect((await library.get("slus-20062"))!.coverAt).toBe(cover.coverAt); // (the one there keeps its cover)
  expect((await library.list()).length).toBe(1);
});

test("the same search asks vimm.net once", async () => {
  let asked = 0;
  const vault = createVault({ fetch: (async (url: string) => url.startsWith("https://api.github.com/")
    ? Response.json({ tree: [] }) : (asked++, new Response('<tr><td><a href="/vault/5">Okami</a></td></tr>'))) as unknown as typeof fetch });
  expect(await vault.search("okami")).toMatchObject([{ id: 5, name: "Okami" }]);
  await vault.search("okami");
  expect(asked).toBe(1);
});

test("the vault's list rows become games (vimm.net's own markup)", async () => {
  const html = await Bun.file(join(import.meta.dir, "fixtures/vimm-vault.html")).text();
  expect(parseVault(html)).toEqual([
    { id: 7843, name: "Adventures of Cookie & Cream, The", regions: ["USA"], version: "3.00", rating: "8.5" },
    { id: 70425, name: "Naruto Shippuden: Ultimate Ninja 4", regions: ["Europe"], version: "1.0", rating: "9.3" },
  ]);
  const two = '<tr><td><a href="/vault/1">X</a></td><td><img class="flag" title="USA"><img class="flag" title="Japan"></td><td>1</td><td>-</td><td>-</td></tr>';
  expect(parseVault(two)[0]).toMatchObject({ regions: ["USA", "Japan"], rating: "" });
  expect(parseVault('<tr><td><a href="/vault/2">Tony Hawk&#039;s Pro &#x26; &lt;b&gt;</a></td></tr>')[0]!.name).toBe("Tony Hawk's Pro & <b>");
});

test("searches stay on vimm.net's PS2 vault, whatever is typed", () => {
  expect(vaultUrl(" naruto ")).toBe("https://vimm.net/vault/?p=list&system=PS2&q=naruto");
  expect(vaultUrl("a&system=GBA")).toBe("https://vimm.net/vault/?p=list&system=PS2&q=a%26system%3DGBA");
  expect(vaultUrl("//evil.com")).toStartWith("https://vimm.net/vault/?");
  expect(vaultUrl("k")).toBe("https://vimm.net/vault/PS2/K");
  expect(vaultUrl("#")).toBe("https://vimm.net/vault/?p=list&system=PS2&q=%23");
});

test("the PS2 page's lists: the month's top and the best rated (vimm.net's own markup)", async () => {
  const { top, rated } = parseHome(await Bun.file(join(import.meta.dir, "fixtures/vimm-ps2.html")).text());
  expect(top).toEqual([
    { id: 8433, name: "Grand Theft Auto: San Andreas" },
    { id: 8199, name: "Dragon Ball Z: Budokai Tenkaichi 3" },
    { id: 9262, name: "Simpsons, The: Hit & Run" },
  ]);
  expect(rated.map((g) => g.id)).toEqual([8653, 9015, 8735, 8433]);
});

const SET = [
  "Named_Boxarts/Grand Theft Auto - San Andreas (Europe, Australia) (En,Fr,De,Es,It) (v1.03).png",
  "Named_Boxarts/Grand Theft Auto - San Andreas (USA) (v1.03).png",
  "Named_Boxarts/Simpsons, The - Hit _ Run (USA).png",
  "Named_Snaps/Grand Theft Auto - San Andreas.png",
  "Named_Logos/Okami (USA).png",
];

test("art matches Vimm's names to the set's, its region first", () => {
  const ix = artIndex(SET);
  expect(pickArt(ix, "box", "Grand Theft Auto: San Andreas", ["USA"])).toBe("Grand Theft Auto - San Andreas (USA) (v1.03)");
  expect(pickArt(ix, "box", "Grand Theft Auto: San Andreas", ["Europe"])).toStartWith("Grand Theft Auto - San Andreas (Europe");
  expect(pickArt(ix, "box", "Simpsons, The: Hit & Run")).toBe("Simpsons, The - Hit _ Run (USA)");
  expect(pickArt(ix, "snap", "Grand Theft Auto: San Andreas", ["Japan"])).toBe("Grand Theft Auto - San Andreas");
  expect(pickArt(ix, "box", "Okami")).toBeNull(); // (only logos of it)
});

test("the loja asks vimm.net once per search, and GitHub only for files in the set", async () => {
  const asked: string[] = [];
  const fake = (async (url: string) => {
    asked.push(url);
    const folder = /trees\/(\w+)$/.exec(url)?.[1];
    if (folder === "master") return Response.json({ tree: ["Named_Boxarts", "Named_Snaps", "Named_Logos"].map((path) => ({ path, sha: path })) });
    if (folder) return Response.json({ tree: SET.filter((p) => p.startsWith(`${folder}/`)).map((p) => ({ path: p.slice(folder.length + 1), sha: "f" })) });
    if (url.includes("raw.githubusercontent.com")) return new Response("png");
    return new Response('<tr><td><a href="/vault/8433">Grand Theft Auto: San Andreas</a></td><td><img class="flag" title="USA"></td></tr>');
  }) as unknown as typeof fetch;
  const vault = createVault({ fetch: fake });
  expect(await vault.search("gta")).toMatchObject([{ id: 8433, box: "Grand Theft Auto - San Andreas (USA) (v1.03)", snap: "Grand Theft Auto - San Andreas" }]);
  await vault.search("gta");
  expect(asked.filter((u) => u.includes("vimm.net"))).toHaveLength(1);
  expect(await vault.art("box", "../../etc/passwd")).toBeNull();
  expect(await vault.art("snap", "Grand Theft Auto - San Andreas (USA) (v1.03)")).toBeNull(); // (a box, not a snap)
  expect(await (await vault.art("box", "Simpsons, The - Hit _ Run (USA)"))!.text()).toBe("png");
  expect(asked.at(-1)).toBe("https://raw.githubusercontent.com/libretro-thumbnails/Sony_-_PlayStation_2/master/Named_Boxarts/Simpsons%2C%20The%20-%20Hit%20_%20Run%20(USA).png");
  expect(asked.filter((u) => u.includes("api.github.com"))).toHaveLength(3); // (the root, boxes and snaps: logos never)
});
