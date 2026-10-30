// Coverage: session lifecycle (server/auth.tsx session layer + the sessions
// table) and the central session-gate middleware (server/app.tsx) —
// including the browser-navigation pass-through for document loads carrying
// a dead session cookie (addendum-108) AND the twofa_required analog for
// live-but-unverified sessions (addendum-128, red-regiment row 11), pinned
// at the end of the gate section below.
//
// PORTED to the backend harness (addendum-081): this file now uses
// defineTest() — the seeded world + guaranteed teardown are automatic, and
// HTTP calls go through the recording ctx client instead of raw req().
// Every assertion is unchanged from the pre-harness version.
//
// Sessions moved off the generic kv_store blob into a real `sessions` table
// carrying an absolute TTL (expires_at), an inactivity watermark
// (last_activity_at), and the 2FA columns (twofa_verified_at,
// pending_totp_secret) that Workstream B enforces. This slice covers the
// session-lifecycle + expiry/inactivity behavior; the 2FA-required gate
// branch is exercised in twofa.test.tsx once 2FA enforcement lands. See
// addendum-047-sessions-and-2fa-gate.md.
import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { createAdmin, createActiveUser, loginAs, uniqueEmail, req, authHeaders } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { SESSION_COOKIE_NAME } from "../../../server/security-headers.ts";
import { getSession, touchSession, createSession, createSessionExclusive, destroySession } from "../../../server/auth.tsx";
import { defineTest } from "./harness/harness.ts";

// Deno's Headers supports getSetCookie() (multi Set-Cookie values). Guarded so
// a runtime without it degrades gracefully to a typed empty list (same idiom
// as security-headers.test.tsx).
function setCookiesOf(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  return typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
}

defineTest("sessions (harness)", async ({ ctx, t }) => {
  await t.step("getSession: positive — resolves an active session to its row", async () => {
    const admin = await createAdmin("SessResolvePass!2026");
    const token = await createSession(admin.id);
    const s = await getSession(token);
    assertExists(s);
    assertEquals(s!.userId, admin.id);
    // A freshly created session is not yet 2FA-verified — login never marks
    // the session verified (Workstream B does, at /auth/2fa/verify).
    assertEquals(s!.twofaVerifiedAt, null);
  });

  await t.step("session token shape: 64-char high-entropy bearer token, NOT a uuidv7", async () => {
    const admin = await createAdmin("SessTokenShapePass!2026");
    const token = await createSession(admin.id);
    // VARCHAR(64) = 32 random bytes hex. Deliberately not uuid_generate_v7()
    // — a session id is a secret credential where unpredictability outweighs
    // index locality (see addendum-047).
    assertEquals(token.length, 64);
    assertEquals(token.includes("-"), false);
  });

  await t.step("getSession: negative — null + row deleted past the absolute TTL", async () => {
    const admin = await createAdmin("SessTtlPass!2026");
    const token = await createSession(admin.id);
    // Force the absolute expiry into the past (leave last_activity_at fresh,
    // so this isolates the absolute-TTL path from the inactivity path).
    await query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [token]);
    assertEquals(await getSession(token), null);
    // Deleted, not merely filtered — a dead bearer token must stop resolving.
    const rows = await query(`SELECT id FROM sessions WHERE id = $1`, [token]);
    assertEquals(rows.length, 0);
  });

  await t.step("getSession: negative — null + row deleted past the inactivity timeout", async () => {
    const admin = await createAdmin("SessIdlePass!2026");
    const token = await createSession(admin.id);
    // last_activity_at older than the 15-minute inactivity window, but the
    // absolute TTL is still far in the future — isolates the inactivity path.
    await query(`UPDATE sessions SET last_activity_at = now() - interval '16 minutes' WHERE id = $1`, [token]);
    assertEquals(await getSession(token), null);
    const rows = await query(`SELECT id FROM sessions WHERE id = $1`, [token]);
    assertEquals(rows.length, 0);
  });

  await t.step("touchSession: slides the inactivity window forward", async () => {
    const admin = await createAdmin("SessTouchPass!2026");
    const token = await createSession(admin.id);
    // Backdate to 10 minutes ago (still inside the window), then touch.
    await query(`UPDATE sessions SET last_activity_at = now() - interval '10 minutes' WHERE id = $1`, [token]);
    const before = await query<{ last_activity_at: string }>(
      `SELECT last_activity_at FROM sessions WHERE id = $1`, [token],
    );
    await touchSession(token);
    const after = await query<{ last_activity_at: string }>(
      `SELECT last_activity_at FROM sessions WHERE id = $1`, [token],
    );
    assertEquals(
      new Date(after[0].last_activity_at).getTime() > new Date(before[0].last_activity_at).getTime(),
      true,
    );
  });

  await t.step("destroySession: deletes the row (logout is a real DELETE, not soft-invalidation)", async () => {
    const admin = await createAdmin("SessDestroyPass!2026");
    const token = await createSession(admin.id);
    await destroySession(token);
    const rows = await query(`SELECT id FROM sessions WHERE id = $1`, [token]);
    assertEquals(rows.length, 0);
    assertEquals(await getSession(token), null);
  });

  // ── Single-session sign-in (addendum-097) ───────────────────────────────

  await t.step("single-session sign-in: a second login invalidates the first session immediately", async () => {
    const user = await createActiveUser({
      fullName: "Single Session User", email: uniqueEmail("singleneck"), password: "SingleSess!2026", affiliation: "agency",
    });
    const loginA = await loginAs(user.email, "SingleSess!2026");
    const sessionA = "error" in loginA ? "" : loginA.session;
    assertExists(sessionA);

    // First session works.
    const okA = await ctx.actors.as(sessionA).get("/requests/my-requests");
    assertEquals(okA.status, 200);

    // Same user signs in elsewhere…
    const loginB = await loginAs(user.email, "SingleSess!2026");
    const sessionB = "error" in loginB ? "" : loginB.session;
    assertExists(sessionB);
    assertNotEquals(sessionA, sessionB);

    // …the first session is dead IMMEDIATELY (row deleted, not merely
    // flagged): its very next gated request resolves no session and the
    // client is auto-signed-out by the session_expired handling.
    const first = await ctx.actors.as(sessionA).get("/requests/my-requests");
    assertEquals(first.status, 401);
    assertEquals(first.json.code, "session_expired");
    const rows = await query(`SELECT id FROM sessions WHERE id = $1`, [sessionA]);
    assertEquals(rows.length, 0);

    // The second session is the sole survivor.
    const second = await ctx.actors.as(sessionB).get("/requests/my-requests");
    assertEquals(second.status, 200);
  });

  await t.step("createSessionExclusive: mints a session and deletes the user's other sessions; createSession stays non-exclusive", async () => {
    const user = await createActiveUser({
      fullName: "Exclusive Mint User", email: uniqueEmail("exclmint"), password: "ExclMint!2026", affiliation: "vendor",
    });
    // The plain mint (fixture/non-interactive path) does NOT kill siblings —
    // two concurrent sessions coexist.
    const older = await createSession(user.id);
    const stale = await createSession(user.id);
    assertEquals((await query(`SELECT id FROM sessions WHERE user_id = $1`, [user.id])).length, 2);

    // The exclusive mint keeps ONLY its own token: every other session of
    // the user is deleted, regardless of how it was created.
    const fresh = await createSessionExclusive(user.id);
    const remaining = await query<{ id: string }>(`SELECT id FROM sessions WHERE user_id = $1`, [user.id]);
    assertEquals(remaining.length, 1);
    assertEquals(remaining[0].id, fresh);
    assertEquals(await getSession(older), null);
    assertEquals(await getSession(stale), null);
    assertEquals((await getSession(fresh))!.userId, user.id);
  });

  // ── Central session-gate middleware (server/app.tsx) ────────────────────

  await t.step("gate: an operational route rejects an inactive session with 401 session_expired", async () => {
    const vendor = await createActiveUser({
      fullName: "Gate Vendor", email: uniqueEmail("gate"), password: "GatePass!2026", affiliation: "vendor",
    });
    const login = await loginAs(vendor.email, "GatePass!2026");
    const session = "error" in login ? "" : login.session;
    assertExists(session);

    // Active session works through the gate.
    const ok = await ctx.actors.as(session).get("/requests/my-requests");
    assertEquals(ok.status, 200);

    // Idle it past the inactivity window; the gate now rejects at the choke
    // point, before the route handler runs.
    await query(`UPDATE sessions SET last_activity_at = now() - interval '16 minutes' WHERE id = $1`, [session]);
    const res = await ctx.actors.as(session).get("/requests/my-requests");
    assertEquals(res.status, 401);
    assertEquals(res.json.code, "session_expired");
  });

  await t.step("gate: an active session still slides forward on each request (touch)", async () => {
    const admin = await createAdmin("GateTouchPass!2026");
    const login = await loginAs(admin.email, "GateTouchPass!2026");
    const session = "error" in login ? "" : login.session;
    // Backdate near (but inside) the window, then make an authenticated
    // request — the gate's touchSession should push last_activity_at to now.
    await query(`UPDATE sessions SET last_activity_at = now() - interval '10 minutes' WHERE id = $1`, [session]);
    const res = await ctx.actors.as(session).get("/requests/my-requests");
    assertEquals(res.status, 200);
    const rows = await query<{ last_activity_at: string }>(
      `SELECT last_activity_at FROM sessions WHERE id = $1`, [session],
    );
    // Well within a second of "now" — proves the gate touched it.
    assertEquals(Date.now() - new Date(rows[0].last_activity_at).getTime() < 60_000, true);
  });

  await t.step("gate: allowlisted /auth/me resolves for an active session (not gated)", async () => {
    const admin = await createAdmin("GateMePass!2026");
    const login = await loginAs(admin.email, "GateMePass!2026");
    const session = "error" in login ? "" : login.session;
    const res = await ctx.actors.as(session).get("/auth/me");
    assertEquals(res.status, 200);
  });

  await t.step("gate: no token passes through to the route's own auth rejection, not the gate's", async () => {
    const res = await ctx.api.get("/requests/my-requests");
    // The route's own requireActiveUser answers a missing session (403 here);
    // the exact status is the route's concern. What matters is the gate did
    // NOT intercept — it emits session_expired only for a present-but-dead
    // token, never for a missing one.
    assertEquals(res.status >= 400 && res.status < 500, true);
    assertNotEquals(res.json.code, "session_expired");
  });

  // ── Browser-navigation pass-through (addendum-108) ─────────────────────
  // A document load (address bar / refresh / bookmark) with a dead session
  // cookie must NOT be answered with the 401 session_expired JSON trap:
  // index.html is served AFTER the gate, so that response is unrecoverable
  // for a browser. The gate clears the dead cookie and passes the request
  // through to the SPA instead; API-shaped callers keep the machine-
  // readable code. Raw req() throughout — the harness ctx client always
  // sends X-Session-Token, and these cases hinge on the cookie transport.

  // Login + idle out past the inactivity window → a present-but-dead
  // cookie/token, the exact input state of the browser-nav trap.
  const deadSessionFor = async (password: string): Promise<string> => {
    const user = await createActiveUser({
      fullName: "Nav Gate User", email: uniqueEmail("gatenav"), password, affiliation: "vendor",
    });
    const login = await loginAs(user.email, password);
    const session = "error" in login ? "" : login.session;
    assertExists(session);
    await query(`UPDATE sessions SET last_activity_at = now() - interval '16 minutes' WHERE id = $1`, [session]);
    assertEquals(await getSession(session), null, "setup: the session must be dead for these steps");
    return session;
  };

  await t.step("gate: a browser document navigation with a dead session cookie passes through to the SPA and clears the cookie", async () => {
    const dead = await deadSessionFor("GateNavA!2026");
    // Address-bar/refresh shape: cookie transport, Accept: text/html, NO
    // X-Session-Token header. The exact fall-through status is environment-
    // dependent (200 with index.html where dist/ is built, 404 in a bare
    // test checkout) — the pinned contract is "never the 401 trap, and the
    // dead cookie is actively expired so the next navigation arrives clean".
    const res = await req("/", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${dead}`,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    assertNotEquals(res.status, 401);
    assertEquals((await res.text()).includes("session_expired"), false);
    const cleared = setCookiesOf(res).some((cookie) =>
      cookie.startsWith(`${SESSION_COOKIE_NAME}=;`) && cookie.toLowerCase().includes("max-age=0")
    );
    assertEquals(cleared, true, "the dead session cookie must be actively expired in the response");
  });

  await t.step("gate: a dead session cookie on an API-shaped request (non-HTML Accept) still gets 401 session_expired", async () => {
    const dead = await deadSessionFor("GateNavB!2026");
    // The SPA's own fetch calls (browser-default Accept, never text/html)
    // and any non-HTML consumer keep the machine-readable signal — the
    // http layer keys its clean auto-sign-out on this code, so it must
    // survive the pass-through carve-out.
    const res = await req("/requests/my-requests", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${dead}`,
        Accept: "application/json",
      },
    });
    assertEquals(res.status, 401);
    assertEquals((await res.json()).code, "session_expired");
  });

  await t.step("gate: an explicit X-Session-Token keeps 401 session_expired even with a browser-like Accept", async () => {
    const dead = await deadSessionFor("GateNavC!2026");
    // Non-browser clients (and this suite) present the token explicitly; a
    // browsery Accept string must not downgrade their answer. The no-header
    // condition is what makes the browser-nav carve-out safe.
    const res = await req("/requests/my-requests", {
      headers: {
        ...authHeaders(dead),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    assertEquals(res.status, 401);
    assertEquals((await res.json()).code, "session_expired");
  });

  // ── twofa_required browser-navigation analog (addendum-128, row 11) ─────
  // The sibling arm: a session ALIVE but mid-2FA (unverified) hits the same
  // single-origin trap on a document load — a 403 JSON where only the SPA
  // shell could drive the enroll/verify modal (/auth/me's allowlisted 200
  // arms the modal, addendum-051). The gate passes the navigation through
  // WITHOUT clearing the cookie (the session is alive and the handshake
  // needs it); API presentations keep the machine-readable 403. Raw req()
  // throughout — same cookie-transport reasoning as the 108 steps above.

  const pendingVerificationSessionFor = async (password: string): Promise<string> => {
    // Enrolled fixture user (default) — raw login, verify deliberately NOT completed.
    const user = await createActiveUser({
      fullName: "2FA Nav User", email: uniqueEmail("gate2fav"), password, affiliation: "vendor",
    });
    const res = await req("/auth/login", { method: "POST", body: { email: user.email, password } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.needs2faVerification, true, "setup: session verify-pending");
    return data.session as string;
  };

  const pendingEnrollmentSessionFor = async (password: string): Promise<string> => {
    const user = await createActiveUser({
      fullName: "2FA Enroll Nav User", email: uniqueEmail("gate2fae"), password, affiliation: "vendor", enroll2fa: false,
    });
    const res = await req("/auth/login", { method: "POST", body: { email: user.email, password } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.needs2faEnrollment, true, "setup: session enrollment-pending");
    return data.session as string;
  };

  await t.step("gate: a browser document navigation mid-2FA-enrollment passes through to the SPA WITHOUT clearing the live cookie (addendum-128)", async () => {
    const pending = await pendingEnrollmentSessionFor("Gate2faA!2026");
    const res = await req("/", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${pending}`,
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    assertNotEquals(res.status, 403);
    assertEquals((await res.text()).includes("twofa_required"), false);
    // Mirror-difference of the dead arm: the session is ALIVE, so no active
    // expiry may ride the response.
    const cleared = setCookiesOf(res).some((cookie) =>
      cookie.startsWith(`${SESSION_COOKIE_NAME}=;`) && cookie.toLowerCase().includes("max-age=0")
    );
    assertEquals(cleared, false, "the live mid-2FA cookie must NOT be cleared");
  });

  await t.step("gate: mid-2FA session on an API-shaped request keeps 403 twofa_required", async () => {
    const pending = await pendingVerificationSessionFor("Gate2faB!2026");
    const res = await req("/requests/my-requests", {
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${pending}`,
        Accept: "application/json",
      },
    });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).code, "twofa_required");
  });

  await t.step("gate: an explicit X-Session-Token keeps 403 twofa_required even with a browser-like Accept", async () => {
    const pending = await pendingVerificationSessionFor("Gate2faC!2026");
    const res = await req("/requests/my-requests", {
      headers: {
        ...authHeaders(pending),
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    });
    assertEquals(res.status, 403);
    assertEquals((await res.json()).code, "twofa_required");
  });
});
