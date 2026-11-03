/**
 * "Baixar do vimm.net": the server downloads a PS2 game straight from Vimm's Lair, instead of someone sending its ISO
 * from their PC. The game's page there sits behind a human check, so the link comes from whoever passed it: Download
 * on the game's page, then the address in the browser's downloads (https://dl3.vimm.net/?mediaId=12345). The server
 * only ever asks a dl*.vimm.net host, with an address it builds itself from the digits.
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
  // (a download cut by a restart left its files: they're nobody's now)
  const ready = rm(work, { recursive: true, force: true }).catch(() => undefined);

  async function run(url: string, pass: Pass): Promise<VimmJob> {
    await ready;
    await rm(work, { recursive: true, force: true });
    await mkdir(join(work, "out"), { recursive: true });
    const res = await get(url, { headers: { Referer: "https://vimm.net/", "User-Agent": "Mozilla/5.0 HypePlay" }, redirect: "manual" });
    const type = res.headers.get("content-type") ?? "";
    if (res.status !== 200 || !res.body || /text\/html/.test(type))
      throw new Refused("O vimm.net não entregou um jogo nesse link. Pegue o link de novo na página do jogo.");
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

    /** Starts the download and returns at once; the page follows it with status(). */
    start(pass: Pass, link: string): { ok: true } | { ok: false; status: number; error: string } {
      const url = vimmLink(link);
      if (!url) return { ok: false, status: 400, error: "Cole o link de download do vimm.net (https://dl3.vimm.net/?mediaId=…)." };
      if (job.state === "downloading" || job.state === "extracting")
        return { ok: false, status: 409, error: `${job.by} já está baixando ${job.name || "um jogo"} do vimm.net.` };
      job = { state: "downloading", by: pass.name, name: "", received: 0, size: null };
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
      while (job.state === "downloading" || job.state === "extracting") await Bun.sleep(10);
    },
  };
}

export type Vimm = ReturnType<typeof createVimm>;
