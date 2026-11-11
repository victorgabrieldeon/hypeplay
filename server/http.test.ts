import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheFor, IMMUTABLE, injectPad, rangeResponse, versionOf, withVersions } from "./http";

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

test("range: a disc that reads itself (discs.ts) gets the range it asked, end excluded", async () => {
  const asked: [number, number][] = [];
  const disc = { size: data.length, read: (start: number, end: number) => (asked.push([start, end]), new Blob([data.slice(start, end)])) };
  const r = rangeResponse(new Request("http://x/disc.iso", { headers: { range: "bytes=10-19" } }), disc, {});
  expect(r.status).toBe(206);
  expect(await bytes(r)).toEqual(data.slice(10, 20));
  expect(rangeResponse(new Request("http://x/disc.iso"), disc, {}).headers.get("content-length")).toBe("1000");
  rangeResponse(new Request("http://x/disc.iso", { method: "HEAD" }), disc, {});
  expect(asked).toEqual([[10, 20], [0, 1000]]);
});

test("versions: short, and the same for the same content", () => {
  expect(versionOf("a")).toMatch(/^[0-9a-f]{12}$/);
  expect(versionOf("a")).toBe(versionOf(new TextEncoder().encode("a")));
  expect(versionOf("a")).not.toBe(versionOf("b"));
});

test("immutable only for the very version asked; anything else is asked again", () => {
  expect(IMMUTABLE["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  expect(cacheFor(new Request("http://x/pad.js?v=abc"), "abc")).toEqual(IMMUTABLE);
  expect(cacheFor(new Request("http://x/pad.js?v=old"), "abc")).toEqual({ "Cache-Control": "no-cache" });
  expect(cacheFor(new Request("http://x/pad.js"), "abc")).toEqual({ "Cache-Control": "no-cache" });
  expect(cacheFor(new Request("http://x/pad.js?v="), "")).toEqual({ "Cache-Control": "no-cache" });
  expect(cacheFor(new Request("http://x/pad.js"), undefined)).toEqual({ "Cache-Control": "no-cache" });
});

test("withVersions: the known scripts get their ?v=, wherever they are; the rest stay", () => {
  const v = { "pad.js": "111", "ps2play.js": "222", "watch.js": "333" };
  const html = [
    '<script src="pad.js"></script>',
    "<script src='../../../ps2play.js'></script>",
    '<script src="./watch.js" defer></script>',
    '<script src="home/app.js" type="module"></script>',
    '<script src="app.js?v=385757d8e81d"></script>',
    '<script src="https://cdn.example/pad.js"></script>',
    "<p>pad.js</p>",
  ].join("\n");
  expect(withVersions(html, v).split("\n")).toEqual([
    '<script src="pad.js?v=111"></script>',
    "<script src='../../../ps2play.js?v=222'></script>",
    '<script src="./watch.js?v=333" defer></script>',
    '<script src="home/app.js" type="module"></script>',
    '<script src="app.js?v=385757d8e81d"></script>',
    '<script src="https://cdn.example/pad.js"></script>',
    "<p>pad.js</p>",
  ]);
});
