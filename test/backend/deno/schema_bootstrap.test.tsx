// Coverage: server/schema-bootstrap.tsx — isSchemaApplied, listAvailableSqlFiles,
// applySqlFile, ensureSchemaApplied. See addendum-057-setup-schema-self-bootstrap.md.
//
// This file deliberately does NOT start with wipeDatabase() like every other
// test file — its whole point is to simulate a database with NO schema at
// all (not just empty tables), so it drops the entire public schema itself
// and must fully restore it (via ensureSchemaApplied()) before finishing,
// since every subsequent test file's wipeDatabase() assumes the schema
// already exists.
import { assertEquals, assertRejects } from "jsr:@std/assert";
import { query } from "../../../server/pg.tsx";
import {
  isSchemaApplied,
  listAvailableSqlFiles,
  applySqlFile,
  ensureSchemaApplied,
} from "../../../server/schema-bootstrap.tsx";
import { runPendingMigrations } from "../../../server/migrate.tsx";

Deno.test("schema_bootstrap", async (t) => {
  await t.step("listAvailableSqlFiles: positive — includes the known setup SQL files", async () => {
    const files = await listAvailableSqlFiles();
    assertEquals(files.includes("001_schema.sql"), true);
    assertEquals(files.includes("002_seed_demo.sql"), true);
    assertEquals(files.includes("003_seed_demo_live.sql"), true);
  });

  await t.step("applySqlFile: negative — rejects a filename not in setup/sql/ (path traversal)", async () => {
    await assertRejects(() => applySqlFile("../../etc/passwd"));
  });

  await t.step("applySqlFile: negative — rejects a plausible but nonexistent filename", async () => {
    await assertRejects(() => applySqlFile("003_evil.sql"));
  });

  await t.step("isSchemaApplied: positive — true against the already-provisioned test database", async () => {
    assertEquals(await isSchemaApplied(), true);
  });

  await t.step("ensureSchemaApplied: positive — no-op when schema already exists", async () => {
    const bootstrapped = await ensureSchemaApplied();
    assertEquals(bootstrapped, false);
  });

  await t.step("isSchemaApplied / ensureSchemaApplied: positive — detects and self-heals a truly schema-less database", async () => {
    await query(`DROP SCHEMA public CASCADE`);
    await query(`CREATE SCHEMA public`);

    try {
      assertEquals(await isSchemaApplied(), false);

      const bootstrapped = await ensureSchemaApplied();
      assertEquals(bootstrapped, true);

      assertEquals(await isSchemaApplied(), true);
      // Confirm the schema is genuinely usable, not just "users exists" —
      // a real query against it must succeed. setup/sql/001_schema.sql itself
      // unconditionally seeds the 2 reserved system-actor rows
      // (SYSTEM_USER_ID/UNKNOWN_USER_ID) — see addendum-057 §4 — so the count
      // right after ensureSchemaApplied() is 2, not 0.
      const rows = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users`);
      assertEquals(rows[0].count, 2);

      // Re-running pending migrations is a no-op here for the system-actor
      // rows (already seeded above), but mirrors server/index.tsx's real
      // startup chain (ensureSchemaApplied() -> ensureDefaultAdmin() ->
      // runPendingMigrations()). Every later test file's wipeDatabase()
      // preserves is_system rows on the assumption they already exist, so this
      // step must restore them too, not just the base schema.
      await runPendingMigrations();
      const systemRows = await query<{ count: number }>(
        `SELECT COUNT(*)::int AS count FROM users WHERE is_system`,
      );
      assertEquals(systemRows[0].count, 2);
    } finally {
      // Belt-and-suspenders: if the assertions above threw before the
      // self-heal completed, every later test file's wipeDatabase() would
      // fail against a still-missing schema or missing system-actor rows.
      // Re-run both steps unconditionally so this file always leaves a fully
      // restored database behind.
      await ensureSchemaApplied();
      await runPendingMigrations();
    }
  });
});
