import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { injectPad, rangeResponse } from "./http";

let dir = "";
let path = "";
const data = new Uint8Array(1000).map((_, i) => i & 0xff);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cordplay-http-"));
  path = join(dir, "disc.iso");
  await writeFile(path, data);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const ask = (range?: string, method = "GET") =>
  rangeResponse(new Request("http://x/disc.iso", { method, headers: range ? { range } : {} }), Bun.file(path), { "X-Test": "1" });
const bytes = async (r: Response) => new Uint8Array(await r.arrayBuffer());

test("range: whole, a slice, an open end, a suffix, HEAD", async () => {
  const whole = ask();
  expect(whole.status).toBe(200);
  expect(whole.headers.get("accept-ranges")).toBe("bytes");
  expect(whole.headers.get("x-test")).toBe("1");
  expect((await bytes(whole)).length).toBe(1000);

  const slice = ask("bytes=10-19");
  expect(slice.status).toBe(206);
  expect(slice.headers.get("content-range")).toBe("bytes 10-19/1000");
  expect([...(await bytes(slice))]).toEqual([...data.subarray(10, 20)]);

  const open = ask("bytes=990-");
  expect(open.headers.get("content-range")).toBe("bytes 990-999/1000");
  expect((await bytes(open)).length).toBe(10);

  const past = ask("bytes=995-5000");
  expect(past.headers.get("content-range")).toBe("bytes 995-999/1000");

  const suffix = ask("bytes=-4");
  expect(suffix.headers.get("content-range")).toBe("bytes 996-999/1000");
  expect([...(await bytes(suffix))]).toEqual([...data.subarray(996)]);

  const head = ask(undefined, "HEAD");
  expect(head.status).toBe(200);
  expect(head.headers.get("content-length")).toBe("1000");
  expect((await bytes(head)).length).toBe(0);
});

test("range out of the file or malformed is 416", () => {
  for (const r of ["bytes=5000000000-", "bytes=abc", "bytes=10-5", "bytes=-0", "bytes=-", "bytes=0-1,5-6", "items=0-1"]) {
    const res = ask(r);
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  }
});

test("injectPad before </head>, null without it", () => {
  expect(injectPad("<html><HEAD><title>x</title></Head><body></body></html>", "../../pad.js")).toBe(
    '<html><HEAD><title>x</title><script src="../../pad.js"></script></Head><body></body></html>',
  );
  expect(injectPad("<html><body>no head</body></html>", "pad.js")).toBeNull();
});
