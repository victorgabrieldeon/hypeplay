// padmap.js for the home's controller screen (bundled at startup, server/index.ts): the same mapping the games use.
import { remap, STANDARD, validMapping } from "./padmap";

(globalThis as { CordPad?: unknown }).CordPad = { remap, STANDARD, validMapping };
