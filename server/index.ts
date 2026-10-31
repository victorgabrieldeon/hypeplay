import { join } from "node:path";
import { createBios } from "./bios";
import { createDiscord } from "./discord";
import { createLibrary } from "./library";
import { createPasses } from "./pass";
import { createPeople } from "./people";
import { Ps2Rooms } from "./ps2rooms";
import { createApp, type NetData } from "./routes";
import { createSaves } from "./saves";

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

const pageDir = join(import.meta.dir, "..", "page");

/** A page script, bundled once at startup. */
async function bundle(entry: string, define: Record<string, string> = {}) {
  const built = await Bun.build({ entrypoints: [join(pageDir, entry)], minify: true, format: "iife", define });
  if (!built.success) throw new AggregateError(built.logs, `page/${entry} didn't build`);
  return built.outputs[0]!.text();
}

const dir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
const app = createApp({
  // Each game's folder is <dir>/<id>/: BT3's builder works in /app/data/bt3/, the PS2 games live in /app/data/ps2/.
  dir,
  pageDir,
  entryJs: await bundle("entry.ts", {
    "process.env.DISCORD_CLIENT_ID": JSON.stringify(DISCORD_CLIENT_ID),
    "process.env.PUBLIC_URL": JSON.stringify(PUBLIC_URL),
  }),
  // The client secret signs the passes too: resetting it in the portal also ends every open session.
  passes: createPasses(DISCORD_CLIENT_SECRET),
  discord: createDiscord({ clientId: DISCORD_CLIENT_ID, clientSecret: DISCORD_CLIENT_SECRET }),
  clientId: DISCORD_CLIENT_ID,
  library: createLibrary(dir),
  saves: createSaves(dir),
  people: createPeople(dir),
  ps2Rooms: new Ps2Rooms(),
  bios: createBios(dir),
  publicUrl: PUBLIC_URL,
  turn: TURN,
  scripts: {
    "iso.js": await bundle("iso.ts"),
    "pad.js": await bundle("pad.ts"),
    "padmap.js": await bundle("padmap-global.ts"),
    "overlay.js": await bundle("overlay.ts"),
    "ps2play.js": await bundle("ps2play.ts"),
    // (not a page's: the end of TabStationToo's disc-worker.js, routes.ts)
    "disccache.js": await bundle("disccache-worker.ts"),
    "watch.js": await bundle("watch.ts"),
  },
});

// Homebrew Hub's list: the saved one now, a fresh one in the background when it's a day old.
await app.homebrew.start();

Bun.serve<NetData>({
  port: PORT,
  // (above the online rooms' long-poll, ps2rooms.ts WAIT_MS; Bun's default 10 s would cut it)
  idleTimeout: 30,
  fetch: (req, server) => app.handle(req, server),
  websocket: app.websocket,
});

console.log(`cordplay on http://localhost:${PORT}`);
