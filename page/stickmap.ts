/**
 * Mapping a stick (the controller screen, home/controller.js): the person turns it round, which finds its two axes and
 * where each one rests (some adapters don't rest at 0); then pushes it right and down, which tells x from y and which
 * way each one goes. Only the stick's own two axes count, and the one that moved most wins, so a push that drifts a
 * little diagonally, a trigger resting at -1 or the d-pad's hat can't be taken for it.
 */

/** Turned all the way round: from about -0.7 to 0.7 at least. */
export const TURN_REACH = 1.4;
/** Pushed: this far from the middle. */
export const PUSH = 0.6;

export interface Stick {
  axes: [number, number];
  middle: [number, number];
}

/** Watching a stick being turned; `skip`: axes that can't be it (hats, the other stick's, ones mapped as buttons). */
export function turning(skip: ReadonlySet<number> = new Set()) {
  const lo = new Map<number, number>();
  const hi = new Map<number, number>();
  return {
    add(axes: readonly number[]) {
      axes.forEach((v, i) => {
        if (skip.has(i) || Math.abs(v) > 1.05) return;
        lo.set(i, Math.min(lo.get(i) ?? v, v));
        hi.set(i, Math.max(hi.get(i) ?? v, v));
      });
    },
    /** How far each axis has gone so far (the screen shows it filling). */
    reach(i: number) {
      return (hi.get(i) ?? 0) - (lo.get(i) ?? 0);
    },
    /** The stick, once two axes went all the way round; null until then. */
    stick(): Stick | null {
      const best = [...lo.keys()].sort((a, b) => this.reach(b) - this.reach(a)).slice(0, 2);
      if (best.length < 2 || best.some((i) => this.reach(i) < TURN_REACH)) return null;
      const axes = best.sort((a, b) => a - b) as [number, number];
      return { axes, middle: axes.map((i) => (lo.get(i)! + hi.get(i)!) / 2) as [number, number] };
    },
  };
}

/** Pushed one way: of the stick's two axes, the one furthest from its middle (past PUSH), and which way. */
export function pushed(axes: readonly number[], stick: Stick): { axis: number; dir: 1 | -1 } | null {
  let best: { axis: number; dir: 1 | -1 } | null = null;
  let far = PUSH;
  for (const [k, axis] of stick.axes.entries()) {
    const d = (axes[axis] ?? 0) - stick.middle[k]!;
    if (Math.abs(d) > far) {
      far = Math.abs(d);
      best = { axis, dir: d > 0 ? 1 : -1 };
    }
  }
  return best;
}

/** Back in the middle: both of the stick's axes near where they rest. */
export const centered = (axes: readonly number[], stick: Stick) => stick.axes.every((axis, k) => Math.abs((axes[axis] ?? 0) - stick.middle[k]) < 0.3);
