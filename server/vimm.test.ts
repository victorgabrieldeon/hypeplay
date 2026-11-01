import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLibrary } from "./library";
import type { Pass } from "./pass";
import { makeIso } from "./testing/iso";
import { createVimm, listing, vimmLink } from "./vimm";

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
