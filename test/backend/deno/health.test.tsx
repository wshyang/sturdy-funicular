// Coverage: GET /health, GET /setup.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { req, wipeDatabase, createAdmin } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { runPendingMigrations } from "../../../server/migrate.tsx";

Deno.test("health", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("GET /health: positive — reports ok", async () => {
    const res = await req("/health");
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.status, "ok");
  });

  // GET /setup must self-heal a truly schema-less database (no tables at
  // all — the Northflank incident that motivated addendum-057-setup-schema-
  // self-bootstrap.md), independent of whether server/index.tsx's startup
  // chain already ran. Simulated the same way schema_bootstrap.test.tsx
  // does: drop the whole public schema against the real test database, hit
  // the route directly, and confirm it recovers on its own.
  await t.step("GET /setup: positive — self-heals a schema-less database (no tables at all)", async () => {
    await query(`DROP SCHEMA public CASCADE`);
    await query(`CREATE SCHEMA public`);

    try {
      const res = await req("/setup");
      assertEquals(res.status, 200);
      const data = await res.json();
      assertEquals(data.schemaJustBootstrapped, true);
      assertExists(data.message);

      // Restore the reserved system-actor rows too (see
      // schema_bootstrap.test.tsx) — ensureSchemaApplied() only applies
      // 001_schema.sql itself, which already seeds them (see
      // setup/sql/001_schema.sql), but re-run pending migrations anyway to
      // mirror the real startup chain exactly before later steps continue.
      await runPendingMigrations();

      const rows = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users`);
      assertEquals(rows[0].count > 0, true); // the default admin GET /setup just created
    } finally {
      await wipeDatabase();
    }
  });

  await t.step("GET /setup: positive — no users yet, creates the default admin", async () => {
    const res = await req("/setup");
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.message);
    assertEquals(data.schemaJustBootstrapped, false);
    assertEquals(data.availableSqlFiles.includes("001_schema.sql"), true);
    assertEquals(data.availableSqlFiles.includes("002_seed_demo.sql"), true);
  });

  await t.step("GET /setup: positive — users already exist, reports userCount instead of re-creating", async () => {
    await createAdmin("SetupAdmin!2026");
    const res = await req("/setup");
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(typeof data.userCount, "number");
    assertEquals(data.userCount > 0, true);
  });

  await t.step("GET /setup?file=...: negative — rejects applying a file once users already exist", async () => {
    const res = await req("/setup?file=002_seed_demo.sql");
    assertEquals(res.status, 400);
    const data = await res.json();
    assertExists(data.error);
  });

  await t.step("GET /setup?file=...: positive — applies a chosen setup/sql/ file while zero users exist", async () => {
    await wipeDatabase();

    const res = await req("/setup?file=002_seed_demo.sql");
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.appliedFile, "002_seed_demo.sql");

    // 002_seed_demo.sql seeds its own demo users — confirm ensureDefaultAdmin()
    // correctly skipped creating admin@breakglass.local on top of them (it
    // does its own internal users.list() check).
    const rows = await query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM users WHERE email = 'admin@breakglass.local'`,
    );
    assertEquals(rows[0].count, 0);

    const demoRows = await query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM users WHERE NOT is_system`);
    assertEquals(demoRows[0].count > 0, true);
  });

  await t.step("GET /setup?file=...: negative — rejects an unknown filename", async () => {
    await wipeDatabase();

    const res = await req("/setup?file=003_evil.sql");
    assertEquals(res.status, 400);
    const data = await res.json();
    assertExists(data.error);
  });
});
