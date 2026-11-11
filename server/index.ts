import { SQL } from "bun";
import { join } from "node:path";
import { telemetryFromEnv } from "./otlp";
import { createBios } from "./bios";
import { createChunkCache, discCacheBytes } from "./chunkcache";
import { importOld, migrate } from "./db";
import { createDiscs, r2FromEnv } from "./discs";
import { createDiscord } from "./discord";
import { edgeFromEnv } from "./edgetoken";
import { createLibrary } from "./library";
import { log, useTelemetry } from "./log";
import { createOps } from "./ops";
import { createPasses } from "./pass";
import { createPeople } from "./people";
import { Ps2Rooms } from "./ps2rooms";
import { createQueue } from "./queue";
import { cloudflareTurn } from "./ice";
import { createApp, type NetData } from "./routes";
import { createSaves } from "./saves";
import { createSocial } from "./social";
import { createVimm } from "./vimm";
import { createWorkerApi } from "./workers";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
};

const PORT = Number(process.env.PORT ?? 3003);
// The Discord app the Activity belongs to (Developer Portal → OAuth2).
const DISCORD_CLIENT_ID = env("DISCORD_CLIENT_ID");
const DISCORD_CLIENT_SECRET = env("DISCORD_CLIENT_SECRET");
// Optional: the app's public address, for "Abrir no navegador" (inside Discord the page is behind its proxy).
const PUBLIC_URL = (process.env.PUBLIC_URL ?? "").replace(/\/+$/, "");
// Optional: a TURN relay for the PS2 games' online (coturn with --use-auth-secret).
const TURN = process.env.TURN_URL && process.env.TURN_SECRET ? { url: process.env.TURN_URL, secret: process.env.TURN_SECRET } : undefined;
// Optional, preferred: Cloudflare's TURN (Realtime → TURN in its dashboard), near the players wherever they are.
const CLOUDFLARE = process.env.TURN_CF_KEY_ID && process.env.TURN_CF_TOKEN ? cloudflareTurn({ keyId: process.env.TURN_CF_KEY_ID, token: process.env.TURN_CF_TOKEN }) : undefined;

const pageDir = join(import.meta.dir, "..", "page");

/** A page script, bundled once at startup. */
async function bundle(entry: string, define: Record<string, string> = {}) {
  const built = await Bun.build({ entrypoints: [join(pageDir, entry)], minify: true, format: "iife", define });
  if (!built.success) throw new AggregateError(built.logs, `page/${entry} didn't build`);
  return built.outputs[0]!.text();
}

// Metrics and logs out by OTLP only with OTEL_EXPORTER_OTLP_ENDPOINT (server/otlp.ts); without it, nothing changes.
const telemetry = telemetryFromEnv("hypeplay");
useTelemetry(telemetry);

const dir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
// R2 when S3_BUCKET is set: the new games' discs (discs.ts; the ones on this disk stay) and the memory cards (saves.ts).
const r2 = r2FromEnv();
// The R2 discs' pieces kept in memory (chunkcache.ts), DISC_CACHE_MB megabytes (256; 0: none): two people in the same
// game, or a menu read again, don't wait on R2 again.
const discCache = r2 && discCacheBytes() > 0 ? createChunkCache({ maxBytes: discCacheBytes() }) : null;
// The builds' queue (queue.ts): its own file next to the data, shared with the builders on this machine.
const queue = createQueue(join(dir, "queue.db"));
const library = createLibrary(dir, { r2, queue });
// (the "versão rápida" asked before the queue: in it, once)
const adopted = await library.importFast();
if (adopted) log.info("queue: fast builds from the volume", { adopted });
// Optional: workers on other machines (ps2-builder with QUEUE_URL) take jobs through /worker/ (workers.ts). Their builds
// go to R2 and are served from there: without R2 here, they'd be ready and never found.
if (process.env.WORKER_TOKEN && !r2) throw new Error("WORKER_TOKEN without S3_BUCKET: workers elsewhere publish their builds in R2");
const workers = process.env.WORKER_TOKEN ? createWorkerApi({ dir, queue, r2, token: process.env.WORKER_TOKEN }) : null;
// Postgres (the compose's postgres service): what's kept per person and the friends (people.ts, social.ts). Its tables
// are made first, once, and what came before it (hypeplay.db, the JSON files) imported the first time (db.ts).
const sql = new SQL(env("DATABASE_URL"));
await migrate(sql);
await importOld(sql, dir);
const people = createPeople(sql, dir);
await people.ready;
const social = await createSocial(sql, dir);
const ps2Rooms = new Ps2Rooms();
// The client secret signs the passes too: resetting it in the portal also ends every open session.
const passes = createPasses(DISCORD_CLIENT_SECRET);
// Reservations never sent and folders left without their game.json go now and then (library.ts), not on the list's way.
const sweep = () => void library.sweep().catch((err) => console.error("library sweep:", err));
sweep();
setInterval(sweep, 10 * 60_000);
const app = createApp({
  // (the PS2 games live in /app/data/ps2/)
  dir,
  pageDir,
  entryJs: await bundle("entry.ts", {
    "process.env.DISCORD_CLIENT_ID": JSON.stringify(DISCORD_CLIENT_ID),
    "process.env.PUBLIC_URL": JSON.stringify(PUBLIC_URL),
  }),
  passes,
  discord: createDiscord({ clientId: DISCORD_CLIENT_ID, clientSecret: DISCORD_CLIENT_SECRET }),
  clientId: DISCORD_CLIENT_ID,
  library,
  vimm: createVimm(dir, library),
  discs: createDiscs(dir, r2, discCache),
  // Optional: the R2 discs served near the players by edge/worker.ts (DISC_EDGE_URL, DISC_EDGE_SECRET; README)
  edge: r2 ? edgeFromEnv() : null,
  saves: createSaves(dir, r2),
  people,
  social,
  ps2Rooms,
  bios: createBios(dir),
  publicUrl: PUBLIC_URL,
  turn: TURN,
  cloudflare: CLOUDFLARE,
  scripts: {
    "iso.js": await bundle("iso.ts"),
    "pad.js": await bundle("pad.ts"),
    "padmap.js": await bundle("padmap-global.ts"),
    "overlay.js": await bundle("overlay.ts"),
    "ps2play.js": await bundle("ps2play.ts"),
    // (the "versão rápida"'s online, put in its page by routes.ts)
    "fastplay.js": await bundle("fastplay.ts"),
    // (not a page's: the end of TabStationToo's disc-worker.js, routes.ts)
    "disccache.js": await bundle("disccache-worker.ts"),
    "watch.js": await bundle("watch.ts"),
  },
});

// /health, the limits per person and the metrics around the routes; drain() on SIGTERM (ops.ts).
const ops = createOps({ app, passes, telemetry, ps2Rooms });

const server = Bun.serve<NetData>({
  port: PORT,
  // (above the online rooms' long-poll, ps2rooms.ts WAIT_MS; Bun's default 10 s would cut it)
  idleTimeout: 30,
  fetch: (req, server) => workers?.handle(req) ?? ops.handle(req, server),
  websocket: ops.websocket,
});

log.info("cordplay listening", { port: PORT, otlp: telemetry.enabled });

/**
 * A deploy (docker stop: SIGTERM, then SIGKILL after stop_grace_period): no new connections, the WebSockets told to
 * connect again, the requests going on finish, the friends' changes and the telemetry written, then out.
 */
async function shutdown(signal: string) {
  log.info("shutdown", { signal });
  try {
    await ops.drain(server);
    await social.settle();
    await sql.close();
  } catch (err) {
    log.error("shutdown: something pending was lost", { err });
  }
  // (a collector away doesn't hold the exit: drain + this stay well under stop_grace_period)
  await Promise.race([telemetry.shutdown().catch(() => {}), Bun.sleep(3000)]);
  process.exit(0);
}
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    // (a second one: out now)
    if (stopping) process.exit(1);
    stopping = true;
    void shutdown(signal);
  });
