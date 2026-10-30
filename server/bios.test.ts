import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BIOS_BYTES, createBios, validBios } from "./bios";
import type { Pass } from "./pass";
import { fakeBios } from "./testing/bios";

const ana: Pass = { id: "42", name: "Ana", exp: Infinity };
const bia: Pass = { id: "43", name: "Bia", exp: Infinity };

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cordplay-bios-"));
  dirs.push(dir);
  let clock = 1_000_000;
  return { dir, bios: createBios(dir, { now: () => clock++ }) };
}

test("a PS2 BIOS: 4 MiB with its ROMDIR table", () => {
  expect(validBios(fakeBios())).toBe(true);
  expect(validBios(fakeBios().subarray(0, BIOS_BYTES - 1))).toBe(false);
  expect(validBios(new Uint8Array(BIOS_BYTES))).toBe(false);
  const late = new Uint8Array(BIOS_BYTES);
  late.set(new TextEncoder().encode("RESET\0"), 0x20000);
  late.set(new TextEncoder().encode("ROMDIR"), 0x20010);
  expect(validBios(late)).toBe(false);
});

test("sent once for the whole server; replacing it is on purpose", async () => {
  const { bios } = await setup();
  expect(await bios.info()).toEqual({ present: false });
  expect(await bios.put(ana, fakeBios(1), false)).toEqual({ ok: true });
  expect(await bios.info()).toEqual({ present: true, by: "Ana", at: 1_000_000 });
  expect(await bios.put(bia, fakeBios(2), false)).toEqual({ ok: false, status: 409, error: "O servidor já tem a BIOS" });
  expect((await Bun.file(bios.path).bytes())[0]).toBe(1);
  expect(await bios.put(bia, fakeBios(2), true)).toEqual({ ok: true });
  expect((await Bun.file(bios.path).bytes())[0]).toBe(2);
  expect((await bios.info()).present && (await bios.info())).toMatchObject({ by: "Bia" });
});

test("anything else is refused and the kept one stays", async () => {
  const { bios } = await setup();
  await bios.put(ana, fakeBios(1), false);
  expect(await bios.put(ana, new Uint8Array(100), true)).toEqual({ ok: false, status: 400, error: "Isso não parece a BIOS de um PS2 (arquivo de 4 MB)" });
  expect((await Bun.file(bios.path).bytes())[0]).toBe(1);
});
