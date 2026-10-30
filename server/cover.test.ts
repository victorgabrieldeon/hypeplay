import { expect, test } from "bun:test";
import sharp from "sharp";
import { COVER_MAX, generatedCover, normalizeCover } from "./cover";

const image = (format: "png" | "gif", w = 1000, h = 1000) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#7655ff" } })
    .toFormat(format)
    .toBuffer()
    .then((b) => new Uint8Array(b));

test("a png becomes a 600x900 webp", async () => {
  const r = await normalizeCover(await image("png"));
  if (!r.ok) throw new Error(r.error);
  const meta = await sharp(r.webp).metadata();
  expect([meta.format, meta.width, meta.height]).toEqual(["webp", 600, 900]);
});

test("too big, not an image, or another format is refused", async () => {
  const big = new Uint8Array(COVER_MAX + 1);
  expect(await normalizeCover(big)).toEqual({ ok: false, error: "A capa pode ter até 5 MB" });
  expect(await normalizeCover(crypto.getRandomValues(new Uint8Array(4096)))).toEqual({ ok: false, error: "A capa precisa ser PNG, JPG ou WebP" });
  expect(await normalizeCover(await image("gif", 1, 1))).toEqual({ ok: false, error: "A capa precisa ser PNG, JPG ou WebP" });
});

test("the generated cover is the same for the same game, escapes the name and differs between games", () => {
  const a = generatedCover("SLES-12345", "<Tom & Jerry>");
  expect(generatedCover("SLES-12345", "<Tom & Jerry>")).toBe(a);
  expect(a).toStartWith("<svg");
  expect(a).toContain('viewBox="0 0 600 900"');
  expect(a).toContain("&lt;Tom &amp; Jerry&gt;");
  expect(a).not.toContain("<Tom");
  expect(generatedCover("SCUS-97481", "<Tom & Jerry>")).not.toBe(a);
});

test("a generated cover carries the serial on its spine, and the library's covers don't share one color", () => {
  expect(generatedCover("SLES-12345", "A")).toContain(">SLES-12345<");
  const hues = Array.from({ length: 20 }, (_, i) => Number(/hsl\((\d+)/.exec(generatedCover(`SLUS-2${String(i).padStart(4, "0")}`, "x"))![1]));
  expect(Math.max(...hues) - Math.min(...hues)).toBeGreaterThan(100);
});
