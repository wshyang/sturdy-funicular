// Org-scoped settings/templates overrides — the addendum-137 §6 data plane
// (migrations/068), covering:
//   * provenance view semantics (source flags: 'organization' vs 'global') —
//     the data behind the owner-directed per-field inheritance indicators;
//   * the ORG_OVERRIDABLE_SETTINGS allowlist (platform keys 400, never
//     silently applied);
//   * scoped-capability enforcement of the four siblings
//     (OrgAppSettingsRead/Write, OrgTemplateRead/Write): global reach,
//     in-scope reach, out-of-scope 404-disguise, capability-absent 403;
//   * secrets discipline parity with the global route (masked GET, [hidden]
//     audit) + phase-3 attribution on the override audit rows;
//   * resolution chain getOrgSetting: org live row → global row → code
//     default (incl. explicit-empty org override winning over a global value);
//   * template override create/update/revert round-trip.
import { assert, assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import {
  addOrgMembership,
  createActiveUser,
  createOrganization,
  loginAs,
  uniqueEmail,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { getOrgSetting } from "../../../server/app-settings.tsx";
import type { User } from "../../../server/types.tsx";

const runSuffix = crypto.randomUUID().slice(0, 8);

async function grantScoped(userId: string, roleKey: string, organizationId: string, grantedBy: string): Promise<void> {
  await query(
    `INSERT INTO user_admin_role_grants (user_id, role_key, granted_by, organization_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, roleKey, grantedBy, organizationId],
  );
}

async function agencyUserWithSession(label: string, password: string): Promise<{ user: User; session: string }> {
  const user = await createActiveUser({
    fullName: label,
    email: uniqueEmail(label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    password,
    affiliation: "agency",
  });
  const login = await loginAs(user.email, password);
  if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
  return { user, session: login.session };
}

defineTest(
  "org-scoped settings/templates overrides (addendum-137 §6): allowlist, scoping, provenance, secrets, resolution, revert",
  async ({ ctx, t }) => {
    let orgA = "";
    let orgB = "";
    let scopedSession = "";
    let grantlessSession = "";

    await t.step("setup: two orgs + a scoped config_audit_admin (Org A) + a grantless agency user", async () => {
      orgA = (await createOrganization({ name: `OvR Org A ${runSuffix}`, shortCode: "OVA", createdBy: ctx.admin.id })).id;
      orgB = (await createOrganization({ name: `OvR Org B ${runSuffix}`, shortCode: "OVB", createdBy: ctx.admin.id })).id;

      const scoped = await agencyUserWithSession("OvR Scoped Admin", "OvRScoped!2026");
      await addOrgMembership({ organizationId: orgA, userId: scoped.user.id, addedBy: ctx.admin.id });
      await grantScoped(scoped.user.id, "config_audit_admin", orgA, ctx.admin.id);
      scopedSession = scoped.session;

      const grantless = await agencyUserWithSession("OvR Grantless", "OvRGrant!2026");
      await addOrgMembership({ organizationId: orgA, userId: grantless.user.id, addedBy: ctx.admin.id });
      grantlessSession = grantless.session;
    });

    await t.step("provenance view: every allowlisted key starts source='global'; secrets stay masked/empty", async () => {
      const res = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/settings`);
      assertEquals(res.status, 200);
      const settings = res.json.settings as { key: string; value: string; isSecret: boolean; source: string }[];
      assertExists(settings);
      assert(settings.length > 0, "the allowlisted effective view is non-empty");
      assert(settings.every((s) => s.source === "global"), "fresh org: every field is inherited from global");
      const smtpPassword = settings.find((s) => s.key === "smtp_password");
      assertExists(smtpPassword);
      assertEquals(smtpPassword.isSecret, true);
      assertEquals(smtpPassword.value, "", "unset secrets round-trip as '' (never a fabricated mask)");
      // The allowlist is the credential/integration family ONLY.
      assert(settings.some((s) => s.key === "slack_bot_token"));
      assert(!settings.some((s) => s.key === "session_ttl_ms"), "platform keys never appear in the org view");
    });

    await t.step("allowlist: a PLATFORM key (session_ttl_ms) PUT is 400 — org-scoped admins cannot change global parameters", async () => {
      const res = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/settings/session_ttl_ms`, {
        body: { value: "1000" },
      });
      assertEquals(res.status, 400, "non-overridable key is a caller fault — the G-class guard from addendum-137 §6");
      assert((res.json.error as string).includes("not org-overridable"));
    });

    await t.step("write: slack_client_id override lands with source='organization' and flips the provenance flag", async () => {
      const put = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/settings/slack_client_id`, {
        body: { value: "orga-slack-client" },
      });
      assertEquals(put.status, 200);
      assertEquals(put.json.source, "organization");

      const list = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/settings`);
      const row = (list.json.settings as { key: string; value: string; source: string }[]).find((s) => s.key === "slack_client_id");
      assertExists(row);
      assertEquals(row.source, "organization");
      assertEquals(row.value, "orga-slack-client");
    });

    await t.step("secret write: smtp_password stays masked on read + audit carries [hidden] with phase-3 org attribution", async () => {
      const put = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/settings/smtp_password`, {
        body: { value: "super-secret-org-smtp" },
      });
      assertEquals(put.status, 200);
      assertEquals(put.json.value, "••••••••", "masked on write response, never the plaintext");

      const list = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/settings`);
      const row = (list.json.settings as { key: string; value: string; isSecret: boolean }[]).find((s) => s.key === "smtp_password");
      assertExists(row);
      assertEquals(row.value, "••••••••", "masked on read, real value never round-trips");

      const rows = await query<{ details: { key: string; newValue: string }; organization_id: string | null }>(
        `SELECT details, organization_id FROM audit_log WHERE action = 'organization_setting.updated' ORDER BY created_at DESC LIMIT 1`,
      );
      assertExists(rows[0]);
      assertEquals(rows[0].details.key, "smtp_password");
      assertEquals(rows[0].details.newValue, "[hidden]", "secret material never reaches audit details");
      assertEquals(rows[0].organization_id, orgA, "phase-3 attribution: the row belongs to the target's org (addendum-137 §3)");
    });

    await t.step("validation: malformed PEM material on aws_encrypt_private_key_pem_b64 is a 400 (crypto validators apply)", async () => {
      const res = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/settings/aws_encrypt_private_key_pem_b64`, {
        body: { value: "not-a-pem" },
      });
      assertEquals(res.status, 400);
    });

    await t.step("resolution: getOrgSetting returns the org override, then explicit-empty wins over any global value", async () => {
      const overridden = await getOrgSetting<string>(orgA, "slack_client_id");
      assertEquals(overridden, "orga-slack-client");

      const explicitEmpty = await getOrgSetting<string>(orgA, "slack_redirect_uri");
      assertEquals(explicitEmpty, "", "default is '' and no rows exist — chain ends at the code default");

      await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/settings/slack_redirect_uri`, {
        body: { value: "https://org-a.example/slack/cb" },
      });
      await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/settings/slack_redirect_uri`, {
        body: { value: "" },
      });
      const emptyOverride = await getOrgSetting<string>(orgA, "slack_redirect_uri");
      assertEquals(emptyOverride, "", "value '' is a live org override — explicit-empty, not an inherit fallback");
    });

    await t.step("resolution guards: getOrgSetting throws loudly on non-overridable keys (never silently reads global)", async () => {
      await assertRejects(
        () => getOrgSetting(orgA, "session_ttl_ms"),
        Error,
        "not org-overridable",
      );
    });

    await t.step("isolation: Org B answers 404-disguise for the scoped admin; grantless member answers 403", async () => {
      const bRead = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgB}/settings`);
      assertEquals(bRead.status, 404, "out-of-scope org ids are existence-disguised (addendum-137 §7)");
      const bWrite = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgB}/settings/slack_client_id`, {
        body: { value: "x" },
      });
      assertEquals(bWrite.status, 404);

      const noCapsRead = await ctx.actors.as(grantlessSession).get(`/admin/organizations/${orgA}/settings`);
      assertEquals(noCapsRead.status, 403, "membership ≠ grant — capability absent everywhere is 403");
      const noCapsWrite = await ctx.actors.as(grantlessSession).put(`/admin/organizations/${orgA}/settings/slack_client_id`, {
        body: { value: "x" },
      });
      assertEquals(noCapsWrite.status, 403);
    });

    await t.step("revert: DELETE clears the override (resolution falls back to global); a second DELETE is a clean 404", async () => {
      const del = await ctx.actors.as(scopedSession).del(`/admin/organizations/${orgA}/settings/slack_client_id`);
      assertEquals(del.status, 200);

      const inherited = await getOrgSetting<string>(orgA, "slack_client_id");
      assertEquals(inherited, "", "after revert the chain resolves global row → default (both '' here)");

      const list = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/settings`);
      const row = (list.json.settings as { key: string; source: string }[]).find((s) => s.key === "slack_client_id");
      assertExists(row);
      assertEquals(row.source, "global", "provenance flag falls back to inherited");

      const again = await ctx.actors.as(scopedSession).del(`/admin/organizations/${orgA}/settings/slack_client_id`);
      assertEquals(again.status, 404, "reverting a non-existent override is a clean miss, not an error");
    });

    await t.step("templates: effective view starts source='global'; PUT creates the org override (only subject+bodyHtml required)", async () => {
      const list = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/templates`);
      assertEquals(list.status, 200);
      const templates = list.json.templates as { triggerKey: string; source: string }[];
      assertExists(templates);
      assert(templates.length > 0);
      assert(templates.every((tt) => tt.source === "global"));

      const put = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/templates/user.approved`, {
        body: {
          subject: "Org A says welcome, {{full_name}}!",
          bodyHtml: "<p>Org A welcome body for {{full_name}}</p>",
        },
      });
      assertEquals(put.status, 200);
      assertEquals(put.json.source, "organization");

      const after = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/templates`);
      const row = (after.json.templates as { triggerKey: string; subject: string; source: string }[])
        .find((tt) => tt.triggerKey === "user.approved");
      assertExists(row);
      assertEquals(row.source, "organization");
      assertEquals(row.subject, "Org A says welcome, {{full_name}}!");
    });

    await t.step("templates: organization overrides strip stored-XSS payloads", async () => {
      const put = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/templates/user.approved`, {
        body: {
          bodyHtml: '<p onmouseover="steal()">Safe</p><a href="javascript:steal()">bad</a><svg onload="steal()"></svg>',
        },
      });
      assertEquals(put.status, 200);
      const after = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/templates`);
      const row = (after.json.templates as { triggerKey: string; bodyHtml: string }[])
        .find((tt) => tt.triggerKey === "user.approved");
      assertExists(row);
      assert(row.bodyHtml.includes("Safe"));
      for (const forbidden of ["onmouseover", "javascript:", "<svg", "onload"]) {
        assertEquals(row.bodyHtml.toLowerCase().includes(forbidden), false);
      }
    });

    await t.step("templates: unknown trigger 404s; update-in-place works; revert restores the global provenance", async () => {
      const unknown = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/templates/no.such.trigger`, {
        body: { subject: "x", bodyHtml: "<p>x</p>" },
      });
      assertEquals(unknown.status, 404);

      const upd = await ctx.actors.as(scopedSession).put(`/admin/organizations/${orgA}/templates/user.approved`, {
        body: { subject: "Org A welcome v2, {{full_name}}!" },
      });
      assertEquals(upd.status, 200);

      const del = await ctx.actors.as(scopedSession).del(`/admin/organizations/${orgA}/templates/user.approved`);
      assertEquals(del.status, 200);

      const after = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgA}/templates`);
      const row = (after.json.templates as { triggerKey: string; source: string }[])
        .find((tt) => tt.triggerKey === "user.approved");
      assertExists(row);
      assertEquals(row.source, "global", "revert restores the inherited global template");

      const again = await ctx.actors.as(scopedSession).del(`/admin/organizations/${orgA}/templates/user.approved`);
      assertEquals(again.status, 404);
    });

    await t.step("global reach: the global admin (full_admin) manages any org's overrides and sees all provenance", async () => {
      const put = await ctx.actors.admin.put(`/admin/organizations/${orgB}/settings/slack_client_id`, {
        body: { value: "orgb-by-global-admin" },
      });
      assertEquals(put.status, 200, "a global OrgAppSettingsWrite grant reaches every org");

      const scopedSeesNothing = await ctx.actors.as(scopedSession).get(`/admin/organizations/${orgB}/settings`);
      assertEquals(scopedSeesNothing.status, 404, "the scoped admin still cannot observe Org B");
    });
  },
);
