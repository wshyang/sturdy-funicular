// Coverage: GET /admin/app-settings, PUT /admin/app-settings/:key
// (server/routes-admin-app-settings.tsx). Admin-only; update validates
// type/bounds, rejects immutable-field changes + unknown keys, audits the
// change, and the helper cache reflects the new value. See
// addendum-049-app-settings.md.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { getMaxLoginAttempts, clearAppSettingsCache, DEFAULTS } from "../../../server/app-settings.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";

Deno.test("admin_app_settings", async (t) => {
  let adminSession: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AppSettingsAdmin!2026");
    adminSession = (await loginAs(admin.email, "AppSettingsAdmin!2026") as any).session;
    assertExists(adminSession);
    // Restore any rows a prior run may have mutated to a known baseline.
    await query(`UPDATE app_settings SET value = '5' WHERE key = 'max_login_attempts'`);
    clearAppSettingsCache();
  });

  await t.step("list: positive — admin gets all settings", async () => {
    const res = await req("/admin/app-settings", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.settings);
    assertEquals(Array.isArray(data.settings), true);
    // A representative known key is present with its metadata.
    const row = data.settings.find((s: any) => s.key === "max_login_attempts");
    assertExists(row);
    assertEquals(row.valueType, "int");
    assertEquals(row.category, "security");
  });

  await t.step("list: negative — non-admin forbidden (403)", async () => {
    const vendor = await createActiveUser({
      fullName: "Settings Vendor", email: uniqueEmail("setv"), password: "SetVendor!2026", affiliation: "vendor",
    });
    const vSession = (await loginAs(vendor.email, "SetVendor!2026") as any).session;
    const res = await req("/admin/app-settings", { headers: authHeaders(vSession) });
    assertEquals(res.status, 403);
  });

  await t.step("update: positive — persists, audits, and the helper reflects the new value", async () => {
    const res = await req("/admin/app-settings/max_login_attempts", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "8" },
    });
    assertEquals(res.status, 200);

    // Persisted…
    const rows = await query<{ value: string; updated_by: string | null }>(
      `SELECT value, updated_by FROM app_settings WHERE key = 'max_login_attempts'`,
    );
    assertEquals(rows[0].value, "8");
    assertExists(rows[0].updated_by);

    // …audited…
    const audit = await query<{ action: string; target_id: string }>(
      `SELECT action, target_id FROM audit_log WHERE action = 'app_setting.updated' AND target_id = 'max_login_attempts' ORDER BY created_at DESC LIMIT 1`,
    );
    assertEquals(audit[0].target_id, "max_login_attempts");

    // …and the helper cache was cleared, so getter returns the new value.
    assertEquals(await getMaxLoginAttempts(), 8);

    // restore baseline
    await req("/admin/app-settings/max_login_attempts", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "5" },
    });
  });

  await t.step("update: negative — type/bound violation (below minimum) rejected 400", async () => {
    // password_min_length has a floor of 8.
    const res = await req("/admin/app-settings/password_min_length", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "4" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: negative — non-integer value for an int setting rejected 400", async () => {
    const res = await req("/admin/app-settings/max_login_attempts", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "not-a-number" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: negative — inactivity timeout below 60s floor rejected 400", async () => {
    const res = await req("/admin/app-settings/session_inactivity_timeout_ms", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "5000" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: negative — immutable field (value_type) rejected 400", async () => {
    const res = await req("/admin/app-settings/max_login_attempts", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "6", valueType: "string" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: negative — unknown key rejected 404", async () => {
    const res = await req("/admin/app-settings/no_such_key", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "1" },
    });
    assertEquals(res.status, 404);
  });

  await t.step("update: negative — non-admin forbidden (403)", async () => {
    const vendor = await createActiveUser({
      fullName: "Settings Vendor 2", email: uniqueEmail("setv2"), password: "SetVendor2!2026", affiliation: "vendor",
    });
    const vSession = (await loginAs(vendor.email, "SetVendor2!2026") as any).session;
    const res = await req("/admin/app-settings/max_login_attempts", {
      method: "PUT", headers: authHeaders(vSession), body: { value: "3" },
    });
    assertEquals(res.status, 403);
  });

  // ── is_secret masking + clear (entra_client_key_pem_base64) ─────────────
  // addendum-054-entra-key-in-db-and-dynamic-redirect.md

  await t.step("secret: list — unset secret row returns '' unchanged (not masked)", async () => {
    await query(`UPDATE app_settings SET value = '' WHERE key = 'entra_client_key_pem_base64'`);
    clearAppSettingsCache();
    const res = await req("/admin/app-settings", { headers: authHeaders(adminSession) });
    const data = await res.json();
    const row = data.settings.find((s: any) => s.key === "entra_client_key_pem_base64");
    assertExists(row);
    assertEquals(row.isSecret, true);
    assertEquals(row.value, "");
  });

  await t.step("secret: update — a new base64 value persists (verified via DB, not GET, since GET masks it)", async () => {
    // Real RSA-2048 private key (PKCS#8 PEM, base64-encoded) required by the
    // entra_client_key_pem_base64 validator added in 0836a10.
    const FAKE_RSA_B64 = "LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0tCk1JSUV2UUlCQURBTkJna3Foa2lHOXcwQkFRRUZBQVNDQktjd2dnU2pBZ0VBQW9JQkFRQ1MzS21VZ0lQaVp5OE0KbGMzbjdaazh5Kzh1aFNFVk5XdCsyeFZFOXVnQkpDQnFNV0k0S2tSSk1EWG9Zb2k3TzFNeHZsRW9pcFNBdGZJKwpwVm9kTmdBVll1dnRVWU90VmJFR0xRb1JTZzA5MzJHRVE1L21EQmF2K3MrN3lmYkZJQnp1R1JDV2cyNURtbGdVClBFcE1Wd3k1VDN2S005dmg5VTFjQ0I2OEVIeE1CVDQ3V21hQnpRdXFUWGhhUk9ycmpkM1BxaXFmbkowZC9nRXUKcWUzK0VFY09oa2RlRjFxUlF2SWE5cW1ZZ3Qremh2NWM3aVV4QlJ3WU0yZXdranJoUkZxRzQvVXRsbFhDVjFXTwpaT1hHcDJXd2U1bUdVT29ESmN3Y012RGQ1eWhqc09YK1NnNWhlMHBFeUZ4Um5HQzBwL3F4VVduV2RCSHRsUFhUCkZkQU1ZbG03QWdNQkFBRUNnZ0VBTGs5N0FpTU1jNFpLSmRQUFhFVm1QdStuK3Fsc1p6MnpLZ3QzeDRsOFcyL0MKOFBtbG1VUnF5QkYxemxQVC9nYVZFMmlLT3hpSC81WmdUelRoRjdrQmlienAzS29KdGMwQng0cklVKzlnQVpUQgpNVzRKckFjLzJEcGs2emlpb2tLZ0hNeTJtRi9WazJmR1FvdEllbzR3cXZiUGVGR21FcmpCcmpXNVMyQi9jWkR6CktlU2dZWmQzSkVSMGpLOTZWYVprakpRNXVhcjhsak1idUR3UGUzYmhPeDBzbVpTZTBlRkE1ZXFLV0NKRHc0QlEKZFAxcURramNDY3FRN0JMZXhVbG1CQmwvZTBCZTNsRmwwMlBiMDEyaGZQcktVT3BZdDlBY1ZMRldiM1FncHBXbApYT25VQUV1SXlLc2owSmppMDlqMmJNbHoxYzJiQ2svK3laSVNtUktZUVFLQmdRRE9iWE5nWkd4ZDd6NTIwdUxSCitTWFN0U05mZXRnWmVOYkdRL0s4cDIrb3EyN3BsSklqQXppbzU5N0F3eWlNbFIxc0NyalVEZGlTdDl3SjBIajgKWG5YbEJBdGJPM0tpZWV3dnM0MWVHQkRLTUxBdlNBRTRhUVhiYnprOHRwRzNVQmRvZjF5SzUzTFByRFBtaU12YgpRcm5vUkk0bzVHQStXYmRLQjVuVFB3T1dDd0tCZ1FDMklVd3ptVlF1MWlTR2UycWgxdXdFYlZiNVdhMmVkalZhClZ2WFQwWlRLMjdjMzJPcFJuS2dSZDFTbmtWYUN0dWJJN3c5eW93MFgyV2kvK2ZkZHhtcFR2Ny9CMlYzRmUrWE8Kbk1KN0lYT3dXaWh0MXVSc0xqZ3JGYzF4RFp3L1VjNVBwN2VxaTVxMldjMFFvYUwzbVYvVjJtVEJFUHFSLzh3MwpRamhmM1AwSkVRS0JnQXpwTlpVcTBzaFJSV1BqTHNLWlJhOVhHdjVHemF0U0xvUzZEVDJWYjF0cVZZYVFmMDluClRTenJTN2hjdkhXR2dnK1c0QmFMUXlkeURuWWlydDZCL2ZleitBM2R1djdFaDJ3NFc3Z3Q0eWJ5UXFMQ2F5a2YKRUhtNERDbHE5ZFEwVXpKNi9NdkhUQndIRmp2dUJHb1RVMU5lcmxHS2J5YVhMK3FXYlIyVVRHSWZBb0dBQzNNYwpiMEg0WU5WbGhtN0x6VkRObFptcUZoTGxMMGtQSVpiRjdZTUhiNWxRYzFwWG9MblFkd2loY2NkWlFPNXVvOE1qCm5YbFNvV1V4aUtBV1JQYnNTRWVOcm9vVHN3Nk82K1krODY2dXJ5OTd5eXZ2UUQzSG1pM010SWErZzl5SXM4ay8KYXFGTUlKcVVvYThIcDdra3BUVU5rSFdZeXdUaHViZVlBNjdJMllFQ2dZRUF6SkNtY2hxa3FzcG1nSERESlk1ZwpRTUxqZlJkNVBibnkxbGJJcS9lS0dtQi8zYk1KdnVCWVBaUTR6VGxMZU9PdSszTW5NQnlneisrZ3pGSEhteTNFClZtUzZJdGN5c1VMUzBLSjZ3ZllrMDJDNnFoSzl2eHh2NEM5NGJPVkk2dVdQOXhBVzgyNUVjM3BHZHZmNlNWa3EKbmcvSjVEUUpRd0pVejMzdmd4V1dIZmc9Ci0tLS0tRU5EIFBSSVZBVEUgS0VZLS0tLS0K";
    const res = await req("/admin/app-settings/entra_client_key_pem_base64", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: FAKE_RSA_B64 },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    // The PUT response itself must never echo the real value back either.
    assertEquals(body.value, "••••••••");

    const rows = await query<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = 'entra_client_key_pem_base64'`,
    );
    assertEquals(rows[0].value, FAKE_RSA_B64);
  });

  await t.step("secret: list — now-set secret row is masked, not the real value", async () => {
    const res = await req("/admin/app-settings", { headers: authHeaders(adminSession) });
    const data = await res.json();
    const row = data.settings.find((s: any) => s.key === "entra_client_key_pem_base64");
    assertEquals(row.value, "••••••••");
  });

  await t.step("secret: audit log records '[hidden]', not the real base64, for old_value/new_value", async () => {
    const audit = await query<{ details: any }>(
      `SELECT details FROM audit_log WHERE action = 'app_setting.updated' AND target_id = 'entra_client_key_pem_base64' ORDER BY created_at DESC LIMIT 1`,
    );
    assertExists(audit[0]);
    const details = typeof audit[0].details === "string" ? JSON.parse(audit[0].details) : audit[0].details;
    assertEquals(details.oldValue, "[hidden]");
    assertEquals(details.newValue, "[hidden]");
  });

  await t.step("secret: update with clear:true blanks the value regardless of body.value", async () => {
    const res = await req("/admin/app-settings/entra_client_key_pem_base64", {
      method: "PUT", headers: authHeaders(adminSession), body: { value: "ignored-value", clear: true },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.value, "");

    const rows = await query<{ value: string }>(
      `SELECT value FROM app_settings WHERE key = 'entra_client_key_pem_base64'`,
    );
    assertEquals(rows[0].value, "");
    clearAppSettingsCache();
  });

  // ── Bulk transfer (addendum-097) ──────────────────────────────────────────
  // GET /admin/app-settings/export + POST /admin/app-settings/import are
  // gated on the NEW ConfigAppSettingsBulkTransfer capability (the export
  // reveals plaintext secrets, which masked read/write never does).

  await t.step("bulk export: positive — full registry incl. plaintext secrets, sorted, audited", async () => {
    // Known plaintext in a secret row, so the export provably carries what
    // GET /admin/app-settings masks.
    await query(`UPDATE app_settings SET value = 'c2VjcmV0LXVuaXQtdGVzdA==' WHERE key = 'slack_client_secret'`);
    clearAppSettingsCache();

    const res = await req("/admin/app-settings/export", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.version, 1);
    assertExists(body.exportedAt);
    // Every registered key is exported, sorted ascending.
    assertEquals(body.settings.length, Object.keys(DEFAULTS).length);
    const keys = body.settings.map((s: any) => s.key);
    const sorted = [...keys].sort();
    assertEquals(keys, sorted);
    // The secret is PLAINTEXT (the masked GET would have shown "••••••••").
    const secretRow = body.settings.find((s: any) => s.key === "slack_client_secret");
    assertEquals(secretRow.value, "c2VjcmV0LXVuaXQtdGVzdA==");

    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'app_setting.bulk_exported' ORDER BY created_at DESC LIMIT 1`,
    );
    assertExists(audit[0]);

    await query(`UPDATE app_settings SET value = '' WHERE key = 'slack_client_secret'`);
    clearAppSettingsCache();
  });

  await t.step("bulk export: negative — non-admin forbidden (403)", async () => {
    const vendor = await createActiveUser({
      fullName: "Export Vendor", email: uniqueEmail("expv"), password: "ExpVendor!2026", affiliation: "vendor",
    });
    const vSession = (await loginAs(vendor.email, "ExpVendor!2026") as any).session;
    const res = await req("/admin/app-settings/export", { headers: authHeaders(vSession) });
    assertEquals(res.status, 403);
  });

  await t.step("bulk export: negative — read/write settings capability WITHOUT bulk-transfer is 403", async () => {
    // config_audit_admin can read+write app settings but deliberately does
    // NOT hold ConfigAppSettingsBulkTransfer (secrets disclosure boundary).
    const limited = await createActiveUser({
      fullName: "Limited Settings Admin", email: uniqueEmail("limset"), password: "LimSettings!2026", affiliation: "agency",
    });
    await grantAdminRole(limited.id, "config_audit_admin", limited.id, "Test grant: settings admin without bulk-transfer");
    const limSession = (await loginAs(limited.email, "LimSettings!2026") as any).session;
    const resExport = await req("/admin/app-settings/export", { headers: authHeaders(limSession) });
    assertEquals(resExport.status, 403);
    const resImport = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(limSession), body: { settings: [{ key: "max_login_attempts", value: "7" }] },
    });
    assertEquals(resImport.status, 403);
  });

  await t.step("bulk import: positive — whole batch applied, audited, helpers reflect new values", async () => {
    const before = await query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings WHERE key IN ('max_login_attempts', 'password_min_length')`,
    );
    const res = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { version: 1, settings: [
        { key: "max_login_attempts", value: "9" },
        { key: "password_min_length", value: "10" },
      ] },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.appliedCount, 2);

    const rows = await query<{ key: string; value: string }>(
      `SELECT key, value FROM app_settings WHERE key IN ('max_login_attempts', 'password_min_length')`,
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    assertEquals(byKey.max_login_attempts, "9");
    assertEquals(byKey.password_min_length, "10");
    assertEquals(await getMaxLoginAttempts(), 9);

    const audit = await query<{ action: string; details: any }>(
      `SELECT action, details FROM audit_log WHERE action = 'app_setting.bulk_imported' ORDER BY created_at DESC LIMIT 1`,
    );
    assertExists(audit[0]);
    const details = typeof audit[0].details === "string" ? JSON.parse(audit[0].details) : audit[0].details;
    assertEquals(details.appliedCount, 2);

    // Restore baseline for hygiene.
    const restore: [string, string][] = before.map((r) => [r.key, r.value]);
    await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { version: 1, settings: restore.map(([key, value]) => ({ key, value })) },
    });
  });

  await t.step("bulk import: negative — one unknown key rejects the WHOLE batch (nothing applied)", async () => {
    const before = await query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'max_login_attempts'`);
    const res = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { version: 1, settings: [
        { key: "max_login_attempts", value: "7" },
        { key: "nonsense_key_xyz", value: "1" },
      ] },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertExists(body.failures);
    assertEquals(body.failures.length, 1);
    assertEquals(body.failures[0].key, "nonsense_key_xyz");
    // Atomicity: the VALID entry in the same batch must NOT have been applied.
    const after = await query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'max_login_attempts'`);
    assertEquals(after[0].value, before[0].value);
  });

  await t.step("bulk import: negative — bound violation in one entry rejects the whole batch", async () => {
    const before = await query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'max_login_attempts'`);
    const res = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { version: 1, settings: [
        { key: "max_login_attempts", value: "7" },
        { key: "password_min_length", value: "4" }, // floor is 8
      ] },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.failures.length, 1);
    assertEquals(body.failures[0].key, "password_min_length");
    const after = await query<{ value: string }>(`SELECT value FROM app_settings WHERE key = 'max_login_attempts'`);
    assertEquals(after[0].value, before[0].value);
  });

  await t.step("bulk import: negative — malformed PEM key material rejected with a per-key failure", async () => {
    const res = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { version: 1, settings: [{ key: "aws_encrypt_private_key_pem_b64", value: "bm90LWEtcmVhbC1rZXk=" }] },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.failures.length, 1);
    assertEquals(body.failures[0].key, "aws_encrypt_private_key_pem_b64");
  });

  await t.step("bulk import: negative — duplicate keys rejected 400", async () => {
    const res = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { version: 1, settings: [
        { key: "max_login_attempts", value: "6" },
        { key: "max_login_attempts", value: "7" },
      ] },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.failures.some((f: any) => f.key === "max_login_attempts" && f.error.includes("Duplicate")), true);
  });

  await t.step("bulk import: negative — empty settings array rejected 400 (schema)", async () => {
    const res = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(adminSession), body: { version: 1, settings: [] },
    });
    assertEquals(res.status, 400);
  });

  await t.step("bulk import: negative — non-admin forbidden (403)", async () => {
    const vendor = await createActiveUser({
      fullName: "Import Vendor", email: uniqueEmail("impv"), password: "ImpVendor!2026", affiliation: "vendor",
    });
    const vSession = (await loginAs(vendor.email, "ImpVendor!2026") as any).session;
    const res = await req("/admin/app-settings/import", {
      method: "POST", headers: authHeaders(vSession), body: { settings: [{ key: "max_login_attempts", value: "7" }] },
    });
    assertEquals(res.status, 403);
  });

  await t.step("runtime-info: admin reads deployment mode; non-admin forbidden", async () => {
    const res = await req("/admin/runtime-info", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    // .env.test pins BREAKGLASS_DEV=DEV for the whole suite.
    assertEquals(body.breakglassDevMode, "DEV");
    assertEquals(body.demoControlsEnabled, true);

    const vendor = await createActiveUser({
      fullName: "Runtime Vendor", email: uniqueEmail("rtv"), password: "RtVendor!2026", affiliation: "vendor",
    });
    const vSession = (await loginAs(vendor.email, "RtVendor!2026") as any).session;
    const denied = await req("/admin/runtime-info", { headers: authHeaders(vSession) });
    assertEquals(denied.status, 403);
  });
});
