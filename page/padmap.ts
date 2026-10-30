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
