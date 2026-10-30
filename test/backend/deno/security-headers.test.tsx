// Security headers + HttpOnly session cookie (addendum-080, Batch A).
//
// Two layers:
//   1. UNIT — the pure builder (server/security-headers.ts) across the
//      env×https matrix: dev/http must NEVER emit HSTS or Secure cookies and
//      must keep the dev CSP (script-src 'unsafe-inline' + ws:// in
//      connect-src); prod/https emits HSTS + strict CSP (+
//      upgrade-insecure-requests) and __Host- cookie naming.
//   2. INTEGRATION — through the real Hono app via req(): responses carry the
//      header set, JSON responses get Cache-Control: no-store, login sets an
//      HttpOnly SameSite=Lax cookie that round-trips, logout clears it + sends
//      Clear-Site-Data, the CSRF double-submit is enforced only when the
//      cookie is present (backend suite stays cookie-less and green), and the
//      X-Session-Token dual-path still works.
import { assertEquals, assert, assertMatch } from "jsr:@std/assert";
import { req, wipeDatabase, createAdmin, loginAs } from "./helpers.tsx";
import { securityHeaders, cspFor, csrfCookieName, sessionCookieName, isSecureCookie } from "../../../server/security-headers.ts";
import { query } from "../../../server/pg.tsx";
import { corsAllowedOrigins } from "../../../server/app-middleware.tsx";

// Deno's Headers supports getSetCookie() (multi Set-Cookie values). Guarded so
// a runtime without it degrades gracefully to a typed empty list.
function setCookiesOf(res: Response): string[] {
  const h = res.headers as unknown as { getSetCookie?: () => string[] };
  return typeof h.getSetCookie === "function" ? h.getSetCookie() : [];
}

Deno.test("security headers: builder matrix (pure, no DB)", async (t) => {
  await t.step("dev/http — no HSTS, dev CSP allowances, plain cookie name", () => {
    const h = securityHeaders({ env: "dev", https: false });
    assertEquals(h["Strict-Transport-Security"], undefined, "HSTS must never be emitted over http");
    assertEquals(h["X-Content-Type-Options"], "nosniff");
    assertEquals(h["X-Frame-Options"], "DENY");
    assertEquals(h["Referrer-Policy"], "no-referrer");
    assertEquals(h["Cross-Origin-Opener-Policy"], "same-origin");
    assertEquals(h["Cross-Origin-Resource-Policy"], "same-origin");
    assertEquals(h["X-XSS-Protection"], "0");
    assertMatch(h["Content-Security-Policy"]!, /script-src 'self' 'unsafe-inline'/);
    assertMatch(h["Content-Security-Policy"]!, /connect-src 'self' ws:\/\/localhost:\*/);
    assertEquals(h["Content-Security-Policy"]!.includes("upgrade-insecure-requests"), false);
    assertEquals(sessionCookieName("dev", false), "ffs_session");
    assertEquals(csrfCookieName("dev", false), "ffs_csrf");
    assertEquals(isSecureCookie("dev", false), false);
  });

  await t.step("prod/https — HSTS, strict CSP, __Host- + Secure cookie", () => {
    const h = securityHeaders({ env: "prod", https: true });
    assertEquals(h["Strict-Transport-Security"], "max-age=63072000; includeSubDomains");
    assertMatch(h["Content-Security-Policy"]!, /script-src 'self'[^']/);
    assertMatch(h["Content-Security-Policy"]!, /upgrade-insecure-requests/);
    // style-src keeps 'unsafe-inline' (Tailwind/emotion), but script-src must not.
    assertEquals(/script-src 'self' 'unsafe-inline'/.test(h["Content-Security-Policy"]!), false);
    assertEquals(sessionCookieName("prod", true), "__Host-ffs_session");
    assertEquals(csrfCookieName("prod", true), "__Host-ffs_csrf");
    assertEquals(isSecureCookie("prod", true), true);
  });

  await t.step("prod/http — strict CSP but NO HSTS and no Secure cookie", () => {
    const h = securityHeaders({ env: "prod", https: false });
    assertEquals(h["Strict-Transport-Security"], undefined);
    assertEquals(/script-src 'self' 'unsafe-inline'/.test(h["Content-Security-Policy"]!), false);
    assertEquals(sessionCookieName("prod", false), "ffs_session");
    assertEquals(isSecureCookie("prod", false), false);
  });

  await t.step("CORS origins — production excludes every localhost development origin", () => {
    const prod = corsAllowedOrigins("prod", "https://portal.example.gov");
    assertEquals([...prod], ["https://portal.example.gov"]);
    const dev = corsAllowedOrigins("dev", "http://localhost:5173");
    assert(dev.has("http://localhost:4173"));
  });

  await t.step("cspFor — dev connect-src includes caller-provided API origins", () => {
    const csp = cspFor({ env: "dev", https: false, connectSrc: ["http://localhost:8789"] });
    assertMatch(csp, /http:\/\/localhost:8789/);
  });
});

Deno.test("security headers: integration through the real app", async (t) => {
  let adminSession: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("HdrAdmin!2026");
    const login = await loginAs(admin.email, "HdrAdmin!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
    adminSession = login.session;
  });

  await t.step("every response carries the header set; JSON gets Cache-Control no-store; no HSTS over http", async () => {
    const res = await req("/health");
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("X-Content-Type-Options"), "nosniff");
    assertEquals(res.headers.get("X-Frame-Options"), "DENY");
    assertEquals(res.headers.get("Referrer-Policy"), "no-referrer");
    assertEquals(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
    assertEquals(res.headers.get("Cross-Origin-Resource-Policy"), "same-origin");
    assertEquals(res.headers.get("X-XSS-Protection"), "0");
    assert(res.headers.get("Content-Security-Policy")?.includes("script-src 'self' 'unsafe-inline'"));
    assertEquals(res.headers.get("Strict-Transport-Security"), null, "no HSTS over http");
    assertEquals(res.headers.get("Cache-Control"), "no-store", "JSON API responses are no-store");
  });

  await t.step("https (x-forwarded-proto) — HSTS IS emitted", async () => {
    const res = await req("/health", { headers: { "x-forwarded-proto": "https" } });
    assertEquals(res.headers.get("Strict-Transport-Security"), "max-age=63072000; includeSubDomains");
  });

  await t.step("login sets an HttpOnly SameSite=Lax session cookie (no Secure in dev) that round-trips", async () => {
    const admin = await createAdmin("CookieAdmin!2026");
    const res = await req("/auth/login", {
      method: "POST",
      body: { email: admin.email, password: "CookieAdmin!2026" },
    });
    assertEquals(res.status, 200);

    const setCookies = setCookiesOf(res);
    const sessionCookie = setCookies.find((c) => c.startsWith("ffs_session="));
    assert(sessionCookie, "expected a ffs_session Set-Cookie");
    assertMatch(sessionCookie, /HttpOnly/);
    assertMatch(sessionCookie, /SameSite=Lax/);
    assertEquals(sessionCookie.includes("Secure"), false, "no Secure flag in dev/http");

    const token = sessionCookie.slice("ffs_session=".length).split(";")[0];
    const me = await req("/auth/me", { headers: { Cookie: `ffs_session=${token}` } });
    assertEquals(me.status, 200, "cookie-authenticated request resolves");
  });

  await t.step("X-Session-Token dual-path still works (backend suite transport)", async () => {
    const res = await req("/auth/me", { headers: { "X-Session-Token": adminSession } });
    assertEquals(res.status, 200);
  });

  await t.step("CSRF double-submit — cookie-authenticated mutations fail closed", async () => {
    // Header-token/non-browser shape with no ambient cookies remains allowed.
    const noCookie = await req("/auth/logout", { method: "POST" });
    assertEquals(noCookie.status, 200);

    // A session cookie without a CSRF cookie/header must never disable the check.
    const missingBoth = await req("/auth/logout", {
      method: "POST",
      headers: { Cookie: "ffs_session=session-token" },
    });
    assertEquals(missingBoth.status, 403);

    const missingHeader = await req("/auth/logout", {
      method: "POST",
      headers: { Cookie: "ffs_session=session-token; ffs_csrf=abc123" },
    });
    assertEquals(missingHeader.status, 403);

    const matching = await req("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: "ffs_session=session-token; ffs_csrf=abc123",
        "X-CSRF-Token": "abc123",
      },
    });
    assertEquals(matching.status, 200);

    const mismatched = await req("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: "ffs_session=session-token; ffs_csrf=abc123",
        "X-CSRF-Token": "wrong",
      },
    });
    assertEquals(mismatched.status, 403);
  });

  await t.step("logout clears the cookie and sends Clear-Site-Data", async () => {
    const admin = await createAdmin("LogoutAdmin!2026");
    const loginRes = await req("/auth/login", {
      method: "POST",
      body: { email: admin.email, password: "LogoutAdmin!2026" },
    });
    const setCookies = setCookiesOf(loginRes);
    const sessionCookie = setCookies.find((c) => c.startsWith("ffs_session="));
    assert(sessionCookie);
    const token = sessionCookie.slice("ffs_session=".length).split(";")[0];

    const logout = await req("/auth/logout", {
      method: "POST",
      headers: {
        Cookie: `ffs_session=${token}; ffs_csrf=x`,
        "X-CSRF-Token": "x",
      },
    });
    assertEquals(logout.status, 200);
    assertEquals(logout.headers.get("Clear-Site-Data"), '"cache", "cookies", "storage"');
    const clearCookies = setCookiesOf(logout);
    assert(clearCookies.some((c) => c.includes("Max-Age=0")), "logout clears the session cookie");

    const me = await req("/auth/me", { headers: { Cookie: `ffs_session=${token}` } });
    assertEquals(me.status, 401, "cleared session no longer authenticates");
  });

  await t.step("cleanup — remove any straggler rows", async () => {
    await query(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.local')`);
  });
});
