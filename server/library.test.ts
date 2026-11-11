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

test("another copy, when asked: the same game again (a mod keeps its serial)", async () => {
  const { dir, library } = await setup();
  const bt3 = await library.reserve(ana, "SLUS-21678", "Budokai Tenkaichi 3");
  expect(bt3.ok && bt3.game).toMatchObject({ id: "slus-21678", serial: "SLUS-21678", name: "Budokai Tenkaichi 3" });
  const mod = await library.reserve(bia, "SLUS-21678", "BT4 mod", { copy: true });
  expect(mod.ok && mod.game).toMatchObject({ id: "slus-21678-2", serial: "SLUS-21678", name: "BT4 mod" });
  // without asking, the game that's there
  expect(await library.reserve(ana, "SLUS-21678", "x")).toEqual({ ok: false, exists: "ps2/slus-21678" });
  expect((await library.reserve(ana, "SLES-12345", "A")).ok).toBe(true);
  expect(await library.reserve(ana, "SLES-12345", "B")).toEqual({ ok: false, exists: "ps2/sles-12345" });
  const two = await Promise.all([library.reserve(ana, "SLES-12345", "C", { copy: true }), library.reserve(bia, "SLES-12345", "D", { copy: true })]);
  expect(two.map((r) => r.ok && r.game.id).sort()).toEqual(["sles-12345-2", "sles-12345-3"]);
  expect((await readdir(join(dir, "ps2"))).sort()).toEqual(["sles-12345", "sles-12345-2", "sles-12345-3", "slus-21678", "slus-21678-2"]);
  // a copy is a game like any: its disc is checked against the serial
  expect((await library.get("slus-21678-2"))?.serial).toBe("SLUS-21678");
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
  await library.sweep();
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

test("a piece that lands after the game was removed doesn't bring its folder back", async () => {
  const { library } = await setup();
  await library.reserve(ana, "SLES-12345", "A");
  const disc = library.disc("sles-12345");
  expect((await disc.put(ana, 0, 20, new Uint8Array(8))).ok).toBe(true);
  await library.remove("sles-12345");
  expect(await disc.put(ana, 8, 20, new Uint8Array(8))).toMatchObject({ ok: false, status: 404, code: "gone" });
  expect(await exists(library.paths("sles-12345").root)).toBe(false);
});

test("a folder left without game.json doesn't block its serial, and the sweep clears it", async () => {
  const { dir, library, advance } = await setup();
  await mkdir(join(dir, "ps2", "sles-12345", "upload"), { recursive: true });
  await writeFile(join(dir, "ps2", "sles-12345", "upload", "state.json"), "{}");
  expect((await library.reserve(ana, "SLES-12345", "A")).ok).toBe(true);
  await mkdir(join(dir, "ps2", "scus-97481"), { recursive: true });
  advance(2 * 60_000);
  expect((await library.list()).map((g) => g.id)).toEqual(["sles-12345"]);
  await library.sweep();
  expect(await exists(join(dir, "ps2", "scus-97481"))).toBe(false);
});

test("the list comes from the index, not the disk: kept up to date by every change, and the sweep catches up with the folders", async () => {
  const { dir, library, advance } = await setup();
  await library.reserve(ana, "SLES-12345", "A");
  advance(1000);
  await library.reserve(bia, "SCUS-97481", "B");
  await library.rename("sles-12345", "Novo");
  await library.setCover("scus-97481", true);
  const listed = await library.list();
  expect(listed.map((g) => [g.id, g.name, g.cover])).toEqual([["scus-97481", "B", true], ["sles-12345", "Novo", false]]);
  // what the builders read is the same
  expect(JSON.parse(await Bun.file(join(dir, "ps2", "sles-12345", "game.json")).text()).name).toBe("Novo");

  // a library made from the same folder (a restart) finds them
  expect((await createLibrary(dir).list()).map((g) => g.name)).toEqual(["B", "Novo"]);

  // a folder gone from outside, and one put there: the sweep sees both
  await rm(join(dir, "ps2", "scus-97481"), { recursive: true });
  await mkdir(join(dir, "ps2", "slpm-66666"));
  await writeFile(join(dir, "ps2", "slpm-66666", "game.json"), JSON.stringify({ ...listed[1], id: "slpm-66666", serial: "SLPM-66666", name: "C" }));
  expect((await library.list()).length).toBe(2);
  await library.sweep();
  expect((await library.list()).map((g) => g.id).sort()).toEqual(["sles-12345", "slpm-66666"]);
  await library.remove("sles-12345");
  expect((await library.list()).map((g) => g.id)).toEqual(["slpm-66666"]);
});

test("a game reserved or removed while the sweep runs stays as it was left", async () => {
  const { library } = await setup();
  for (let n = 10_000; n < 10_030; n++) await library.reserve(ana, `SLES-${n}`, "x");
  const sweep = library.sweep();
  await library.reserve(bia, "SLPM-66666", "C");
  await library.remove("sles-10029");
  await sweep;
  expect(await library.get("slpm-66666")).not.toBeNull();
  expect(await library.get("sles-10029")).toBeNull();
  expect((await library.list()).length).toBe(30);
});
