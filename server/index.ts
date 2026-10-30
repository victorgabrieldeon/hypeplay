import { join } from "node:path";
import { createDiscord } from "./discord";
import { createPasses } from "./pass";
import { createApp, type NetData } from "./routes";

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`missing env: ${name}`);
  return value;
};

const PORT = Number(process.env.PORT ?? 3003);
// The Discord app the Activity belongs to (Developer Portal → OAuth2).
const DISCORD_CLIENT_ID = env("DISCORD_CLIENT_ID");
const DISCORD_CLIENT_SECRET = env("DISCORD_CLIENT_SECRET");

const pageDir = join(import.meta.dir, "..", "page");
const built = await Bun.build({
  entrypoints: [join(pageDir, "entry.ts")],
  minify: true,
  define: { "process.env.DISCORD_CLIENT_ID": JSON.stringify(DISCORD_CLIENT_ID) },
});
if (!built.success) throw new AggregateError(built.logs, "page/entry.ts didn't build");

const app = createApp({
  // Each game's folder is <dir>/<id>/: BT3's builder works in /app/data/bt3/.
  dir: process.env.DATA_DIR ?? join(import.meta.dir, "..", "data"),
  pageDir,
  entryJs: await built.outputs[0]!.text(),
  // The client secret signs the passes too: resetting it in the portal also ends every open session.
  passes: createPasses(DISCORD_CLIENT_SECRET),
  discord: createDiscord({ clientId: DISCORD_CLIENT_ID, clientSecret: DISCORD_CLIENT_SECRET }),
});

Bun.serve<NetData>({
  port: PORT,
  fetch: (req, server) => app.handle(req, server),
  websocket: app.websocket,
});

console.log(`cordplay on http://localhost:${PORT}`);
