import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABANDONED_MS, createLibrary } from "./library";
import type { Pass } from "./pass";
import { makeIso } from "./testing/iso";

const ana: Pass = { id: "42", name: "Ana", exp: Infinity };
const bia: Pass = { id: "43", name: "Bia", exp: Infinity };
const cnf = (serial: string) => `BOOT2 = cdrom0:\\${serial.replace("-", "_").replace(/(\d{3})(\d{2})$/, "$1.$2")};1\r\n`;

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "cordplay-library-"));
  dirs.push(dir);
  let clock = 1_000_000;
  const library = createLibrary(dir, { now: () => clock, min: 10, max: 10 * 1024 * 1024 });
  return { dir, library, advance: (ms: number) => (clock += ms) };
}
const exists = (path: string) => stat(path).then(() => true, () => false);

test("reserve makes the game folder and game.json; list shows it", async () => {
  const { dir, library } = await setup();
  const r = await library.reserve(ana, "SLES-12345", "  Meu Jogo  ");
  expect(r).toEqual({ ok: true, game: { id: "sles-12345", serial: "SLES-12345", name: "Meu Jogo", by: { id: "42", name: "Ana" }, at: 1_000_000, cover: false } });
  expect(await exists(join(dir, "ps2", "sles-12345", "game.json"))).toBe(true);
  expect((await library.list()).map((g) => g.id)).toEqual(["sles-12345"]);
  expect((await library.reserve(bia, "SCUS-97481", "")).ok && (await library.get("scus-97481"))?.name).toBe("SCUS-97481");
});

test("the same serial twice, even at the same time, is one game", async () => {
  const { dir, library } = await setup();
  const [a, b] = await Promise.all([library.reserve(ana, "SLES-12345", "A"), library.reserve(bia, "SLES-12345", "B")]);
  expect([a.ok, b.ok].sort()).toEqual([false, true]);
  expect((a.ok ? b : a) as unknown).toEqual({ ok: false, exists: "ps2/sles-12345" });
  expect(await readdir(join(dir, "ps2"))).toEqual(["sles-12345"]);
});

test("BT3's serial points at BT3", async () => {
  const { library } = await setup();
  expect(await library.reserve(ana, "SLUS-21678", "x")).toEqual({ ok: false, exists: "bt3" });
  expect(await library.list()).toEqual([]);
});

test("verify keeps a matching disc and drops a wrong or foreign one", async () => {
  const { library } = await setup();
  await library.reserve(ana, "SLES-12345", "A");
  await writeFile(library.paths("sles-12345").iso, makeIso({ "SYSTEM.CNF": cnf("SLES-12345") }));
  expect(await library.verify("sles-12345")).toEqual({ ok: true });

  await library.reserve(ana, "SCUS-97481", "B");
  await writeFile(library.paths("scus-97481").iso, makeIso({ "SYSTEM.CNF": cnf("SLES-12345") }));
  expect(await library.verify("scus-97481")).toEqual({ ok: false, message: "A ISO não é do jogo escolhido" });
  expect(await library.get("scus-97481")).toBeNull();

  await library.reserve(ana, "SLPM-66666", "C");
  await writeFile(library.paths("slpm-66666").iso, makeIso({ "README.TXT": "no" }));
  expect(await library.verify("slpm-66666")).toEqual({ ok: false, message: "Isso não parece um disco de PS2" });
  expect(await library.get("slpm-66666")).toBeNull();
});

test("rename, cover flag and remove (saves stay)", async () => {
  const { dir, library } = await setup();
  await library.reserve(ana, "SLES-12345", "A");
  expect(await library.rename("sles-12345", "Novo nome")).toBe(true);
  expect(await library.rename("sles-12345", "   ")).toBe(true);
  expect((await library.get("sles-12345"))?.name).toBe("SLES-12345");
  expect(await library.rename("slus-00000", "x")).toBe(false);
  await library.setCover("sles-12345", true);
  expect((await library.get("sles-12345"))?.cover).toBe(true);

  const p = library.paths("sles-12345");

  await mkdir(join(dir, "saves", "sles-12345"), { recursive: true });
  await writeFile(join(dir, "saves", "sles-12345", "42.ps2"), "card");
  await mkdir(p.work, { recursive: true });
  await library.remove("sles-12345");
  expect(await library.get("sles-12345")).toBeNull();
  expect(await exists(p.root)).toBe(false);
  expect(await exists(p.work)).toBe(false);
  expect(await exists(join(dir, "saves", "sles-12345", "42.ps2"))).toBe(true);
});

test("an abandoned reservation goes after 24 h; one with an upload under way stays", async () => {
  const { library, advance } = await setup();
  await library.reserve(ana, "SLES-12345", "parado");
  await library.reserve(ana, "SCUS-97481", "enviando");
  expect((await library.disc("scus-97481").put(ana, 0, 20, new Uint8Array(8))).ok).toBe(true);
  advance(ABANDONED_MS + 1);
  expect((await library.list()).map((g) => g.id)).toEqual(["scus-97481"]);
  expect(await library.get("sles-12345")).toBeNull();
});

test("ids from outside never reach the disk", async () => {
  const { library } = await setup();
  expect(await library.get("../bt3")).toBeNull();
  expect(await library.get("SLUS-21678")).toBeNull();
  expect(await library.rename("../x", "y")).toBe(false);
  expect(() => library.paths("../x")).toThrow();
});
