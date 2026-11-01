/**
 * The person's own keys for the PS2 games, made on the home's Controle screen: a key per standard button and per stick
 * direction. pad.js turns the held keys into a pad in front of navigator.getGamepads(), so the emulator and the fast
 * version both read it the way they read a controller. No DOM here: pad.ts, the home and the server share it.
 */
import type { PadButton, PadLike } from "./padmap";

export interface KeyMap {
  /** 16 KeyboardEvent.code (or null), in the standard layout's order (STANDARD) */
  buttons: (string | null)[];
  /** 8: left stick left, right, up, down; then the right stick's */
  sticks: (string | null)[];
}

export const KEYBOARD_ID = "Teclado (HypePlay)";

/**
 * A key that can be mapped. Escape and Tab stay the page's (they close the home's screens and release TabStationToo's
 * keyboard); Ctrl, Alt and Meta too, since pad.js leaves combos with them (browser shortcuts) to the page.
 */
export const keyAllowed = (c: unknown): c is string => typeof c === "string" && /^[A-Za-z0-9]{1,24}$/.test(c) && !/^(Escape|Tab|Control|Alt|Meta|OS)/.test(c);
const code = (c: unknown) => c === null || keyAllowed(c);

export function validKeyMap(m: unknown): m is KeyMap {
  if (!m || typeof m !== "object") return false;
  const { buttons, sticks } = m as Record<string, unknown>;
  if (!Array.isArray(buttons) || buttons.length !== 16 || !Array.isArray(sticks) || sticks.length !== 8) return false;
  const all = [...buttons, ...sticks];
  const used = all.filter((c) => c !== null);
  return all.every(code) && new Set(used).size === used.length && Object.keys(m).length === 2;
}

export const keyCodes = (m: KeyMap) => new Set([...m.buttons, ...m.sticks].filter((c): c is string => c !== null));

const button = (on: boolean): PadButton => ({ pressed: on, touched: on, value: on ? 1 : 0 });

/** The pad the held keys make: 16 buttons, 4 axes (both ways held is the middle). */
export function keyPad(m: KeyMap, held: ReadonlySet<string>, timestamp: number): PadLike {
  const on = (c: string | null | undefined) => !!c && held.has(c);
  return {
    id: KEYBOARD_ID,
    index: 0,
    connected: true,
    timestamp,
    mapping: "standard",
    buttons: m.buttons.map((c) => button(on(c))),
    axes: [0, 1, 2, 3].map((a) => (on(m.sticks[a * 2 + 1]) ? 1 : 0) - (on(m.sticks[a * 2]) ? 1 : 0)),
  };
}

/** The keyboard as player 1: pressed along with the first pad, or as pad 0 when there's none. */
export function withKeys(list: (PadLike | null)[], keys: PadLike | null): (PadLike | null)[] {
  if (!keys) return list;
  const out = [...list];
  const i = out.findIndex(Boolean);
  if (i < 0) {
    out[0] = keys;
    return out;
  }
  const pad = out[i]!;
  out[i] = {
    ...pad,
    timestamp: Math.max(pad.timestamp, keys.timestamp),
    buttons: pad.buttons.map((b, k) => (keys.buttons[k]?.pressed ? keys.buttons[k]! : b)),
    axes: pad.axes.map((v, k) => keys.axes[k] || v),
  };
  return out;
}
