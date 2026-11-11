import { afterEach, expect, test } from "bun:test";
import { statfsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTelemetry } from "./otlp";
import { LIMITS, RateLimiter } from "./limits";
import { captureLog } from "./log";
import { createOps, RESTART, type OpsApp } from "./ops";
import type { Pass } from "./pass";
import type { NetData } from "./routes";

const passes = { verify: async (t: string) => (t === "good" ? ({ id: "111", name: "Ana" } as Pass) : null) };

let cap = captureLog();
afterEach(() => {
  cap.restore();
  cap = captureLog();
});

function setup(handle: OpsApp["handle"], o: { limits?: Partial<typeof LIMITS>; dataDir?: string } = {}) {
  const sent: any[] = [];
  const telemetry = createTelemetry({
    endpoint: "http://otel",
    service: "t",
    timers: false,
    fetch: async (url, init) => (url.endsWith("/v1/metrics") && sent.push(JSON.parse(String(init.body))), new Response(null)),
  });
  let calls = 0;
  const app: OpsApp = {
    handle: (req, server) => (calls++, handle(req, server)),
    websocket: { open() {}, message() {}, close() {} },
    presence: { others: () => [{}, {}] },
  };
  const ops = createOps({ app, passes, telemetry, ps2Rooms: { size: 4 }, limiter: new RateLimiter(() => 0, { ...LIMITS, ...o.limits }), dataDir: o.dataDir });
  const metrics = async () => {
    await telemetry.flush();
    const last = sent.at(-1);
    return Object.fromEntries((last?.resourceMetrics[0].scopeMetrics[0].metrics ?? []).map((m: any) => [m.name, m]));
  };
  return { ops, metrics, calls: () => calls };
}

const req = (path: string, init?: RequestInit) => new Request(`http://localhost${path}`, init);

test("/health: 200 ok without anyone's data, never reaching the routes", async () => {
  const { ops, calls } = setup(async () => new Response("routes"));
  const r = (await ops.handle(req("/health")))!;
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("ok");
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(calls()).toBe(0);
});

test("past the limit: 429 with the home's message (CORS, Retry-After), and the routes never see it", async () => {
  const { ops, calls, metrics } = setup(async () => new Response(null, { status: 202 }), { limits: { vimm: { max: 1, windowMs: 3_600_000, what: "downloads do vimm.net" } } });
  expect((await ops.handle(req("/p/good/vimm", { method: "POST" })))!.status).toBe(202);
  const r = (await ops.handle(req("/p/good/vimm", { method: "POST" })))!;
  expect(r.status).toBe(429);
  expect(r.headers.get("access-control-allow-origin")).toBe("*");
  expect(r.headers.get("retry-after")).toBe("3600");
  expect(await r.json()).toEqual({ error: "Muitos downloads do vimm.net em pouco tempo. Tente de novo em 60 minutos.", code: "rate" });
  expect(calls()).toBe(1);
  // (the GET, how it goes, stays free)
  expect((await ops.handle(req("/p/good/vimm")))!.status).toBe(202);
  expect(cap.lines.find((l) => l.msg === "rate limited")).toMatchObject({ action: "vimm", user: "111" });
  const m = await metrics();
  expect(m["hypeplay.ratelimit.rejected"].sum.dataPoints[0].attributes).toEqual([{ key: "action", value: { stringValue: "vimm" } }]);
});

test("a request refused by the route gives its turn back; a pass that doesn't verify goes on to its 403", async () => {
  let status = 400;
  const { ops, calls } = setup(async () => new Response(null, { status }), { limits: { invite: { max: 1, windowMs: 1000, what: "convites" } } });
  expect((await ops.handle(req("/p/good/invite", { method: "POST" })))!.status).toBe(400);
  status = 204;
  expect((await ops.handle(req("/p/good/invite", { method: "POST" })))!.status).toBe(204);
  expect((await ops.handle(req("/p/good/invite", { method: "POST" })))!.status).toBe(429);
  status = 403;
  expect((await ops.handle(req("/p/expired/invite", { method: "POST" })))!.status).toBe(403);
  expect(calls()).toBe(3);
});

test("metrics: disc bytes per game (GET only), the catalog's latency, rooms, people, requests by status", async () => {
  const { ops, metrics } = setup(async (r) => {
    const path = new URL(r.url).pathname;
    if (path.endsWith("disc.iso")) return new Response(r.method === "HEAD" ? null : "x", { status: 206, headers: { "Content-Length": "1048576", "X-Disc-Source": "r2" } });
    // (a game's other files aren't its disc)
    if (path.endsWith(".wasm")) return new Response("x", { headers: { "Content-Length": "500" } });
    return new Response("{}");
  });
  await ops.handle(req("/p/good/ps2/slus-21678-2/game/disc.iso"));
  await ops.handle(req("/p/good/ps2/slus-21678-2/fast/disc.iso"));
  await ops.handle(req("/p/good/ps2/slus-21678-2/game/disc.iso", { method: "HEAD" }));
  await ops.handle(req("/p/good/ps2/slus-21678-2/fast/ps2web.wasm"));
  await ops.handle(req("/p/good/games"));
  const m = await metrics();
  const bytes = m["hypeplay.disc.bytes"].sum.dataPoints.map((p: any) => [p.attributes.map((a: any) => a.value.stringValue).join(" "), p.asDouble]);
  expect(bytes).toEqual([["ps2/slus-21678-2 r2", 2 * 1048576]]);
  expect(m["hypeplay.games.duration"].histogram.dataPoints[0].count).toBe("1");
  expect(m["hypeplay.rooms.active"].gauge.dataPoints[0].asDouble).toBe(4);
  expect(m["hypeplay.people.online"].gauge.dataPoints[0].asDouble).toBe(2);
  expect(m["hypeplay.http.requests"].sum.dataPoints[0]).toMatchObject({ asDouble: 5, attributes: [{ key: "status", value: { stringValue: "2xx" } }] });
});

test("metrics: the data disk's free and total bytes and the process' memory, read at the export", async () => {
  const { metrics } = setup(async () => new Response("{}"), { dataDir: tmpdir() });
  const m = await metrics();
  const s = statfsSync(tmpdir());
  const free = m["hypeplay.disk.free_bytes"].gauge.dataPoints[0].asDouble;
  const total = m["hypeplay.disk.total_bytes"].gauge.dataPoints[0].asDouble;
  expect(m["hypeplay.disk.free_bytes"].unit).toBe("By");
  expect(total).toBe(s.blocks * s.bsize);
  expect(free).toBeGreaterThan(0);
  expect(free).toBeLessThanOrEqual(total);
  expect(m["hypeplay.memory.rss"].gauge.dataPoints[0].asDouble).toBeGreaterThan(0);
});

test("metrics: a data dir that can't be read leaves out only the disk", async () => {
  const { metrics } = setup(async () => new Response("{}"), { dataDir: join(tmpdir(), "hypeplay-no-such-dir") });
  const m = await metrics();
  expect(m["hypeplay.disk.free_bytes"]).toBeUndefined();
  expect(m["hypeplay.disk.total_bytes"]).toBeUndefined();
  expect(m["hypeplay.rooms.active"].gauge.dataPoints[0].asDouble).toBe(4);
});

test("a route that throws: 500 and an error in the log, never the pass in it", async () => {
  const { ops } = setup(async () => {
    throw new Error("boom");
  });
  const r = (await ops.handle(req("/p/secret-pass/games")))!;
  expect(r.status).toBe(500);
  const line = cap.lines.find((l) => l.msg === "request failed") as any;
  expect(line.err.message).toBe("boom");
  expect(line.path).toBe("/p/…/games");
});

test("drain: /health 503, the WebSockets closed with RESTART, the request going on finishes, no new ones", async () => {
  let release!: () => void;
  const slow = new Promise<void>((ok) => (release = ok));
  const { ops } = setup(async (r, server) => {
    const path = new URL(r.url).pathname;
    if (path === "/ws") return server!.upgrade(r, { data: { game: "", kind: "vimm" } as NetData }) ? undefined : new Response(null, { status: 400 });
    if (path === "/slow") await slow;
    return new Response("done");
  });
  const server = Bun.serve<NetData>({ port: 0, fetch: (r, s) => ops.handle(r, s), websocket: ops.websocket });
  const base = `http://localhost:${server.port}`;
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  await new Promise((ok) => (ws.onopen = ok));
  const closed = new Promise<number>((ok) => (ws.onclose = (e) => ok(e.code)));
  expect(ops.sockets).toBe(1);
  const going = fetch(`${base}/slow`).then((r) => r.text());
  await Bun.sleep(50);
  const drained = ops.drain(server, 5000);
  expect(ops.draining).toBe(true);
  expect((await ops.handle(req("/health")))!.status).toBe(503);
  expect(await closed).toBe(RESTART);
  release();
  expect(await going).toBe("done");
  await drained;
  expect(await fetch(`${base}/health`).then(() => "answered", () => "refused")).toBe("refused");
  expect(cap.lines.find((l) => l.msg === "shutdown: drained")).toMatchObject({ websockets: 1, clean: true });
});

test("drain: past the grace, what's left is cut", async () => {
  const { ops } = setup(async () => new Promise<Response>(() => {}));
  const server = Bun.serve<NetData>({ port: 0, fetch: (r, s) => ops.handle(r, s), websocket: ops.websocket });
  const hung = fetch(`http://localhost:${server.port}/p/good/games`).catch(() => "cut");
  await Bun.sleep(50);
  await ops.drain(server, 100);
  expect(await hung).toBe("cut");
  expect(cap.lines.find((l) => l.msg === "shutdown: drained")).toMatchObject({ clean: false });
});
