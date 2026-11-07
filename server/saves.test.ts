import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "bun";
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

// A stand-in for R2: objects by key; `down` makes it fail like an outage.
const objects = new Map<string, Uint8Array<ArrayBuffer>>();
const writtenAt = new Map<string, Date>();
let down = false;
const r2 = Bun.serve({
  port: 0,
  async fetch(req) {
    if (down) return new Response("<Error><Code>InternalError</Code></Error>", { status: 500 });
    const key = decodeURIComponent(new URL(req.url).pathname.replace(/^\/bucket\//, ""));
    if (req.method === "PUT") {
      objects.set(key, new Uint8Array(await req.arrayBuffer()));
      writtenAt.set(key, new Date());
      return new Response(null, { headers: { ETag: '"e"' } });
    }
    const data = objects.get(key);
    if (!data) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    return new Response(req.method === "HEAD" ? null : data, {
      headers: { ETag: '"e"', "Content-Length": String(data.length), "Last-Modified": writtenAt.get(key)!.toUTCString() },
    });
  },
});
const client = new S3Client({ accessKeyId: "k", secretAccessKey: "s", bucket: "bucket", endpoint: `http://127.0.0.1:${r2.port}` });

test("with R2 the card lives there, the one before it as .prev, and a card left on this disk goes up when read", async () => {
  const { dir } = await setup();
  objects.clear();
  const saves = createSaves(dir, client);
  expect(await saves.get("sles-12345", "42")).toBeNull();
  expect(await saves.put("sles-12345", "42", card(1))).toEqual({ ok: true });
  expect(await saves.put("sles-12345", "42", card(2))).toEqual({ ok: true });
  expect(objects.get("saves/sles-12345/42.ps2")?.[100]).toBe(2);
  // saves seconds apart (half a save, then the whole one) don't touch .prev
  expect(objects.has("saves/sles-12345/42.ps2.prev")).toBe(false);
  // the next session, a while later: the card from before it becomes .prev, and stays through that session's saves
  writtenAt.set("saves/sles-12345/42.ps2", new Date(Date.now() - 3_600_000));
  expect(await saves.put("sles-12345", "42", card(3))).toEqual({ ok: true });
  expect(await saves.put("sles-12345", "42", card(4))).toEqual({ ok: true });
  expect(objects.get("saves/sles-12345/42.ps2")?.[100]).toBe(4);
  expect(objects.get("saves/sles-12345/42.ps2.prev")?.[100]).toBe(2);
  expect((await saves.put("sles-12345", "42", new Uint8Array(100))).ok).toBe(false);
  expect((await saves.get("sles-12345", "42"))?.[100]).toBe(4);

  await mkdir(join(dir, "saves", "scus-97481"), { recursive: true });
  await writeFile(join(dir, "saves", "scus-97481", "42.ps2"), card(5));
  expect((await saves.get("scus-97481", "42"))?.[100]).toBe(5);
  expect(objects.get("saves/scus-97481/42.ps2")?.[100]).toBe(5);
});

test("a card that can't be read throws instead of looking like no save (the page would start a blank one)", async () => {
  const { dir } = await setup();
  const saves = createSaves(dir, client);
  down = true;
  try {
    await expect(saves.get("sles-12345", "42")).rejects.toThrow();
  } finally {
    down = false;
  }
  // on this disk too: only a missing file is "no save"
  await mkdir(join(dir, "saves", "sles-12345", "42.ps2"), { recursive: true });
  await expect(createSaves(dir).get("sles-12345", "42")).rejects.toThrow();
});
