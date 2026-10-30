// Central authentication-gate matrix (GAP C from the test-coverage audit,
// 2026-07-29). Two of the four negative auth dimensions — a present-but-dead
// token (→ 401 session_expired) and a 2FA-unverified session (→ 403
// twofa_required) — were previously asserted on exactly ONE route each
// (/requests/my-requests, in sessions.test.tsx / twofa.test.tsx). But those
// two rejections come from a single central middleware (server/app.tsx's
// `app.use("*")` gate, see addendum-047), so what actually needs proving is
// that the gate fires uniformly for EVERY protected route family, not just the
// one route each existing test happened to poke.
//
// This suite drives one representative GET per family through all three
// gate-observable dimensions:
//   • bad token (random, no matching session row) → 401 + code "session_expired"
//   • 2FA-unverified session                      → 403 + code "twofa_required"
//   • no token at all                             → 4xx, and NOT session_expired
//                                                    (gate passes through; the
//                                                    route's own auth answers)
//
// Behaviour read straight from server/app.tsx lines 204-234, not guessed. GET
// routes are used so the idempotency middleware (POST/PUT/PATCH/DELETE only)
// never confounds the assertion — the session gate runs first regardless.
import { assertEquals, assertNotEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createActiveUser, loginAs, uniqueEmail,
} from "./helpers.tsx";

// One representative protected GET per route family. Every one sits behind the
// central gate (none is in GATE_ALLOWLIST), so the gate's verdict is identical
// across all of them regardless of what the handler would ultimately do.
const PROTECTED_GETS: Array<{ family: string; path: string }> = [
  { family: "requests", path: "/requests/my-requests" },
  { family: "requests-search", path: "/requests/search?q=x" },
  { family: "admin/users", path: "/admin/users" },
  { family: "admin/systems", path: "/admin/systems" },
  { family: "admin/data", path: "/admin/data/export" },
  { family: "admin/app-settings", path: "/admin/app-settings" },
  { family: "admin/notification-templates", path: "/admin/notification-templates" },
  { family: "admin/sent-notifications", path: "/admin/sent-notifications" },
  { family: "admin/access-log", path: "/admin/access-log" },
  { family: "audit", path: "/audit/logs" },
  { family: "owner", path: "/owner/systems" },
  { family: "me/integrations", path: "/me/integrations" },
];

const BAD_TOKEN = "not-a-real-session-token-000000000000";

Deno.test("authz-matrix: central gate fires uniformly across route families", async (t) => {
  let unverifiedSession: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    // A user seeded WITHOUT 2FA enrollment: loginAs skips the verify step, so
    // the returned session is authenticated but NOT 2FA-verified — exactly the
    // state the gate rejects with twofa_required.
    const user = await createActiveUser({
      fullName: "Unverified User", email: uniqueEmail("authzmx"),
      password: "AuthzPass!2026", affiliation: "vendor", enroll2fa: false,
    });
    const login = await loginAs(user.email, "AuthzPass!2026");
    unverifiedSession = (login as any).session;
    if (!unverifiedSession) throw new Error("expected an authenticated-but-unverified session");
  });

  // ── Dimension 1: present-but-dead token → 401 session_expired ─────────────

  for (const { family, path } of PROTECTED_GETS) {
    await t.step(`bad token on ${family} → 401 session_expired`, async () => {
      const res = await req(path, { headers: authHeaders(BAD_TOKEN) });
      assertEquals(res.status, 401);
      const data = await res.json().catch(() => ({}));
      assertEquals(data.code, "session_expired");
    });
  }

  // ── Dimension 2: 2FA-unverified session → 403 twofa_required ──────────────

  for (const { family, path } of PROTECTED_GETS) {
    await t.step(`2FA-unverified session on ${family} → 403 twofa_required`, async () => {
      const res = await req(path, { headers: authHeaders(unverifiedSession) });
      assertEquals(res.status, 403);
      const data = await res.json().catch(() => ({}));
      assertEquals(data.code, "twofa_required");
    });
  }

  // ── Dimension 3: no token → gate passes through, route's own auth answers ─
  // The gate never intercepts a missing token; the route replies 4xx on its
  // own terms, and crucially NOT with session_expired (which would mean the
  // gate mis-fired on an absent token).

  for (const { family, path } of PROTECTED_GETS) {
    await t.step(`no token on ${family} → 4xx and not session_expired`, async () => {
      const res = await req(path);
      assertEquals(res.status >= 400 && res.status < 500, true);
      const data = await res.json().catch(() => ({}));
      assertNotEquals(data.code, "session_expired");
    });
  }
});
