import { expect, test } from "bun:test";
import { decodePad, encodePad, GUEST_ID, GuestPads, KEYS } from "./guestpad";
import type { PadLike } from "./padmap";

const btn = (pressed: boolean, value = pressed ? 1 : 0) => ({ pressed, touched: pressed, value });
const pad = (pressed: number[] = [], axes = [0, 0, 0, 0]): PadLike => ({
  id: "Real pad (STANDARD GAMEPAD)", index: 0, connected: true, timestamp: 1, mapping: "standard",
  buttons: Array.from({ length: 17 }, (_, i) => btn(pressed.includes(i))), axes,
});

test("a pad and the keyboard go out as 16 buttons and 4 axes, and come back the same", () => {
  const msg = encodePad(pad([0, 9], [0.5, -1, 0, 0.25]), new Set(["KeyX"]));
  expect(msg.b).toHaveLength(16);
  expect(msg.a).toEqual([0.5, -1, 0, 0.25]);
  expect(msg.b[0]).toBe(1); // cross, from the pad
  expect(msg.b[9]).toBe(1); // start
  expect(msg.b[1]).toBe(1); // circle, from X on the keyboard
  const back = decodePad(msg);
  expect(back.buttons.slice(0, 16).map((b) => b.pressed)).toEqual(msg.b.map((v) => v > 0.5));
  expect(back.axes).toEqual([0.5, -1, 0, 0.25]);
  expect(KEYS.ArrowUp).toBe(12);
});

test("garbage from the channel is a released pad", () => {
  for (const bad of [null, "x", { b: "no" }, { b: [1, 2], a: [9, 9, 9, 9] }]) {
    const p = decodePad(bad);
    expect(p.buttons.every((b) => !b.pressed)).toBe(true);
    expect(p.axes).toEqual([0, 0, 0, 0]);
  }
  // values are clamped
  expect(decodePad({ b: Array(16).fill(5), a: [3, -3, 0, 0] }).axes).toEqual([1, -1, 0, 0]);
});

test("the guest comes after the host's pads, so it's player 2; a neutral stand-in goes first when the host has none", () => {
  const g = new GuestPads();
  expect(g.list([pad()])).toEqual([pad()]); // nobody joined
  g.join();
  g.set({ b: Array.from({ length: 16 }, (_, i) => (i === 3 ? 1 : 0)), a: [0, 0, 0, 0] });
  const withHost = g.list([pad()]);
  expect(withHost).toHaveLength(2);
  expect(withHost[1]!.id).toBe(GUEST_ID);
  expect(withHost[1]!.index).toBe(1);
  expect(withHost[1]!.buttons[3]!.pressed).toBe(true);

  const keyboardOnly = g.list([null, null]);
  expect(keyboardOnly.map((p) => p?.id)).toEqual(["CordPlay (host)", GUEST_ID]);
  expect(keyboardOnly[0]!.buttons.every((b) => !b.pressed)).toBe(true);

  g.leave();
  expect(g.list([pad()])).toEqual([pad()]);
});
