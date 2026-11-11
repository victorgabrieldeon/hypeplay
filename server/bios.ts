/**
 * The PS2 BIOS the PS2 games boot with (TabStationToo, like PCSX2, needs one): sent once, by whoever adds the first PS2
 * game, for the whole server, and kept in the data folder (bios/bios.bin, bios/bios.json with who and when). It's
 * Sony's software, from the sender's own console: it stays in the volume, and (with R2) in its daily backup only
 * (backup.ts), in the same private bucket as the discs.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Pass } from "./pass";

/** The 4 MB main ROM of a PS2 (ROM0 in a full dump). */
export const BIOS_BYTES = 4 * 1024 * 1024;
const ROMDIR_WITHIN = 64 * 1024;

/** 4 MiB, with the ROMDIR table near its start: a "RESET" entry and, 16 bytes on, the "ROMDIR" one. */
export function validBios(b: Uint8Array): boolean {
  if (b.length !== BIOS_BYTES) return false;
  const head = new TextDecoder("latin1").decode(b.subarray(0, ROMDIR_WITHIN));
  for (let at = head.indexOf("RESET\0"); at >= 0; at = head.indexOf("RESET\0", at + 1))
    if (head.startsWith("ROMDIR", at + 16)) return true;
  return false;
}

export type BiosInfo = { present: false } | { present: true; by: string; at: number };
export type BiosPut = { ok: true } | { ok: false; status: number; error: string };

export function createBios(dir: string, { now = () => Date.now() } = {}) {
  const root = join(dir, "bios");
  const path = join(root, "bios.bin");
  const meta = join(root, "bios.json");

  async function info(): Promise<BiosInfo> {
    try {
      const m = JSON.parse(await readFile(meta, "utf8")) as { by: string; at: number };
      if (!(await Bun.file(path).exists())) return { present: false };
      return { present: true, by: m.by, at: m.at };
    } catch {
      return { present: false };
    }
  }

  return {
    path,
    info,
    async put(pass: Pass, bytes: Uint8Array, replace: boolean): Promise<BiosPut> {
      if (!validBios(bytes)) return { ok: false, status: 400, error: "Isso não parece a BIOS de um PS2 (arquivo de 4 MB)" };
      if (!replace && (await info()).present) return { ok: false, status: 409, error: "O servidor já tem a BIOS" };
      await mkdir(root, { recursive: true });
      await writeFile(`${path}.tmp`, bytes);
      await rename(`${path}.tmp`, path);
      await writeFile(meta, JSON.stringify({ by: pass.name, at: now() }));
      return { ok: true };
    },
  };
}

export type Bios = ReturnType<typeof createBios>;
