// Development only: a pass signed with the app's secret, to open the home at http://localhost:3003/p/<pass>/ without
// Discord. usage: bun scripts/pass.ts <DISCORD_CLIENT_SECRET> [discord id] [name]
import { createPasses } from "../server/pass";

const [secret, id = "42", name = "Dev"] = process.argv.slice(2);
if (!secret) {
  console.error("usage: bun scripts/pass.ts <DISCORD_CLIENT_SECRET> [discord id] [name]");
  process.exit(2);
}
console.log(createPasses(secret).issue({ id, name }));
