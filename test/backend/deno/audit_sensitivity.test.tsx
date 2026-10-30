// Coverage: the config-driven sensitive-column system (addendum-092).
// config/audit_sensitive_columns.yaml is the single source of truth; it is
// synced into the audit_sensitive_columns registry at startup and the
// ffs_audit_mutation() trigger masks listed columns to '[hidden]' (still
// recording that the column changed). Validates the loader, the sync, the
// app-side probe, and the end-to-end masked delta with no plaintext leak.
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import { query } from "../../../server/pg.tsx";
import { runWithAuditContext } from "../../../server/audit-context.tsx";
import {
  loadAuditSensitivityConfig,
  syncAuditSensitiveColumns,
  isColumnSensitive,
} from "../../../server/audit-column-sensitivity.tsx";
import {
  wipeDatabase, createAdmin, createActiveUser, uniqueEmail, createWiredSystem, createAsset,
} from "./helpers.tsx";

Deno.test("audit sensitivity: YAML config + registry + masked delta capture", async (t) => {
  let adminId: string;
  let ownerId: string;
  let assetId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    await syncAuditSensitiveColumns();
    const admin = await createAdmin("AuditSensAdmin!2026");
    adminId = admin.id;
    const owner = await createActiveUser({ fullName: "AuditSensOwner", email: uniqueEmail("auditsensowner"), password: "AuditSensOwner!2026", affiliation: "agency" });
    ownerId = owner.id;
    const { system } = await createWiredSystem(adminId, owner);
    assetId = (await createAsset(system.id)).id;
  });

  await t.step("1 — the shipped YAML declares the expected sensitive columns", async () => {
    const cfg = await loadAuditSensitivityConfig();
    assertExists(cfg.users);
    assert(cfg.users.includes("password_hash"), "users.password_hash");
    assert(cfg.users.includes("password_salt"), "users.password_salt");
    assert(cfg.users.includes("totp_secret"), "users.totp_secret");
    assert(cfg.app_settings?.includes("value"), "app_settings.value");
    // The user's examples: the per-request private-key wrap key
    // (request_key_material) and the Entra OAuth nonce (entra_handoffs) are
    // declared (inert until those tables gain audit children).
    assert(cfg.request_key_material?.includes("private_key_wrap_key"), "request_key_material.private_key_wrap_key");
    assert(cfg.entra_handoffs?.includes("nonce"), "entra_handoffs.nonce");
  });

  await t.step("2 — the registry is synced from the YAML and the probe reflects it", async () => {
    assertEquals(await isColumnSensitive("users", "password_hash"), true);
    assertEquals(await isColumnSensitive("app_settings", "value"), true);
    assertEquals(await isColumnSensitive("assets", "expires_after"), false);
    const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM audit_sensitive_columns`);
    assertEquals(rows[0].n >= 5, true, "registry seeded with the YAML rows");
  });

  await t.step("3 — a sensitive update is recorded with [hidden] values, never the plaintext", async () => {
    await runWithAuditContext("test.sens_masked", adminId, null, () =>
      query(`UPDATE users SET password_hash = 'MASKME-hash', password_salt = 'MASKME-salt' WHERE id = $1`, [ownerId]),
    );
    const rows = await query<{ action: string; changes: Record<string, { previous: unknown; after: unknown; masked?: boolean }> }>(
      `SELECT b.action, c.changes FROM audit_log_changes c JOIN audit_log b ON b.id = c.id
        WHERE b.target_type = 'user' AND b.target_id = $1 AND b.action = 'test.sens_masked'`, [ownerId],
    );
    assertEquals(rows.length, 1, "the change is still RECORDED (one parent + one child row)");
    const ph = rows[0].changes.password_hash;
    const ps = rows[0].changes.password_salt;
    assertEquals(ph.previous, "[hidden]");
    assertEquals(ph.after, "[hidden]");
    assertEquals(ph.masked, true);
    assertEquals(ps.masked, true);
    const text = JSON.stringify(rows[0].changes);
    assert(!text.includes("MASKME"), "the plaintext secret must never reach the changes payload");
  });

  await t.step("4 — an unmasked column still records the real previous/after values", async () => {
    await runWithAuditContext("test.sens_unmasked", adminId, null, () =>
      query(`UPDATE assets SET hostname = 'audit-sens-host' WHERE id = $1`, [assetId]),
    );
    const rows = await query<{ changes: Record<string, { previous: unknown; after: unknown; masked?: boolean }> }>(
      `SELECT c.changes FROM audit_log_changes c JOIN audit_log b ON b.id = c.id
        WHERE b.target_type = 'asset' AND b.target_id = $1 AND c.changes::text LIKE '%hostname%' ORDER BY c.id DESC LIMIT 1`,
      [assetId],
    );
    assertEquals(rows.length, 1);
    const h = rows[0].changes.hostname;
    assert(h && h.after === "audit-sens-host", "unmasked column records the real after value");
    assertEquals(h.masked, undefined, "no masked flag on a non-sensitive column");
  });
});
