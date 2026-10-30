// Tests for the provider-configuration layer of server/app-settings.tsx —
// the `is*Configured()` predicates, the `get*()` normalising getters, and the
// environment-variable overrides on the feature toggles.
//
// Why these matter beyond the coverage number:
//   * `isSmtpConfigured()` / `isSesConfigured()` are the gates that decide
//     whether mail is attempted at all. They AND together several settings, so
//     a single missing field must make the whole provider read as
//     unconfigured — otherwise the app tries to send and fails at the socket
//     rather than degrading cleanly.
//   * The getters normalise "" to null. That distinction is the whole contract:
//     a seeded-but-empty row means "not configured", and callers branch on
//     null, not on falsiness of a string they then pass to a client.
//   * The toggles let an environment variable override the database. The
//     precedence rule is specific — env wins only when SET AND NON-EMPTY — and
//     an empty env var must fall through to the DB rather than reading as
//     "false". That is easy to regress and impossible to notice in staging.
//
// Every read goes through getSetting()'s cache, so each step that changes a
// row clears the cache first; that is also what makes the cache behaviour
// itself observable.
import { assert, assertEquals } from "jsr:@std/assert";
import { wipeDatabase } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import {
  clearAppSettingsCache,
  getEmailDeliveryProvider,
  getSesConfigurationSet,
  getSesFromAddress,
  getSesRegion,
  getSmtpFrom,
  getSmtpHost,
  getSmtpPassword,
  getSmtpPort,
  getSmtpSecure,
  getSmtpUsername,
  isAwsIntegrationEnabled,
  isEmailDeliveryEnabled,
  isSesConfigured,
  isSlackIntegrationEnabled,
  isSmtpConfigured,
} from "../../../server/app-settings.tsx";

// app_settings is deliberately NOT cleared by wipeDatabase() (see the note in
// helpers.tsx): its seed rows outlive every wipe. A file that mutates them must
// restore the exact keys it touched, or it leaks state into whichever file the
// runner reaches next. So: snapshot before, restore after, in a finally.
const TOUCHED_KEYS = [
  "smtp_host", "smtp_port", "smtp_username", "smtp_password", "smtp_from", "smtp_secure",
  "ses_region", "ses_from_address", "ses_configuration_set",
  "email_delivery_enabled", "email_delivery_provider",
  "aws_integration_enabled", "slack_integration_enabled",
] as const;

async function snapshotSettings(): Promise<Map<string, string>> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE organization_id IS NULL AND key = ANY($1)`,
    [[...TOUCHED_KEYS]],
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

async function restoreSettings(snap: Map<string, string>): Promise<void> {
  for (const [key, value] of snap) {
    await query(
      `UPDATE app_settings SET value = $2 WHERE key = $1 AND organization_id IS NULL`,
      [key, value],
    );
  }
  clearAppSettingsCache();
}

// Write a global (organization_id IS NULL) setting row and drop the cache.
async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `UPDATE app_settings SET value = $2 WHERE key = $1 AND organization_id IS NULL`,
    [key, value],
  );
  clearAppSettingsCache();
}

// Put every key this file touches into a known-empty baseline, so the
// "unconfigured out of the box" assertions do not depend on whatever a
// previously-run file happened to leave behind.
async function blankTouchedSettings(): Promise<void> {
  for (const key of TOUCHED_KEYS) await setSetting(key, "");
}

const SMTP_KEYS = ["smtp_host", "smtp_port", "smtp_username", "smtp_password", "smtp_from"] as const;

async function configureSmtp(): Promise<void> {
  await setSetting("smtp_host", "smtp.example.gov");
  await setSetting("smtp_port", "587");
  await setSetting("smtp_username", "mailer");
  await setSetting("smtp_password", "s3cret");
  await setSetting("smtp_from", "noreply@example.gov");
}

// Restore an env var to whatever it was (including "absent").
function restoreEnv(name: string, previous: string | undefined): void {
  if (previous === undefined) Deno.env.delete(name);
  else Deno.env.set(name, previous);
}

Deno.test("app settings — provider configuration predicates", async (t) => {
  await wipeDatabase();
  clearAppSettingsCache();
  const snap = await snapshotSettings();
  try {
  await blankTouchedSettings();

  await t.step("SMTP: unconfigured when no fields are set", async () => {
    assertEquals(await isSmtpConfigured(), false);
    // …and each getter reports null rather than "".
    assertEquals(await getSmtpHost(), null);
    assertEquals(await getSmtpPort(), null);
    assertEquals(await getSmtpUsername(), null);
    assertEquals(await getSmtpPassword(), null);
    assertEquals(await getSmtpFrom(), null);
  });

  await t.step("SMTP: configured only once EVERY field is present", async () => {
    await configureSmtp();
    assertEquals(await isSmtpConfigured(), true);
    assertEquals(await getSmtpHost(), "smtp.example.gov");
    // NB: smtp_port is declared `int` in DEFAULTS, so getSetting coerces it and
    // the getter yields a NUMBER despite its `Promise<string | null>` signature.
    // Pinned because the annotation is misleading and a caller string-comparing
    // this value would silently never match.
    assertEquals(await getSmtpPort(), 587 as unknown as string);
  });

  await t.step("SMTP: NEGATIVE — clearing any single field un-configures the provider", async () => {
    // The property worth pinning: the predicate is an AND across all five, so
    // a half-finished configuration must never read as ready.
    for (const key of SMTP_KEYS) {
      await configureSmtp();
      assertEquals(await isSmtpConfigured(), true, `precondition for ${key}`);

      await setSetting(key, "");
      assertEquals(await isSmtpConfigured(), false, `${key} empty must un-configure SMTP`);
    }
    await configureSmtp();
  });

  await t.step("SMTP: smtp_secure is independent of the readiness gate", async () => {
    // It is a transport flag, not a credential — clearing it must NOT flip the
    // provider to unconfigured.
    await setSetting("smtp_secure", "");
    assertEquals(await getSmtpSecure(), null);
    assertEquals(await isSmtpConfigured(), true);

    // Also `bool`-typed, so this is the boolean true, not the string "true".
    await setSetting("smtp_secure", "true");
    assertEquals(await getSmtpSecure(), true as unknown as string);

    // LIMIT worth recording: the getter is `coerce(...) || null`, and the
    // coercion is a strict `raw === "true"`. So a bool setting can only ever
    // read back as `true` or `null` — an explicit "false" is indistinguishable
    // from "unset", and "TRUE" is not recognised. Anything that needs to tell
    // "disabled" from "unconfigured" cannot use this getter.
    for (const raw of ["false", "TRUE", "1", "yes"]) {
      await setSetting("smtp_secure", raw);
      assertEquals(await getSmtpSecure(), null, `smtp_secure=${raw}`);
    }
    await setSetting("smtp_secure", "true");
  });

  await t.step("SES: needs both region and from-address", async () => {
    assertEquals(await isSesConfigured(), false);

    await setSetting("ses_region", "ap-southeast-1");
    assertEquals(await isSesConfigured(), false, "region alone is not enough");

    await setSetting("ses_from_address", "noreply@example.gov");
    assertEquals(await isSesConfigured(), true);
    assertEquals(await getSesRegion(), "ap-southeast-1");
    assertEquals(await getSesFromAddress(), "noreply@example.gov");

    // The configuration set is optional and must not gate readiness.
    assertEquals(await getSesConfigurationSet(), null);
    assertEquals(await isSesConfigured(), true);

    await setSetting("ses_configuration_set", "primary");
    assertEquals(await getSesConfigurationSet(), "primary");
  });

  await t.step("SES: NEGATIVE — clearing either required field un-configures it", async () => {
    await setSetting("ses_region", "");
    assertEquals(await isSesConfigured(), false);

    await setSetting("ses_region", "ap-southeast-1");
    await setSetting("ses_from_address", "");
    assertEquals(await isSesConfigured(), false);

    await setSetting("ses_from_address", "noreply@example.gov");
    assertEquals(await isSesConfigured(), true);
  });

  await t.step("getters: whitespace is NOT trimmed — only the empty string means null", async () => {
    // Honest boundary. A value of " " is truthy, so it configures the
    // provider and is handed to the mail client as-is. Worth knowing: these
    // getters normalise emptiness, they do not sanitise.
    await setSetting("ses_configuration_set", " ");
    assertEquals(await getSesConfigurationSet(), " ");
  });
  } finally {
    await restoreSettings(snap);
  }
});

Deno.test("app settings — environment overrides on the feature toggles", async (t) => {
  await wipeDatabase();
  clearAppSettingsCache();
  const snap = await snapshotSettings();
  try {

  const cases: Array<{
    name: string;
    env: string;
    key: string;
    read: () => Promise<boolean>;
  }> = [
    { name: "email delivery", env: "EMAIL_DELIVERY_ENABLED", key: "email_delivery_enabled", read: isEmailDeliveryEnabled },
    { name: "AWS integration", env: "AWS_INTEGRATION_ENABLED", key: "aws_integration_enabled", read: isAwsIntegrationEnabled },
    { name: "Slack integration", env: "SLACK_INTEGRATION_ENABLED", key: "slack_integration_enabled", read: isSlackIntegrationEnabled },
  ];

  for (const { name, env, key, read } of cases) {
    await t.step(`${name}: env absent → the database value is used`, async () => {
      const prev = Deno.env.get(env);
      try {
        Deno.env.delete(env);
        await setSetting(key, "true");
        assertEquals(await read(), true);
        await setSetting(key, "false");
        assertEquals(await read(), false);
      } finally {
        restoreEnv(env, prev);
        clearAppSettingsCache();
      }
    });

    await t.step(`${name}: a non-empty env var OVERRIDES the database`, async () => {
      const prev = Deno.env.get(env);
      try {
        await setSetting(key, "false");
        Deno.env.set(env, "true");
        assertEquals(await read(), true, "env 'true' must win over DB 'false'");

        await setSetting(key, "true");
        Deno.env.set(env, "false");
        assertEquals(await read(), false, "env 'false' must win over DB 'true'");
      } finally {
        restoreEnv(env, prev);
        clearAppSettingsCache();
      }
    });

    await t.step(`${name}: an EMPTY env var falls through to the database`, async () => {
      // The subtle branch: `env !== undefined && env !== ""`. An empty value
      // must NOT be read as "false" — it means "unset", and the DB decides.
      const prev = Deno.env.get(env);
      try {
        Deno.env.set(env, "");
        await setSetting(key, "true");
        assertEquals(await read(), true, "empty env must not force false");
      } finally {
        restoreEnv(env, prev);
        clearAppSettingsCache();
      }
    });

    await t.step(`${name}: any env value other than 'true' reads as false`, async () => {
      const prev = Deno.env.get(env);
      try {
        await setSetting(key, "true");
        for (const raw of ["1", "TRUE", "yes", "on", "garbage"]) {
          Deno.env.set(env, raw);
          assertEquals(await read(), false, `env=${raw} must not enable the toggle`);
        }
      } finally {
        restoreEnv(env, prev);
        clearAppSettingsCache();
      }
    });
  }

  await t.step("email provider: env overrides, empty falls through, value passes verbatim", async () => {
    const prev = Deno.env.get("EMAIL_DELIVERY_PROVIDER");
    try {
      Deno.env.delete("EMAIL_DELIVERY_PROVIDER");
      await setSetting("email_delivery_provider", "smtp");
      assertEquals(await getEmailDeliveryProvider(), "smtp");

      // Unlike the booleans this is a free-form string: it is returned as-is,
      // with no allowlist check at this layer.
      Deno.env.set("EMAIL_DELIVERY_PROVIDER", "ses");
      assertEquals(await getEmailDeliveryProvider(), "ses");

      Deno.env.set("EMAIL_DELIVERY_PROVIDER", "not-a-real-provider");
      assertEquals(await getEmailDeliveryProvider(), "not-a-real-provider");

      Deno.env.set("EMAIL_DELIVERY_PROVIDER", "");
      assertEquals(await getEmailDeliveryProvider(), "smtp", "empty env falls through to the DB");
    } finally {
      restoreEnv("EMAIL_DELIVERY_PROVIDER", prev);
      clearAppSettingsCache();
    }
  });
  } finally {
    await restoreSettings(snap);
  }
});

Deno.test("app settings — the read cache", async (t) => {
  await wipeDatabase();
  clearAppSettingsCache();
  const snap = await snapshotSettings();
  try {

  await t.step("a write is invisible until the cache is cleared", async () => {
    await setSetting("smtp_host", "first.example.gov");
    assertEquals(await getSmtpHost(), "first.example.gov");

    // Write directly, deliberately WITHOUT clearing — the stale value must
    // still be served, which is what makes clearAppSettingsCache() load-bearing
    // on every settings-mutating route.
    await query(
      `UPDATE app_settings SET value = $1 WHERE key = 'smtp_host' AND organization_id IS NULL`,
      ["second.example.gov"],
    );
    assertEquals(await getSmtpHost(), "first.example.gov", "cached value is served");

    clearAppSettingsCache();
    assertEquals(await getSmtpHost(), "second.example.gov", "cleared cache re-reads");
  });

  await t.step("the cache stores the coerced value, including null-normalisation", async () => {
    await setSetting("smtp_host", "");
    assertEquals(await getSmtpHost(), null);
    assertEquals(await getSmtpHost(), null, "second read comes from the cache");
    assert(!(await isSmtpConfigured()), "and the predicate agrees");
  });
  } finally {
    await restoreSettings(snap);
  }
});
