/**
 * The online guest's controller, as one more gamepad on the host's page. The guest's page sends its pad (and keyboard)
 * as 16 standard buttons and 4 axes over a data channel; the host's pad.js lists it after the host's own pads, so the
 * emulator, which hands out ports by arrival, makes it player 2. When the host plays on the keyboard (no pad), a
 * neutral stand-in goes first, so the guest is still the second pad. No DOM here: tested on its own.
 */
import type { PadButton, PadLike } from "./padmap";

export const GUEST_ID = "HypePlay convidado (jogador 2)";
const HOST_ID = "HypePlay (host)";

/** The guest's keyboard, on the standard layout (the same keys TabStationToo and the PS2 web ports use). */
export const KEYS: Record<string, number> = {
  KeyZ: 0, KeyX: 1, KeyA: 2, KeyS: 3, KeyQ: 4, KeyW: 5, Digit1: 6, Digit2: 7, Backspace: 8, Enter: 9,
  ArrowUp: 12, ArrowDown: 13, ArrowLeft: 14, ArrowRight: 15,
};

/** What goes over the channel: buttons 0–1, axes −1–1. */
export interface PadMsg {
  b: number[];
  a: number[];
}

const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);

export function encodePad(pad: PadLike | null, keys: Set<string>): PadMsg {
  const b = Array.from({ length: 16 }, (_, i) => {
    const x = pad?.buttons[i];
    return x ? (x.pressed ? Math.max(x.value, 1) : x.value) : 0;
  });
  for (const k of keys) if (k in KEYS) b[KEYS[k]!] = 1;
  const a = Array.from({ length: 4 }, (_, i) => pad?.axes[i] ?? 0);
  return { b: b.map((v) => clamp(v, 0, 1)), a: a.map((v) => clamp(v, -1, 1)) };
}

const released = (): PadButton[] => Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 }));

/** A message from the channel as buttons and axes; anything malformed is a released pad. */
export function decodePad(msg: unknown): { buttons: PadButton[]; axes: number[] } {
  const m = msg as Partial<PadMsg> | null;
  if (!m || !Array.isArray(m.b) || m.b.length !== 16 || !Array.isArray(m.a) || m.a.length !== 4) return { buttons: released(), axes: [0, 0, 0, 0] };
  const buttons = released();
  m.b.forEach((v, i) => {
    const value = clamp(v, 0, 1);
    buttons[i] = { pressed: value > 0.5, touched: value > 0, value };
  });
  return { buttons, axes: m.a.map((v) => clamp(v, -1, 1)) };
}

const pad = (id: string, index: number, buttons: PadButton[], axes: number[]): PadLike => ({
  id, index, connected: true, timestamp: performance.now(), mapping: "standard", buttons, axes,
});

export class GuestPads {
  private joined = false;
  private state = decodePad(null);

  join() {
    this.joined = true;
    this.state = decodePad(null);
  }

  leave() {
    this.joined = false;
  }

  get active() {
    return this.joined;
  }

  set(msg: unknown) {
    this.state = decodePad(msg);
  }

  /** The browser's pads, plus the stand-in (if the host has none) and the guest, at the first free places. */
  list(real: (PadLike | null)[]): (PadLike | null)[] {
    if (!this.joined) return real;
    const out = [...real];
    if (!out.some(Boolean)) out[0] = pad(HOST_ID, 0, released(), [0, 0, 0, 0]);
    let i = 1;
    while (out[i]) i++;
    out[i] = pad(GUEST_ID, i, this.state.buttons, this.state.axes);
    return out;
  }
}
