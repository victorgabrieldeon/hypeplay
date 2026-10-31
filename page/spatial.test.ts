import { expect, test } from "bun:test";
import { nearest, stickScroll, type Box } from "./spatial";

const box = (left: number, top: number, w = 100, h = 150): Box => ({ left, top, right: left + w, bottom: top + h });

test("the nearest thing that way, preferring what's in line over what's closer but off to the side", () => {
  // a grid of covers: 3 across, 2 down, 20 px apart
  const grid = [box(0, 0), box(120, 0), box(240, 0), box(0, 170), box(120, 170), box(240, 170)];
  expect(nearest(grid[1]!, grid, "right")).toBe(2);
  expect(nearest(grid[1]!, grid, "left")).toBe(0);
  expect(nearest(grid[1]!, grid, "down")).toBe(4);
  expect(nearest(grid[4]!, grid, "up")).toBe(1);
  expect(nearest(grid[2]!, grid, "right")).toBe(-1);
  expect(nearest(grid[0]!, grid, "up")).toBe(-1);
});

test("from the sidebar to the page, and a wide button above a row", () => {
  const side = box(10, 300, 200, 40);
  const hero = box(260, 80, 800, 300);
  const card = box(260, 420);
  expect(nearest(side, [side, hero, card], "right")).toBe(1);
  // down from a wide box lands on the card under it
  expect(nearest(hero, [side, hero, card], "down")).toBe(2);
});

test("the right stick scrolls: nothing in the dead zone, faster the further it's pushed, either way", () => {
  expect(stickScroll(0.15, 30)).toBe(0);
  expect(stickScroll(-0.15, 30)).toBe(0);
  expect(stickScroll(1, 30)).toBe(54); // full tilt: 1800 px a second
  expect(stickScroll(-1, 30)).toBe(-54);
  const half = stickScroll(0.6, 30);
  expect(half).toBeGreaterThan(0);
  expect(half).toBeLessThan(stickScroll(0.9, 30));
  expect(stickScroll(1, 60)).toBe(108);
  expect(stickScroll(Number.NaN, 30)).toBe(0);
});
