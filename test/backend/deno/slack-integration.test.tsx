// Coverage for the Slack account-linking integration (slack_plan.md §13,
// E-42..E-46). A live Slack OAuth round-trip is impossible in this suite (no
// real workspace), exactly like entra_auth.test.tsx — so we cover:
//   • HTTP gating: login requires a verified session; login/callback no-op or
//     error cleanly while Slack is unconfigured.
//   • the ExternalIdentity link lifecycle (create / duplicate-block / unlink /
//     re-link) as direct db.tsx calls, mirroring the callback's own logic.
//   • GET /me/integrations status projection.
//   • sendSlackDM's non-throwing gating (disabled / no token / not linked) —
//     none of which reaches the network.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
} from "./helpers.tsx";
import { externalIdentities, generateId, now } from "../../../server/db.tsx";
import { PROVIDER_SLACK } from "../../../server/slack/config.tsx";
import { sendSlackDM } from "../../../server/slack.ts";
import { setSetting, clearAppSettingsCache } from "../../../server/app-settings.tsx";
import { query } from "../../../server/pg.tsx";

// Restores every slack_* setting to its unconfigured baseline so ordering
// between steps can't leak state (setSetting is a real upsert on app_settings).
async function resetSlackSettings(): Promise<void> {
  await query(
    `UPDATE app_settings SET value = '' WHERE key IN
     ('slack_client_id','slack_client_secret','slack_bot_token','slack_team_id','slack_redirect_uri')`,
  );
  await query(`UPDATE app_settings SET value = 'false' WHERE key = 'slack_integration_enabled'`);
  clearAppSettingsCache();
}

Deno.test("slack-integration", async (t) => {
  let userSession: string;
  let userId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    await resetSlackSettings();

    const admin = await createAdmin();
    assertExists(admin);

    const email = uniqueEmail("slack-user");
    const user = await createActiveUser({
      fullName: uniqueName("Slack User"),
      email,
      password: "SlackPass!2026",
      affiliation: "agency",
    });
    userId = user.id;
    const login = await loginAs(email, "SlackPass!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
    userSession = login.session;
  });

  // ── HTTP gating ───────────────────────────────────────────────────────────

  await t.step("E-42: GET /auth/slack/login without a session → 401", async () => {
    const res = await req("/auth/slack/login", { method: "GET" });
    assertEquals(res.status, 401);
  });

  await t.step("E-42: GET /auth/slack/login while unconfigured → 503", async () => {
    const res = await req("/auth/slack/login", { method: "GET", headers: authHeaders(userSession) });
    assertEquals(res.status, 503);
  });

  await t.step("E-42: GET /auth/slack/callback while unconfigured → redirect ?slack_linked=error", async () => {
    const res = await req("/auth/slack/callback?code=x&state=y", { method: "GET" });
    assertEquals(res.status, 302);
    const location = res.headers.get("Location") || "";
    assertEquals(location.includes("slack_linked=error"), true);
  });

  await t.step("E-42: login returns a Slack authorize URL once configured", async () => {
    await setSetting("slack_client_id", "test-client-id");
    await setSetting("slack_client_secret", "test-client-secret");
    await setSetting("slack_redirect_uri", "https://example.test/auth/slack/callback");

    const res = await req("/auth/slack/login", { method: "GET", headers: authHeaders(userSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.url);
    assertEquals(data.url.startsWith("https://slack.com/oauth/v2/authorize"), true);
    assertEquals(data.url.includes("client_id=test-client-id"), true);
    // A state row must have been minted for the CSRF boundary.
    const states = await query<{ user_id: string }>(`SELECT user_id FROM slack_auth_states`);
    assertEquals(states.length, 1);
    assertEquals(states[0].user_id, userId);

    await resetSlackSettings();
  });

  // Red-regiment ledger row 3 (assessment 2026-08-04-slack-oauth-invalid-
  // permissions.md): UAT app install was rejected by Slack with "Invalid
  // permissions requested" — root cause is the DEPRECATED conversations:write
  // scope in SLACK_BOT_SCOPES (slack-config.tsx:21). chat.postMessage already
  // accepts a user DM channel id, so im:write suffices and
  // conversations:write must go. RED by design until the config drops it.
  await t.step("E-43: authorize URL requests exactly the approved bot scopes — deprecated conversations:write dropped", async () => {
    await setSetting("slack_client_id", "test-client-id");
    await setSetting("slack_client_secret", "test-client-secret");
    await setSetting("slack_redirect_uri", "https://example.test/auth/slack/callback");

    const res = await req("/auth/slack/login", { method: "GET", headers: authHeaders(userSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.url);
    const scopeParam = new URL(data.url).searchParams.get("scope") ?? "";
    const scopes = scopeParam.split(",").sort();
    assertEquals(scopes, ["chat:write", "im:write", "users:read"]);
    assertEquals(scopes.includes("conversations:write"), false);

    await resetSlackSettings();
  });

  await t.step("E-42: callback with an unknown state → redirect error (no link created)", async () => {
    await setSetting("slack_client_id", "test-client-id");
    await setSetting("slack_client_secret", "test-client-secret");
    const res = await req("/auth/slack/callback?code=abc&state=not-a-real-state", { method: "GET" });
    assertEquals(res.status, 302);
    assertEquals((res.headers.get("Location") || "").includes("slack_linked=error"), true);
    const link = await externalIdentities.findActiveByUserAndProvider(userId, PROVIDER_SLACK);
    assertEquals(link, null);
    await resetSlackSettings();
  });

  // ── Link lifecycle (direct db, mirrors the callback's create/update path) ──

  await t.step("E-45: link creates an active ExternalIdentity(provider='slack')", async () => {
    const slackUserId = "U-SLACK-1";
    await externalIdentities.create({
      id: generateId(),
      userId,
      provider: PROVIDER_SLACK,
      externalId: slackUserId,
      externalUpn: "slack.user",
      // Workspace id captured from oauth.v2.access team.id (addendum-078).
      tenantId: "T-WORKSPACE-1",
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });

    const link = await externalIdentities.findActiveByUserAndProvider(userId, PROVIDER_SLACK);
    assertExists(link);
    assertEquals(link!.externalId, slackUserId);
    assertEquals(link!.status, "active");
    // The workspace id round-trips through the storage layer.
    assertEquals(link!.tenantId, "T-WORKSPACE-1");
  });

  await t.step("E-45: /me/integrations reports the linked Slack account", async () => {
    const res = await req("/me/integrations", { method: "GET", headers: authHeaders(userSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.slack.linked, true);
    assertEquals(data.slack.externalUpn, "slack.user");
  });

  await t.step("E-45: duplicate-link guard — same Slack id, different user → blocked", async () => {
    // A second local user tries to claim the same Slack id already linked above.
    const other = await createActiveUser({
      fullName: uniqueName("Other User"),
      email: uniqueEmail("slack-other"),
      password: "OtherPass!2026",
      affiliation: "vendor",
    });
    const existing = await externalIdentities.findByProviderAndExternalId(PROVIDER_SLACK, "U-SLACK-1");
    assertExists(existing);
    // Mirrors slackCallback's guard: existing row belongs to a different user.
    assertEquals(existing!.userId !== other.id, true);
    // The other user has no active slack link of their own.
    const otherLink = await externalIdentities.findActiveByUserAndProvider(other.id, PROVIDER_SLACK);
    assertEquals(otherLink, null);
  });

  await t.step("E-45: unlink soft-decommissions (row remains, status flips)", async () => {
    const res = await req("/auth/slack/unlink", { method: "POST", headers: authHeaders(userSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.linked, false);

    // No longer active…
    const active = await externalIdentities.findActiveByUserAndProvider(userId, PROVIDER_SLACK);
    assertEquals(active, null);
    // …but the row is still present, decommissioned.
    const row = await externalIdentities.findByProviderAndExternalId(PROVIDER_SLACK, "U-SLACK-1");
    assertExists(row);
    assertEquals(row!.status, "decommissioned");
    assertExists(row!.decommissionedAt);
  });

  await t.step("E-45: /me/integrations reports unlinked after disconnect", async () => {
    const res = await req("/me/integrations", { method: "GET", headers: authHeaders(userSession) });
    const data = await res.json();
    assertEquals(data.slack.linked, false);
  });

  await t.step("E-45: re-link reactivates the same Slack id", async () => {
    const row = await externalIdentities.findByProviderAndExternalId(PROVIDER_SLACK, "U-SLACK-1");
    assertExists(row);
    await externalIdentities.update(row!.id, {
      userId,
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
    });
    const active = await externalIdentities.findActiveByUserAndProvider(userId, PROVIDER_SLACK);
    assertExists(active);
    assertEquals(active!.status, "active");
  });

  await t.step("E-45: unlink is idempotent — POST when not linked → ok, linked:false", async () => {
    // Decommission again, then unlink a second time.
    const row = await externalIdentities.findByProviderAndExternalId(PROVIDER_SLACK, "U-SLACK-1");
    await externalIdentities.update(row!.id, { status: "decommissioned", decommissionedAt: now() });
    const res = await req("/auth/slack/unlink", { method: "POST", headers: authHeaders(userSession) });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).linked, false);
  });

  // ── audit ──────────────────────────────────────────────────────────────────

  await t.step("E-45: unlink writes a user.slack_unlinked audit row", async () => {
    const rows = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE action = 'user.slack_unlinked' AND actor_id = $1`,
      [userId],
    );
    assertEquals(rows.length >= 1, true);
  });

  // ── sendSlackDM gating (never touches the network in these paths) ──────────

  await t.step("E-44/E-46: sendSlackDM returns disabled when the flag is off", async () => {
    await resetSlackSettings(); // integration flag = false
    const result = await sendSlackDM(userId, "hello");
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "disabled");
  });

  await t.step("E-44: sendSlackDM returns no_token when enabled but no bot token", async () => {
    await query(`UPDATE app_settings SET value = 'true' WHERE key = 'slack_integration_enabled'`);
    clearAppSettingsCache();
    const result = await sendSlackDM(userId, "hello");
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "no_token");
  });

  await t.step("E-44: sendSlackDM returns not_linked when enabled + token but user has no active link", async () => {
    await setSetting("slack_bot_token", "xoxb-fake-test-token");
    // Ensure the user has no active slack link.
    const row = await externalIdentities.findByProviderAndExternalId(PROVIDER_SLACK, "U-SLACK-1");
    if (row) await externalIdentities.update(row.id, { status: "decommissioned", decommissionedAt: now() });
    const result = await sendSlackDM(userId, "hello");
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "not_linked");
    await resetSlackSettings();
  });

  // ── Auth-gate + CSRF-state negative coverage (OWASP A05/A07) ──────────────

  await t.step("E-42: POST /auth/slack/unlink without a session → 401", async () => {
    const res = await req("/auth/slack/unlink", { method: "POST" });
    assertEquals(res.status, 401);
  });

  await t.step("E-42: GET /me/integrations without a session → 401", async () => {
    const res = await req("/me/integrations", { method: "GET" });
    assertEquals(res.status, 401);
  });

  await t.step("E-42: callback with an EXPIRED state → redirect error (state consumed, no link)", async () => {
    await setSetting("slack_client_id", "test-client-id");
    await setSetting("slack_client_secret", "test-client-secret");
    // Seed a state row that is already past its expiry.
    const expiredState = "expired-" + generateId();
    await query(
      `INSERT INTO slack_auth_states (state, user_id, created_at, expires_at)
       VALUES ($1, $2, now() - interval '1 hour', now() - interval '30 minutes')`,
      [expiredState, userId],
    );
    const res = await req(`/auth/slack/callback?code=abc&state=${expiredState}`, { method: "GET" });
    assertEquals(res.status, 302);
    assertEquals((res.headers.get("Location") || "").includes("slack_linked=error"), true);
    // The expired state must have been consumed (deleted) regardless of outcome.
    const remaining = await query<{ state: string }>(`SELECT state FROM slack_auth_states WHERE state = $1`, [expiredState]);
    assertEquals(remaining.length, 0);
    const link = await externalIdentities.findActiveByUserAndProvider(userId, PROVIDER_SLACK);
    assertEquals(link, null);
    await resetSlackSettings();
  });

  await t.step("E-42: a state token is single-use — a second callback with the same state fails", async () => {
    await setSetting("slack_client_id", "test-client-id");
    await setSetting("slack_client_secret", "test-client-secret");
    const state = "single-use-" + generateId();
    await query(
      `INSERT INTO slack_auth_states (state, user_id, created_at, expires_at)
       VALUES ($1, $2, now(), now() + interval '10 minutes')`,
      [state, userId],
    );
    // First callback consumes the state (the code exchange will fail against a
    // fake code, but the state row must be gone afterward).
    await req(`/auth/slack/callback?code=fake&state=${state}`, { method: "GET" });
    const afterFirst = await query<{ state: string }>(`SELECT state FROM slack_auth_states WHERE state = $1`, [state]);
    assertEquals(afterFirst.length, 0, "state must be consumed after the first callback");
    // Second callback with the same state now hits the unknown-state path.
    const res2 = await req(`/auth/slack/callback?code=fake&state=${state}`, { method: "GET" });
    assertEquals(res2.status, 302);
    assertEquals((res2.headers.get("Location") || "").includes("slack_linked=error"), true);
    await resetSlackSettings();
  });

  await t.step("A03: callback state/code with SQL-injection metacharacters is handled safely", async () => {
    await setSetting("slack_client_id", "test-client-id");
    await setSetting("slack_client_secret", "test-client-secret");
    const evil = encodeURIComponent("' OR '1'='1; DROP TABLE slack_auth_states;--");
    const res = await req(`/auth/slack/callback?code=${evil}&state=${evil}`, { method: "GET" });
    assertEquals(res.status, 302);
    assertEquals((res.headers.get("Location") || "").includes("slack_linked=error"), true);
    // The table must still exist and the parameterized query must not have executed the payload.
    const stillThere = await query<{ n: number }>(`SELECT count(*)::int AS n FROM slack_auth_states`);
    assertExists(stillThere[0]);
    await resetSlackSettings();
  });

  // ── Admin Slack diagnostics routes (G1 — addendum-140 gap register) ──────
  // POST /admin/integrations/slack/test and GET /admin/integrations/slack/users
  // had zero suite references; the frontend consumes both (api/admin.ts). The
  // pins below cover positive shape, the configured/unconfigured fail-closed
  // branches, and the session-scoping negatives.
  let diagAdminId = "";
  let diagAdminSession = "";

  await t.step("G1: diagnostics setup — fresh full_admin with a verified session", async () => {
    await resetSlackSettings();
    const diagAdmin = await createAdmin("DiagAdmin!2026");
    diagAdminId = diagAdmin.id;
    const login = await loginAs(diagAdmin.email, "DiagAdmin!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
    diagAdminSession = login.session;
  });

  await t.step("G1: POST /admin/integrations/slack/test — session-scoping negatives (403 non-admin, 403 anon)", async () => {
    // userSession is a grantless agency user — requireAdminWith rejects.
    const plain = await req("/admin/integrations/slack/test", { method: "POST", headers: authHeaders(userSession) });
    assertEquals(plain.status, 403);
    const anon = await req("/admin/integrations/slack/test", { method: "POST" });
    assertEquals(anon.status, 403);
  });

  await t.step("G1: POST /admin/integrations/slack/test — admin with NO linked Slack → 400 not-linked branch", async () => {
    const res = await req("/admin/integrations/slack/test", { method: "POST", headers: authHeaders(diagAdminSession) });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(typeof body.error, "string");
  });

  await t.step("G1: POST /admin/integrations/slack/test — linked but integration disabled → 502 (fail-closed send path)", async () => {
    await externalIdentities.create({
      id: generateId(),
      userId: diagAdminId,
      provider: PROVIDER_SLACK,
      externalId: "U-DIAG-ADMIN",
      externalUpn: "diag.admin",
      tenantId: "T-WORKSPACE-DIAG",
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });
    // slack_integration_enabled=false + no bot token (resetSlackSettings):
    // sendSlackDM must fail closed without any network call.
    const res = await req("/admin/integrations/slack/test", { method: "POST", headers: authHeaders(diagAdminSession) });
    assertEquals(res.status, 502);
  });

  await t.step("G1: GET /admin/integrations/slack/users — positive shape over the linked set; 403 negatives", async () => {
    const res = await req("/admin/integrations/slack/users", { headers: authHeaders(diagAdminSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertExists(body.linked);
    assertEquals(body.linked.length >= 1, true);
    const row = body.linked.find((l: { userId: string }) => l.userId === diagAdminId);
    assertExists(row);
    assertEquals(row.slack_user_id, "U-DIAG-ADMIN");
    assertEquals(row.slack_handle, "diag.admin");
    assertEquals(row.workspace_id, "T-WORKSPACE-DIAG");
    assertEquals(row.active, true);
    assertExists(row.email);
    assertExists(row.linked_at);

    const plain = await req("/admin/integrations/slack/users", { headers: authHeaders(userSession) });
    assertEquals(plain.status, 403);
    const anon = await req("/admin/integrations/slack/users");
    assertEquals(anon.status, 403);
  });
});
