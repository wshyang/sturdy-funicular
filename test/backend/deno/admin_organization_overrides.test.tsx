// Route tests for server/routes/admin/organization-overrides.tsx — the six
// endpoints behind /admin/organizations/:id/{settings,templates}.
//
// This module had NO test coverage at all despite being ~307 lines that
// govern per-organisation mail credentials, Slack credentials and AWS
// transport key material (addendum-137 §6). The rules worth pinning:
//
//   * The org-overridable ALLOWLIST is a security boundary. Platform-wide
//     keys must be rejected with 400 (loudly, never silently ignored), so an
//     org admin cannot re-point a global control from inside their own org.
//   * Secret values must be MASKED on read-back and recorded as "[hidden]"
//     in the audit log — an override write must never echo the plaintext.
//   * Reads are an effective view: org override wins over the global row,
//     which wins over the code default, and each row is labelled with its
//     provenance (`source`).
//   * DELETE is a soft revert — the global value applies again, and the key
//     stays re-overridable.
//
// Driven through the real Hono app, per the harness convention.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  createAdmin,
  createOrganization,
  loginAs,
  req,
  uniqueShortCode,
  wipeDatabase,
} from "./helpers.tsx";
import { query } from "../../../server/db/drizzle.ts";

// An allowlisted, non-secret key and an allowlisted secret key.
const OVERRIDABLE = "smtp_host";
const OVERRIDABLE_SECRET = "smtp_password";
const SECRET_MASK = "••••••••";

type SettingRow = {
  key: string;
  value: string;
  source: string;
  isSecret: boolean;
  orgUpdatedAt: string | null;
};

Deno.test("admin organization overrides — settings and templates", async (t) => {
  await wipeDatabase();

  const admin = await createAdmin("OrgOverrideAdmin!2026");
  const login = await loginAs(admin.email, "OrgOverrideAdmin!2026");
  assert("session" in login, `admin login failed: ${JSON.stringify(login)}`);
  const auth = { "X-Session-Token": login.session };
  const org = await createOrganization({
    name: `Override Org ${uniqueShortCode()}`,
    shortCode: uniqueShortCode(),
    createdBy: admin.id,
  });

  const getSettings = async (orgId = org.id) => {
    const res = await req(`/admin/organizations/${orgId}/settings`, { headers: auth });
    return { res, body: await res.json().catch(() => ({})) };
  };
  const putSetting = (key: string, body: unknown, orgId = org.id) =>
    req(`/admin/organizations/${orgId}/settings/${key}`, { method: "PUT", headers: auth, body });
  const delSetting = (key: string, orgId = org.id) =>
    req(`/admin/organizations/${orgId}/settings/${key}`, { method: "DELETE", headers: auth });

  // ── GET settings ─────────────────────────────────────────────────────────

  await t.step("GET settings: returns only org-overridable keys, all sourced 'global' initially", async () => {
    const { res, body } = await getSettings();
    assertEquals(res.status, 200);
    const settings = body.settings as SettingRow[];
    assert(Array.isArray(settings) && settings.length > 0, "expected a non-empty settings list");

    // Every returned key must be on the allowlist — this endpoint must never
    // leak platform-wide settings into the org surface.
    const keys = settings.map((s) => s.key);
    assert(keys.includes(OVERRIDABLE), `expected ${OVERRIDABLE} in ${keys.join(",")}`);
    for (const platformKey of ["session_ttl_ms", "max_login_attempts"]) {
      assertEquals(keys.includes(platformKey), false, `${platformKey} must not be org-overridable`);
    }
    // With no overrides written yet everything inherits.
    assertEquals(settings.every((s) => s.source === "global"), true);
    assertEquals(settings.every((s) => s.orgUpdatedAt === null), true);
  });

  await t.step("GET settings: 404 for an unknown organisation", async () => {
    const { res } = await getSettings("00000000-0000-7000-8000-0000000000ff");
    assertEquals(res.status, 404);
  });

  await t.step("negative: unauthenticated access is rejected", async () => {
    // These handlers resolve the user then requireAdmin(), which raises an
    // AuthorizationError -> 403 for an absent session (not a 401 challenge).
    const res = await req(`/admin/organizations/${org.id}/settings`);
    assertEquals(res.status, 403);
    const write = await req(`/admin/organizations/${org.id}/settings/${OVERRIDABLE}`, {
      method: "PUT",
      body: { value: "smtp.example.gov" },
    });
    assertEquals(write.status, 403);
  });

  // ── PUT settings ─────────────────────────────────────────────────────────

  await t.step("PUT: writes an override, and the read-back flips to source 'organization'", async () => {
    const res = await putSetting(OVERRIDABLE, { value: "smtp.agency.example" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.value, "smtp.agency.example");
    assertEquals(body.source, "organization");

    const { body: after } = await getSettings();
    const row = (after.settings as SettingRow[]).find((s) => s.key === OVERRIDABLE)!;
    assertEquals(row.value, "smtp.agency.example");
    assertEquals(row.source, "organization");
    assert(row.orgUpdatedAt !== null, "orgUpdatedAt must be stamped once overridden");
  });

  await t.step("PUT: a second write updates in place rather than stacking rows", async () => {
    const res = await putSetting(OVERRIDABLE, { value: "smtp2.agency.example" });
    assertEquals(res.status, 200);

    const live = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_settings
        WHERE organization_id = $1 AND key = $2 AND expires_after IS NULL`,
      [org.id, OVERRIDABLE],
    );
    assertEquals(live[0]!.n, "1", "exactly one live override row per (org, key)");

    const { body } = await getSettings();
    const row = (body.settings as SettingRow[]).find((s) => s.key === OVERRIDABLE)!;
    assertEquals(row.value, "smtp2.agency.example");
  });

  await t.step("PUT: a secret value is masked on the response AND on read-back", async () => {
    const res = await putSetting(OVERRIDABLE_SECRET, { value: "hunter2-super-secret" });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.value, SECRET_MASK, "the write response must not echo the plaintext");

    const { body: after } = await getSettings();
    const row = (after.settings as SettingRow[]).find((s) => s.key === OVERRIDABLE_SECRET)!;
    assertEquals(row.isSecret, true);
    assertEquals(row.value, SECRET_MASK);
    assert(!JSON.stringify(after).includes("hunter2"), "the plaintext secret must never be serialised");
  });

  await t.step("PUT: the secret's plaintext is stored but audited as [hidden]", async () => {
    const stored = await query<{ value: string }>(
      `SELECT value FROM app_settings
        WHERE organization_id = $1 AND key = $2 AND expires_after IS NULL`,
      [org.id, OVERRIDABLE_SECRET],
    );
    assertEquals(stored[0]!.value, "hunter2-super-secret", "the real value must still be usable by the mailer");

    const audit = await query<{ details: string }>(
      `SELECT details::text AS details FROM audit_log
        WHERE action = 'organization_setting.updated' AND target_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [org.id],
    );
    assert(audit.length > 0, "the override write must be audited");
    assert(!audit[0]!.details.includes("hunter2"), "the audit log must not contain the secret");
    assert(audit[0]!.details.includes("[hidden]"), audit[0]!.details);
  });

  await t.step("PUT: NEGATIVE — a platform-wide key is refused with 400, not silently ignored", async () => {
    // session_ttl_ms is a real DEFAULTS key that is deliberately NOT on the
    // org allowlist, so this exercises the allowlist branch (400) rather than
    // the unknown-key branch (404).
    const res = await putSetting("session_ttl_ms", { value: "60000" });
    assertEquals(res.status, 400);
    const body = await res.json();
    assert(String(body.error).includes("not org-overridable"), body.error);

    // And it must not have been written anywhere.
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_settings
        WHERE organization_id = $1 AND key = 'session_timeout_minutes'`,
      [org.id],
    );
    assertEquals(rows[0]!.n, "0");
  });

  await t.step("PUT: NEGATIVE — an entirely unknown key is 404", async () => {
    const res = await putSetting("totally_made_up_key", { value: "x" });
    assertEquals(res.status, 404);
  });

  await t.step("PUT: NEGATIVE — immutable fields are rejected loudly", async () => {
    for (const field of ["key", "valueType", "category", "organizationId"]) {
      const res = await putSetting(OVERRIDABLE, { value: "smtp.x.example", [field]: "tampered" });
      assertEquals(res.status, 400, `${field} must be rejected`);
      const body = await res.json();
      assert(String(body.error).includes("immutable"), body.error);
    }
  });

  await t.step("PUT: NEGATIVE — malformed PEM key material is rejected", async () => {
    const res = await putSetting("aws_encrypt_public_key_pem_b64", { value: "bm90LWEta2V5" });
    assertEquals(res.status, 400);
  });

  await t.step("PUT: NEGATIVE — unknown organisation is 404", async () => {
    const res = await putSetting(OVERRIDABLE, { value: "x" }, "00000000-0000-7000-8000-0000000000ff");
    assertEquals(res.status, 404);
  });

  // ── DELETE settings ──────────────────────────────────────────────────────

  await t.step("DELETE: reverts to the global value and is re-overridable", async () => {
    const res = await delSetting(OVERRIDABLE);
    assertEquals(res.status, 200);

    const { body } = await getSettings();
    const row = (body.settings as SettingRow[]).find((s) => s.key === OVERRIDABLE)!;
    assertEquals(row.source, "global", "the override must no longer win");
    assertEquals(row.orgUpdatedAt, null);

    // Soft-invalidated, not hard-deleted — the history is retained.
    const dead = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM app_settings
        WHERE organization_id = $1 AND key = $2 AND expires_after IS NOT NULL`,
      [org.id, OVERRIDABLE],
    );
    assertEquals(dead[0]!.n, "1");

    // And the key can be overridden again afterwards.
    const again = await putSetting(OVERRIDABLE, { value: "smtp3.agency.example" });
    assertEquals(again.status, 200);
    const { body: after } = await getSettings();
    const back = (after.settings as SettingRow[]).find((s) => s.key === OVERRIDABLE)!;
    assertEquals(back.source, "organization");
    assertEquals(back.value, "smtp3.agency.example");
  });

  await t.step("DELETE: NEGATIVE — 404 when no override exists, and on an unknown key", async () => {
    const noOverride = await delSetting("ses_region");
    assertEquals(noOverride.status, 404);
    const unknown = await delSetting("totally_made_up_key");
    assertEquals(unknown.status, 404);
  });

  // ── templates ────────────────────────────────────────────────────────────

  await t.step("GET templates: every seeded global trigger is listed, sourced 'global'", async () => {
    const res = await req(`/admin/organizations/${org.id}/templates`, { headers: auth });
    assertEquals(res.status, 200);
    const body = await res.json();
    const templates = body.templates as Array<{ triggerKey: string; source: string }>;
    assert(templates.length > 0, "expected the seeded notification templates");
    assertEquals(templates.every((tpl) => tpl.source === "global"), true);
  });

  await t.step("PUT template: overriding a seeded trigger flips its source to 'organization'", async () => {
    const list = await (await req(`/admin/organizations/${org.id}/templates`, { headers: auth })).json();
    const trigger = (list.templates as Array<{ triggerKey: string }>)[0]!.triggerKey;

    const res = await req(`/admin/organizations/${org.id}/templates/${trigger}`, {
      method: "PUT",
      headers: auth,
      body: {
        subject: "Org-specific subject",
        bodyHtml: "<p>Org body</p>",
        bodyText: "Org body",
        channels: ["email"],
        isActive: true,
      },
    });
    assertEquals(res.status, 200);

    const after = await (await req(`/admin/organizations/${org.id}/templates`, { headers: auth })).json();
    const row = (after.templates as Array<{ triggerKey: string; subject: string; source: string }>)
      .find((tpl) => tpl.triggerKey === trigger)!;
    assertEquals(row.source, "organization");
    assertEquals(row.subject, "Org-specific subject");

    // Reverting restores the global template.
    const del = await req(`/admin/organizations/${org.id}/templates/${trigger}`, {
      method: "DELETE",
      headers: auth,
    });
    assertEquals(del.status, 200);
    const reverted = await (await req(`/admin/organizations/${org.id}/templates`, { headers: auth })).json();
    const back = (reverted.templates as Array<{ triggerKey: string; source: string }>)
      .find((tpl) => tpl.triggerKey === trigger)!;
    assertEquals(back.source, "global");
  });

  await t.step("PUT template: NEGATIVE — an unknown trigger is 404", async () => {
    const res = await req(`/admin/organizations/${org.id}/templates/not.a.real.trigger`, {
      method: "PUT",
      headers: auth,
      body: { subject: "x", bodyHtml: "<p>x</p>", channels: ["email"], isActive: true },
    });
    assertEquals(res.status, 404);
  });
});
