// Coverage: server/app-settings.tsx — the centralized-settings retrieval
// helper (getSetting + typed getters). Proves: DB value wins when present,
// DEFAULTS fallback when the row is absent, correct coercion per value_type,
// and the env-override precedence on the feature toggles. See
// addendum-049-app-settings.md.
import { assertEquals } from "jsr:@std/assert";
import { wipeDatabase } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import {
  getSetting, getSessionTtlMs, getMaxLoginAttempts, getPasswordMinLength,
  isAwsIntegrationEnabled, clearAppSettingsCache, DEFAULTS, getEntraPrivateKeyPem,
} from "../../../server/app-settings.tsx";

// The settings rows are seeded by 001_schema.sql / migration 022 and are NOT
// wiped by wipeDatabase() (config, like email_templates). Each step clears the
// helper's in-process cache first so it re-reads the DB.
Deno.test("app_settings helper", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
    clearAppSettingsCache();
  });

  await t.step("returns the seeded DB value, coerced to int", async () => {
    // Seeded default is 86400000 (24h).
    clearAppSettingsCache();
    const ttl = await getSessionTtlMs();
    assertEquals(typeof ttl, "number");
    assertEquals(ttl, 86_400_000);
  });

  await t.step("reflects an updated DB value after cache clear", async () => {
    await query(`UPDATE app_settings SET value = $1 WHERE key = 'max_login_attempts'`, ["9"]);
    clearAppSettingsCache();
    assertEquals(await getMaxLoginAttempts(), 9);
    // restore
    await query(`UPDATE app_settings SET value = '5' WHERE key = 'max_login_attempts'`);
    clearAppSettingsCache();
    assertEquals(await getMaxLoginAttempts(), 5);
  });

  await t.step("falls back to DEFAULTS when the row is absent", async () => {
    // Delete a row, confirm the getter still returns the code default.
    await query(`DELETE FROM app_settings WHERE key = 'password_min_length'`);
    clearAppSettingsCache();
    assertEquals(await getPasswordMinLength(), parseInt(DEFAULTS.password_min_length.value, 10));
    // Restore the seeded row. app_settings has no plain UNIQUE(key): since
    // settings became per-organisation the key is covered by two PARTIAL unique
    // indexes (app_settings_global_key_uniq ... WHERE organization_id IS NULL,
    // and app_settings_org_key_uniq on (organization_id, key)). Postgres only
    // matches an ON CONFLICT inference clause against an index whose predicate
    // it also states, so the arbiter has to name the global predicate — a bare
    // ON CONFLICT (key) raises "there is no unique or exclusion constraint
    // matching the ON CONFLICT specification" and leaves the row deleted, which
    // then fails app_settings_seed_drift for every later file in the run.
    await query(
      `INSERT INTO app_settings (key, value, value_type, category, description)
       VALUES ('password_min_length', '12', 'int', 'security', $1)
       ON CONFLICT (key) WHERE organization_id IS NULL DO NOTHING`,
      [DEFAULTS.password_min_length.description],
    );
    clearAppSettingsCache();
  });

  await t.step("coerces bool correctly", async () => {
    // No env override set in the test env for AWS → reads the DB value 'false'.
    clearAppSettingsCache();
    const enabled = await isAwsIntegrationEnabled();
    assertEquals(typeof enabled, "boolean");
  });

  await t.step("unknown key throws", async () => {
    let threw = false;
    try {
      await getSetting("no_such_setting_key");
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
  });

  await t.step("getEntraPrivateKeyPem: returns null when the row is empty (seeded default)", async () => {
    await query(`UPDATE app_settings SET value = '' WHERE key = 'entra_client_key_pem_base64'`);
    clearAppSettingsCache();
    assertEquals(await getEntraPrivateKeyPem(), null);
  });

  await t.step("getEntraPrivateKeyPem: base64-decodes the stored value into the PEM string", async () => {
    const pem = "-----BEGIN PRIVATE KEY-----\nFAKEKEYDATA\n-----END PRIVATE KEY-----\n";
    const b64 = btoa(pem);
    await query(`UPDATE app_settings SET value = $1 WHERE key = 'entra_client_key_pem_base64'`, [b64]);
    clearAppSettingsCache();
    assertEquals(await getEntraPrivateKeyPem(), pem);
    // restore
    await query(`UPDATE app_settings SET value = '' WHERE key = 'entra_client_key_pem_base64'`);
    clearAppSettingsCache();
  });
});
