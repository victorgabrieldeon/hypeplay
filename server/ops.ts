/**
 * Around the routes (routes.ts' createApp), what running the server takes rather than what it does:
 *
 *   GET /health          public: 200 "ok" while it takes requests, 503 once shutting down (docker-compose.yml's
 *                        healthcheck). Nothing about anyone.
 *   rate limits          limits.ts, per person, before the route: 429 with the message the home shows
 *   metrics              rooms, people online, open WebSockets, disc bytes served per game, the catalog's (games)
 *                        latency, requests by status, the data disk's free and total bytes, the process' memory
 *                        (server/otlp.ts: out only with OTEL_EXPORTER_OTLP_ENDPOINT)
 *   drain()              SIGTERM (index.ts): no new connections, every WebSocket closed with RESTART (1012) so the
 *                        page connects again, the requests going on finish (up to a grace), then index.ts writes
 *                        what's pending and exits
 */
import type { Server, ServerWebSocket, WebSocketHandler } from "bun";
import { statfsSync } from "node:fs";
import type { Telemetry } from "./otlp";
import { RESTART } from "../page/relaywire";
import { actionOf, limitMessage, RateLimiter } from "./limits";
import { log } from "./log";
import type { Passes } from "./pass";
import type { NetData } from "./routes";
import { HEADERS } from "./routes";

export { RESTART };

/** Up to this long for the requests going on (a long-poll waits 8 s, ps2rooms.ts) before they're cut. */
export const DRAIN_MS = 10_000;
const GAMES_MS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000];
const PASS = /^\/p\/([\w.-]+)(\/.*)?$/;
/** A game's disc as its page reads it: every such answer says where it came from (X-Disc-Source), under ps2/<id>/. */
const GAME = /^\/(ps2\/[^/]+)\//;

export interface OpsApp {
  handle(req: Request, server?: Server<NetData>): Promise<Response | undefined>;
  websocket: WebSocketHandler<NetData>;
  presence: { others(me: string): unknown[] };
}

export interface OpsOptions {
  app: OpsApp;
  passes: Pick<Passes, "verify">;
  telemetry: Telemetry;
  /** The PS2 games' online rooms (ps2rooms.ts), counted for the metrics. */
  ps2Rooms?: { size: number };
  limiter?: RateLimiter;
  /** DATA_DIR: its disk's free and total bytes go in the metrics (the builders and uploads write GBs there). */
  dataDir?: string;
}

export function createOps({ app, passes, telemetry, ps2Rooms, limiter = new RateLimiter(), dataDir }: OpsOptions) {
  let draining = false;
  const sockets = new Set<ServerWebSocket<NetData>>();

  const requests = telemetry.counter("hypeplay.http.requests", { description: "Pedidos HTTP, por classe de status" });
  const discBytes = telemetry.counter("hypeplay.disc.bytes", { description: "Bytes de disco servidos, por jogo", unit: "By" });
  const limited = telemetry.counter("hypeplay.ratelimit.rejected", { description: "Pedidos recusados pelo limite por pessoa" });
  const games = telemetry.histogram("hypeplay.games.duration", { description: "Tempo da lista de jogos (games)", unit: "ms", bounds: GAMES_MS });
  telemetry.gauge("hypeplay.rooms.active", { description: "Salas online abertas" }, () => ps2Rooms?.size ?? 0);
  telemetry.gauge("hypeplay.people.online", { description: "Pessoas com a home ou um jogo aberto" }, () => app.presence.others("").length);
  telemetry.gauge("hypeplay.websockets.open", { description: "WebSockets abertos, por tipo" }, () => {
    const by = new Map<string, number>();
    for (const ws of sockets) by.set(ws.data.kind, (by.get(ws.data.kind) ?? 0) + 1);
    return [...by].map(([kind, n]): [number, { kind: string }] => [n, { kind }]);
  });
  telemetry.gauge("hypeplay.memory.rss", { description: "Memória do processo (RSS)", unit: "By" }, () => process.memoryUsage().rss);
  if (dataDir) {
    // (statfs only at each export; one that throws skips the point, otlp.ts)
    telemetry.gauge("hypeplay.disk.free_bytes", { description: "Bytes livres no disco dos dados", unit: "By" }, () => {
      const s = statfsSync(dataDir);
      return s.bavail * s.bsize;
    });
    telemetry.gauge("hypeplay.disk.total_bytes", { description: "Tamanho do disco dos dados", unit: "By" }, () => {
      const s = statfsSync(dataDir);
      return s.blocks * s.bsize;
    });
  }

  const plain = (body: string, status: number, headers: Record<string, string> = {}) =>
    new Response(body, { status, headers: { ...HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers } });

  async function handle(req: Request, server?: Server<NetData>): Promise<Response | undefined> {
    const url = new URL(req.url);
    if (url.pathname === "/health") return draining ? plain("draining", 503) : plain("ok", 200);
    const started = performance.now();
    const m = PASS.exec(url.pathname);
    const rest = m?.[2] ?? "";
    let turn: { undo(): void } | undefined;
    const action = m ? actionOf(req.method, rest, url.searchParams) : null;
    if (action) {
      // (a pass that doesn't verify goes on: the route answers it 403)
      const pass = await passes.verify(m![1]!);
      if (pass) {
        const r = limiter.take(pass.id, action);
        if (!r.ok) {
          limited.add(1, { action });
          requests.add(1, { status: "4xx" });
          log.info("rate limited", { action, user: pass.id, retry_s: Math.ceil(r.retryMs / 1000) });
          return new Response(JSON.stringify({ error: limitMessage(action, r.retryMs), code: "rate" }), {
            status: 429,
            headers: { ...HEADERS, "Content-Type": "application/json", "Retry-After": String(Math.ceil(r.retryMs / 1000)) },
          });
        }
        turn = r;
      }
    }
    let res: Response | undefined;
    try {
      res = await app.handle(req, server);
    } catch (err) {
      turn?.undo();
      requests.add(1, { status: "5xx" });
      log.error("request failed", { method: req.method, path: m ? `/p/…${rest}` : url.pathname, err });
      return plain("Erro no servidor", 500);
    }
    if (!res) {
      requests.add(1, { status: "101" });
      return res;
    }
    if (res.status >= 400) turn?.undo();
    requests.add(1, { status: `${Math.floor(res.status / 100)}xx` });
    if (rest === "/games") games.record(performance.now() - started, { status: res.status });
    if (m && req.method === "GET" && (res.status === 200 || res.status === 206)) {
      const source = res.headers.get("x-disc-source");
      const game = source && GAME.exec(rest)?.[1];
      const n = Number(res.headers.get("content-length"));
      if (game && n > 0) discBytes.add(n, { game, source });
    }
    return res;
  }

  const inner = app.websocket;
  const websocket: WebSocketHandler<NetData> = {
    ...inner,
    open(ws) {
      sockets.add(ws);
      return inner.open?.(ws);
    },
    close(ws, code, reason) {
      sockets.delete(ws);
      return inner.close?.(ws, code, reason);
    },
  };

  /**
   * Shutting down: /health says so, no new connections, every WebSocket closed with RESTART, and the requests going
   * on get up to `graceMs` before they're cut.
   */
  async function drain(server: Pick<Server<NetData>, "stop">, graceMs = DRAIN_MS): Promise<void> {
    if (draining) return;
    draining = true;
    const open = sockets.size;
    const stopped = server.stop();
    for (const ws of sockets) {
      try {
        ws.close(RESTART, "restart");
      } catch {
        // (already closing)
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = await Promise.race([stopped.then(() => true), new Promise<false>((ok) => (timer = setTimeout(() => ok(false), graceMs)))]);
    clearTimeout(timer);
    if (!done) {
      log.warn("shutdown: requests cut after the grace", { grace_ms: graceMs });
      // (Bun 1.4: after a graceful stop() still waiting, stop(true) cuts the connections but its promise never settles)
      await Promise.race([server.stop(true), Bun.sleep(1000)]);
    }
    log.info("shutdown: drained", { websockets: open, clean: done });
  }

  return {
    handle,
    websocket,
    drain,
    get draining() {
      return draining;
    },
    /** Open WebSockets (tests). */
    get sockets() {
      return sockets.size;
    },
  };
}
