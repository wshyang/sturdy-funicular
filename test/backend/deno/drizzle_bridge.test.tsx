// Coverage: the Drizzle-over-pg.tsx transaction bridge (server/db/drizzle.ts +
// server/pg.tsx's queryArray). Proves a Drizzle write executes on the SAME
// connection as pg.tsx's runInTransaction() — so Drizzle and raw-SQL writes in
// one request are atomic together (roll back / commit as a unit), and outside a
// transaction a Drizzle write behaves like any pooled query. This is the
// prerequisite that makes the Handoff-3 db.tsx migration safe; see
// CLAUDE-drizzle-migration.md's "Handoff 3 — REVISED APPROACH".
//
// Assertions use raw SQL (query()) only — this test never trusts the Drizzle
// layer to verify itself, matching the suite's no-mocks / real-DB discipline.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { wipeDatabase, createAdmin } from "./helpers.tsx";
import { query, runInTransaction } from "../../../server/pg.tsx";
import { db } from "../../../server/db/drizzle.ts";
import { clusters } from "../../../server/db/schema.ts";
import { eq } from "npm:drizzle-orm@0.33.0";

Deno.test("drizzle_bridge", async (t) => {
  let adminId: string;
  // addendum-206: clusters.organization_id is NOT NULL — the bridge fixtures
  // need an org row to hang the cluster inserts off.
  const bridgeOrgId = "00000000-0000-7000-8000-0000000000f1";

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin();
    adminId = admin.id;
    await query(
      `INSERT INTO organizations (id, name, short_code, created_by) VALUES ($1, 'Bridge Org', 'BRG', $2)`,
      [bridgeOrgId, adminId],
    );
  });

  await t.step(
    "positive: a Drizzle INSERT commits when the transaction succeeds",
    async () => {
      const id = "00000000-0000-7000-8000-00000000c001";
      await runInTransaction(async () => {
        await db.insert(clusters).values({
          id,
          name: "Bridge Commit",
          type: "vendor",
          organizationId: bridgeOrgId,
          createdBy: adminId,
        });
      });
      // Verified with raw SQL, outside the transaction: the row persisted.
      const rows = await query<{ name: string }>(
        `SELECT name FROM clusters WHERE id = $1`,
        [id],
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].name, "Bridge Commit");
    },
  );

  await t.step(
    "negative: a Drizzle INSERT rolls back when the transaction throws",
    async () => {
      const id = "00000000-0000-7000-8000-00000000c002";
      let threw = false;
      try {
        await runInTransaction(async () => {
          await db.insert(clusters).values({
            id,
            name: "Bridge Rollback",
            type: "vendor",
            organizationId: bridgeOrgId,
            createdBy: adminId,
          });
          // Prove the write is visible INSIDE the same transaction before we
          // abort — i.e. it really executed on the tx connection, not a
          // separate pool (which would make this SELECT see nothing).
          const midTx = await query<{ id: string }>(
            `SELECT id FROM clusters WHERE id = $1`,
            [id],
          );
          assertEquals(midTx.length, 1);
          throw new Error("intentional rollback");
        });
      } catch (e) {
        threw = (e as Error).message === "intentional rollback";
      }
      assertEquals(threw, true);
      // After rollback the row must be gone — the Drizzle write shared the
      // aborted transaction rather than committing independently.
      const after = await query<{ id: string }>(
        `SELECT id FROM clusters WHERE id = $1`,
        [id],
      );
      assertEquals(after.length, 0);
    },
  );

  await t.step(
    "positive: a Drizzle INSERT outside any transaction commits directly",
    async () => {
      const id = "00000000-0000-7000-8000-00000000c003";
      await db.insert(clusters).values({
        id,
        name: "Bridge No-Tx",
        type: "agency",
        organizationId: bridgeOrgId,
        createdBy: adminId,
      });
      const rows = await query<{ name: string }>(
        `SELECT name FROM clusters WHERE id = $1`,
        [id],
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].name, "Bridge No-Tx");
    },
  );

  await t.step(
    "positive: a Drizzle SELECT round-trips typed columns correctly",
    async () => {
      // pg-proxy maps rows positionally; confirm the enum/uuid/varchar columns
      // decode to the right JS values through the bridge.
      const rows = await db
        .select()
        .from(clusters)
        .where(eq(clusters.type, "agency"));
      const noTx = rows.find((r) => r.name === "Bridge No-Tx");
      assertExists(noTx);
      assertEquals(noTx!.type, "agency");
      assertEquals(noTx!.createdBy, adminId);
    },
  );
});
