/**
 * "Baixar do vimm.net": the server downloads a PS2 game straight from Vimm's Lair, instead of someone sending its ISO
 * from their PC. Public snapshot metadata maps vault IDs to download links without visiting protected game pages.
 * Entries missing from that snapshot can still use a pasted download link. Files only come from dl*.vimm.net,
 * with addresses rebuilt from their validated parts.
 *
 * One download at a time (vimm limits them per address too), in <dir>/vimm/: the archive, then its one .iso, read for
 * its serial and moved into the library (library.ts), where it plays like a sent one.
 */
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileRead, readDiscId } from "./iso9660";
import { PS2_MAX, PS2_MIN, type Library } from "./library";
import type { Pass } from "./pass";

export type VimmJob =
  | { state: "idle" }
  | { state: "resolving"; by: string }
  | { state: "downloading"; by: string; name: string; received: number; size: number | null }
  | { state: "extracting"; by: string; name: string }
  /** `existed`: the library had the game already; `key` is that one */
  | { state: "done"; by: string; name: string; key: string; existed: boolean }
  | { state: "failed"; by: string; message: string };

/** A message for the page: the rest are logged and shown as a generic failure. */
class Refused extends Error {}

/** The download address from what someone pasted, rebuilt from its parts; null when it isn't a vimm download link. */
export function vimmLink(text: string): string | null {
  let u: URL;
  try {
    u = new URL(text.trim());
  } catch {
    return null;
  }
  const id = u.searchParams.get("mediaId");
  if (!/^https?:$/.test(u.protocol) || !/^dl\d{0,2}\.vimm\.net$/.test(u.hostname) || !id || !/^\d{1,9}$/.test(id)) return null;
  return `https://${u.hostname}/?mediaId=${id}`;
}

/** A pasted game page identifies an exact edition, never a URL for the server to fetch. */
export function vimmPage(text: string): string | null {
  try {
    const u = new URL(text.trim());
    return /^https?:$/.test(u.protocol) && u.hostname === "vimm.net" && /^\/vault\/\d{1,9}$/.test(u.pathname)
      ? `https://vimm.net${u.pathname}` : null;
  } catch {
    return null;
  }
}

/** PS2GD's public snapshot, pinned so metadata cannot silently change. No protected Vimm pages are scraped. */
export function createMediaCatalog({ fetch: get = fetch }: { fetch?: typeof fetch } = {}) {
  let pending: Promise<Map<string, string>> | undefined;
  return function load(): Promise<Map<string, string>> {
    return pending ??= Promise.all(["number", ..."abcdefghijklmnopqrstuvwxyz"].map(async (section) => {
      const res = await get(`https://raw.githubusercontent.com/forbenaj/ps2gd/728c7d5ce988280310a9b593e961584fbd1bd8d1/data/catalogs/catalog_${section}.json`, {
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) throw new Error(`media catalog answered ${res.status}`);
      const entries: unknown = await res.json();
      if (!Array.isArray(entries)) throw new Error("Invalid media catalog");
      const links: [string, string][] = [];
      for (const entry of entries) {
        if (!entry || typeof entry.id !== "string" || !/^\d{1,9}$/.test(entry.id) || typeof entry.download_url !== "string") continue;
        const link = vimmLink(entry.download_url);
        if (link) links.push([entry.id, link]);
      }
      return links;
    })).then((parts) => new Map(parts.flat())).catch((err) => {
      pending = undefined;
      throw err;
    });
  };
}

/** `7z l -slt`'s files (after its "----------" line): path, size, folder or not. */
export function listing(out: string) {
  const files: { path: string; size: number; folder: boolean }[] = [];
  const body = out.slice(out.indexOf("\n----------") + 1);
  for (const block of body.split(/\r?\n\r?\n/)) {
    const field = (k: string) => new RegExp(`^${k} = (.*)$`, "m").exec(block)?.[1];
    const path = field("Path");
    if (path === undefined) continue;
    files.push({ path, size: Number(field("Size") ?? 0), folder: field("Folder") === "+" || (field("Attributes") ?? "").startsWith("D") });
  }
  return files;
}

async function sevenZip(args: string[]) {
  // (niced: a multi-GB extraction shares the app's CPUs with the online relay)
  const p = Bun.spawn(["nice", "-n", "19", "7z", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`7z ${args[0]} exited ${code}: ${err.trim()}`);
  return out;
}

export interface VimmOptions {
  fetch?: typeof fetch;
  /** Accepted disc sizes (the library's; smaller in tests). */
  min?: number;
  max?: number;
}

export function createVimm(dir: string, library: Library, { fetch: get = fetch, min = PS2_MIN, max = PS2_MAX }: VimmOptions = {}) {
  const work = join(dir, "vimm");
  let job: VimmJob = { state: "idle" };
  const catalog = createMediaCatalog({ fetch: get });
  const search = createVault({ fetch: get });
  // (a download cut by a restart left its files: they're nobody's now)
  const ready = rm(work, { recursive: true, force: true }).catch(() => undefined);

  async function run(url: string, pass: Pass): Promise<VimmJob> {
    await ready;
    const page = vimmPage(url);
    if (page) {
      const links = await catalog().catch(() => {
        throw new Refused("O catálogo de links não respondeu. Tente de novo ou cole o link de download do vimm.net.");
      });
      const link = links.get(page.split("/").at(-1)!);
      if (!link) throw new Refused("Essa edição não está no catálogo automático. Cole o link de download do vimm.net ou envie sua ISO.");
      url = link;
      job = { state: "downloading", by: pass.name, name: "", received: 0, size: null };
    }
    await rm(work, { recursive: true, force: true });
    await mkdir(join(work, "out"), { recursive: true });
    const res = await get(url, { headers: { Referer: "https://vimm.net/", "User-Agent": "Mozilla/5.0 HypePlay" }, redirect: "manual" });
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200 || !res.body || /text\/html/.test(type))
      throw new Refused("O vimm.net não entregou um jogo nesse link. Ele pode estar desatualizado ou indisponível. Cole um link de download atual ou envie sua ISO.");
    const size = Number(res.headers.get("content-length")) || null;
    if (size && size > max) throw new Refused("Esse arquivo é grande demais para um jogo de PS2.");
    const file = /filename="?([^";]+)"?/i.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "";
    const name = file.replace(/\.(7z|zip|rar)$/i, "").trim().slice(0, 80);
    const by = pass.name;
    const down: Extract<VimmJob, { state: "downloading" }> = { state: "downloading", by, name, received: 0, size };
    job = down;

    const archive = join(work, "download");
    const writer = Bun.file(archive).writer();
    try {
      for await (const chunk of res.body) {
        down.received += chunk.length;
        if (down.received > max) throw new Refused("Esse arquivo é grande demais para um jogo de PS2.");
        writer.write(chunk);
        await writer.flush();
      }
    } finally {
      await writer.end();
    }
    if (size && down.received !== size) throw new Refused("O download parou no meio. Tente de novo.");

    job = { state: "extracting", by, name };
    const files = await sevenZip(["l", "-slt", archive]).then(listing, () => {
      throw new Refused("Não deu para abrir o arquivo que veio do vimm.net.");
    });
    const isos = files.filter((f) => !f.folder && /\.iso$/i.test(f.path));
    if (isos.length !== 1)
      throw new Refused(
        files.some((f) => /\.(bin|cue)$/i.test(f.path))
          ? "Esse jogo vem em .bin/.cue (disco de CD). Por enquanto só dá para baixar jogos em ISO."
          : "O arquivo não tem uma ISO de PS2 dentro.",
      );
    if (isos[0]!.size < min || isos[0]!.size > max) throw new Refused("A ISO de dentro não tem o tamanho de um jogo de PS2.");
    // `e` flattens paths: whatever the archive names its files, they land in out/
    await sevenZip(["e", archive, `-o${join(work, "out")}`, "-y", "-r", "-ssc-", "*.iso"]);
    await rm(archive, { force: true });
    const [inside] = await readdir(join(work, "out"));
    if (!inside) throw new Refused("O arquivo não tem uma ISO de PS2 dentro.");
    const iso = join(work, "disc.iso");
    await rename(join(work, "out", inside), iso);

    const disc = await readDiscId(fileRead(iso));
    if (!disc) throw new Refused("Isso não parece um disco de PS2 (não achei o SYSTEM.CNF com o jogo).");
    const r = await library.reserve(pass, disc.serial, name);
    if (!r.ok) return { state: "done", by, name, key: r.exists, existed: true } as const;
    try {
      await rename(iso, library.paths(r.game.id).iso);
    } catch (err) {
      await library.remove(r.game.id);
      throw err;
    }
    library.settle(r.game.id);
    return { state: "done", by, name: r.game.name, key: `ps2/${r.game.id}`, existed: false } as const;
  }

  return {
    status: (): VimmJob => ({ ...job }),

    /** The "loja"'s search in Vimm's PS2 vault. */
    async search(q: string) {
      const [games, links] = await Promise.all([search(q), catalog().catch(() => null)]);
      return games.map((g) => ({ ...g, automatic: links?.has(String(g.id)) ?? false }));
    },

    /** Starts the download and returns at once; the page follows it with status(). */
    start(pass: Pass, link: string): { ok: true } | { ok: false; status: number; error: string } {
      const url = vimmLink(link) ?? vimmPage(link);
      if (!url) return { ok: false, status: 400, error: "Cole a página do jogo (https://vimm.net/vault/…) ou o link de download (https://dl2.vimm.net/?mediaId=…)." };
      if (job.state === "resolving" || job.state === "downloading" || job.state === "extracting")
        return { ok: false, status: 409, error: `${job.by} já está instalando um jogo do vimm.net.` };
      job = vimmPage(url) ? { state: "resolving", by: pass.name } : { state: "downloading", by: pass.name, name: "", received: 0, size: null };
      const by = pass.name;
      void run(url, pass)
        .catch((err): VimmJob => {
          if (!(err instanceof Refused)) console.error("vimm download failed", err);
          return { state: "failed", by, message: err instanceof Refused ? err.message : "Não deu para baixar do vimm.net. Tente de novo." };
        })
        // (cleared while still busy, so a next download can't start in the middle of it)
        .then(async (end) => {
          await rm(work, { recursive: true, force: true }).catch(() => undefined);
          job = end;
        });
      return { ok: true };
    },

    /** Done when the current download is (tests). */
    async settled() {
      while (job.state === "resolving" || job.state === "downloading" || job.state === "extracting") await Bun.sleep(10);
    },
  };
}

export type Vimm = ReturnType<typeof createVimm>;

/** A PS2 game in Vimm's vault, as its lists show it. */
export interface VaultGame {
  id: number;
  name: string;
  regions: string[];
  version: string;
  rating: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: " " };
const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|nbsp));/gi, (all, dec?: string, hex?: string, name?: string) => {
      const n = dec ? Number(dec) : hex ? parseInt(hex, 16) : null;
      return n === null ? ENTITIES[name!.toLowerCase()]! : n <= 0x10ffff ? String.fromCodePoint(n) : all;
    })
    .trim();

/** The games in a vault list page (by letter or a search): one per table row with a /vault/<id> link. */
export function parseVault(html: string): VaultGame[] {
  const games: VaultGame[] = [];
  for (const [row] of html.matchAll(/<tr[^>]*>.*?<\/tr>/gs)) {
    const link = /<a href="\/vault\/(\d{1,9})"[^>]*>(.*?)<\/a>/s.exec(row);
    if (!link) continue;
    const cells = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((c) => c[1]!);
    games.push({
      id: Number(link[1]),
      name: text(link[2]!).slice(0, 120),
      regions: [...(cells[1] ?? "").matchAll(/class="flag" title="([^"]{1,30})"/g)].map((m) => m[1]!),
      version: text(cells[2] ?? "").slice(0, 12),
      rating: /^\d{1,2}(\.\d)?$/.test(text(cells[4] ?? "")) ? text(cells[4]!) : "",
    });
  }
  return games;
}

/** The vault address for what was typed: a letter lists that letter, anything else is a search. */
export function vaultUrl(q: string): string {
  const s = q.trim().slice(0, 60);
  if (/^[a-z]$/i.test(s)) return `https://vimm.net/vault/PS2/${s.toUpperCase()}`;
  return `https://vimm.net/vault/?${new URLSearchParams({ p: "list", system: "PS2", q: s })}`;
}

/** The "loja": searches Vimm's PS2 vault. Answers are kept 10 minutes, so the same search asks vimm.net once. */
export function createVault({ fetch: get = fetch }: { fetch?: typeof fetch } = {}) {
  const cache = new Map<string, { at: number; games: VaultGame[] }>();
  return async function search(q: string): Promise<VaultGame[]> {
    const url = vaultUrl(q);
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.games;
    const res = await get(url, { headers: { "User-Agent": "Mozilla/5.0 HypePlay" } });
    if (!res.ok) throw new Error(`vimm.net answered ${res.status}`);
    const games = parseVault(await res.text());
    // shortcut: unbounded until restart; fine for a handful of people searching, an LRU if it ever grows
    cache.set(url, { at: Date.now(), games });
    return games;
  };
}
