import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "./library";
import type { Pass } from "./pass";
import { makeIso } from "./testing/iso";
import { createMediaCatalog, createVault, createVimm, listing, parseVault, vaultUrl, vimmLink, vimmPage } from "./vimm";

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
  expect(vimm.start(ana, "https://dl3.vimm.net/?mediaId=1")).toEqual({ ok: true });
  expect(vimm.start(ana, "https://dl3.vimm.net/?mediaId=2")).toMatchObject({ ok: false, status: 409 });
  await vimm.settled();
  expect(vimm.status()).toMatchObject({ state: "failed", message: expect.stringContaining("não entregou") });
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
    return offline ? new Response("offline", { status: 503 }) : catalogFetch()(url);
  }) as unknown as typeof fetch;
  const vimm = createVimm(dir, createLibrary(dir), { fetch: searchFetch(false) });
  expect(await vimm.search("a")).toMatchObject([{ id: 7843, automatic: true }, { id: 70425, automatic: false }]);
  const other = await temp();
  const offline = createVimm(other, createLibrary(other), { fetch: searchFetch(true) });
  expect(await offline.search("a")).toMatchObject([{ id: 7843, automatic: false }, { id: 70425, automatic: false }]);
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
  const get = (async (url: string | URL | Request) => String(url).startsWith("https://raw.githubusercontent.com/")
    ? catalogFetch()(url) : served(bytes, headers, seen)(url)) as unknown as typeof fetch;
  const vimm = createVimm(dir, library, { min: 10, fetch: get });
  expect(vimm.start(ana, "https://vimm.net/vault/7843")).toEqual({ ok: true });
  await vimm.settled();
  expect(seen).toEqual([catalogEntry.download_url]);
  expect(vimm.status()).toEqual({ state: "done", by: "Ana", name: "Game (USA)", key: "ps2/slus-20062", existed: false });
  expect((await library.get("slus-20062"))?.name).toBe("Game (USA)");
  expect((await stat(library.paths("slus-20062").iso)).size).toBe(iso.length);
  expect(await readdir(dir)).toEqual(["ps2"]);

  // the same game again: the one there, nothing new
  const again = createVimm(dir, library, { min: 10, fetch: served(bytes, headers) });
  again.start(ana, "https://dl3.vimm.net/?mediaId=99");
  await again.settled();
  expect(again.status()).toMatchObject({ state: "done", key: "ps2/slus-20062", existed: true });
  expect((await library.list()).length).toBe(1);
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

test("the same search asks vimm.net once", async () => {
  let asked = 0;
  const search = createVault({ fetch: (async () => (asked++, new Response('<tr><td><a href="/vault/5">Okami</a></td></tr>'))) as unknown as typeof fetch });
  expect(await search("okami")).toMatchObject([{ id: 5, name: "Okami" }]);
  await search("okami");
  expect(asked).toBe(1);
});
