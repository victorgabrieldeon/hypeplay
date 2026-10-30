// padmap.js for the home's controller screen (bundled at startup, server/index.ts): the same mapping the games use.
import { padFamily, remap, STANDARD, validMapping } from "./padmap";

(globalThis as { CordPad?: unknown }).CordPad = { padFamily, remap, STANDARD, validMapping };
