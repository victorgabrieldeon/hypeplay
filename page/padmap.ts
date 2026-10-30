/**
 * A PS2 controller the browser doesn't know, mapped once by its owner onto the standard gamepad layout every game
 * reads. No DOM here: pad.ts (in the games), the home's mapping screen and the server (to check what it keeps) share it.
 */

/** Where a standard button comes from on the real pad. */
export type Source =
  | { button: number }
  /** an axis used as a button: pressed past half way in `dir` */
  | { axis: number; dir: 1 | -1 }
  /** a d-pad reported as one axis with a value per direction (many PS2 adapters) */
  | { hat: number; value: number };

export interface AxisSource {
  axis: number;
  invert?: boolean;
}

export interface Mapping {
  /** 16, in the standard layout's order (STANDARD) */
  buttons: (Source | null)[];
  /** 4: left x, left y, right x, right y */
  axes: (AxisSource | null)[];
}

/** The W3C standard gamepad's buttons, in order: what the games read (PS2 names). */
export const STANDARD = ["cross", "circle", "square", "triangle", "l1", "r1", "l2", "r2", "select", "start", "l3", "r3", "up", "down", "left", "right"] as const;

export interface PadButton {
  pressed: boolean;
  touched: boolean;
  value: number;
}

/** What games read of a Gamepad (a real one, or the one remap makes). */
export interface PadLike {
  id: string;
  index: number;
  connected: boolean;
  timestamp: number;
  mapping: string;
  buttons: readonly PadButton[];
  axes: readonly number[];
  vibrationActuator?: unknown;
}

/** An axis used as a button counts as pressed past this. */
const AXIS_PRESS = 0.5;
/** A hat's value matches a direction within this. */
const HAT_SLACK = 0.1;
const released: PadButton = { pressed: false, touched: false, value: 0 };

function read(raw: PadLike, s: Source | null): PadButton {
  if (!s) return released;
  if ("button" in s) {
    const b = raw.buttons[s.button];
    return b ? { pressed: b.pressed, touched: b.touched, value: b.value } : released;
  }
  if ("hat" in s) {
    const v = raw.axes[s.hat];
    return v !== undefined && Math.abs(v - s.value) < HAT_SLACK ? { pressed: true, touched: true, value: 1 } : released;
  }
  const v = raw.axes[s.axis];
  if (v === undefined) return released;
  const value = Math.max(0, v * s.dir);
  return value > AXIS_PRESS ? { pressed: true, touched: true, value } : released;
}

/** The raw pad seen through its mapping: the standard layout, 16 buttons and 4 axes. */
export function remap(raw: PadLike, m: Mapping): PadLike {
  return {
    id: raw.id,
    index: raw.index,
    connected: raw.connected,
    timestamp: raw.timestamp,
    mapping: "standard",
    buttons: m.buttons.map((s) => read(raw, s)),
    axes: m.axes.map((a) => {
      const v = a ? raw.axes[a.axis] : undefined;
      return v === undefined ? 0 : a!.invert ? -v : v;
    }),
    vibrationActuator: raw.vibrationActuator,
  };
}

/**
 * Puts the mappings in front of `nav.getGamepads()`: a pad with a valid mapping (by its id) comes back remapped, any
 * other as it is. `maps` is read on every call, so filling it in later (once fetched) takes effect at once.
 */
export function install(nav: { getGamepads(): (PadLike | null)[] }, maps: Record<string, Mapping>) {
  const real = nav.getGamepads.bind(nav);
  nav.getGamepads = () =>
    [...real()].map((pad) => {
      const m = pad && Object.hasOwn(maps, pad.id) ? maps[pad.id] : undefined;
      return pad && m && validMapping(m) ? remap(pad, m) : pad;
    });
}

const index = (n: unknown) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < 64;

function validSource(s: unknown): boolean {
  if (s === null) return true;
  if (typeof s !== "object") return false;
  const o = s as Record<string, unknown>;
  if ("button" in o) return Object.keys(o).length === 1 && index(o.button);
  if ("hat" in o) return Object.keys(o).length === 2 && index(o.hat) && typeof o.value === "number" && Math.abs(o.value) <= 1;
  if ("axis" in o) return Object.keys(o).length === 2 && index(o.axis) && (o.dir === 1 || o.dir === -1);
  return false;
}

function validAxis(a: unknown): boolean {
  if (a === null) return true;
  if (typeof a !== "object") return false;
  const o = a as Record<string, unknown>;
  return index(o.axis) && (o.invert === undefined || typeof o.invert === "boolean") && Object.keys(o).every((k) => k === "axis" || k === "invert");
}

export function validMapping(m: unknown): m is Mapping {
  if (!m || typeof m !== "object") return false;
  const { buttons, axes } = m as Record<string, unknown>;
  return Array.isArray(buttons) && buttons.length === 16 && buttons.every(validSource) && Array.isArray(axes) && axes.length === 4 && axes.every(validAxis);
}
