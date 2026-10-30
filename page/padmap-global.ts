// padmap.js for the home's controller screen (bundled at startup, server/index.ts): the same mapping the games use.
import { padFamily, remap, STANDARD, validMapping } from "./padmap";
import { nearest } from "./spatial";
import { centered, pushed, turning } from "./stickmap";

(globalThis as { CordPad?: unknown }).CordPad = { centered, nearest, padFamily, pushed, remap, STANDARD, turning, validMapping };
