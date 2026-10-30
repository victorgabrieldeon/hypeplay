/**
 * The homebrew shelf: Game Boy, GBA and NES homebrew from Homebrew Hub (hh.gbdev.io), played in EmulatorJS
 * (emulator/, page/play.html). Nothing is mirrored up front, in its data folder (<data>/homebrew/):
 *
 *   catalog.json         every game, from the Homebrew Hub API, refreshed once a day ({ at, games })
 *   <slug>/rom-<name>    a game's ROM, fetched the first time someone plays it
 *   <slug>/cover-<name>  its first screenshot, fetched the first time the home shows it
 *
 * The files come from the databases' GitHub repositories: the API's own file route answers 404. Only the three known
 * repositories, and only paths without "..": what the API says is data, never an address to fetch blindly.
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const API = "https://hh3.gbdev.io/api";
const REPOS = new Set(["gbdev/database", "gbadev-org/games", "nesdev-org/homebrew-db"]);
export const PLATFORMS = new Set(["GB", "GBC", "GBA", "NES"]);
/** A ROM's extension, for the entries (a few hundred) that don't say their platform. */
const BY_EXTENSION: Record<string, string> = { gb: "GB", gbc: "GBC", gba: "GBA", nes: "NES" };
const DAY_MS = 24 * 60 * 60_000;
/** GBA ROMs top out at 32 MiB. */
export const MAX_FILE = 64 * 1024 ** 2;
/** Well past the ~170 pages there are: a runaway page_total can't keep it fetching. */
const MAX_PAGES = 1000;

export interface Homebrew {
  slug: string;
  title: string;
  developer: string;
  platform: string;
  tags: string[];
  license: string | null;
  /** owner/name on GitHub. */
  repo: string;
  /** Paths inside the entry's folder in that repository. */
  rom: string;
  cover: string | null;
}

export type Which = "rom" | "cover";

interface Catalog {
  at: number;
  games: Homebrew[];
}

const SLUG = /^[\w-][\w.-]*$/;
const safePath = (p: unknown): p is string =>
  typeof p === "string" && p.length < 200 && !p.includes("\\") && p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** An API entry, down to what the shelf needs; null when it can't be played here. */
export function slim(e: any): Homebrew | null {
  if (!e || typeof e !== "object" || typeof e.slug !== "string" || !SLUG.test(e.slug)) return null;
  const repo = typeof e.baserepo === "string" ? e.baserepo.replace(/^https:\/\/github\.com\//, "") : "gbdev/database";
  if (!REPOS.has(repo)) return null;
  const files: any[] = Array.isArray(e.files) ? e.files.filter((f: any) => f?.playable && safePath(f.filename)) : [];
  const rom = (files.find((f) => f.default) ?? files[0])?.filename;
  const platform = e.platform ?? BY_EXTENSION[rom?.slice(rom.lastIndexOf(".") + 1).toLowerCase()];
  if (!rom || !PLATFORMS.has(platform)) return null;
  const devs = Array.isArray(e.developer) ? e.developer.map((d: any) => (typeof d === "string" ? d : d?.name)) : [e.developer];
  return {
    slug: e.slug,
    title: typeof e.title === "string" && e.title ? e.title : e.slug,
    developer: devs.filter((d: unknown) => typeof d === "string" && d).join(", "),
    platform,
    tags: Array.isArray(e.tags) ? e.tags.filter((t: unknown) => typeof t === "string").slice(0, 8) : [],
    license: typeof e.license === "string" ? e.license : null,
    repo,
    rom,
    cover: (Array.isArray(e.screenshots) ? e.screenshots : []).find(safePath) ?? null,
  };
}

export interface HomebrewOptions {
  /** <data>/homebrew/ */
  dir: string;
  fetch?: (url: string) => Promise<Response>;
  now?: () => number;
}

// (a stalled request would hold its file, or the refresh, forever: the timeout covers the body too)
const timedFetch = (url: string) => fetch(url, { signal: AbortSignal.timeout(60_000) });

export function createHomebrew({ dir, fetch: get = timedFetch, now = () => Date.now() }: HomebrewOptions) {
  let catalog: Catalog = { at: 0, games: [] };
  let bySlug = new Map<string, Homebrew>();
  const inflight = new Map<string, Promise<void>>();
  let refreshing: Promise<void> | null = null;

  function use(c: Catalog) {
    catalog = c;
    bySlug = new Map(c.games.map((g) => [g.slug, g]));
  }

  async function load() {
    const saved = (await readFile(join(dir, "catalog.json"), "utf8").then(JSON.parse, () => null)) as Catalog | null;
    if (saved && Array.isArray(saved.games)) use(saved);
  }

  /** Every game, page by page; the old list stays until a whole new one is in. */
  function refresh() {
    refreshing ??= (async () => {
      const games: Homebrew[] = [];
      // (newest first: one added mid-refresh pushes the pages along, and a game comes twice)
      const seen = new Set<string>();
      for (let page = 1, total = 1; page <= Math.min(total, MAX_PAGES); page++) {
        const res = await get(`${API}/search?type=game&page_elements=10&page=${page}`);
        if (!res.ok) throw new Error(`Homebrew Hub: HTTP ${res.status}`);
        const body = (await res.json()) as { page_total?: unknown; entries?: unknown };
        total = typeof body.page_total === "number" ? body.page_total : 0;
        for (const e of Array.isArray(body.entries) ? body.entries : []) {
          const g = slim(e);
          if (g && !seen.has(g.slug)) {
            seen.add(g.slug);
            games.push(g);
          }
        }
      }
      if (!games.length) throw new Error("Homebrew Hub: no games");
      const next = { at: now(), games };
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "catalog.json.part"), JSON.stringify(next));
      await rename(join(dir, "catalog.json.part"), join(dir, "catalog.json"));
      use(next);
    })().finally(() => (refreshing = null));
    return refreshing;
  }

  async function download(url: string, path: string) {
    const res = await get(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    if (Number(res.headers.get("content-length") ?? 0) > MAX_FILE) throw new Error(`${url}: too big`);
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.length > MAX_FILE) throw new Error(`${url}: too big`);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(`${path}.part`, body);
    await rename(`${path}.part`, path);
  }

  return {
    list: () => catalog.games,
    get: (slug: string) => bySlug.get(slug),
    load,
    refresh,

    /** The cached list, then a fresh one if it's a day old, then every day. Failures only log: the old list stays. */
    async start() {
      await load();
      const tick = () => void refresh().catch((err: unknown) => console.error("homebrew refresh failed:", err));
      if (now() - catalog.at >= DAY_MS) tick();
      setInterval(tick, DAY_MS).unref();
    },

    /**
     * A game's ROM or cover on disk, fetched the first time (once, however many ask at the same time). Named after
     * the remote file, so a new version is a new file. Null when the game or the file isn't in the list.
     */
    async file(slug: string, which: Which): Promise<string | null> {
      const g = bySlug.get(slug);
      const remote = g && (which === "rom" ? g.rom : g.cover);
      if (!g || !remote) return null;
      const path = join(dir, g.slug, `${which}-${basename(remote)}`);
      if (await Bun.file(path).exists()) return path;
      let p = inflight.get(path);
      if (!p) {
        const url = `https://raw.githubusercontent.com/${g.repo}/HEAD/entries/${encodeURIComponent(g.slug)}/${remote.split("/").map(encodeURIComponent).join("/")}`;
        p = download(url, path)
          .catch(async (err) => {
            await rm(`${path}.part`, { force: true });
            throw err;
          })
          .finally(() => inflight.delete(path));
        inflight.set(path, p);
      }
      await p;
      return path;
    },
  };
}

export type HomebrewShelf = ReturnType<typeof createHomebrew>;
