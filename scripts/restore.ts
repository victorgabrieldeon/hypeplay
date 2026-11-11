// A backup from R2 (server/backup.ts) back into an empty /app/data and an empty Postgres. With the app and ps2-builder
// STOPPED (README "Backup automático"): in the app's container, which has DATA_DIR, DATABASE_URL and S3_*.
// usage: bun scripts/restore.ts [--list] [--from <AAAA-MM-DDTHHMM>] [--force]
import { SQL } from "bun";
import { join } from "node:path";
import { listBackups, restore } from "../server/backup";
import { r2FromEnv } from "../server/discs";

const args = process.argv.slice(2);
const flags = new Set<string>();
let from: string | undefined;
// (anything else, a backup's name without --from say, is refused: never the latest in its place)
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a === "--list" || a === "--force") flags.add(a);
  else if (a === "--from" && args[i + 1] && !args[i + 1]!.startsWith("--") && from === undefined) from = args[++i];
  else {
    console.error("usage: bun scripts/restore.ts [--list] [--from <AAAA-MM-DDTHHMM>] [--force]");
    process.exit(2);
  }
}
const flag = (f: string) => flags.has(f);

const r2 = r2FromEnv();
if (!r2) throw new Error("S3_BUCKET not set: the backups are in R2");
if (flag("--list")) {
  for (const b of await listBackups(r2)) console.log(`${b.name}${b.done ? "" : "  (incompleto)"}`);
  process.exit(0);
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL not set");
const dir = process.env.DATA_DIR ?? join(import.meta.dir, "..", "data");
const sql = new SQL(process.env.DATABASE_URL);
try {
  const r = await restore({ dir, sql, r2, name: from, force: flag("--force") });
  if (r.passed.length) console.log(`backups mais novos deixados de lado (sem jogos ou sem pessoas; só com --from): ${r.passed.join(", ")}`);
  console.log(`backup ${r.name} restaurado em ${dir}`);
  console.log(`  banco: ${Object.entries(r.tables).map(([t, n]) => `${t} ${n}`).join(", ")}`);
  console.log(`  volume: ${r.volume} entradas`);
  if (r.requeued.length) console.log(`  versões rápidas que não estão nem aqui nem no R2: de volta à fila (${r.requeued.join(", ")})`);
  if (r.discless.length) console.log(`  jogos sem disco (nem na VPS nem no R2): a limpeza do app os remove; envie de novo: ${r.discless.join(", ")}`);
} catch (err) {
  console.error(`restore: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.close();
}
