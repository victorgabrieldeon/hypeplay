import { expect, test } from "bun:test";
import { KEYBOARD_ID, keyPad, validKeyMap, withKeys, type KeyMap } from "./keymap";
import type { PadLike } from "./padmap";

const map: KeyMap = {
  buttons: ["KeyK", "KeyL", "KeyJ", "KeyI", "KeyQ", "KeyE", "Digit1", "Digit3", "ShiftLeft", "Enter", null, null, "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"],
  sticks: ["KeyA", "KeyD", "KeyW", "KeyS", null, null, null, null],
};

test("a key map: 16 buttons, 8 directions, codes only, no key twice, no Escape or Tab", () => {
  expect(validKeyMap(map)).toBe(true);
  expect(validKeyMap({ ...map, sticks: map.sticks.slice(1) })).toBe(false);
  expect(validKeyMap({ ...map, buttons: ["KeyA", ...map.buttons.slice(1)] })).toBe(false);
  expect(validKeyMap({ ...map, buttons: ["Escape", ...map.buttons.slice(1)] })).toBe(false);
  expect(validKeyMap({ ...map, buttons: ["Tab", ...map.buttons.slice(1)] })).toBe(false);
  expect(validKeyMap({ ...map, buttons: ["ControlLeft", ...map.buttons.slice(1)] })).toBe(false);
  expect(validKeyMap({ ...map, buttons: ["AltRight", ...map.buttons.slice(1)] })).toBe(false);
  expect(validKeyMap({ ...map, buttons: ["<b>", ...map.buttons.slice(1)] })).toBe(false);
  expect(validKeyMap({ ...map, extra: 1 })).toBe(false);
  expect(validKeyMap(null)).toBe(false);
});

test("held keys make the standard pad; both ways held is the middle", () => {
  const p = keyPad(map, new Set(["KeyK", "KeyD", "KeyW", "KeyS"]), 5);
  expect(p.id).toBe(KEYBOARD_ID);
  expect(p.timestamp).toBe(5);
  expect(p.buttons.map((b) => b.pressed)).toEqual([true, ...Array(15).fill(false)]);
  expect(p.axes).toEqual([1, 0, 0, 0]);
});

test("the keyboard is pad 0 alone, or pressed along with the first pad", () => {
  const keys = keyPad(map, new Set(["KeyL", "KeyA"]), 9);
  expect(withKeys([null, null], keys)[0]).toBe(keys);
  expect(withKeys([null], null)).toEqual([null]);
  const real: PadLike = {
    id: "real", index: 1, connected: true, timestamp: 3, mapping: "standard",
    buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: i === 0, touched: i === 0, value: i === 0 ? 1 : 0 })),
    axes: [0.2, 0.5, 0, 0],
  };
  const [none, both] = withKeys([null, real], keys);
  expect(none).toBeNull();
  expect(both!.id).toBe("real");
  expect(both!.index).toBe(1);
  expect(both!.timestamp).toBe(9);
  expect(both!.buttons.slice(0, 3).map((b) => b.pressed)).toEqual([true, true, false]);
  expect(both!.axes).toEqual([-1, 0.5, 0, 0]);
});
