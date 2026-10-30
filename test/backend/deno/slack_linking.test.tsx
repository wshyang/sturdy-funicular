// Tests for the Slack account-linking routes in server/routes/auth-slack.tsx.
//
// Only ONE suite referenced this module, leaving it at 63.6%. The OAuth
// token exchange needs a live Slack, but everything around it does not:
// the configuration gate, the auth gate, state minting, the atomic
// single-use consumption of that state, unlink, and the status endpoint are
// all pure DB work. Those are also the parts that carry the security
// properties worth pinning:
//
//   * A `state` token must be single-use. It is the CSRF defence on the
//     callback, so two callbacks carrying the same state must not both
//     proceed — the code consumes it with DELETE ... RETURNING for exactly
//     this reason, and that is directly observable.
//   * An expired state must be refused even though it is still in the table.
//   * Unlink must be idempotent and must SOFT-delete (status
//     'decommissioned'), never hard-delete, so the audit trail survives.
//   * Every endpoint must 401 without a session, and the login initiator must
//     503 — not 500, and not a broken redirect — when Slack is unconfigured.
//
// app_settings is not reset by wipeDatabase(), so this file snapshots and
// restores the Slack keys it touches (the resetAwsAppKeySettings convention).
import { assert, assertEquals } from "jsr:@std/assert";
import {
  authHeaders,
  createActiveUser,
  loginAs,
  req,
  uniqueEmail,
  wipeDatabase,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { clearAppSettingsCache } from "../../../server/app-settings.tsx";

const SLACK_KEYS = ["slack_client_id", "slack_client_secret", "slack_bot_token", "slack_redirect_uri"] as const;

async function snapshotSlackSettings(): Promise<Map<string, string>> {
  const rows = await query<{ key: string; value: string }>(
    `SELECT key, value FROM app_settings WHERE organization_id IS NULL AND key = ANY($1)`,
    [[...SLACK_KEYS]],
  );
  return new Map(rows.map((r) => [r.key, r.value]));
}

async function setSetting(key: string, value: string): Promise<void> {
  await query(
    `UPDATE app_settings SET value = $2 WHERE key = $1 AND organization_id IS NULL`,
    [key, value],
  );
  clearAppSettingsCache();
}

async function restore(snap: Map<string, string>): Promise<void> {
  for (const [key, value] of snap) await setSetting(key, value);
}

const configureSlack = async () => {
  await setSetting("slack_client_id", "1234.5678");
  await setSetting("slack_client_secret", "shhh-secret");
};
const unconfigureSlack = async () => {
  await setSetting("slack_client_id", "");
  await setSetting("slack_client_secret", "");
};

type Login = { session: string };
async function signIn(email: string, password: string): Promise<Login> {
  const out = await loginAs(email, password);
  assert("session" in out, `login failed: ${JSON.stringify(out)}`);
  return out as Login;
}

Deno.test("Slack account linking", async (t) => {
  await wipeDatabase();
  clearAppSettingsCache();
  const snap = await snapshotSlackSettings();

  try {
    const user = await createActiveUser({
      fullName: "Slack User",
      email: uniqueEmail("slackuser"),
      password: "SlackPass!2026",
      affiliation: "agency",
    });
    const login = await signIn(user.email, "SlackPass!2026");
    const auth = authHeaders(login.session);

    // ── auth gates ────────────────────────────────────────────────────────

    await t.step("negative: every authenticated endpoint 401s without a session", async () => {
      assertEquals((await req("/auth/slack/login")).status, 401);
      assertEquals((await req("/auth/slack/unlink", { method: "POST" })).status, 401);
      assertEquals((await req("/me/integrations")).status, 401);
    });

    // ── configuration gate ────────────────────────────────────────────────

    await t.step("negative: login is 503 while Slack is unconfigured", async () => {
      await unconfigureSlack();
      const res = await req("/auth/slack/login", { headers: auth });
      assertEquals(res.status, 503);
      assertEquals((await res.json()).error, "Slack integration is not configured.");
    });

    await t.step("negative: a client id WITHOUT a secret is still unconfigured", async () => {
      // isSlackConfigured ANDs both, so a half-filled config must not open the
      // flow and then fail at the exchange.
      await setSetting("slack_client_id", "1234.5678");
      await setSetting("slack_client_secret", "");
      assertEquals((await req("/auth/slack/login", { headers: auth })).status, 503);

      await setSetting("slack_client_id", "");
      await setSetting("slack_client_secret", "shhh-secret");
      assertEquals((await req("/auth/slack/login", { headers: auth })).status, 503);
    });

    await t.step("negative: the callback redirects with an error when unconfigured", async () => {
      // The callback is pre-session and browser-facing, so it must REDIRECT
      // rather than return JSON — a 5xx here would show the user a raw error.
      await unconfigureSlack();
      const res = await req("/auth/slack/callback?code=x&state=y");
      assertEquals(res.status, 302);
      assert(
        (res.headers.get("location") ?? "").includes("slack_linked=error"),
        res.headers.get("location") ?? "(no location)",
      );
    });

    // ── state minting ─────────────────────────────────────────────────────

    await t.step("positive: login mints a state row and returns the authorize URL", async () => {
      await configureSlack();
      const res = await req("/auth/slack/login", { headers: auth });
      assertEquals(res.status, 200);
      const { url } = await res.json();
      assert(url.includes("slack.com"), url);
      assert(url.includes("state="), url);
      assert(url.includes("1234.5678"), "the configured client id must be in the URL");

      const rows = await query<{ state: string; user_id: string; expires_at: string }>(
        `SELECT state, user_id, expires_at FROM slack_auth_states WHERE user_id = $1`,
        [user.id],
      );
      assertEquals(rows.length, 1);
      assertEquals(rows[0].user_id, user.id);
      assert(new Date(rows[0].expires_at).getTime() > Date.now(), "state must not be born expired");
      assert(url.includes(encodeURIComponent(rows[0].state)) || url.includes(rows[0].state), "URL carries the minted state");
    });

    await t.step("each login mints a DISTINCT state", async () => {
      await query(`DELETE FROM slack_auth_states WHERE user_id = $1`, [user.id]);
      const a = await (await req("/auth/slack/login", { headers: auth })).json();
      const b = await (await req("/auth/slack/login", { headers: auth })).json();
      const stateOf = (u: string) => new URL(u).searchParams.get("state");
      assert(stateOf(a.url) !== stateOf(b.url), "state tokens must not repeat");
      const [{ n }] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM slack_auth_states WHERE user_id = $1`,
        [user.id],
      );
      assertEquals(n, 2);
    });

    // ── callback state handling (all pre-network) ─────────────────────────

    await t.step("negative: the callback rejects a missing code or state", async () => {
      await configureSlack();
      for (const qs of ["", "?code=abc", "?state=xyz"]) {
        const res = await req(`/auth/slack/callback${qs}`);
        assertEquals(res.status, 302, qs);
        assert((res.headers.get("location") ?? "").includes("slack_linked=error"), qs);
      }
    });

    await t.step("negative: an unknown state is rejected", async () => {
      const res = await req("/auth/slack/callback?code=abc&state=never-minted");
      assertEquals(res.status, 302);
      assert((res.headers.get("location") ?? "").includes("slack_linked=error"));
    });

    await t.step("SECURITY: a state token is single-use — consumed even on failure", async () => {
      await query(`DELETE FROM slack_auth_states WHERE user_id = $1`, [user.id]);
      const { url } = await (await req("/auth/slack/login", { headers: auth })).json();
      const state = new URL(url).searchParams.get("state")!;

      // The exchange with Slack cannot succeed here, but the state must be
      // consumed regardless — that is what stops a replay.
      await req(`/auth/slack/callback?code=bogus&state=${encodeURIComponent(state)}`);

      const [{ n }] = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM slack_auth_states WHERE state = $1`,
        [state],
      );
      assertEquals(n, 0, "the state row must be deleted on use");

      const replay = await req(`/auth/slack/callback?code=bogus&state=${encodeURIComponent(state)}`);
      assertEquals(replay.status, 302);
      assert((replay.headers.get("location") ?? "").includes("slack_linked=error"), "replay must fail");
    });

    await t.step("SECURITY: an expired state is refused", async () => {
      await query(`DELETE FROM slack_auth_states WHERE user_id = $1`, [user.id]);
      const { url } = await (await req("/auth/slack/login", { headers: auth })).json();
      const state = new URL(url).searchParams.get("state")!;
      await query(`UPDATE slack_auth_states SET expires_at = now() - interval '1 hour' WHERE state = $1`, [state]);

      const res = await req(`/auth/slack/callback?code=abc&state=${encodeURIComponent(state)}`);
      assertEquals(res.status, 302);
      assert((res.headers.get("location") ?? "").includes("slack_linked=error"));
    });

    // ── link status + unlink ──────────────────────────────────────────────

    await t.step("positive: /me/integrations reports unlinked by default", async () => {
      const res = await req("/me/integrations", { headers: auth });
      assertEquals(res.status, 200);
      assertEquals((await res.json()).slack, { linked: false });
    });

    await t.step("positive: /me/integrations reflects a live Slack identity", async () => {
      await query(
        `INSERT INTO external_identities
           (id, user_id, provider, external_id, external_upn, status, linked_at, created_at, updated_at)
         VALUES (uuid_generate_v7(), $1, 'slack', 'U12345', 'slackuser@example.gov', 'active', now(), now(), now())`,
        [user.id],
      );
      const res = await req("/me/integrations", { headers: auth });
      assertEquals(res.status, 200);
      const { slack } = await res.json();
      assertEquals(slack.linked, true);
      assertEquals(slack.externalUpn, "slackuser@example.gov");
      assert(slack.linkedAt, "linkedAt must be reported");
    });

    await t.step("positive: unlink SOFT-deletes and is audited", async () => {
      const res = await req("/auth/slack/unlink", { method: "POST", headers: auth });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, linked: false });

      const rows = await query<{ status: string; decommissioned_at: string | null }>(
        `SELECT status, decommissioned_at FROM external_identities WHERE user_id = $1 AND provider = 'slack'`,
        [user.id],
      );
      assertEquals(rows.length, 1, "the row must be kept, not hard-deleted");
      assertEquals(rows[0].status, "decommissioned");
      assert(rows[0].decommissioned_at, "decommissionedAt must be stamped");

      const audit = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.slack_unlinked' AND target_id = $1`,
        [user.id],
      );
      assertEquals(audit[0].n, 1);

      assertEquals((await (await req("/me/integrations", { headers: auth })).json()).slack, { linked: false });
    });

    await t.step("unlink is idempotent — a second call is still 200", async () => {
      const res = await req("/auth/slack/unlink", { method: "POST", headers: auth });
      assertEquals(res.status, 200);
      assertEquals(await res.json(), { ok: true, linked: false });
      // And it must not have created a second audit row.
      const audit = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM audit_log WHERE action = 'user.slack_unlinked' AND target_id = $1`,
        [user.id],
      );
      assertEquals(audit[0].n, 1, "a no-op unlink must not be audited again");
    });

    await t.step("isolation: one user's Slack link is invisible to another", async () => {
      const other = await createActiveUser({
        fullName: "Other Slack User",
        email: uniqueEmail("otherslack"),
        password: "OtherPass!2026",
        affiliation: "agency",
      });
      await query(
        `INSERT INTO external_identities
           (id, user_id, provider, external_id, external_upn, status, linked_at, created_at, updated_at)
         VALUES (uuid_generate_v7(), $1, 'slack', 'U99999', 'other@example.gov', 'active', now(), now(), now())`,
        [other.id],
      );
      // The original user is still unlinked…
      assertEquals((await (await req("/me/integrations", { headers: auth })).json()).slack, { linked: false });
      // …and the other user sees only their own.
      const otherLogin = await signIn(other.email, "OtherPass!2026");
      const seen = await (await req("/me/integrations", { headers: authHeaders(otherLogin.session) })).json();
      assertEquals(seen.slack.linked, true);
      assertEquals(seen.slack.externalUpn, "other@example.gov");
    });
  } finally {
    await restore(snap);
  }
});
