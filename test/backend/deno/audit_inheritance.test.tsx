// Coverage: the inheritance-based audit & mutation log (addendum-092; child
// collapsed by addendum-209 R8). Deltas are computed by the
// ffs_audit_mutation() DB trigger and stored in the SINGLE generic
// audit_log_changes child (id FK -> audit_log.id CASCADE). Validates:
//   1. createAuditLog() still writes PARENT-only rows unchanged (incl. the
//      two pseudo-targets export_bundle/import_operation).
//   2. A child row with a bogus audit_log id is rejected by the child's REAL
//      FK to the parent.
//   3. An UPDATE on an audited table fires the trigger: exactly one parent +
//      one child row, with the trigger-computed { previous, after } delta —
//      derived from OLD/NEW, never from app input (D5).
//   4. No-op UPDATEs write no audit row; GUC-unset UPDATEs default to the
//      SYSTEM actor + '<entity>.updated'.
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import { createAuditLog } from "../../../server/utils.tsx";
import { auditLogs } from "../../../server/db.tsx";
import { query, runInTransaction } from "../../../server/pg.tsx";
import { SYSTEM_USER_ID } from "../../../server/types.tsx";
import {
  wipeDatabase, createAdmin, createActiveUser, uniqueEmail, createWiredSystem, createAsset,
} from "./helpers.tsx";

Deno.test("audit inheritance: parent-only rows, generic child FK, trigger-computed deltas", async (t) => {
  let adminId: string;
  let assetId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AuditInhAdmin!2026");
    adminId = admin.id;
    const owner = await createActiveUser({ fullName: "AuditInhOwner", email: uniqueEmail("auditinhowner"), password: "AuditInhOwner!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const asset = await createAsset(system.id);
    assetId = asset.id;
  });

  await t.step("1 — createAuditLog still writes parent-only rows (real + pseudo targets)", async () => {
    await createAuditLog(adminId, "test.asset_valid", "asset", assetId, { note: "parent-only" });
    await createAuditLog(adminId, "data.exported", "export_bundle", "export", null);
    await createAuditLog(adminId, "data.reset_seeded", "import_operation", "reset-seed", null);

    const assetLogs = await auditLogs.findByTarget("asset", assetId);
    assertExists(assetLogs.find((l) => l.action === "test.asset_valid"));
    const exportLogs = await auditLogs.findByTarget("export_bundle", "export");
    assertExists(exportLogs.find((l) => l.action === "data.exported"));
    // Parent-only rows have NO child row (children are trigger-written only).
    const children = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log_changes c
        JOIN audit_log b ON b.id = c.id WHERE b.target_id = $1`, [assetId],
    );
    assertEquals(children[0].n, 0);
  });

  await t.step("2 — generic child FK rejects a bogus audit_log id", async () => {
    let threw = false;
    try {
      await query(
        `INSERT INTO audit_log_changes (id, changes) VALUES ($1, '{}'::jsonb)`,
        ["00000000-0000-0000-0000-000000000999"],
      );
    } catch {
      threw = true;
    }
    assertEquals(threw, true, "a child row with a nonexistent audit_log id must be rejected by the FK");
  });

  await t.step("3 — UPDATE fires the trigger: one parent + one child with the computed delta", async () => {
    await runInTransaction(async () => {
      await query(`SELECT set_config('ffs.action', 'test.asset_expired', true)`);
      await query(`SELECT set_config('ffs.actor_id', $1, true)`, [adminId]);
      // A no-op for every other column: only expires_after changes.
      await query(`UPDATE assets SET expires_after = now() WHERE id = $1`, [assetId]);
    });

    const rows = await query<{ parent_action: string; actor: string; target_type: string; changes: Record<string, unknown> }>(
      `SELECT b.action AS parent_action, b.actor_id::text AS actor, b.target_type::text AS target_type, c.changes
         FROM audit_log_changes c JOIN audit_log b ON b.id = c.id
        WHERE b.target_id = $1`, [assetId],
    );
    const hit = rows.filter((r) => r.parent_action === "test.asset_expired");
    assertEquals(hit.length, 1, "exactly one trigger-written row for the GUC action");
    assertEquals(hit[0].actor, adminId);
    assertEquals(hit[0].target_type, "asset");

    const changes = hit[0].changes as Record<string, { previous: unknown; after: unknown }>;
    assert(changes.expires_after, "delta must include expires_after");
    assertEquals(changes.expires_after.previous, null);
    assert(changes.expires_after.after !== null);
    // Identity/noise columns excluded from the delta.
    assert(!("updated_at" in changes), "updated_at must be excluded from the delta");
    assert(!("created_at" in changes), "created_at must be excluded from the delta");
  });

  await t.step("4a — a no-op UPDATE writes no audit row", async () => {
    const before = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log_changes c
        JOIN audit_log b ON b.id = c.id WHERE b.target_id = $1`, [assetId],
    );
    await runInTransaction(async () => {
      await query(`UPDATE assets SET expires_after = expires_after WHERE id = $1`, [assetId]);
    });
    const after = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log_changes c
        JOIN audit_log b ON b.id = c.id WHERE b.target_id = $1`, [assetId],
    );
    assertEquals(after[0].n, before[0].n, "a no-op UPDATE must not produce an audit row");
  });

  await t.step("4b — GUC-unset UPDATE defaults to SYSTEM actor + '<entity>.updated'", async () => {
    await runInTransaction(async () => {
      await query(`UPDATE assets SET hostname = 'audit-inh-default-host' WHERE id = $1`, [assetId]);
    });
    const rows = await query<{ actor: string; action: string }>(
      `SELECT b.actor_id::text AS actor, b.action FROM audit_log_changes c JOIN audit_log b ON b.id = c.id
        WHERE b.target_id = $1 AND b.action = 'asset.updated' ORDER BY b.created_at DESC LIMIT 1`, [assetId],
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].actor, SYSTEM_USER_ID);
  });
});
