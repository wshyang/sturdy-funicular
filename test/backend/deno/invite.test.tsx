// Coverage: POST /admin/users/invite (admin pre-provisions a real user +
// optional notify email) and POST /auth/accept-invite (redeem the signup-link
// token to set a password and get a session). See addendum-051-invite-user.md.
// The second test block pins role-grant AUTHORITY on invite/approve — global
// administrators reach all organisations, org-scoped administrators only the
// organisations their grant reaches (addendum-202).
//
// Written tests-first: the route handlers are implemented to satisfy these.
import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, latestSentNotification, sentNotificationEmailSnapshots,
  createOrganization, addOrgMembership,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { userInvites, users } from "../../../server/db.tsx";
import { hashPassword } from "../../../server/utils.tsx";
import { grantAdminRole, listAdminRoleGrants } from "../../../server/auth-admin-roles.tsx";

Deno.test("invite", async (t) => {
  let adminSession: string;
  let admin: { id: string; email: string };

  await t.step("setup", async () => {
    await wipeDatabase();
    admin = await createAdmin("InviteAdmin!2026");
    adminSession = (await loginAs(admin.email, "InviteAdmin!2026") as any).session;
    assertExists(adminSession);
  });

  // ── invite (admin side) ─────────────────────────────────────────────────

  await t.step("invite: positive — creates an active user + a live invite token; notify=false returns the link", async () => {
    const email = uniqueEmail("invitee");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { fullName: "Invited Person", email, affiliation: "vendor", notify: false },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertExists(data.userId);
    // notify=false → the admin gets the link back to share out-of-band.
    assertExists(data.inviteLink);
    assertEquals(data.inviteLink.includes("/invite/"), true);

    // A real, active user row exists with the chosen affiliation and NO usable
    // password yet (placeholder hash; login can't succeed until accept-invite).
    const rows = await query<{ status: string; affiliation: string; password_hash: string; totp_secret: string | null }>(
      `SELECT status, affiliation, password_hash, totp_secret FROM users WHERE id = $1`, [data.userId],
    );
    assertEquals(rows[0].status, "active");
    assertEquals(rows[0].affiliation, "vendor");
    assertEquals(rows[0].totp_secret, null); // not enrolled — first login enrolls
    // A live invite token was minted for this user.
    const invites = await userInvites.findByUser(data.userId);
    assertEquals(invites.length, 1);
    assertEquals(invites[0].consumedAt, null);
  });

  await t.step("invite: positive — notify=true sends the user.invited email with the link", async () => {
    const email = uniqueEmail("invitee-notify");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { fullName: "Notified Invitee", email, affiliation: "agency", notify: true },
    });
    assertEquals(res.status, 201);

    const mail = await latestSentNotification("user.invited");
    assertExists(mail);
    assertEquals(sentNotificationEmailSnapshots(mail), [email]);
  });

  await t.step("invite: negative — missing/invalid fields rejected 400", async () => {
    const bad1 = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { email: uniqueEmail("x"), affiliation: "vendor" }, // no fullName
    });
    assertEquals(bad1.status, 400);

    const bad2 = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { fullName: "Bad Email", email: "not-an-email", affiliation: "vendor" },
    });
    assertEquals(bad2.status, 400);

    const bad3 = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { fullName: "Bad Aff", email: uniqueEmail("y"), affiliation: "wizard" },
    });
    assertEquals(bad3.status, 400);
  });

  await t.step("invite: negative — inviting an already-active email rejected 400", async () => {
    const existing = await createActiveUser({
      fullName: "Existing", email: uniqueEmail("existing"), password: "Existing!2026", affiliation: "vendor",
    });
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { fullName: "Dup", email: existing.email, affiliation: "vendor", notify: false },
    });
    assertEquals(res.status, 400);
  });

  await t.step("invite: negative — non-admin forbidden (403)", async () => {
    const vendor = await createActiveUser({
      fullName: "Invite Vendor", email: uniqueEmail("invv"), password: "InvVendor!2026", affiliation: "vendor",
    });
    const vSession = (await loginAs(vendor.email, "InvVendor!2026") as any).session;
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(vSession),
      body: { fullName: "Nope", email: uniqueEmail("nope"), affiliation: "vendor", notify: false },
    });
    assertEquals(res.status, 403);
  });

  // ── accept-invite (invited-user side, pre-session) ──────────────────────

  async function inviteAndGetToken(email: string, affiliation = "vendor"): Promise<string> {
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { fullName: "Accept Flow", email, affiliation, notify: false },
    });
    const { inviteLink } = await res.json();
    return new URL(inviteLink).pathname.split("/invite/")[1]!;
  }

  await t.step("accept-invite: positive — sets the password and returns a session", async () => {
    const email = uniqueEmail("accept");
    const token = await inviteAndGetToken(email);
    const password = "AcceptedPass!2026";

    const res = await req("/auth/accept-invite", { method: "POST", body: { token, password } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.session);
    // A fresh session is 2FA-unverified → the client will hit the enroll gate.
    assertEquals(data.needs2faEnrollment, true);

    // The stored hash is now the real SHA-256(password || salt), not the
    // placeholder — so a normal login works too.
    const rows = await query<{ password_hash: string; password_salt: string }>(
      `SELECT password_hash, password_salt FROM users WHERE email = $1`, [email],
    );
    assertEquals(rows[0].password_hash, await hashPassword(password, rows[0].password_salt));

    // Token is now consumed.
    const login = await req("/auth/login", { method: "POST", body: { email, password } });
    assertEquals(login.status, 200);
  });

  await t.step("accept-invite: negative — a weak password is rejected 400", async () => {
    const email = uniqueEmail("weak-accept");
    const token = await inviteAndGetToken(email);
    const res = await req("/auth/accept-invite", { method: "POST", body: { token, password: "weak" } });
    assertEquals(res.status, 400);
  });

  await t.step("accept-invite: negative — an unknown token is rejected 400", async () => {
    const res = await req("/auth/accept-invite", { method: "POST", body: { token: "no-such-token", password: "ValidPass!2026" } });
    assertEquals(res.status, 400);
  });

  await t.step("accept-invite: negative — a token cannot be reused (single-use)", async () => {
    const email = uniqueEmail("reuse");
    const token = await inviteAndGetToken(email);
    const first = await req("/auth/accept-invite", { method: "POST", body: { token, password: "FirstUse!2026" } });
    assertEquals(first.status, 200);
    const second = await req("/auth/accept-invite", { method: "POST", body: { token, password: "SecondUse!2026" } });
    assertEquals(second.status, 400);
  });

  await t.step("accept-invite: negative — an expired token is rejected 400", async () => {
    const email = uniqueEmail("expired");
    const token = await inviteAndGetToken(email);
    // Force the invite into the past.
    await query(`UPDATE user_invites SET expires_at = now() - interval '1 minute' WHERE token = $1`, [token]);
    const res = await req("/auth/accept-invite", { method: "POST", body: { token, password: "TooLate!2026" } });
    assertEquals(res.status, 400);
  });
});

// ── Role-grant authority on invite/approve (addendum-202) ──────────────────
// Owner contract 2026-08-17: on the bulk-invitation endpoint (and its approve
// twin), a GLOBAL administrator may assign roles into ALL organisations,
// while an ORG-SCOPED administrator is limited to the organisations their
// grant reaches. Concretely:
//   * the legacy all-global grant form (grantFullAdmin / bare roleKeys) is a
//     GLOBAL-grant request — a scoped caller fault (400), never honoured;
//   * the additive `grants` form [{roleKey, organizationId|null}] carries
//     per-grant scope — scoped callers may confer roles scoped INTO their own
//     orgs only (null-org and out-of-scope entries are 400s);
//   * every role-grant validation fails FAST — before the user row exists.
// Written tests-first: on the pre-202 server a scoped inviter's grantFullAdmin
// settled a GLOBAL grant (privilege escalation), so every scoped negative
// and every grants-form positive below is RED by behaviour, not by import.
Deno.test("invite/approve role-grant authority (addendum-202): global administrators reach all organisations, scoped administrators only their own", async (t) => {
  const runTag = crypto.randomUUID().slice(0, 8);
  let admin: { id: string; email: string };
  let adminSession: string;
  let orgA: string;
  let orgB: string;
  let scopedAdmin: { id: string; email: string };
  let scopedSession: string;

  await t.step("setup: global admin, live orgs A/B, and a user_admin scoped to Org A only", async () => {
    await wipeDatabase();
    admin = await createAdmin("GrantScope!2026");
    adminSession = (await loginAs(admin.email, "GrantScope!2026") as any).session;
    assertExists(adminSession);
    orgA = (await createOrganization({ name: `GS Org A ${runTag}`, shortCode: "GA", createdBy: admin.id })).id;
    orgB = (await createOrganization({ name: `GS Org B ${runTag}`, shortCode: "GB", createdBy: admin.id })).id;

    scopedAdmin = await createActiveUser({
      fullName: "Scoped User Admin", email: uniqueEmail("scoped-ua"), password: "ScopedUa!2026", affiliation: "agency",
    });
    await addOrgMembership({ organizationId: orgA, userId: scopedAdmin.id, addedBy: admin.id });
    await grantAdminRole(scopedAdmin.id, "user_admin", admin.id, "addendum-202 fixture", orgA);
    scopedSession = (await loginAs(scopedAdmin.email, "ScopedUa!2026") as any).session;
    assertExists(scopedSession);
  });

  // ── Global administrator arm — reaches ALL organisations ────────────────

  await t.step("global admin: grantFullAdmin settles a GLOBAL (organizationId null) full_admin grant", async () => {
    const email = uniqueEmail("gs-global-fa");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: { fullName: "GS Global FA", email, affiliation: "agency", notify: false, grantFullAdmin: true },
    });
    assertEquals(res.status, 201);
    const { userId } = await res.json();
    const grants = await listAdminRoleGrants(userId, false);
    assertEquals(
      grants.some((g) => g.roleKey === "full_admin" && g.organizationId === null),
      true,
      "a global administrator's grantFullAdmin must settle the global full_admin grant",
    );
  });

  await t.step("global admin: the grants form confers a global grant AND a scoped grant into ANY organisation", async () => {
    const email = uniqueEmail("gs-global-grants");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        fullName: "GS Global Grants", email, affiliation: "agency", notify: false,
        grants: [
          { roleKey: "user_admin", organizationId: null },
          { roleKey: "org_structure_admin", organizationId: orgB },
        ],
      },
    });
    assertEquals(res.status, 201);
    const { userId } = await res.json();
    const grants = await listAdminRoleGrants(userId, false);
    assertEquals(grants.some((g) => g.roleKey === "user_admin" && g.organizationId === null), true);
    assertEquals(
      grants.some((g) => g.roleKey === "org_structure_admin" && g.organizationId === orgB),
      true,
      "the global administrator may scope a role into any organisation — Org B here, outside any fixture membership",
    );
  });

  await t.step("schema (either-or): grants combined with grantFullAdmin or roleKeys → 400", async () => {
    const withFullAdmin = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        fullName: "GS Mixed Form", email: uniqueEmail("gs-mixed-1"), affiliation: "agency", notify: false,
        grantFullAdmin: true,
        grants: [{ roleKey: "user_admin", organizationId: orgA }],
      },
    });
    assertEquals(withFullAdmin.status, 400, "grants + grantFullAdmin is the ambiguous mixed form");
    const withRoleKeys = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        fullName: "GS Mixed Form", email: uniqueEmail("gs-mixed-2"), affiliation: "agency", notify: false,
        roleKeys: ["user_admin"],
        grants: [{ roleKey: "user_admin", organizationId: orgA }],
      },
    });
    assertEquals(withRoleKeys.status, 400, "grants + roleKeys is the ambiguous mixed form");
  });

  // ── Org-scoped administrator arm — only their own organisations ──────────

  await t.step("scoped admin: plain invite with an in-scope membership still succeeds (no roles requested)", async () => {
    const email = uniqueEmail("gs-scoped-plain");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: { fullName: "GS Scoped Plain", email, affiliation: "agency", notify: false, organizationIds: [orgA] },
    });
    assertEquals(res.status, 201, "the scoped invite + in-scope membership flow is unchanged");
  });

  await t.step("scoped admin: grants form into an IN-SCOPE organisation succeeds and settles only the scoped grant", async () => {
    const email = uniqueEmail("gs-scoped-grants");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: {
        fullName: "GS Scoped Grants", email, affiliation: "agency", notify: false,
        organizationIds: [orgA],
        grants: [{ roleKey: "user_admin", organizationId: orgA }],
      },
    });
    assertEquals(res.status, 201, "an org-scoped administrator may confer roles scoped into their own organisation");
    const { userId } = await res.json();
    const grants = await listAdminRoleGrants(userId, false);
    assertEquals(grants.length, 1);
    assertEquals(grants[0].roleKey, "user_admin");
    assertEquals(grants[0].organizationId, orgA, "the grant must be anchored to the inviter's organisation — never global");
  });

  await t.step("scoped admin: grantFullAdmin is a caller fault (400) and creates NO user", async () => {
    const email = uniqueEmail("gs-scoped-fa");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: { fullName: "GS Scoped FA", email, affiliation: "agency", notify: false, grantFullAdmin: true },
    });
    assertEquals(res.status, 400, "a scoped inviter requesting a global grant is the escalation this contract closes");
    assertEquals((await res.json()).error, "Global role grants are outside your granted organisations.");
    assertEquals(
      await users.findActiveByEmail(email),
      null,
      "the guard must fire BEFORE the user row exists — a failed invite never leaves an orphan account",
    );
  });

  await t.step("scoped admin: the legacy global roleKeys form → 400 (same global-grant rejection)", async () => {
    const email = uniqueEmail("gs-scoped-rk");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: { fullName: "GS Scoped RK", email, affiliation: "agency", notify: false, roleKeys: ["user_admin"] },
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "Global role grants are outside your granted organisations.");
    assertEquals(await users.findActiveByEmail(email), null);
  });

  await t.step("scoped admin: a grants entry with organizationId null IS a global grant → 400", async () => {
    const email = uniqueEmail("gs-scoped-nullorg");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: {
        fullName: "GS Scoped NullOrg", email, affiliation: "agency", notify: false,
        grants: [{ roleKey: "user_admin", organizationId: null }],
      },
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "Global role grants are outside your granted organisations.");
    assertEquals(await users.findActiveByEmail(email), null);
  });

  await t.step("scoped admin: a grants entry into an OUT-OF-SCOPE organisation → 400", async () => {
    const email = uniqueEmail("gs-scoped-out");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: {
        fullName: "GS Scoped Out", email, affiliation: "agency", notify: false,
        grants: [{ roleKey: "user_admin", organizationId: orgB }],
      },
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "Role-grant organisations are outside your granted organisations.");
    assertEquals(await users.findActiveByEmail(email), null);
  });

  await t.step("scoped admin: out-of-scope membership organizationIds → 400 (invite-side pin of the approve twin's guard)", async () => {
    const email = uniqueEmail("gs-scoped-member");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: { fullName: "GS Scoped Member", email, affiliation: "agency", notify: false, organizationIds: [orgB] },
    });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "Organisation selection is outside your granted organisations.");
    assertEquals(await users.findActiveByEmail(email), null);
  });

  await t.step("scoped admin: duplicate (role, organisation) grant entries → 400, never a double-insert 500", async () => {
    const email = uniqueEmail("gs-scoped-dup");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: {
        fullName: "GS Scoped Dup", email, affiliation: "agency", notify: false,
        grants: [
          { roleKey: "user_admin", organizationId: orgA },
          { roleKey: "user_admin", organizationId: orgA },
        ],
      },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("duplicate"), true);
    assertEquals(await users.findActiveByEmail(email), null);
  });

  await t.step("scoped admin: vendor invite carrying grantFullAdmin stays a silent no-op (agency-gating parity)", async () => {
    const email = uniqueEmail("gs-scoped-vendor");
    const res = await req("/admin/users/invite", {
      method: "POST", headers: authHeaders(scopedSession),
      body: { fullName: "GS Scoped Vendor", email, affiliation: "vendor", notify: false, grantFullAdmin: true },
    });
    assertEquals(res.status, 201, "role requests are silently dropped for non-agency invites today — parity is preserved");
    const { userId } = await res.json();
    const grants = await listAdminRoleGrants(userId, false);
    assertEquals(grants.length, 0);
  });

  // ── Approve twin — the same SG family must behave identically ───────────

  await t.step("approve: scoped approver + grantFullAdmin → 400 and the user stays pending", async () => {
    const signup = await req("/auth/signup", {
      method: "POST", body: { fullName: "GS Pending FA", email: uniqueEmail("gs-pending-fa"), password: "ValidPass!2026" },
    });
    const { userId: pendingId } = await signup.json();
    assertExists(pendingId);

    const res = await req(`/admin/users/${pendingId}/approve`, {
      method: "POST", headers: authHeaders(scopedSession),
      body: { affiliation: "agency", organizationIds: [orgA], grantFullAdmin: true },
    });
    assertEquals(res.status, 400, "approve shares resolveDesiredRoleKeys — the same global-grant rejection applies");
    assertEquals((await res.json()).error, "Global role grants are outside your granted organisations.");
    const rows = await query<{ status: string }>(`SELECT status FROM users WHERE id = $1`, [pendingId]);
    assertEquals(rows[0].status, "pending_approval", "a rejected role-grant request must not approve the user either (fail-fast)");
  });

  await t.step("approve: scoped approver + in-scope grants form → 200 and settles the scoped grant", async () => {
    const signup = await req("/auth/signup", {
      method: "POST", body: { fullName: "GS Pending Grants", email: uniqueEmail("gs-pending-grants"), password: "ValidPass!2026" },
    });
    const { userId: pendingId } = await signup.json();
    assertExists(pendingId);

    const res = await req(`/admin/users/${pendingId}/approve`, {
      method: "POST", headers: authHeaders(scopedSession),
      body: { affiliation: "agency", organizationIds: [orgA], grants: [{ roleKey: "user_admin", organizationId: orgA }] },
    });
    assertEquals(res.status, 200, "an org-scoped approver may confer roles scoped into their own organisation");
    const grants = await listAdminRoleGrants(pendingId, false);
    assertEquals(grants.some((g) => g.roleKey === "user_admin" && g.organizationId === orgA), true);
    assertEquals(grants.some((g) => g.organizationId === null), false);
  });

  await t.step("approve: global admin + grants form into ANY organisation → 200", async () => {
    const signup = await req("/auth/signup", {
      method: "POST", body: { fullName: "GS Pending Global", email: uniqueEmail("gs-pending-global"), password: "ValidPass!2026" },
    });
    const { userId: pendingId } = await signup.json();
    assertExists(pendingId);

    const res = await req(`/admin/users/${pendingId}/approve`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { affiliation: "agency", organizationIds: [orgA], grants: [{ roleKey: "org_structure_admin", organizationId: orgB }] },
    });
    assertEquals(res.status, 200);
    const grants = await listAdminRoleGrants(pendingId, false);
    assertEquals(grants.some((g) => g.roleKey === "org_structure_admin" && g.organizationId === orgB), true);
  });
});
