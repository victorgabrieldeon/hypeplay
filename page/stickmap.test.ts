import { expect, test } from "bun:test";
import { pushed, turning } from "./stickmap";

/** A stick going round once on axes `x` and `y` of a 10-axis pad, the rest as `others`. */
function round(x: number, y: number, others: number[] = Array(10).fill(0), steps = 24) {
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    const axes = [...others];
    axes[x] = Math.cos(a);
    axes[y] = Math.sin(a);
    return axes;
  });
}

test("turning a stick finds its two axes and their middles; hats, triggers at rest and small wobbles don't count", () => {
  const others = [0, 0, 0.05, 0, -1, -1, 0, 0, 0, 3.2857]; // (triggers resting at -1 on 4 and 5, the hat on 9)
  const t = turning(new Set([9]));
  expect(t.stick()).toBeNull();
  for (const axes of round(0, 1, others).slice(0, 8)) t.add(axes); // (a third of a turn: not yet)
  expect(t.stick()).toBeNull();
  for (const axes of round(0, 1, others)) t.add(axes.map((v, i) => (i === 2 ? v + Math.random() * 0.1 : v)));
  const s = t.stick()!;
  expect(s.axes).toEqual([0, 1]);
  expect(s.middle[0]).toBeCloseTo(0, 5);
  expect(s.middle[1]).toBeCloseTo(0, 5);
});

test("the right stick on an adapter's odd axes, with the left stick's left out", () => {
  const t = turning(new Set([0, 1]));
  for (const axes of round(5, 2)) t.add(axes);
  expect(t.stick()!.axes).toEqual([2, 5]);
});

test("pushed one way: the axis that moved most (not the first past the mark), and which way", () => {
  const stick = { axes: [0, 1] as [number, number], middle: [0, 0] as [number, number] };
  // right, a bit down too: both past 0.6, x the most
  expect(pushed([0.95, 0.65], stick)).toEqual({ axis: 0, dir: 1 });
  // down on a pad whose y goes up: inverted
  expect(pushed([0.1, -0.98], stick)).toEqual({ axis: 1, dir: -1 });
  expect(pushed([0.3, 0.2], stick)).toBeNull();
});

test("a stick whose middle isn't 0 (some adapters) is measured from its own middle", () => {
  const stick = { axes: [0, 1] as [number, number], middle: [0.12, -0.05] as [number, number] };
  expect(pushed([0.6, 0], stick)).toBeNull();
  expect(pushed([0.85, 0], stick)).toEqual({ axis: 0, dir: 1 });
});
