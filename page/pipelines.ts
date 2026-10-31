// The PS2 games' pipeline lists (TabStationToo's "Pipeline lists"): the WebGPU renderer logs which pipelines (shader
// combinations) a game's draws asked for, and the page keeps them per game in this browser's IndexedDB to create them
// ahead of time on the next boot. A pipeline made the first time it's drawn costs a long frame, so a browser that never
// saw an effect stutters on it. The server keeps one list per game, the union of everyone's (routes.ts' pipelines),
// so a browser starts with what anyone has seen (ps2play.ts).
//
// On the wire: the version (two little-endian u32, the emulator's key version) and the keys, 36 bytes each.

export const KEY_BYTES = 36; // WebGPUHost::TFX_KEY_BYTES
export const CAPACITY = 4096; // WebGPUHost::TFX_KEY_CAPACITY

export interface PipeList {
  version: [number, number];
  keys: Uint8Array;
}

export function encodeList(l: PipeList): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(8 + l.keys.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, l.version[0] >>> 0, true);
  v.setUint32(4, l.version[1] >>> 0, true);
  out.set(l.keys, 8);
  return out;
}

export function decodeList(bytes: Uint8Array): PipeList | null {
  const n = (bytes.length - 8) / KEY_BYTES;
  if (bytes.length < 8 || !Number.isInteger(n) || n > CAPACITY) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, 8);
  return { version: [v.getUint32(0, true), v.getUint32(4, true)], keys: bytes.slice(8) };
}

const sameVersion = (a: PipeList, b: PipeList) => a.version[0] >>> 0 === b.version[0] >>> 0 && a.version[1] >>> 0 === b.version[1] >>> 0;

/** `first`'s keys, then `more`'s it hasn't got, up to the capacity; a list of another version is left out. */
export function mergeLists(first: PipeList | null, more: PipeList | null): PipeList | null {
  if (!first || !more || !sameVersion(first, more)) return first ?? more;
  const seen = new Set<string>();
  const keys: Uint8Array[] = [];
  for (const l of [first, more])
    for (let o = 0; o + KEY_BYTES <= l.keys.length && keys.length < CAPACITY; o += KEY_BYTES) {
      const k = l.keys.subarray(o, o + KEY_BYTES);
      const id = k.join(",");
      if (seen.has(id)) continue;
      seen.add(id);
      keys.push(k);
    }
  const out = new Uint8Array(keys.length * KEY_BYTES);
  keys.forEach((k, i) => out.set(k, i * KEY_BYTES));
  return { version: [first.version[0] >>> 0, first.version[1] >>> 0], keys: out };
}
