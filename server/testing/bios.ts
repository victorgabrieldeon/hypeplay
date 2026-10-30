/** Test helper: a stand-in PS2 BIOS, 4 MiB with the ROMDIR table where the real one has it. Only tests import it. */
import { BIOS_BYTES } from "../bios";

export function fakeBios(fill = 0) {
  const b = new Uint8Array(BIOS_BYTES).fill(fill);
  const enc = new TextEncoder();
  b.set(enc.encode("RESET\0"), 0x2780);
  b.set(enc.encode("ROMDIR"), 0x2780 + 16);
  return b;
}
