// Coverage: GET /auth/2fa/enroll, POST /auth/2fa/verify, and the login
// response's needs2faEnrollment / needs2faVerification flags. Real TOTP
// codes throughout — no mocks: every code is computed with the same otpauth
// library the server validates against (addendum-046-totp-2fa.md).
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createActiveUser, uniqueEmail,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { currentTotp, verifyTotp } from "../../../server/twofa.tsx";
import * as OTPAuth from "npm:otpauth";

// Parse the base32 secret out of an otpauth:// URI.
function secretFromUri(uri: string): string {
  return new URL(uri).searchParams.get("secret")!;
}

Deno.test("twofa", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  // ── twofa.tsx unit-level (pure) ─────────────────────────────────────────

  await t.step("verifyTotp: accepts a live code, rejects a wrong one", () => {
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    assertEquals(verifyTotp(secret, currentTotp(secret)), true);
    assertEquals(verifyTotp(secret, "000000"), false);
    assertEquals(verifyTotp(secret, ""), false);
    assertEquals(verifyTotp("", "123456"), false);
  });

  // ── login flags ─────────────────────────────────────────────────────────

  await t.step("login: an un-enrolled user gets needs2faEnrollment=true", async () => {
    const email = uniqueEmail("enroll-flag");
    await createActiveUser({
      fullName: "Enroll Flag", email, password: "EnrollFlag!2026", affiliation: "vendor", enroll2fa: false,
    });
    const res = await req("/auth/login", { method: "POST", body: { email, password: "EnrollFlag!2026" } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.needs2faEnrollment, true);
    assertEquals(data.needs2faVerification, false);
    // Secret must never leave the server.
    assertEquals(data.user.totpSecret, undefined);
  });

  await t.step("login: an enrolled user gets needs2faVerification=true", async () => {
    const email = uniqueEmail("verify-flag");
    await createActiveUser({
      fullName: "Verify Flag", email, password: "VerifyFlag!2026", affiliation: "vendor", // enrolled by default
    });
    const res = await req("/auth/login", { method: "POST", body: { email, password: "VerifyFlag!2026" } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.needs2faEnrollment, false);
    assertEquals(data.needs2faVerification, true);
  });

  // ── enrollment flow ───────────────────────────────────────────────────────

  await t.step("enroll: positive — returns QR + URI + secret and stashes a provisional secret on the session", async () => {
    const email = uniqueEmail("enroll");
    await createActiveUser({
      fullName: "Enroll User", email, password: "EnrollUser!2026", affiliation: "vendor", enroll2fa: false,
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "EnrollUser!2026" } });
    const { session } = await login.json();

    const res = await req("/auth/2fa/enroll", { headers: authHeaders(session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.qrDataUrl);
    assertEquals(data.qrDataUrl.startsWith("data:image/png;base64,"), true);
    assertExists(data.otpauthUri);
    assertEquals(data.otpauthUri.startsWith("otpauth://totp/"), true);
    assertExists(data.secretBase32);
    // The URI carries the same secret the body returns.
    assertEquals(secretFromUri(data.otpauthUri), data.secretBase32);

    // Provisional secret is on the SESSION row, NOT on the users row yet.
    const sessRows = await query<{ pending_totp_secret: string }>(
      `SELECT pending_totp_secret FROM sessions WHERE id = $1`, [session],
    );
    assertEquals(sessRows[0].pending_totp_secret, data.secretBase32);
    const userRows = await query<{ totp_secret: string | null }>(
      `SELECT totp_secret FROM users WHERE email = $1`, [email],
    );
    assertEquals(userRows[0].totp_secret, null);
  });

  await t.step("verify (enrollment): positive — a live code confirms the secret onto the user + verifies the session", async () => {
    const email = uniqueEmail("enroll-verify");
    await createActiveUser({
      fullName: "Enroll Verify", email, password: "EnrollVerify!2026", affiliation: "vendor", enroll2fa: false,
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "EnrollVerify!2026" } });
    const { session } = await login.json();

    const enroll = await req("/auth/2fa/enroll", { headers: authHeaders(session) });
    const { secretBase32 } = await enroll.json();

    const res = await req("/auth/2fa/verify", {
      method: "POST", headers: authHeaders(session), body: { code: currentTotp(secretBase32) },
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.verified, true);
    assertEquals(data.enrolled, true);

    // Secret confirmed onto the user row; pending cleared; session verified.
    const userRows = await query<{ totp_secret: string; totp_enrolled_at: string }>(
      `SELECT totp_secret, totp_enrolled_at FROM users WHERE email = $1`, [email],
    );
    assertEquals(userRows[0].totp_secret, secretBase32);
    assertExists(userRows[0].totp_enrolled_at);
    const sessRows = await query<{ pending_totp_secret: string | null; twofa_verified_at: string | null }>(
      `SELECT pending_totp_secret, twofa_verified_at FROM sessions WHERE id = $1`, [session],
    );
    assertEquals(sessRows[0].pending_totp_secret, null);
    assertExists(sessRows[0].twofa_verified_at);
  });

  await t.step("verify (enrollment): negative — wrong code rejected 400, nothing confirmed", async () => {
    const email = uniqueEmail("enroll-wrong");
    await createActiveUser({
      fullName: "Enroll Wrong", email, password: "EnrollWrong!2026", affiliation: "vendor", enroll2fa: false,
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "EnrollWrong!2026" } });
    const { session } = await login.json();
    await req("/auth/2fa/enroll", { headers: authHeaders(session) });

    const res = await req("/auth/2fa/verify", {
      method: "POST", headers: authHeaders(session), body: { code: "000000" },
    });
    assertEquals(res.status, 400);
    const userRows = await query<{ totp_secret: string | null }>(
      `SELECT totp_secret FROM users WHERE email = $1`, [email],
    );
    assertEquals(userRows[0].totp_secret, null);
  });

  await t.step("verify: negative — malformed (non-6-digit) code rejected 400", async () => {
    const email = uniqueEmail("badcode");
    await createActiveUser({
      fullName: "Bad Code", email, password: "BadCode!2026", affiliation: "vendor", enroll2fa: false,
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "BadCode!2026" } });
    const { session } = await login.json();
    await req("/auth/2fa/enroll", { headers: authHeaders(session) });

    for (const bad of ["123", "12345a", "1234567", ""]) {
      const res = await req("/auth/2fa/verify", {
        method: "POST", headers: authHeaders(session), body: { code: bad },
      });
      assertEquals(res.status, 400);
    }
  });

  await t.step("verify: negative — no enrollment in progress (never called enroll) rejected 400", async () => {
    const email = uniqueEmail("noenroll");
    await createActiveUser({
      fullName: "No Enroll", email, password: "NoEnroll!2026", affiliation: "vendor", enroll2fa: false,
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "NoEnroll!2026" } });
    const { session } = await login.json();
    // Skip /auth/2fa/enroll entirely — a real 6-digit-shaped code but no
    // provisional secret to check it against.
    const res = await req("/auth/2fa/verify", {
      method: "POST", headers: authHeaders(session), body: { code: "123456" },
    });
    assertEquals(res.status, 400);
  });

  // ── returning-user flow ─────────────────────────────────────────────────

  await t.step("verify (returning): positive — an already-enrolled user verifies against their stored secret", async () => {
    const email = uniqueEmail("returning");
    await createActiveUser({
      fullName: "Returning User", email, password: "Returning!2026", affiliation: "vendor", // enrolled
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "Returning!2026" } });
    const { session, needs2faVerification } = await login.json();
    assertEquals(needs2faVerification, true);

    // Read the stored secret to compute the live code (a real authenticator
    // app would hold this; the test stands in for it).
    const rows = await query<{ totp_secret: string }>(`SELECT totp_secret FROM users WHERE email = $1`, [email]);
    const res = await req("/auth/2fa/verify", {
      method: "POST", headers: authHeaders(session), body: { code: currentTotp(rows[0].totp_secret) },
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.verified, true);
    assertEquals(data.enrolled, false); // returning, not enrolling
    const sessRows = await query<{ twofa_verified_at: string | null }>(
      `SELECT twofa_verified_at FROM sessions WHERE id = $1`, [session],
    );
    assertExists(sessRows[0].twofa_verified_at);
  });

  await t.step("verify (returning): negative — wrong code rejected, session stays unverified", async () => {
    const email = uniqueEmail("returning-wrong");
    await createActiveUser({
      fullName: "Returning Wrong", email, password: "ReturningWrong!2026", affiliation: "vendor",
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "ReturningWrong!2026" } });
    const { session } = await login.json();
    const res = await req("/auth/2fa/verify", {
      method: "POST", headers: authHeaders(session), body: { code: "000000" },
    });
    assertEquals(res.status, 400);
    const sessRows = await query<{ twofa_verified_at: string | null }>(
      `SELECT twofa_verified_at FROM sessions WHERE id = $1`, [session],
    );
    assertEquals(sessRows[0].twofa_verified_at, null);
  });

  // ── auth negatives ────────────────────────────────────────────────────────

  await t.step("enroll: negative — unauthenticated 401", async () => {
    const res = await req("/auth/2fa/enroll");
    assertEquals(res.status, 401);
  });

  await t.step("verify: negative — unauthenticated 401", async () => {
    const res = await req("/auth/2fa/verify", { method: "POST", body: { code: "123456" }, headers: { "X-Idempotency-Token": "x" } });
    assertEquals(res.status, 401);
  });

  // Session-scoping (IDOR): one session's verify can only affect ITS OWN
  // session row + ITS OWN user — there is no id parameter to substitute, so
  // user A's verify can never mark user B's session verified. Prove the
  // pending secret + verified flag land only on the acting session.
  await t.step("verify: session-scoped — user A's verify does not touch user B's session", async () => {
    const emailA = uniqueEmail("scope-a");
    const emailB = uniqueEmail("scope-b");
    await createActiveUser({ fullName: "Scope A", email: emailA, password: "ScopeA!2026", affiliation: "vendor" });
    await createActiveUser({ fullName: "Scope B", email: emailB, password: "ScopeB!2026", affiliation: "vendor" });

    const loginB = await req("/auth/login", { method: "POST", body: { email: emailB, password: "ScopeB!2026" } });
    const sessionB = (await loginB.json()).session;

    const loginA = await req("/auth/login", { method: "POST", body: { email: emailA, password: "ScopeA!2026" } });
    const sessionA = (await loginA.json()).session;
    const rowsA = await query<{ totp_secret: string }>(`SELECT totp_secret FROM users WHERE email = $1`, [emailA]);
    const resA = await req("/auth/2fa/verify", {
      method: "POST", headers: authHeaders(sessionA), body: { code: currentTotp(rowsA[0].totp_secret) },
    });
    assertEquals(resA.status, 200);

    // B's session is untouched — still unverified.
    const sessB = await query<{ twofa_verified_at: string | null }>(
      `SELECT twofa_verified_at FROM sessions WHERE id = $1`, [sessionB],
    );
    assertEquals(sessB[0].twofa_verified_at, null);
  });

  // ── central gate: twofa_required enforcement ────────────────────────────

  await t.step("gate: an operational route rejects a valid-but-unverified session with 403 twofa_required", async () => {
    const email = uniqueEmail("gate-unverified");
    await createActiveUser({
      fullName: "Gate Unverified", email, password: "GateUnverified!2026", affiliation: "vendor",
    });
    // Log in but DO NOT complete 2FA verify (bypass loginAs, which would).
    const login = await req("/auth/login", { method: "POST", body: { email, password: "GateUnverified!2026" } });
    const { session, needs2faVerification } = await login.json();
    assertEquals(needs2faVerification, true);

    const res = await req("/requests/my-requests", { headers: authHeaders(session) });
    assertEquals(res.status, 403);
    const data = await res.json();
    assertEquals(data.code, "twofa_required");

    // /me/capability-snapshot is allowlisted (addendum-047): reachable before
    // 2FA verification completes so the frontend can obtain an idempotency
    // token for the 2FA verify request itself.
    const snapshot = await req("/me/capability-snapshot", { headers: authHeaders(session) });
    assertEquals(snapshot.status, 200);
  });

  await t.step("verify: five incorrect TOTP codes atomically invalidate the session", async () => {
    const email = uniqueEmail("twofa-attempt-limit");
    const user = await createActiveUser({
      fullName: "2FA Attempt Limit",
      email,
      password: "AttemptLimit!2026",
      affiliation: "vendor",
    });
    const liveCode = currentTotp(user.totpSecret!);
    const wrongCode = liveCode === "000000" ? "999999" : "000000";
    const login = await req("/auth/login", {
      method: "POST",
      body: { email, password: "AttemptLimit!2026" },
    });
    const { session } = await login.json();
    for (let attempt = 1; attempt <= 4; attempt++) {
      const wrong = await req("/auth/2fa/verify", {
        method: "POST",
        headers: authHeaders(session),
        body: { code: wrongCode },
      });
      assertEquals(wrong.status, 400);
    }
    const blocked = await req("/auth/2fa/verify", {
      method: "POST",
      headers: authHeaders(session),
      body: { code: wrongCode },
    });
    assertEquals(blocked.status, 429);
    assertEquals((await blocked.json()).code, "twofa_attempts_exceeded");
    const gone = await query(`SELECT id FROM sessions WHERE id = $1`, [session]);
    assertEquals(gone.length, 0);
  });

  await t.step("gate: the same session passes once 2FA is verified", async () => {
    const email = uniqueEmail("gate-verified");
    await createActiveUser({
      fullName: "Gate Verified", email, password: "GateVerified!2026", affiliation: "vendor",
    });
    const login = await req("/auth/login", { method: "POST", body: { email, password: "GateVerified!2026" } });
    const { session } = await login.json();
    // Blocked before verification…
    const before = await req("/requests/my-requests", { headers: authHeaders(session) });
    assertEquals(before.status, 403);

    // …complete the real verify step…
    const rows = await query<{ totp_secret: string }>(`SELECT totp_secret FROM users WHERE email = $1`, [email]);
    const verify = await req("/auth/2fa/verify", {
      method: "POST", headers: authHeaders(session), body: { code: currentTotp(rows[0].totp_secret) },
    });
    assertEquals(verify.status, 200);

    // …now the SAME session passes the gate.
    const after = await req("/requests/my-requests", { headers: authHeaders(session) });
    assertEquals(after.status, 200);
  });
});
