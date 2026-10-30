import { afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileRead, readDiscId, type Read } from "./iso9660";
import { makeIso } from "./testing/iso";

const memory =
  (data: Uint8Array): Read =>
  async (offset, length) =>
    data.slice(offset, offset + length);

const BT3_CNF = "BOOT2 = cdrom0:\\SLUS_216.78;1\r\nVER = 1.00\r\nVMODE = NTSC\r\n";

let tmp = "";
afterAll(() => tmp && rm(tmp, { recursive: true, force: true }));

test("reads the serial from SYSTEM.CNF", async () => {
  expect(await readDiscId(memory(makeIso({ "SYSTEM.CNF": BT3_CNF })))).toEqual({
    serial: "SLUS-21678",
    id: "slus-21678",
    boot: "cdrom0:\\SLUS_216.78;1",
  });
});

test("no SYSTEM.CNF, no BOOT2, or not an ISO is null", async () => {
  expect(await readDiscId(memory(makeIso({ "README.TXT": "hi" })))).toBeNull();
  // a PlayStation 1 disc says BOOT, not BOOT2
  expect(await readDiscId(memory(makeIso({ "SYSTEM.CNF": "BOOT = cdrom:\\SLPS_123.45;1\r\n" })))).toBeNull();
  expect(await readDiscId(memory(makeIso({ "SYSTEM.CNF": "BOOT2 = cdrom0:\\GAME.ELF;1\r\n" })))).toBeNull();
  expect(await readDiscId(memory(new Uint8Array(64 * 1024)))).toBeNull();
});

test("finds it past other entries and in lower case", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 40; i++) files[`DATA_${String(i).padStart(3, "0")}.BIN`] = `file ${i}`;
  files["system.cnf;1"] = "BOOT2 = cdrom0:\\SLES_123.45;1\n";
  expect(await readDiscId(memory(makeIso(files)))).toEqual({ serial: "SLES-12345", id: "sles-12345", boot: "cdrom0:\\SLES_123.45;1" });
});

test("fileRead reads slices of a file", async () => {
  tmp = await mkdtemp(join(tmpdir(), "cordplay-iso-"));
  const path = join(tmp, "disc.iso");
  await writeFile(path, makeIso({ "SYSTEM.CNF": BT3_CNF }, { pad: 1024 * 1024 }));
  expect((await readDiscId(fileRead(path)))?.serial).toBe("SLUS-21678");
});
