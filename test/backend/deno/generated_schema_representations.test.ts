// Addendum-160 generated schema representation contracts.
import { assert, assertEquals } from "jsr:@std/assert";

const CATALOG = new URL("../../../docs/generated/database-schema.json", import.meta.url);
const SQL = new URL("../../../docs/generated/database-schema.sql", import.meta.url);

Deno.test("generated schema representations identify Drizzle as their source", async () => {
  const catalog = JSON.parse(await Deno.readTextFile(CATALOG));
  const sql = await Deno.readTextFile(SQL);

  assertEquals(catalog.generatedFrom, "server/db/schema.ts");
  // Exact-set tripwire against the Drizzle source. The generated files are
  // verified current by `pnpm run schema:check`, so a mismatch here means
  // server/db/schema.ts grew or shrank and this number was not updated with
  // it — regenerate, confirm schema:check is green, then restate the counts.
  // (audit_sensitive_columns is deliberately absent: it is plain SQL audit
  // infrastructure, not a Drizzle entity, so it is in the DB but not here.)
  assertEquals(Object.keys(catalog.tables).length, 56);
  assertEquals(Object.keys(catalog.enums).length, 28);
  assert(sql.startsWith("-- GENERATED FILE — DO NOT EDIT."));
  assert(sql.includes("-- Source: server/db/schema.ts"));
});

Deno.test("generated catalog and SQL contain every critical normalized aggregate", async () => {
  const catalog = JSON.parse(await Deno.readTextFile(CATALOG));
  const sql = await Deno.readTextFile(SQL);
  const requiredTables = [
    "public.system_workflow_steps",
    "public.asset_tags",
    "public.request_asset_custody_run_items",
    "public.notification_recipients",
    "public.notification_deliveries",
    "public.notification_delivery_attempts",
    "public.request_asset_custody_cases",
  ];

  for (const table of requiredTables) {
    assert(table in catalog.tables, `catalog missing ${table}`);
    const sqlName = table.replace("public.", "");
    assert(sql.includes(`CREATE TABLE IF NOT EXISTS \"${sqlName}\"`));
  }
  assert("public.email_trigger_key" in catalog.enums);
  assert("public.asset_custody_state" in catalog.enums);
});

Deno.test("generated representations contain structure only, never seed DML", async () => {
  const sql = await Deno.readTextFile(SQL);
  assertEquals(/\bINSERT\s+INTO\b/i.test(sql), false);
  assertEquals(sql.includes("CREATE TRIGGER"), false);
  assertEquals(sql.includes("CREATE OR REPLACE FUNCTION"), false);
});
