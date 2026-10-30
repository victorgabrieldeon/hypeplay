/**
 * Which PS2 game a disc image is: its SYSTEM.CNF names the boot program (BOOT2 = cdrom0:\SLUS_216.78;1), and that
 * name is the game's serial. Reads only the few sectors it needs through `read`, so it works on a file on the server
 * and, bundled as iso.js, on a File in the page before anything is sent.
 */

export type Read = (offset: number, length: number) => Promise<Uint8Array>;

export interface DiscId {
  /** SLUS-21678 */
  serial: string;
  /** slus-21678: the game's folder and its place in the addresses */
  id: string;
  /** BOOT2 as written, cdrom0:\SLUS_216.78;1 */
  boot: string;
}

/** Budokai Tenkaichi 3's own port has this serial: sending it again points at that one. */
export const BT3_SERIAL = "SLUS-21678";

const SECTOR = 2048;
/** Directories and SYSTEM.CNF are small; anything larger isn't a disc we read. */
const MOST = 1024 * 1024;

const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array) => String.fromCharCode(...b);

async function systemCnf(read: Read): Promise<string | null> {
  const pvd = await read(16 * SECTOR, SECTOR);
  if (pvd.length < SECTOR || pvd[0] !== 1 || ascii(pvd.subarray(1, 6)) !== "CD001") return null;
  const rootAt = u32(pvd, 156 + 2);
  const rootSize = Math.min(u32(pvd, 156 + 10), MOST);
  const dir = await read(rootAt * SECTOR, rootSize);
  for (let pos = 0; pos < dir.length; ) {
    const len = dir[pos]!;
    if (len === 0) {
      // the rest of this sector is padding
      pos = (Math.floor(pos / SECTOR) + 1) * SECTOR;
      continue;
    }
    if (pos + 33 > dir.length) break;
    const name = ascii(dir.subarray(pos + 33, pos + 33 + dir[pos + 32]!)).toUpperCase().replace(/;1$/, "");
    if (name === "SYSTEM.CNF" && !(dir[pos + 25]! & 2)) {
      const size = Math.min(u32(dir, pos + 10), MOST);
      return new TextDecoder("latin1").decode(await read(u32(dir, pos + 2) * SECTOR, size));
    }
    pos += len;
  }
  return null;
}

/** The game on a disc image, or null when it isn't a PS2 disc (no SYSTEM.CNF, no BOOT2, no serial-shaped name). */
export async function readDiscId(read: Read): Promise<DiscId | null> {
  const cnf = await systemCnf(read).catch(() => null);
  const boot = cnf && /^[ \t]*BOOT2[ \t]*=[ \t]*(cdrom0:[^\r\n]*?)[ \t]*$/im.exec(cnf)?.[1];
  if (!boot) return null;
  const program = boot.slice(boot.lastIndexOf("\\") + 1 || "cdrom0:".length).split(";")[0]!;
  const m = /^([A-Z]{4})_(\d{3})\.(\d{2})$/i.exec(program);
  if (!m) return null;
  const serial = `${m[1]!.toUpperCase()}-${m[2]}${m[3]}`;
  return { serial, id: serial.toLowerCase(), boot };
}

/** Slices of a file on disk. */
export const fileRead =
  (path: string): Read =>
  async (offset, length) =>
    new Uint8Array(await Bun.file(path).slice(offset, offset + length).arrayBuffer());
