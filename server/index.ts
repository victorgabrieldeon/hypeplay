import { join } from "node:path";
import { createPasses } from "./pass";
import { BT3_ID, createBt3, type NetData } from "./routes";

const PORT = Number(process.env.PORT ?? 3003);
// The HypeMeet site whose rooms open the plugin: the only one allowed to frame it, and the one that vouches for passes.
const HYPEMEET_URL = process.env.HYPEMEET_URL;
if (!HYPEMEET_URL) throw new Error("missing env: HYPEMEET_URL");

const bt3 = createBt3({
  dir: process.env.BT3_DIR ?? join(import.meta.dir, "..", "data", "bt3"),
  pageDir: join(import.meta.dir, "..", "page"),
  hypemeetOrigin: new URL(HYPEMEET_URL).origin,
  passes: createPasses(HYPEMEET_URL, BT3_ID),
});

Bun.serve<NetData>({
  port: PORT,
  fetch: (req, server) => bt3.handle(req, server),
  websocket: bt3.websocket,
});

console.log(`bt3 on http://localhost:${PORT} (rooms of ${HYPEMEET_URL})`);
