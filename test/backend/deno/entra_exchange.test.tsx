// Tests for POST /auth/entra/exchange (server/routes/auth-entra.tsx).
//
// The Entra callback lands on the backend, mints a short-lived one-time
// "handoff" code, and redirects the browser to the frontend, which posts that
// code here to collect the real session. So this endpoint converts a code that
// travelled through a URL into an authenticated session — the same class of
// secret as an OAuth authorization code, and it needs the same handling.
//
// routes/auth-entra.tsx sat at 41.9%. Most of the module is the OIDC exchange
// with a live tenant, but this handler is pure database work and carries the
// security-relevant contracts:
//
//   * The handoff code is SINGLE-USE and is consumed regardless of outcome —
//     the handler deletes it before validating, so a replay (or a race) cannot
//     mint a second session. That "delete before validate" ordering is
//     deliberate and worth a regression test.
//   * An expired code must be refused even though the row still exists.
//   * The response must never carry password hashes, salts or TOTP secrets.
//   * The 2FA hints derive from the SESSION, not merely the user's enrolment —
//     that is what lets trusted Entra MFA skip the local gate, and getting it
//     from the user alone would re-gate an already-strongly-authenticated
//     session.
import { assert, assertEquals } from "jsr:@std/assert";
import { createActiveUser, req, uniqueEmail, wipeDatabase } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { generateId } from "../../../server/db.tsx";

// Mint a session row directly; the Entra flow creates one before the handoff.
async function makeSession(
  userId: string,
  opts: { twofaVerified?: boolean; entraMfa?: boolean; strongAuthSource?: string | null } = {},
): Promise<string> {
  const id = generateId();
  await query(
    `INSERT INTO sessions
       (id, user_id, created_at, last_activity_at, twofa_verified_at, twofa_failed_attempts,
        expires_at, auth_method, entra_mfa_performed, strong_auth_source)
     VALUES ($1, $2, now(), now(), $3, 0, now() + interval '1 hour', 'entra', $4, $5)`,
    [
      id,
      userId,
      opts.twofaVerified ? new Date().toISOString() : null,
      opts.entraMfa ?? false,
      opts.strongAuthSource ?? null,
    ],
  );
  return id;
}

async function makeHandoff(sessionId: string, opts: { expired?: boolean } = {}): Promise<string> {
  const code = `handoff-${generateId()}`;
  await query(
    `INSERT INTO entra_handoffs (handoff, session_id, created_at, expires_at)
     VALUES ($1, $2, now(), $3)`,
    [code, sessionId, opts.expired ? new Date(Date.now() - 3600_000).toISOString() : new Date(Date.now() + 600_000).toISOString()],
  );
  return code;
}

const exchange = (body: unknown) => req("/auth/entra/exchange", { method: "POST", body });

const handoffCount = async (code: string): Promise<number> => {
  const [{ n }] = await query<{ n: number }>(
    `SELECT count(*)::int AS n FROM entra_handoffs WHERE handoff = $1`,
    [code],
  );
  return n;
};

Deno.test("POST /auth/entra/exchange — handoff code redemption", async (t) => {
  await wipeDatabase();

  const user = await createActiveUser({
    fullName: "Entra Exchange User",
    email: uniqueEmail("entraexchange"),
    password: "EntraPass!2026",
    affiliation: "agency",
  });

  await t.step("negative: a missing or non-string code is 400", async () => {
    for (const body of [{}, { code: "" }, { code: 123 }, { code: null }]) {
      const res = await exchange(body);
      assertEquals(res.status, 400, JSON.stringify(body));
      assertEquals((await res.json()).error, "A handoff code is required.");
    }
  });

  await t.step("negative: a malformed body is 400, not a 500", async () => {
    // The handler catches the JSON parse failure and falls through to the
    // missing-code branch; a 500 here would leak an internal error to an
    // unauthenticated caller.
    const res = await req("/auth/entra/exchange", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: undefined,
    });
    assertEquals(res.status, 400);
  });

  await t.step("negative: an unknown code is 400", async () => {
    const res = await exchange({ code: "never-minted-code" });
    assertEquals(res.status, 400);
    assertEquals((await res.json()).error, "Invalid or expired handoff code.");
  });

  await t.step("positive: a valid code returns the session and the sanitised user", async () => {
    const sessionId = await makeSession(user.id, { twofaVerified: true });
    const code = await makeHandoff(sessionId);

    const res = await exchange({ code });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.user.id, user.id);
    assertEquals(body.user.email, user.email);
    // Verified session → neither gate.
    assertEquals(body.needs2faEnrollment, false);
    assertEquals(body.needs2faVerification, false);
    assertEquals(body.identityChange, undefined);
  });

  await t.step("SECURITY: the response carries no secret material", async () => {
    const sessionId = await makeSession(user.id, { twofaVerified: true });
    const code = await makeHandoff(sessionId);
    const raw = await (await exchange({ code })).text();

    for (const forbidden of ["passwordHash", "password_hash", "totpSecret", "totp_secret"]) {
      assertEquals(raw.includes(forbidden), false, `exchange leaked ${forbidden}`);
    }
    const [row] = await query<{ password_hash: string; totp_secret: string | null }>(
      `SELECT password_hash, totp_secret FROM users WHERE id = $1`,
      [user.id],
    );
    assertEquals(raw.includes(row.password_hash), false, "password hash value leaked");
    if (row.totp_secret) assertEquals(raw.includes(row.totp_secret), false, "totp secret value leaked");
  });

  await t.step("SECURITY: the code is single-use — consumed on success", async () => {
    const sessionId = await makeSession(user.id, { twofaVerified: true });
    const code = await makeHandoff(sessionId);

    assertEquals((await exchange({ code })).status, 200);
    assertEquals(await handoffCount(code), 0, "the row must be deleted on redemption");

    const replay = await exchange({ code });
    assertEquals(replay.status, 400, "a redeemed code must not mint a second session");
    assertEquals((await replay.json()).error, "Invalid or expired handoff code.");
  });

  await t.step("SECURITY: the code is consumed even when redemption FAILS", async () => {
    // The handler deletes before validating, deliberately: an expired or
    // otherwise unusable code must not survive an attempt for a retry.
    const sessionId = await makeSession(user.id);
    const code = await makeHandoff(sessionId, { expired: true });

    const res = await exchange({ code });
    assertEquals(res.status, 400);
    assertEquals(await handoffCount(code), 0, "an expired code is still consumed");
  });

  await t.step("negative: a code whose session no longer exists is 401", async () => {
    const sessionId = await makeSession(user.id);
    const code = await makeHandoff(sessionId);
    await query(`DELETE FROM sessions WHERE id = $1`, [sessionId]);

    const res = await exchange({ code });
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "Invalid or expired session.");
  });

  await t.step("negative: a code whose user is no longer active is 401", async () => {
    const doomed = await createActiveUser({
      fullName: "Doomed Entra User",
      email: uniqueEmail("doomedentra"),
      password: "DoomedPass!2026",
      affiliation: "agency",
    });
    const sessionId = await makeSession(doomed.id, { twofaVerified: true });
    const code = await makeHandoff(sessionId);
    await query(`UPDATE users SET status = 'tombstoned' WHERE id = $1`, [doomed.id]);

    const res = await exchange({ code });
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "User not found or inactive.");
  });

  await t.step("2FA hints come from the SESSION, not just the user's enrolment", async () => {
    // An enrolled user on an UNVERIFIED session must be told to verify…
    const unverified = await makeSession(user.id, { twofaVerified: false });
    const codeA = await makeHandoff(unverified);
    const a = await (await exchange({ code: codeA })).json();
    assertEquals(a.needs2faVerification, true);
    assertEquals(a.needs2faEnrollment, false);

    // …and the same user on a session already verified via trusted Entra MFA
    // must NOT be re-gated. This is the property the comment in the handler
    // calls out: deriving from user.totpSecret alone would gate them again.
    const trusted = await makeSession(user.id, {
      twofaVerified: true,
      entraMfa: true,
      strongAuthSource: "entra_mfa",
    });
    const codeB = await makeHandoff(trusted);
    const b = await (await exchange({ code: codeB })).json();
    assertEquals(b.needs2faVerification, false);
    assertEquals(b.needs2faEnrollment, false);
    assertEquals(b.entraMfaTrusted, true);
    assertEquals(b.strongAuthSource, "entra_mfa");
  });

  await t.step("an un-enrolled user is told to ENROL rather than verify", async () => {
    const fresh = await createActiveUser({
      fullName: "Unenrolled Entra User",
      email: uniqueEmail("unenrolledentra"),
      password: "FreshPass!2026",
      affiliation: "agency",
      enroll2fa: false,
    });
    const sessionId = await makeSession(fresh.id, { twofaVerified: false });
    const code = await makeHandoff(sessionId);

    const body = await (await exchange({ code })).json();
    assertEquals(body.needs2faEnrollment, true);
    assertEquals(body.needs2faVerification, false);
  });

  await t.step("a pending identity change is surfaced with a human-readable hint", async () => {
    const sessionId = await makeSession(user.id, { twofaVerified: false });
    await query(
      `INSERT INTO identity_change_requests
         (id, session_id, user_id, provider, change_type, source, old_external_identity_id,
          old_external_id, new_external_id, external_upn, email, status, detected_at, expires_at)
       VALUES (uuid_generate_v7(), $1, $2, 'entra_id', 'entra_object_id_mismatch', 'entra_callback',
               NULL, NULL, $3, NULL, $4, 'pending', now(), now() + interval '10 minutes')`,
      [sessionId, user.id, "11111111-1111-4111-8111-111111111111", user.email],
    );
    const code = await makeHandoff(sessionId);

    const body = await (await exchange({ code })).json();
    assertEquals(body.identityChange?.required, true);
    assertEquals(body.identityChange?.type, "entra_object_id_mismatch");
    assertEquals(body.identityChange?.source, "entra_callback");
    assert(
      String(body.identityChange?.message).includes("identity appears to have changed"),
      body.identityChange?.message,
    );
  });

  await t.step("the local-to-Entra upgrade hint uses the other message", async () => {
    const sessionId = await makeSession(user.id, { twofaVerified: false });
    await query(
      `INSERT INTO identity_change_requests
         (id, session_id, user_id, provider, change_type, source, old_external_identity_id,
          old_external_id, new_external_id, external_upn, email, status, detected_at, expires_at)
       VALUES (uuid_generate_v7(), $1, $2, 'entra_id', 'local_to_entra_upgrade', 'entra_callback',
               NULL, NULL, $3, NULL, $4, 'pending', now(), now() + interval '10 minutes')`,
      [sessionId, user.id, "22222222-2222-4222-8222-222222222222", user.email],
    );
    const code = await makeHandoff(sessionId);

    const body = await (await exchange({ code })).json();
    assertEquals(body.identityChange?.type, "local_to_entra_upgrade");
    assert(
      String(body.identityChange?.message).includes("found a corporate Entra identity"),
      body.identityChange?.message,
    );
  });
});
