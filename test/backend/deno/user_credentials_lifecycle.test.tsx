// Coverage: credential-lifecycle control surfaces (addendum-076) — the
// previously-missing interfaces:
//   • POST /auth/change-password — self-service password change (was: NO way
//     for a user to change their password once set).
//   • POST /admin/users/:id/reset-2fa — admin 2FA lockout recovery (was: NO
//     admin surface to clear a user's TOTP enrollment).
//   • POST /admin/users/:id/reset-password — admin temporary-password
//     issuance + forced rotation (was: NO admin password reset).
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
} from "./helpers.tsx";
import { users, sessions, now } from "../../../server/db.tsx";
import { verifyPassword } from "../../../server/utils.tsx";
import { createSession } from "../../../server/auth.tsx";

Deno.test("user_credentials_lifecycle", async (t) => {
  let adminSession: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("CredAdmin!2026");
    const login = await loginAs(admin.email, "CredAdmin!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
    adminSession = login.session;
  });

  // ── Self-service password change ───────────────────────────────────────────

  await t.step("change-password: negative — unauthenticated → 401", async () => {
    const res = await req("/auth/change-password", {
      method: "POST",
      body: { currentPassword: "x", newPassword: "NewPass!2026" },
    });
    assertEquals(res.status, 401);
  });

  await t.step("change-password: positive — changes password, clears force rotation, revokes other sessions", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("Changer"), email: uniqueEmail("chg"), password: "OldPass!2026", affiliation: "agency",
    });
    // Simulate a forced-rotation flag (e.g. after an admin reset).
    await users.update(user.id, { forcePasswordRotation: true });

    // Two concurrent sessions: the one we change through, plus a second
    // "other" session. Under single-session sign-in (addendum-097) a second
    // LOGIN would invalidate sessionA outright, so the "other" session is
    // minted directly — createSession stays deliberately non-exclusive while
    // every interactive sign-in path goes through createSessionExclusive.
    const loginA = await loginAs(user.email, "OldPass!2026");
    const sessionA = "error" in loginA ? "" : loginA.session;
    const sessionB = await createSession(user.id);
    assertExists(sessionA);
    assertExists(sessionB);

    const res = await req("/auth/change-password", {
      method: "POST",
      headers: authHeaders(sessionA),
      body: { currentPassword: "OldPass!2026", newPassword: "NewPass!2026" },
    });
    assertEquals(res.status, 200);

    const after = await users.get(user.id);
    assertEquals(after!.forcePasswordRotation, false);
    assertEquals(await verifyPassword("NewPass!2026", after!.passwordSalt ?? "", after!.passwordHash), true);

    // Session A survives; session B is revoked.
    assertEquals((await sessions.get(sessionA)) !== null, true);
    assertEquals((await sessions.get(sessionB)) === null, true);

    // Old password no longer works.
    const oldLogin = await req("/auth/login", { method: "POST", body: { email: user.email, password: "OldPass!2026" } });
    assertEquals(oldLogin.status, 401);
  });

  await t.step("change-password: negative — wrong current password → 400", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("WrongCur"), email: uniqueEmail("wc"), password: "OldPass!2026", affiliation: "agency",
    });
    const login = await loginAs(user.email, "OldPass!2026");
    const session = "error" in login ? "" : login.session;
    const res = await req("/auth/change-password", {
      method: "POST",
      headers: authHeaders(session),
      body: { currentPassword: "not-the-password", newPassword: "NewPass!2026" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("change-password: negative — weak / same-as-current new password → 400", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("WeakNew"), email: uniqueEmail("wn"), password: "OldPass!2026", affiliation: "agency",
    });
    const login = await loginAs(user.email, "OldPass!2026");
    const session = "error" in login ? "" : login.session;

    const weak = await req("/auth/change-password", {
      method: "POST",
      headers: authHeaders(session),
      body: { currentPassword: "OldPass!2026", newPassword: "short" },
    });
    assertEquals(weak.status, 400);

    const same = await req("/auth/change-password", {
      method: "POST",
      headers: authHeaders(session),
      body: { currentPassword: "OldPass!2026", newPassword: "OldPass!2026" },
    });
    assertEquals(same.status, 400);
  });

  // ── Admin 2FA reset ────────────────────────────────────────────────────────

  await t.step("reset-2fa: positive — admin clears TOTP enrollment and revokes sessions", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("LockedOut"), email: uniqueEmail("lo"), password: "LockedOut!2026", affiliation: "agency",
    });
    await users.update(user.id, { totpSecret: "BASE32SECRET", totpEnrolledAt: now() });
    const login = await loginAs(user.email, "LockedOut!2026");
    const session = "error" in login ? "" : login.session;
    assertExists(session);
    assertEquals((await sessions.findByUser(user.id)).length >= 1, true);

    const res = await req(`/admin/users/${user.id}/reset-2fa`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);

    const after = await users.get(user.id);
    assertEquals(after!.totpSecret, null);
    assertEquals(after!.totpEnrolledAt, null);
    assertEquals((await sessions.findByUser(user.id)).length, 0);
  });

  await t.step("reset-2fa: negative — non-admin forbidden; no-enrollment → 400", async () => {
    // enroll2fa:false — this step asserts the no-enrollment 400 path, so the
    // user must have no totp_secret/totp_enrolled_at. The non-admin 403 check
    // below still holds: the unverified session trips the twofa_required gate
    // before requireAdmin runs.
    const user = await createActiveUser({
      fullName: uniqueName("NoEnroll"), email: uniqueEmail("ne"), password: "NoEnroll!2026", affiliation: "agency",
      enroll2fa: false,
    });
    const login = await loginAs(user.email, "NoEnroll!2026");
    const session = "error" in login ? "" : login.session;

    const nonAdmin = await req(`/admin/users/${user.id}/reset-2fa`, { method: "POST", headers: authHeaders(session) });
    assertEquals(nonAdmin.status, 403);

    const noEnroll = await req(`/admin/users/${user.id}/reset-2fa`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(noEnroll.status, 400);
  });

  // ── Admin password reset ───────────────────────────────────────────────────

  await t.step("reset-password: positive — issues temp password, forces rotation, revokes sessions", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("ForgotIt"), email: uniqueEmail("fi"), password: "ForgotIt!2026", affiliation: "agency",
    });
    const login = await loginAs(user.email, "ForgotIt!2026");
    const session = "error" in login ? "" : login.session;
    assertExists(session);

    const res = await req(`/admin/users/${user.id}/reset-password`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.tempPassword);
    assertEquals(typeof data.tempPassword, "string");
    assertEquals(data.tempPassword.length >= 12, true);

    const after = await users.get(user.id);
    assertEquals(after!.forcePasswordRotation, true);
    assertEquals(await verifyPassword(data.tempPassword, after!.passwordSalt ?? "", after!.passwordHash), true);
    // Old password dead + sessions revoked.
    assertEquals(await verifyPassword("ForgotIt!2026", after!.passwordSalt ?? "", after!.passwordHash), false);
    assertEquals((await sessions.findByUser(user.id)).length, 0);

    // The temp password actually logs the user in (and login doesn't reject it).
    const tempLogin = await req("/auth/login", { method: "POST", body: { email: user.email, password: data.tempPassword } });
    assertEquals(tempLogin.status, 200);
  });

  await t.step("reset-password: negative — non-admin forbidden", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("NR"), email: uniqueEmail("nr"), password: "NRPass!2026", affiliation: "agency",
    });
    const login = await loginAs(user.email, "NRPass!2026");
    const session = "error" in login ? "" : login.session;
    const res = await req(`/admin/users/${user.id}/reset-password`, { method: "POST", headers: authHeaders(session) });
    assertEquals(res.status, 403);
  });
});
