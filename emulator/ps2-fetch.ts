/**
 * Downloads TabStationToo (PCSX2 compiled to WebAssembly, GPL-3.0) into emulator/ps2/, which the server serves for the
 * PS2 games at /p/<pass>/ps2/<id>/game/. The project has no releases: the files come from its published site, each
 * checked against the SHA-256 in ps2-files.json, so a change upstream fails the build here instead of changing the
 * emulator quietly. Run by the Dockerfile; once by hand for dev.
 *
 *   bun emulator/ps2-fetch.ts            download and check
 *   bun emulator/ps2-fetch.ts --update   download what's published now and rewrite the hashes (then review
 *                                        server/ps2page.ts against the new index.html)
 */
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Ps2File {
  path: string;
  sha256: string;
  /** another address than base + path (the license, from the repository) */
  url?: string;
}

export const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

async function download(base: string, f: Ps2File) {
  const res = await fetch(f.url ?? new URL(f.path, base).href);
  if (!res.ok) throw new Error(`${f.path}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Every file into `dir`, or nothing: they land in a temporary folder that's swapped in once all of them check out. */
export async function fetchPs2({ base, dir, files }: { base: string; dir: string; files: Ps2File[] }) {
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  try {
    for (const f of files) {
      const bytes = await download(base, f);
      const got = sha256(bytes);
      if (got !== f.sha256) throw new Error(`${f.path}: sha256 ${f.sha256} ≠ ${got}`);
      const out = join(tmp, f.path);
      await mkdir(dirname(out), { recursive: true });
      await writeFile(out, bytes);
    }
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

if (import.meta.main) {
  const listPath = join(import.meta.dir, "ps2-files.json");
  const list = JSON.parse(await readFile(listPath, "utf8")) as { base: string; files: Ps2File[] };
  if (process.argv.includes("--update")) {
    for (const f of list.files) f.sha256 = sha256(await download(list.base, f));
    await writeFile(listPath, JSON.stringify(list, null, 2) + "\n");
    console.log(`ps2-files.json: ${list.files.length} hashes rewritten`);
  }
  await fetchPs2({ base: list.base, dir: join(import.meta.dir, "ps2"), files: list.files });
  console.log(`TabStationToo: ${list.files.length} files checked`);
}
