/**
 * Moving through the home with a controller, like a console's menu (home/gamepadnav.js): from what has the focus, the
 * nearest thing in the direction pushed. What's in line wins over what's closer but off to the side, so down from a
 * cover is the cover under it, not the one diagonally next to it.
 */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export type Dir = "up" | "down" | "left" | "right";

/** The gap between two ranges (0 when they overlap). */
const gap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, b0 - a1, a0 - b1);

/** The index in `boxes` of the one to go to from `from`, or -1 when there's nothing that way. */
export function nearest(from: Box, boxes: readonly Box[], dir: Dir): number {
  const fx = (from.left + from.right) / 2;
  const fy = (from.top + from.bottom) / 2;
  let best = -1;
  let score = Infinity;
  boxes.forEach((b, i) => {
    const x = (b.left + b.right) / 2;
    const y = (b.top + b.bottom) / 2;
    let along: number;
    let across: number;
    if (dir === "right" || dir === "left") {
      if (dir === "right" ? x <= fx + 1 : x >= fx - 1) return;
      along = dir === "right" ? Math.max(0, b.left - from.right) : Math.max(0, from.left - b.right);
      across = gap(from.top, from.bottom, b.top, b.bottom);
    } else {
      if (dir === "down" ? y <= fy + 1 : y >= fy - 1) return;
      along = dir === "down" ? Math.max(0, b.top - from.bottom) : Math.max(0, from.top - b.bottom);
      across = gap(from.left, from.right, b.left, b.right);
    }
    // (centers' distance only breaks ties)
    const s = along + across * 3 + Math.hypot(x - fx, y - fy) * 0.01;
    if (s < score) {
      score = s;
      best = i;
    }
  });
  return best;
}
