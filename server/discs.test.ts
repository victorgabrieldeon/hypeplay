import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Client } from "bun";
import { createDiscs } from "./discs";
import { rangeResponse } from "./http";

const data = new Uint8Array(1000).map((_, i) => i & 0xff);
const asked: string[] = [];
// A stand-in for R2: only ps2/a/disc.iso, by Range like S3.
const r2 = Bun.serve({
  port: 0,
  fetch(req) {
    const key = new URL(req.url).pathname.replace(/^\/bucket\//, "");
    asked.push(`${req.method} ${key}`);
    if (key !== "ps2/a/disc.iso") return new Response("<Error><Code>NoSuchKey</Code></Error>", { status: 404 });
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.get("range") ?? "");
    const [a, b] = m ? [Number(m[1]), Number(m[2])] : [0, data.length - 1];
    return new Response(req.method === "HEAD" ? null : data.slice(a, b + 1), {
      status: m ? 206 : 200,
      headers: { "Content-Length": String(b - a + 1), ETag: '"x"' },
    });
  },
});
const client = new S3Client({ accessKeyId: "k", secretAccessKey: "s", bucket: "bucket", endpoint: `http://127.0.0.1:${r2.port}` });

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cordplay-discs-"));
  await mkdir(join(dir, "ps2", "b"), { recursive: true });
  await writeFile(join(dir, "ps2", "b", "disc.iso"), new Uint8Array(10));
});
afterAll(async () => {
  r2.stop(true);
  await rm(dir, { recursive: true, force: true });
});

test("R2 first, by range and streamed (never a redirect); the local file when R2 lacks it; size asked once", async () => {
  let t = 0;
  const discs = createDiscs(dir, client, () => t);
  const a = (await discs(join(dir, "ps2", "a", "disc.iso")))!;
  expect(a).toMatchObject({ size: 1000, from: "r2" });
  const r = rangeResponse(new Request("http://x/disc.iso", { headers: { range: "bytes=10-19" } }), a.file, {}, a.size);
  expect(r.status).toBe(206);
  expect(r.headers.get("content-range")).toBe("bytes 10-19/1000");
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([...data.slice(10, 20)]);

  const b = (await discs(join(dir, "ps2", "b", "disc.iso")))!;
  expect(b).toMatchObject({ size: 10, from: "local" });
  expect(await discs(join(dir, "ps2", "c", "disc.iso"))).toBeNull();

  await discs(join(dir, "ps2", "a", "disc.iso"));
  await discs(join(dir, "ps2", "b", "disc.iso"));
  expect(asked.filter((x) => x.startsWith("HEAD"))).toEqual(["HEAD ps2/a/disc.iso", "HEAD ps2/b/disc.iso", "HEAD ps2/c/disc.iso"]);
  // (a miss is asked again later: the upload to R2 may have finished)
  t = 10 * 60_000;
  await discs(join(dir, "ps2", "b", "disc.iso"));
  expect(asked.at(-1)).toBe("HEAD ps2/b/disc.iso");
});

test("without R2, only the local file", async () => {
  expect(await createDiscs(dir, null)(join(dir, "ps2", "b", "disc.iso"))).toMatchObject({ size: 10, from: "local" });
});
