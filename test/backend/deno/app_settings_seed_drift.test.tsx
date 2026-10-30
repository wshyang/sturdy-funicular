// Seed-drift guard for app_settings (addendum-049): every key in the
// code-side DEFAULTS map (server/app-settings.tsx) must exist as a row in
// the app_settings table.
//
// Why this test exists: server/app-settings.tsx's own header promises "add a
// key here and it is automatically seeded (schema + migration)" — but the
// seeds are STATIC SQL (migrations/022/026/033/034 and setup/sql/001_schema.sql),
// not generated from DEFAULTS. That promise was broken at least three times:
// 20 keys (email_delivery_provider, smtp_*, ses_*, postman_*, entra_*,
// direct_link_ttl_days, public_base_url, invite_token_ttl_ms) existed in
// DEFAULTS but in NO seed, so PUT /admin/app-settings/<key> silently updated
// 0 rows and the subsequent audit-log insert was rejected by the
// validate_audit_log_target() trigger — surfacing as the 500:
//   "Audit log write failed: audit_log.target_id ... does not exist for
//    target_type app_setting"
// Fixed by migrations/034_seed_missing_app_settings.sql. This test makes the
// "seeded everywhere" promise enforceable, so a future DEFAULTS addition can
// never drift again unnoticed.
import { assertEquals } from "jsr:@std/assert";
import { wipeDatabase } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { DEFAULTS, clearAppSettingsCache } from "../../../server/app-settings.tsx";

Deno.test("app_settings seed drift — every DEFAULTS key has a DB row", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
    clearAppSettingsCache();
  });

  await t.step("every code-side DEFAULTS key exists in app_settings", async () => {
    const rows = await query<{ key: string }>(`SELECT key FROM app_settings`);
    const dbKeys = new Set(rows.map((r) => r.key));
    const missing = Object.keys(DEFAULTS).filter((key) => !dbKeys.has(key));
    assertEquals(
      missing,
      [],
      `DEFAULTS keys missing from app_settings (add them to migrations/0NN + setup/sql/001_schema.sql): ${missing.join(", ")}`,
    );
  });

  await t.step("the email-delivery provider default is seeded as 'disabled'", async () => {
    // Regression pin for the exact bug this suite was added for: the email
    // config page PUTs email_delivery_provider first.
    const rows = await query<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = 'email_delivery_provider'`,
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0].value, DEFAULTS.email_delivery_provider.value);
  });
});
