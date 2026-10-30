import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fetchPs2, sha256 } from "./ps2-fetch";

const files: Record<string, string> = { "index.html": "<html>tab</html>", "library/console-tv.css": "tv {}", "pcsx2-wasm.wasm": "\0asm" };
let server: ReturnType<typeof Bun.serve>;
let dir = "";
const exists = (p: string) => stat(p).then(() => true, () => false);

beforeAll(async () => {
  server = Bun.serve({ port: 0, fetch: (req) => { const f = files[new URL(req.url).pathname.slice(1)]; return f === undefined ? new Response("no", { status: 404 }) : new Response(f); } });
  dir = await mkdtemp(join(tmpdir(), "cordplay-ps2fetch-"));
});
afterAll(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

const list = () => Object.entries(files).map(([path, body]) => ({ path, sha256: sha256(new TextEncoder().encode(body)) }));

test("every file with the right hash is written, folders included", async () => {
  const out = join(dir, "ok");
  await fetchPs2({ base: server.url.href, dir: out, files: list() });
  expect(await readFile(join(out, "library", "console-tv.css"), "utf8")).toBe("tv {}");
  expect(await readFile(join(out, "index.html"), "utf8")).toBe("<html>tab</html>");
});

test("a changed file fails with its name and both hashes, and leaves nothing behind", async () => {
  const out = join(dir, "bad");
  const bad = list().map((f) => (f.path === "pcsx2-wasm.wasm" ? { ...f, sha256: "0".repeat(64) } : f));
  expect(fetchPs2({ base: server.url.href, dir: out, files: bad })).rejects.toThrow(`pcsx2-wasm.wasm: sha256 ${"0".repeat(64)} ≠ ${sha256(new TextEncoder().encode("\0asm"))}`);
  await Bun.sleep(50);
  expect(await exists(out)).toBe(false);
});

test("a missing file fails with its HTTP status", async () => {
  expect(fetchPs2({ base: server.url.href, dir: join(dir, "gone"), files: [{ path: "nope.js", sha256: "x" }] })).rejects.toThrow("nope.js: HTTP 404");
});
