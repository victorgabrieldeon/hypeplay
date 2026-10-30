import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API, createHomebrew, MAX_FILE, slim } from "./homebrew";

const entry = (slug: string, more: Record<string, unknown> = {}) => ({
  slug,
  title: slug.toUpperCase(),
  developer: "Ana",
  platform: "GB",
  typetag: "game",
  tags: ["Puzzle"],
  license: "MIT",
  screenshots: ["1.png"],
  files: [{ filename: `${slug}.gb`, playable: true, default: true }],
  ...more,
});

let dir: string;
let calls: string[];
// Homebrew Hub, faked: two pages of entries, and the raw files on GitHub.
let pages: unknown[][];
let files: Record<string, Response | (() => Response)>;
const fakeFetch = async (url: string) => {
  calls.push(url);
  if (url.startsWith(`${API}/search?`)) {
    const page = Number(new URL(url).searchParams.get("page"));
    return Response.json({ page_total: pages.length, entries: pages[page - 1] ?? [] });
  }
  const f = files[url];
  return typeof f === "function" ? f() : (f ?? new Response("no", { status: 404 }));
};
const raw = (repo: string, rest: string) => `https://raw.githubusercontent.com/${repo}/HEAD/entries/${rest}`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cordplay-homebrew-"));
  calls = [];
  // (tetra again on page 2: a game added mid-refresh pushes the pages along)
  pages = [[entry("tetra"), entry("nofiles", { files: [] })], [entry("tetra"), entry("pong", { platform: "GBA", baserepo: "https://github.com/gbadev-org/games" })]];
  files = {};
});
afterEach(() => rm(dir, { recursive: true, force: true }));

test("an entry is kept only when it can be played here, from a known repository, through a safe path", () => {
  expect(slim(entry("tetra"))).toEqual({
    slug: "tetra",
    title: "TETRA",
    developer: "Ana",
    platform: "GB",
    tags: ["Puzzle"],
    license: "MIT",
    repo: "gbdev/database",
    rom: "tetra.gb",
    cover: "1.png",
  });
  expect(slim(entry("a", { developer: [{ name: "Ana" }, { name: "Bia", role: "music" }], license: undefined, screenshots: [] }))).toMatchObject({
    developer: "Ana, Bia",
    license: null,
    cover: null,
  });
  // the playable file, the default one first
  expect(slim(entry("a", { files: [{ filename: "a.txt" }, { filename: "b.gb", playable: true }, { filename: "files/c.gb", playable: true, default: true }] }))?.rom).toBe("files/c.gb");
  expect(slim(entry("a", { files: [] }))).toBeNull();
  expect(slim(entry("a", { platform: "SNES" }))).toBeNull();
  // no platform: the ROM's extension tells
  expect(slim(entry("a", { platform: undefined, files: [{ filename: "a.GBA", playable: true }] }))?.platform).toBe("GBA");
  expect(slim(entry("a", { platform: undefined, files: [{ filename: "a.zip", playable: true }] }))).toBeNull();
  expect(slim(entry("a", { baserepo: "https://github.com/evil/repo" }))).toBeNull();
  expect(slim(entry("..", {}))).toBeNull();
  expect(slim(entry("a/b", {}))).toBeNull();
  expect(slim(entry("a", { files: [{ filename: "../../etc/passwd", playable: true }] }))).toBeNull();
  expect(slim(entry("a", { files: [{ filename: "/abs.gb", playable: true }] }))).toBeNull();
  expect(slim(entry("a", { screenshots: ["../x.png", "ok.png"] }))?.cover).toBe("ok.png");
  expect(slim(null)).toBeNull();
});

test("the list comes in page by page, is saved, and a later start uses the saved one while it's under a day old", async () => {
  let t = 1000;
  const shelf = createHomebrew({ dir, fetch: fakeFetch, now: () => t });
  expect(shelf.list()).toEqual([]);
  await shelf.refresh();
  expect(shelf.list().map((g) => g.slug)).toEqual(["tetra", "pong"]);
  expect(shelf.get("pong")?.repo).toBe("gbadev-org/games");
  expect(calls).toEqual([`${API}/search?type=game&page_elements=10&page=1`, `${API}/search?type=game&page_elements=10&page=2`]);

  calls = [];
  t += 60_000;
  const later = createHomebrew({ dir, fetch: fakeFetch, now: () => t });
  await later.start();
  expect(later.list().map((g) => g.slug)).toEqual(["tetra", "pong"]);
  expect(calls).toEqual([]);
});

test("a failed refresh keeps the list there was", async () => {
  const shelf = createHomebrew({ dir, fetch: fakeFetch });
  await shelf.refresh();
  pages = [];
  await expect(shelf.refresh()).rejects.toThrow("no games");
  expect(shelf.list()).toHaveLength(2);
});

test("a file is fetched from its repository once, even when asked for twice at the same time, then read from disk", async () => {
  const shelf = createHomebrew({ dir, fetch: fakeFetch });
  await shelf.refresh();
  files[raw("gbadev-org/games", "pong/pong.gb")] = () => new Response("ROM");
  const [a, b] = await Promise.all([shelf.file("pong", "rom"), shelf.file("pong", "rom")]);
  expect(a).toBe(join(dir, "pong", "rom-pong.gb"));
  expect(b).toBe(a);
  expect(await Bun.file(a!).text()).toBe("ROM");
  calls = [];
  expect(await shelf.file("pong", "rom")).toBe(a);
  expect(calls).toEqual([]);
});

test("unknown games and missing covers are null; a failed or oversized download leaves nothing behind", async () => {
  const shelf = createHomebrew({ dir, fetch: fakeFetch });
  pages = [[entry("tetra", { screenshots: [] })]];
  await shelf.refresh();
  expect(await shelf.file("nope", "rom")).toBeNull();
  expect(await shelf.file("tetra", "cover")).toBeNull();
  await expect(shelf.file("tetra", "rom")).rejects.toThrow("HTTP 404");
  files[raw("gbdev/database", "tetra/tetra.gb")] = () => new Response(new Uint8Array(MAX_FILE + 1));
  await expect(shelf.file("tetra", "rom")).rejects.toThrow("too big");
  expect(await readdir(join(dir, "tetra")).catch(() => [])).toEqual([]);
});
