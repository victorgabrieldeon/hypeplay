// padmap.js for the home's controller screen (bundled at startup, server/index.ts): the same mapping the games use.
import { keyAllowed, keyPad } from "./keymap";
import { padFamily, remap, STANDARD, validMapping } from "./padmap";
import { nearest, stickScroll } from "./spatial";
import { centered, pushed, turning } from "./stickmap";

(globalThis as { CordPad?: unknown }).CordPad = { centered, keyAllowed, keyPad, nearest, padFamily, pushed, remap, STANDARD, stickScroll, turning, validMapping };
