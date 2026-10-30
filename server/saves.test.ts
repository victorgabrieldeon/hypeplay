import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARD_BYTES, CARD_MAGIC, createSaves } from "./saves";

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cordplay-saves-"));
  dirs.push(dir);
  return { dir, saves: createSaves(dir) };
}

function card(fill: number) {
  const c = new Uint8Array(CARD_BYTES).fill(fill);
  c.set(new TextEncoder().encode(CARD_MAGIC));
  return c;
}

test("a card of the right size and header is kept per game and person", async () => {
  const { saves } = await setup();
  expect(await saves.get("sles-12345", "42")).toBeNull();
  expect(await saves.put("sles-12345", "42", card(1))).toEqual({ ok: true });
  expect(await saves.put("sles-12345", "43", card(2))).toEqual({ ok: true });
  expect((await saves.get("sles-12345", "42"))?.[100]).toBe(1);
  expect((await saves.get("sles-12345", "43"))?.[100]).toBe(2);
  expect(await saves.get("scus-97481", "42")).toBeNull();
});

test("wrong size or header is refused and the old card stays", async () => {
  const { saves } = await setup();
  await saves.put("sles-12345", "42", card(1));
  expect((await saves.put("sles-12345", "42", new Uint8Array(100))).ok).toBe(false);
  expect((await saves.put("sles-12345", "42", new Uint8Array(CARD_BYTES).fill(7))).ok).toBe(false);
  expect((await saves.get("sles-12345", "42"))?.[100]).toBe(1);
});

test("a write that died midway leaves the old card", async () => {
  const { dir, saves } = await setup();
  await saves.put("sles-12345", "42", card(1));
  // what a crash between writing the temporary file and renaming it leaves behind
  await writeFile(join(dir, "saves", "sles-12345", "42.ps2.tmp"), new Uint8Array(10));
  expect((await saves.get("sles-12345", "42"))?.length).toBe(CARD_BYTES);
  expect(await saves.put("sles-12345", "42", card(3))).toEqual({ ok: true });
  expect((await saves.get("sles-12345", "42"))?.[100]).toBe(3);
});

test("ids that aren't plain are refused", async () => {
  const { dir, saves } = await setup();
  await mkdir(join(dir, "saves"), { recursive: true });
  expect((await saves.put("sles-12345", "../x", card(1))).ok).toBe(false);
  expect((await saves.put("../bt3", "42", card(1))).ok).toBe(false);
  expect(await saves.get("sles-12345", "../x")).toBeNull();
});
