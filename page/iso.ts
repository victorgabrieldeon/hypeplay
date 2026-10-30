// iso.js for the home (bundled at startup, server/index.ts): reads a chosen disc image's serial before anything is
// sent, with the same reader the server checks the whole image with.
import { readDiscId } from "../server/iso9660";

(globalThis as { CordISO?: unknown }).CordISO = {
  /** The serial of a File the person picked, or null when it isn't a PS2 disc. */
  fromFile: (file: Blob) => readDiscId(async (offset, length) => new Uint8Array(await file.slice(offset, offset + length).arrayBuffer())),
};
