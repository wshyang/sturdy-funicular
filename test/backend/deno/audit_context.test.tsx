// Coverage: the Phase 2 audit-context plumbing (addendum-092) — the
// transaction-scoped GUC bridge between the app and the ffs_audit_mutation()
// DB trigger. Validates:
//   1. runWithAuditContext(action, actor, details, fn) makes the trigger write
//      ONE parent + ONE child row with the real action/actor/details and the
//      computed delta.
//   2. The GUCs are transaction-scoped (LOCAL): after the transaction they are
//      gone, so a later autocommit UPDATE falls back to the default context —
//      no cross-connection leakage.
//   3. Secret columns are excluded from the delta: a users UPDATE that only
//      touches password_hash/password_salt produces NO user audit row, and the
//      hash never appears in any changes payload.
//   4. access_log_id is derived from the ALS context (set inside the
//      transaction), not from request input.
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import { query, runInTransaction } from "../../../server/pg.tsx";
import { runWithAuditContext, setAuditContext } from "../../../server/audit-context.tsx";
import { syncAuditSensitiveColumns } from "../../../server/audit-column-sensitivity.tsx";
import { accessLogContext } from "../../../server/access-log.tsx";
import { SYSTEM_USER_ID } from "../../../server/types.tsx";
import {
  wipeDatabase, createAdmin, createActiveUser, uniqueEmail, createWiredSystem, createAsset,
} from "./helpers.tsx";

Deno.test("audit context: GUC bridge + trigger context + secret exclusions", async (t) => {
  let adminId: string;
  let ownerId: string;
  let systemId: string;
  let assetId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    await syncAuditSensitiveColumns(); // seed the sensitive-column registry from the shipped YAML
    const admin = await createAdmin("AuditCtxAdmin!2026");
    adminId = admin.id;
    const owner = await createActiveUser({ fullName: "AuditCtxOwner", email: uniqueEmail("auditctxowner"), password: "AuditCtxOwner!2026", affiliation: "agency" });
    ownerId = owner.id;
    const { system } = await createWiredSystem(adminId, owner);
    systemId = system.id;
    const asset = await createAsset(systemId);
    assetId = asset.id;
    // audit_log.access_log_id has an FK to access_log(id); step 1 drives a fixed
    // access-log id through the ALS context, so that row must exist first.
    await query(
      `INSERT INTO access_log (id, user_id, method, path, status_code)
       VALUES ('00000000-0000-7000-8000-00000000aaa1', $1, 'POST', '/audit-context-test', 200)
       ON CONFLICT (id) DO NOTHING`,
      [adminId],
    );
  });

  await t.step("1 — runWithAuditContext: trigger writes one parent + one child with real context + delta", async () => {
    // An access-log context is in play for this transaction (Phase-2
    // ergonomics: the bridge derives it from the ALS context, same as
    // createAuditLog does).
    await runInTransaction(async () => {
      await accessLogContext.run("00000000-0000-7000-8000-00000000aaa1", async () => {
        await runWithAuditContext(
          'test.asset_ctx_updated',
          adminId,
          { reason: "context-test", systemId: systemId },
          () => query(`UPDATE assets SET expires_after = now() WHERE id = $1`, [assetId]),
        );
      });
    });

    const rows = await query<{ action: string; actor: string; access_log_id: string | null; details: Record<string, unknown>; changes: Record<string, { previous: unknown; after: unknown }> }>(
      `SELECT b.action, b.actor_id::text AS actor, b.access_log_id::text AS access_log_id, b.details, c.changes
         FROM audit_log_changes c JOIN audit_log b ON b.id = c.id
        WHERE b.target_type = 'asset' AND b.target_id = $1 AND b.action = 'test.asset_ctx_updated'`, [assetId],
    );
    assertEquals(rows.length, 1, "exactly one trigger row for the GUC action");
    assertEquals(rows[0].actor, adminId);
    assertEquals(rows[0].access_log_id, "00000000-0000-7000-8000-00000000aaa1");
    assertEquals(rows[0].details?.reason, "context-test");
    assert(rows[0].changes.expires_after, "delta must include expires_after");
    assertEquals(rows[0].changes.expires_after.previous, null);
  });

  await t.step("2 — GUCs are transaction-scoped: no leakage after commit", async () => {
    // setAuditContext inside one transaction…
    await runInTransaction(async () => {
      await setAuditContext({ action: 'test.scoped', actorId: adminId });
    });
    // …then a plain autocommit read must see NO ffs.* GUCs.
    const out = await query<{ action: string | null; actor: string | null }>(
      `SELECT NULLIF(current_setting('ffs.action', true), '') AS action,
              NULLIF(current_setting('ffs.actor_id', true), '') AS actor`,
    );
    assertEquals(out[0].action, null, "ffs.action must not leak past the transaction");
    assertEquals(out[0].actor, null, "ffs.actor_id must not leak past the transaction");
  });

  await t.step("3 — secret columns are MASKED: a password-only update records the change with [hidden] values", async () => {
    await runWithAuditContext('test.secret_update', adminId, null, () =>
      query(`UPDATE users SET password_hash = 'supersecrethash', password_salt = 'supersecretsalt' WHERE id = $1`, [ownerId]),
    );
    const rows = await query<{ changes: Record<string, { previous: unknown; after: unknown; masked?: boolean }> }>(
      `SELECT c.changes FROM audit_log_changes c JOIN audit_log b ON b.id = c.id
        WHERE b.target_type = 'user' AND b.target_id = $1 AND c.changes::text LIKE '%password_hash%' ORDER BY c.id DESC LIMIT 1`,
      [ownerId],
    );
    assertEquals(rows.length, 1, "a secret-only UPDATE now PRODUCES a masked audit row");
    const ph = rows[0].changes.password_hash;
    assert(ph, "delta must contain password_hash (masked)");
    assertEquals(ph.previous, "[hidden]");
    assertEquals(ph.after, "[hidden]");
    assertEquals(ph.masked, true);
    // The real values must never appear anywhere in the changes payload.
    const text = JSON.stringify(rows[0].changes);
    assert(!text.includes("supersecrethash") && !text.includes("supersecretsalt"),
      "masked delta must not contain the plaintext secret");
  });

  await t.step("4 — GUC-unset autocommit UPDATE still falls back to default context", async () => {
    await query(`UPDATE assets SET hostname = 'audit-ctx-default-host' WHERE id = $1`, [assetId]);
    const rows = await query<{ actor: string; action: string; details: unknown }>(
      `SELECT b.actor_id::text AS actor, b.action, b.details FROM audit_log_changes c JOIN audit_log b ON b.id = c.id
        WHERE b.target_type = 'asset' AND b.target_id = $1 AND b.action = 'asset.updated' ORDER BY b.created_at DESC LIMIT 1`, [assetId],
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].actor, SYSTEM_USER_ID);
    assertEquals(rows[0].details, null);
  });
});
