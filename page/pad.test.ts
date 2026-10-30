import { expect, test } from "bun:test";
import { install, padFamily, remap, STANDARD, type Mapping, type PadLike } from "./padmap";

const button = (pressed: boolean, value = pressed ? 1 : 0) => ({ pressed, touched: pressed, value });

/** A USB PS2 adapter as Chrome reports it: 12 buttons, sticks on 0,1 / 5,2, the d-pad as one axis (9). */
function adapter(press: number[] = [], axes: Partial<Record<number, number>> = {}): PadLike {
  const a = Array.from({ length: 10 }, (_, i) => axes[i] ?? 0);
  if (axes[9] === undefined) a[9] = 3.2857; // the hat at rest
  return {
    id: "USB Joystick (Vendor: 0810 Product: 0001)",
    index: 0,
    connected: true,
    timestamp: 1,
    mapping: "",
    buttons: Array.from({ length: 12 }, (_, i) => button(press.includes(i))),
    axes: a,
    vibrationActuator: { kind: "rumble" },
  };
}

const map: Mapping = {
  buttons: [
    { button: 2 }, { button: 1 }, { button: 3 }, { button: 0 },
    { button: 6 }, { button: 7 }, { button: 4 }, { button: 5 },
    { button: 8 }, { button: 9 }, { button: 10 }, { button: 11 },
    { hat: 9, value: -1 }, { hat: 9, value: 0.14 }, { hat: 9, value: 0.71 }, { hat: 9, value: -0.43 },
  ],
  axes: [{ axis: 0 }, { axis: 1 }, { axis: 5 }, { axis: 2 }],
};

test("buttons, axes as buttons, and a hat d-pad", () => {
  expect(STANDARD).toHaveLength(16);
  const out = remap(adapter([2, 9], { 9: 0.14 }), map);
  expect(out.mapping).toBe("standard");
  expect(out.buttons).toHaveLength(16);
  expect(out.axes).toHaveLength(4);
  const on = out.buttons.map((b, i) => (b.pressed ? STANDARD[i] : null)).filter(Boolean);
  expect(on).toEqual(["cross", "start", "down"]);

  const triggers: Mapping = { ...map, buttons: map.buttons.map((s, i) => (i === 6 ? { axis: 3, dir: 1 } : i === 7 ? { axis: 3, dir: -1 } : s)) };
  const l2 = remap(adapter([], { 3: 0.8 }), triggers);
  expect(l2.buttons[6]).toEqual({ pressed: true, touched: true, value: 0.8 });
  expect(l2.buttons[7]!.pressed).toBe(false);
  expect(remap(adapter([], { 3: 0.3 }), triggers).buttons[6]!.pressed).toBe(false);
  expect(remap(adapter([], { 3: -0.9 }), triggers).buttons[7]!.pressed).toBe(true);
});

test("inverted sticks", () => {
  const inverted: Mapping = { ...map, axes: [{ axis: 0 }, { axis: 1, invert: true }, null, { axis: 2 }] };
  const out = remap(adapter([], { 0: 0.5, 1: 0.25, 2: -1 }), inverted);
  expect(out.axes).toEqual([0.5, -0.25, 0, -1]);
});

test("no map, or a broken one, gives the raw pad", () => {
  const raw = adapter([1]);
  const nav = { getGamepads: () => [raw, null] as (PadLike | null)[] };
  install(nav, {});
  expect(nav.getGamepads()[0]).toBe(raw);

  const broken = { getGamepads: () => [raw] as (PadLike | null)[] };
  install(broken, { [raw.id]: { ...map, buttons: map.buttons.slice(0, 3) } as Mapping });
  expect(broken.getGamepads()[0]).toBe(raw);

  // a source the pad doesn't have reads as released, never throws
  const far: Mapping = { ...map, buttons: map.buttons.map((s, i) => (i === 0 ? { button: 40 } : s)), axes: [{ axis: 30 }, null, null, null] };
  const out = remap(raw, far);
  expect(out.buttons[0]).toEqual({ pressed: false, touched: false, value: 0 });
  expect(out.axes[0]).toBe(0);
});

test("install keeps nulls and vibration", () => {
  const raw = adapter([0]); // raw 0 is triangle in this map
  const nav = { getGamepads: () => [null, raw] as (PadLike | null)[] };
  install(nav, { [raw.id]: map });
  const [none, pad] = nav.getGamepads();
  expect(none).toBeNull();
  expect(pad!.mapping).toBe("standard");
  expect(pad!.buttons[3]!.pressed).toBe(true); // triangle
  expect(pad!.vibrationActuator).toBe(raw.vibrationActuator);
  expect(pad!.id).toBe(raw.id);
  expect(pad!.index).toBe(raw.index);
});

test("which drawing the controller screen starts on, from the pad's name (Chrome's and Firefox's)", () => {
  expect(padFamily("Xbox 360 Controller (XInput STANDARD GAMEPAD)")).toBe("xbox");
  expect(padFamily("Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)")).toBe("xbox");
  expect(padFamily("045e-028e-Microsoft X-Box 360 pad")).toBe("xbox");
  expect(padFamily("DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)")).toBe("ps5");
  expect(padFamily("Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 09cc)")).toBe("ps5");
  expect(padFamily("054c-05c4-Wireless Controller")).toBe("ps5");
  // a PS3 pad has the PS2's layout; so do USB adapters and anything unknown
  expect(padFamily("PLAYSTATION(R)3 Controller (STANDARD GAMEPAD Vendor: 054c Product: 0268)")).toBe("ps2");
  expect(padFamily("USB Joystick (Vendor: 0810 Product: 0001)")).toBe("ps2");
  expect(padFamily("")).toBe("ps2");
});
