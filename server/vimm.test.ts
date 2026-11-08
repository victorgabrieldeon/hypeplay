import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "./library";
import type { Pass } from "./pass";
import { makeIso } from "./testing/iso";
import { artIndex, createVault, createVimm, listing, parseHome, parseVault, pickArt, vaultUrl, vimmLink } from "./vimm";

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
  expect(vimm.start(ana, "https://vimm.net/vault/1")).toMatchObject({ ok: false, status: 400 });
  expect(vimm.start(ana, "https://dl3.vimm.net/?mediaId=1")).toEqual({ ok: true });
  expect(vimm.start(ana, "https://dl3.vimm.net/?mediaId=2")).toMatchObject({ ok: false, status: 409 });
  await vimm.settled();
  expect(vimm.status()).toMatchObject({ state: "failed", message: expect.stringContaining("não entregou") });
  expect(await readdir(dir)).toEqual([]);
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
  const vimm = createVimm(dir, library, { min: 10, fetch: served(bytes, headers, seen) });
  expect(vimm.start(ana, "https://dl3.vimm.net/?mediaId=99")).toEqual({ ok: true });
  await vimm.settled();
  expect(seen).toEqual(["https://dl3.vimm.net/?mediaId=99"]);
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
