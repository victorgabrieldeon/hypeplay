import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mapping } from "../page/padmap";
import { createPeople } from "./people";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cordplay-people-"));
  dirs.push(dir);
  return { dir, people: createPeople(dir) };
}

const adapter: Mapping = {
  buttons: [
    { button: 2 }, { button: 1 }, { button: 3 }, { button: 0 },
    { button: 6 }, { button: 7 }, { button: 4 }, { button: 5 },
    { button: 8 }, { button: 9 }, { button: 10 }, { button: 11 },
    { hat: 9, value: -1 }, { hat: 9, value: 0.14 }, { hat: 9, value: 0.71 }, { hat: 9, value: -0.43 },
  ],
  axes: [{ axis: 0 }, { axis: 1 }, { axis: 5 }, { axis: 2, invert: true }],
};

test("pads round-trip; a bad mapping is refused whole", async () => {
  const { people } = await setup();
  expect(await people.pads("42")).toEqual({});
  expect(await people.setPads("42", { "USB Joystick (Vendor: 0810 Product: 0001)": adapter })).toBe(true);
  expect(await people.pads("42")).toEqual({ "USB Joystick (Vendor: 0810 Product: 0001)": adapter });

  const short = { ...adapter, buttons: adapter.buttons.slice(0, 15) };
  expect(await people.setPads("42", { a: adapter, b: short })).toBe(false);
  expect(await people.setPads("42", { a: { ...adapter, axes: [{ axis: 999 }, null, null, null] } })).toBe(false);
  expect(await people.setPads("42", "nope")).toBe(false);
  expect(Object.keys(await people.pads("42"))).toEqual(["USB Joystick (Vendor: 0810 Product: 0001)"]);
  expect(await people.pads("43")).toEqual({});
});

test("played and last", async () => {
  const { people } = await setup();
  expect(await people.last("42")).toBeNull();
  await people.played("42", "ps2/sles-12345");
  await people.played("42", "bt3");
  expect(await people.last("42")).toBe("bt3");
  expect(await people.last("43")).toBeNull();
});

test("a corrupted pads file reads as none", async () => {
  const { dir, people } = await setup();
  await mkdir(join(dir, "pads"), { recursive: true });
  await writeFile(join(dir, "pads", "42.json"), "{");
  expect(await people.pads("42")).toEqual({});
});

test("ids that aren't plain are refused", async () => {
  const { people } = await setup();
  expect(await people.setPads("../x", { a: adapter })).toBe(false);
  expect(await people.pads("../x")).toEqual({});
  await people.played("../x", "bt3");
  expect(await people.last("../x")).toBeNull();
});
