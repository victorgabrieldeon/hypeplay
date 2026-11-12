/**
 * Test helper: a minimal ISO9660 image in memory (primary descriptor, root directory, files), enough for the
 * disc readers to find SYSTEM.CNF. Never shipped: only tests import it.
 */

const SECTOR = 2048;

function record(name: Uint8Array, extent: number, size: number, dir: boolean): Uint8Array {
  const len = 33 + name.length + (name.length % 2 === 0 ? 1 : 0);
  const r = new Uint8Array(len);
  const v = new DataView(r.buffer);
  r[0] = len;
  v.setUint32(2, extent, true);
  v.setUint32(6, extent, false);
  v.setUint32(10, size, true);
  v.setUint32(14, size, false);
  r[25] = dir ? 2 : 0;
  r[32] = name.length;
  r.set(name, 33);
  return r;
}

/** Files by name ("SYSTEM.CNF" is stored as "SYSTEM.CNF;1"; a name with ";" is kept as is). `pad`: least total size. */
export function makeIso(files: Record<string, string | Uint8Array>, { pad = 0 }: { pad?: number } = {}): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const entries = Object.entries(files).map(([name, data]) => ({
    name: enc.encode(name.includes(";") ? name : `${name};1`),
    data: typeof data === "string" ? enc.encode(data) : data,
  }));
  const ROOT = 18;
  // Directory records may not cross a sector: lay them out first to know the directory's length.
  const sizes = [34, 34, ...entries.map((e) => record(e.name, 0, 0, false).length)];
  let at = 0;
  const offsets = sizes.map((len) => {
    if ((at % SECTOR) + len > SECTOR) at = Math.ceil(at / SECTOR) * SECTOR;
    const o = at;
    at += len;
    return o;
  });
  const dirSectors = Math.max(1, Math.ceil(at / SECTOR));
  let next = ROOT + dirSectors;
  const extents = entries.map((e) => {
    const x = next;
    next += Math.max(1, Math.ceil(e.data.length / SECTOR));
    return x;
  });
  const out = new Uint8Array(Math.max(next * SECTOR, pad));

  const pvd = 16 * SECTOR;
  out[pvd] = 1;
  out.set(enc.encode("CD001"), pvd + 1);
  out[pvd + 6] = 1;
  // the volume's size in sectors, both-endian (a truncated copy is shorter than this)
  new DataView(out.buffer).setUint32(pvd + 80, Math.floor(out.length / SECTOR), true);
  new DataView(out.buffer).setUint32(pvd + 84, Math.floor(out.length / SECTOR), false);
  out.set(record(new Uint8Array([0]), ROOT, dirSectors * SECTOR, true), pvd + 156);
  out[17 * SECTOR] = 255;
  out.set(enc.encode("CD001"), 17 * SECTOR + 1);

  const dir = ROOT * SECTOR;
  out.set(record(new Uint8Array([0]), ROOT, dirSectors * SECTOR, true), dir + offsets[0]!);
  out.set(record(new Uint8Array([1]), ROOT, dirSectors * SECTOR, true), dir + offsets[1]!);
  entries.forEach((e, i) => {
    out.set(record(e.name, extents[i]!, e.data.length, false), dir + offsets[i + 2]!);
    out.set(e.data, extents[i]! * SECTOR);
  });
  return out;
}
