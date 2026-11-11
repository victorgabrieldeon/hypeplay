/**
 * A Postgres for the tests: TEST_DATABASE_URL (README "Local"). Each `testDb()` is a schema of its own, dropped by
 * `close`. Without the variable the tests that need it are skipped (`needsPg`), with a warning.
 */
import { SQL } from "bun";
import { test } from "bun:test";
import { migrate } from "../db";

export const PG_URL = process.env.TEST_DATABASE_URL ?? "";
if (!PG_URL) console.warn("TEST_DATABASE_URL not set: the tests that need Postgres are skipped (README, Local)");

/** `test`, skipped without a Postgres. */
export const needsPg = test.skipIf(!PG_URL);

let n = 0;

export async function testDb() {
  const schema = `test_${process.pid}_${Date.now().toString(36)}_${n++}`;
  const admin = new SQL({ url: PG_URL, max: 1 });
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  const sql = new SQL({ url: PG_URL, max: 2, connection: { search_path: schema } });
  await migrate(sql);
  return {
    sql,
    async close() {
      await sql.close();
      await admin.unsafe(`DROP SCHEMA ${schema} CASCADE`);
      await admin.close();
    },
  };
}
