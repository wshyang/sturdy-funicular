// Coverage: POST /auth/signup, POST /auth/login, POST /auth/logout,
// GET /auth/me, GET /me/capability-snapshot.
import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, uniqueEmail,
  latestSentNotification, sentNotificationEmailSnapshots,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { generateSalt, hashPassword, verifyPassword } from "../../../server/utils.tsx";

Deno.test("auth", async (t) => {
  let signupNotifyAdmin: { email: string };

  await t.step("setup", async () => {
    await wipeDatabase();
    signupNotifyAdmin = await createAdmin("SignupNotifyAdminPass!2026");
  });

  await t.step("signup: positive — creates pending_approval user", async () => {
    const email = uniqueEmail("signup");
    const res = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "New Signup", email, password: "ValidPass!2026" },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertExists(data.userId);

    // Email notification (addendum-044) #17 — all active admins.
    const signupEmail = await latestSentNotification("user.signup_pending_admins");
    assertExists(signupEmail);
    assertEquals(sentNotificationEmailSnapshots(signupEmail), [signupNotifyAdmin.email]);
  });

  await t.step("signup: negative — missing fields", async () => {
    const res = await req("/auth/signup", { method: "POST", body: { email: "x@test.local" } });
    assertEquals(res.status, 400);
  });

  await t.step("signup: negative — invalid email format", async () => {
    const res = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "Bad Email", email: "not-an-email", password: "ValidPass!2026" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("signup: negative — weak password rejected", async () => {
    const res = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "Weak Pw", email: uniqueEmail("weak"), password: "weak" },
    });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertExists(data.error);
  });

  await t.step("signup: negative — duplicate active email rejected", async () => {
    const email = uniqueEmail("dup");
    const first = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "First", email, password: "ValidPass!2026" },
    });
    assertEquals(first.status, 201);
    const second = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "Second", email, password: "ValidPass!2026" },
    });
    assertEquals(second.status, 400);
  });

  await t.step("login: negative — pending_approval account blocked", async () => {
    const email = uniqueEmail("pending");
    await req("/auth/signup", { method: "POST", body: { fullName: "Pending", email, password: "ValidPass!2026" } });
    const res = await req("/auth/login", { method: "POST", body: { email, password: "ValidPass!2026" } });
    assertEquals(res.status, 403);
  });

  await t.step("login: negative — wrong password generic error", async () => {
    const admin = await createAdmin("CorrectPass!2026");
    const res = await req("/auth/login", { method: "POST", body: { email: admin.email, password: "WrongPass!2026" } });
    assertEquals(res.status, 401);
    const data = await res.json();
    assertEquals(data.error, "Invalid email or password.");
  });

  await t.step("login: negative — unknown email generic error (no enumeration)", async () => {
    const res = await req("/auth/login", { method: "POST", body: { email: "nobody@test.local", password: "Whatever!2026" } });
    assertEquals(res.status, 401);
    const data = await res.json();
    assertEquals(data.error, "Invalid email or password.");
  });

  await t.step("login: negative — missing fields", async () => {
    const res = await req("/auth/login", { method: "POST", body: { email: "x@test.local" } });
    assertEquals(res.status, 400);
  });

  await t.step("login: explicit bearer client receives session + sanitized user", async () => {
    const admin = await createAdmin("LoginPass!2026");
    const res = await req("/auth/login", { method: "POST", body: { email: admin.email, password: "LoginPass!2026" } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.session);
    assertEquals(data.user.email, admin.email);
    assertEquals(data.user.passwordHash, undefined);
    assertEquals(data.user.passwordSalt, undefined);
  });

  await t.step("login: browser transport omits bearer material from JSON", async () => {
    const admin = await createAdmin("CookieOnlyPass!2026");
    const res = await req("/auth/login", {
      method: "POST",
      headers: { "X-Session-Transport": "cookie" },
      body: { email: admin.email, password: "CookieOnlyPass!2026" },
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals("session" in data, false);
    assertEquals(data.user.email, admin.email);
  });

  await t.step("auth/me: positive — returns current user for valid session", async () => {
    const admin = await createAdmin("MePass!2026");
    const login = await req("/auth/login", { method: "POST", body: { email: admin.email, password: "MePass!2026" } });
    const { session } = await login.json();
    const res = await req("/auth/me", { headers: authHeaders(session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.user.id, admin.id);
  });

  await t.step("auth/me: negative — no session token", async () => {
    const res = await req("/auth/me");
    assertEquals(res.status, 401);
  });

  await t.step("auth/me: negative — garbage session token", async () => {
    const res = await req("/auth/me", { headers: authHeaders("not-a-real-session") });
    assertEquals(res.status, 401);
  });

  await t.step("capability-snapshot: positive — admin sees is_admin true, visible_system_ids '*'", async () => {
    const admin = await createAdmin("SnapPass!2026");
    const login = await req("/auth/login", { method: "POST", body: { email: admin.email, password: "SnapPass!2026" } });
    const { session } = await login.json();
    const res = await req("/me/capability-snapshot", { headers: authHeaders(session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.snapshot.isAdmin, true);
    assertEquals(data.snapshot.visibleSystemIds, "*");
  });

  await t.step("capability-snapshot: negative — unauthenticated", async () => {
    const res = await req("/me/capability-snapshot");
    assertEquals(res.status, 401);
  });

  // Idempotency-token bootstrap: this GET is exempt from the enforcement
  // middleware, but mints a fresh token in the body on every call so the
  // frontend has a starting token without an extra round-trip. See
  // addendum-008-idempotency-tokens.md and idempotency.test.tsx for the
  // full enforcement-behavior matrix.
  await t.step("capability-snapshot: positive — response body includes a fresh idempotency_token", async () => {
    const admin = await createAdmin("SnapIdemPass!2026");
    const login = await req("/auth/login", { method: "POST", body: { email: admin.email, password: "SnapIdemPass!2026" } });
    const { session } = await login.json();
    const res = await req("/me/capability-snapshot", { headers: authHeaders(session) });
    const data = await res.json();
    assertExists(data.idempotencyToken);

    const res2 = await req("/me/capability-snapshot", { headers: authHeaders(session) });
    const data2 = await res2.json();
    assertExists(data2.idempotencyToken);
    // Each call mints a distinct token.
    assertEquals(data.idempotencyToken === data2.idempotencyToken, false);
  });

  await t.step("logout: positive — destroys session, subsequent /auth/me fails", async () => {
    const admin = await createAdmin("LogoutPass!2026");
    const login = await req("/auth/login", { method: "POST", body: { email: admin.email, password: "LogoutPass!2026" } });
    const { session } = await login.json();

    const before = await req("/auth/me", { headers: authHeaders(session) });
    assertEquals(before.status, 200);

    const logoutRes = await req("/auth/logout", { method: "POST", headers: authHeaders(session) });
    assertEquals(logoutRes.status, 200);

    const after = await req("/auth/me", { headers: authHeaders(session) });
    assertEquals(after.status, 401);
  });

  await t.step("login: negative — lockout after repeated failures", async () => {
    const admin = await createAdmin("LockoutPass!2026");
    for (let i = 0; i < 5; i++) {
      await req("/auth/login", { method: "POST", body: { email: admin.email, password: "WrongPass!2026" } });
    }
    const res = await req("/auth/login", { method: "POST", body: { email: admin.email, password: "LockoutPass!2026" } });
    assertEquals(res.status, 429);
  });

  // ── Per-user password salt (addendum-045) ──────────────────────────────
  // Each user row carries its own random salt; hashPassword(password, salt)
  // and a constant-time verifyPassword(password, salt, hash) replace the old
  // single global-salt scheme.

  await t.step("password-salt: signup stores a per-user salt and login round-trips through it", async () => {
    const email = uniqueEmail("salted");
    const password = "SaltedPass!2026";
    const signupRes = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "Salted User", email, password },
    });
    assertEquals(signupRes.status, 201);
    const { userId } = await signupRes.json();

    // A real, non-empty per-user salt was persisted…
    const rows = await query<{ password_salt: string; password_hash: string }>(
      `SELECT password_salt, password_hash FROM users WHERE id = $1`,
      [userId],
    );
    assertExists(rows[0]);
    assertNotEquals(rows[0].password_salt, "");
    // …and the stored hash is exactly hashPassword(password, thatSalt).
    assertEquals(rows[0].password_hash, await hashPassword(password, rows[0].password_salt));

    // Approve so the account can actually log in, then confirm the stored
    // salt+hash verify against the real password. Activation must also assign
    // an affiliation: users_affiliation_required_unless_system (migrations
    // 094/095) forbids an active, non-system user with no affiliation, and
    // /auth/signup deliberately does not collect one — affiliation is assigned
    // at approval time (addendum-109). Setting status alone now raises a check
    // constraint violation.
    await query(`UPDATE users SET status = 'active', affiliation = 'vendor' WHERE id = $1`, [userId]);
    const loginRes = await req("/auth/login", { method: "POST", body: { email, password } });
    assertEquals(loginRes.status, 200);
  });

  await t.step("password-salt: two users with the SAME password get DIFFERENT hashes", async () => {
    const password = "IdenticalPass!2026";
    const emailA = uniqueEmail("same-a");
    const emailB = uniqueEmail("same-b");
    await req("/auth/signup", { method: "POST", body: { fullName: "Same A", email: emailA, password } });
    await req("/auth/signup", { method: "POST", body: { fullName: "Same B", email: emailB, password } });

    const rows = await query<{ email: string; password_salt: string; password_hash: string }>(
      `SELECT email, password_salt, password_hash FROM users WHERE email = ANY($1)`,
      [[emailA, emailB]],
    );
    assertEquals(rows.length, 2);
    // Distinct salts → distinct hashes, defeating precomputation/rainbow
    // tables even for two users who happen to share a password.
    assertNotEquals(rows[0].password_salt, rows[1].password_salt);
    assertNotEquals(rows[0].password_hash, rows[1].password_hash);
  });

  await t.step("password-salt: verifyPassword accepts the right password, rejects the wrong one", async () => {
    const salt = generateSalt();
    const hash = await hashPassword("CorrectHorse!2026", salt);
    assertEquals(await verifyPassword("CorrectHorse!2026", salt, hash), true);
    assertEquals(await verifyPassword("WrongHorse!2026", salt, hash), false);
    // Wrong salt with the right password must also fail (salt is part of the
    // secret material, not a public constant).
    assertEquals(await verifyPassword("CorrectHorse!2026", generateSalt(), hash), false);
  });

  await t.step("password-salt: constant-time compare handles a same-length wrong hash without throwing", async () => {
    const salt = generateSalt();
    const hash = await hashPassword("BasePass!2026", salt);
    // A hex string of the exact same length but differing content — exercises
    // the constant-time comparison's equal-length path rather than an early
    // length-mismatch bail-out.
    const sameLenWrong = hash.split("").reverse().join("");
    assertEquals(sameLenWrong.length, hash.length);
    assertEquals(await verifyPassword("BasePass!2026", salt, sameLenWrong), false);
  });
});
