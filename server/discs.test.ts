import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "bun";
import { createDiscs, dropFromR2, fetchFromR2, markOf, moveToR2 } from "./discs";
import { rangeResponse } from "./http";
import { ABANDONED_MS, createLibrary } from "./library";
import { createDiscStore } from "./upload";

// A stand-in for R2: objects by key, single PUTs and multipart ones, GET by Range, DELETE.
const objects = new Map<string, Uint8Array>();
const parts = new Map<number, Uint8Array<ArrayBuffer>>();
const r2 = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/bucket\//, ""));
    const q = url.searchParams;
    const ok = (body: BodyInit | null = null, headers: Record<string, string> = {}) => new Response(body, { headers: { ETag: '"e"', ...headers } });
    if (req.method === "POST" && q.has("uploads")) {
      parts.clear();
      return ok("<InitiateMultipartUploadResult><UploadId>u1</UploadId></InitiateMultipartUploadResult>");
    }
    if (req.method === "PUT" && q.has("partNumber")) {
      parts.set(Number(q.get("partNumber")), new Uint8Array(await req.arrayBuffer()));
      return ok();
    }
    if (req.method === "POST" && q.has("uploadId")) {
      const all = [...parts.entries()].sort((a, b) => a[0] - b[0]).map(([, p]) => p);
      objects.set(key, new Uint8Array(await new Blob(all).arrayBuffer()));
      return ok("<CompleteMultipartUploadResult><ETag>\"e\"</ETag></CompleteMultipartUploadResult>");
    }
    if (req.method === "PUT") {
      objects.set(key, new Uint8Array(await req.arrayBuffer()));
      return ok();
    }
    if (req.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const data = objects.get(key);
    if (!data) return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
    const [a, b] = m ? [Number(m[1]), Number(m[2])] : [0, data.length - 1];
    return ok(req.method === "HEAD" ? null : data.slice(a, b + 1), { "Content-Length": String(b - a + 1) });
  },
});
const client = new S3Client({ accessKeyId: "k", secretAccessKey: "s", bucket: "bucket", endpoint: `http://127.0.0.1:${r2.port}` });

const data = new Uint8Array(1000).map((_, i) => i & 0xff);
let dir = "";
const iso = (id: string) => join(dir, "ps2", id, "disc.iso");
async function disc(id: string, bytes: Uint8Array = data) {
  await mkdir(join(dir, "ps2", id), { recursive: true });
  await writeFile(iso(id), bytes);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cordplay-discs-"));
});
afterAll(async () => {
  r2.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test("moved: R2 has it, its mark holds the size, the local file is gone; read from R2 by range, streamed", async () => {
  await disc("a");
  expect(await moveToR2(client, dir, iso("a"), async () => true)).toBe(true);
  expect(objects.get("ps2/a/disc.iso")).toEqual(data);
  expect(await readFile(markOf(iso("a")), "utf8")).toBe("1000");
  expect(await Bun.file(iso("a")).exists()).toBe(false);

  const d = (await createDiscs(dir, client)(iso("a")))!;
  expect(d).toMatchObject({ size: 1000, from: "r2" });
  const r = rangeResponse(new Request("http://x/disc.iso", { headers: { range: "bytes=10-19" } }), d.file, {}, d.size);
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe("bytes 10-19/1000");
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...data.slice(10, 20)]);
  // (without R2 configured, a disc only in R2 isn't there)
  expect(await createDiscs(dir, null)(iso("a"))).toBeNull();
});

test("a big disc goes in parts", async () => {
  const big = new Uint8Array(150 * 1024 ** 2).map((_, i) => (i * 7) & 0xff);
  await disc("big", big);
  await moveToR2(client, dir, iso("big"), async () => true);
  expect(parts.size).toBeGreaterThan(1);
  expect(objects.get("ps2/big/disc.iso")?.length).toBe(big.length);
  objects.delete("ps2/big/disc.iso");
});

test("removed while sending: R2's copy goes, the local file stays, no mark", async () => {
  await disc("b");
  expect(await moveToR2(client, dir, iso("b"), async () => false)).toBe(false);
  expect(objects.has("ps2/b/disc.iso")).toBe(false);
  expect(await Bun.file(iso("b")).exists()).toBe(true);
  expect(await Bun.file(markOf(iso("b"))).exists()).toBe(false);
  // the local file first, R2 or not
  expect(await createDiscs(dir, client)(iso("b"))).toMatchObject({ size: 1000, from: "local" });
});

test("back from R2 for a build, then dropped with its game", async () => {
  await fetchFromR2(client, dir, iso("a"), join(dir, "copy.iso"));
  expect(new Uint8Array(await Bun.file(join(dir, "copy.iso")).arrayBuffer())).toEqual(data);
  await dropFromR2(client, dir, iso("a"));
  expect(objects.has("ps2/a/disc.iso")).toBe(false);
});

test("the library: a game whose disc is in R2 is no abandoned game, and removing it empties R2", async () => {
  let t = 1_000_000;
  const library = createLibrary(dir, { now: () => t, min: 10, r2: client });
  const r = await library.reserve({ id: "u", name: "Ana", exp: 0 } as never, "SLUS-20001", "Jogo");
  if (!r.ok) throw new Error("not reserved");
  const id = r.game.id;
  await writeFile(iso(id), data);
  await moveToR2(client, dir, iso(id), async () => true);
  expect(await library.hasDisc(id)).toBe(true);

  t += ABANDONED_MS + 1;
  expect((await library.list()).map((g) => g.id)).toContain(id);
  // (the upload sees it in too: no second image over it)
  const store = createDiscStore(join(dir, "ps2", id), { min: 10 });
  expect(await store.progress()).toMatchObject({ done: true });
  expect(await store.put({ id: "u", name: "Ana" } as never, 0, 1000, data)).toMatchObject({ ok: false, code: "done" });

  await library.remove(id);
  expect(objects.has(`ps2/${id}/disc.iso`)).toBe(false);
});
