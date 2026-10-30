// E2E coverage for the session-gate browser-navigation pass-through
// (addendum-108) — the recovery transport contract behind the single-origin
// (Docker) "Your session has expired. Please log in again." JSON trap.
//
// The e2e topology (Vite serves the SPA on its own origin; the backend on
// a separate port) can never reproduce the full trap itself — Vite hands
// out index.html without the backend gate ever seeing the document load.
// What this spec pins, against the real backend origin through the
// browser's real cookie jar (cookies are port-agnostic on localhost, so
// page.request carries the same ffs_session the app uses):
//
//   A. A document-navigation-shaped request (Accept: text/html, cookie
//      transport, no X-Session-Token header) carrying a DEAD session
//      cookie is never answered with the unrecoverable 401 session_expired
//      JSON: the gate falls through toward the SPA and actively expires
//      the dead cookie, so the next navigation arrives clean and the app
//      boots to the login chooser.
//   B. The machine-readable signal is preserved for everything else: the
//      same dead session presented API-style (non-HTML Accept, or an
//      explicit X-Session-Token under a browsery Accept) still gets
//      401 + code session_expired — the code the http layer keys its
//      clean auto-sign-out on (addendum-097).
//
// Addendum-128 (red-regiment row 11) adds the sibling arm for a session
// that is ALIVE but mid-2FA (verify/enroll pending) — same trap class, one
// deliberate difference (the cookie must survive):
//
//   C. A document-navigation-shaped request carrying a live mid-2FA
//      session is never answered 403 twofa_required: the gate falls
//      through WITHOUT expiring the cookie, and the booted SPA drives the
//      2FA modal to completion (the intended recovery path end to end).
//   D. API presentations of the same pending session keep the 403
//      twofa_required code the http layer branches its modal on.
import { test, expect } from '../helpers/harness';
import type { Browser } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, loginPasswordOnly, completeTwoFactor, getSessionCookie } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

// Backend origin — same derivation the helpers use (mirrors
// config/playwright.config.ts's E2E_BACKEND_URL).
const E2E_BACKEND_URL = process.env['E2E_BACKEND_URL'] ??
  `http://localhost:${8789 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;

// The Accept header of a real browser document navigation.
const NAV_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';

// Sign the same user in on a second, fresh browser context: single-session
// sign-in deletes the first session row at mint time (addendum-097),
// leaving device 1's cookie pointing at a dead session — the trap's input
// state, reached through a real user-level flow (no DB poking).
async function invalidateOnSecondDevice(browser: Browser, email: string, password: string): Promise<void> {
  const context2 = await browser.newContext();
  try {
    const page2 = await context2.newPage();
    await login(page2, email, password);
    await completeTwoFactor(page2, email);
  } finally {
    await context2.close();
  }
}

function setCookiesOf(resp: { headersArray(): { name: string; value: string }[] }): string[] {
  return resp.headersArray().filter((h) => h.name.toLowerCase() === 'set-cookie').map((h) => h.value);
}

test.describe('session-expired SPA recovery (addendum-108)', () => {
  test('document navigation with a dead session cookie falls through to the SPA and clears the cookie', async ({ page, browser }) => {
    // Device 1 fully signed in past the 2FA gate…
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await completeTwoFactor(page, SUPERADMIN.email);
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
    // …then device 2's sign-in kills device 1's session server-side.
    await invalidateOnSecondDevice(browser, SUPERADMIN.email, SUPERADMIN.password);

    // The trap's exact request shape: a document load against the backend
    // origin carrying only the dead cookie. Before addendum-108 this was
    // answered 401 { code: "session_expired" } — unrecoverable for a
    // document load, since index.html is served after the gate.
    const resp = await page.request.get(`${E2E_BACKEND_URL}/`, { headers: { Accept: NAV_ACCEPT } });

    // Never the trap. (The fall-through status itself is environment-
    // dependent — 200 with index.html where dist/ is built, 404 in a bare
    // e2e checkout — so the pin is "not the trap", plus the cookie clear.)
    expect(resp.status()).not.toBe(401);
    expect(await resp.text()).not.toContain('session_expired');

    // The gate actively expires the dead cookie: a raw Set-Cookie of
    // `ffs_session=; … Max-Age=0`…
    expect(
      setCookiesOf(resp).some((c) => c.startsWith('ffs_session=;') && /max-age=0/i.test(c)),
    ).toBe(true);
    // …and the shared cookie jar is clean afterwards.
    expect(await getSessionCookie(page)).toBeNull();

    // Recovery end state: the SPA boots and lands on the login chooser.
    await page.goto('/');
    await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible();
  });

  test('the same dead session presented API-style keeps the 401 session_expired signal', async ({ page, browser }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await completeTwoFactor(page, SUPERADMIN.email);
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();

    // Capture the soon-to-be-dead token before device 2 invalidates it —
    // needed for the explicit-header probe below.
    const deadToken = await getSessionCookie(page);
    expect(deadToken).toBeTruthy();
    await invalidateOnSecondDevice(browser, SUPERADMIN.email, SUPERADMIN.password);

    // Non-HTML Accept (what the SPA's own fetch calls look like — the
    // browser default is */*): the http layer depends on this code to
    // drive the clean auto-sign-out, so it must survive the carve-out.
    const apiResp = await page.request.get(`${E2E_BACKEND_URL}/requests/my-requests`, {
      headers: { Accept: 'application/json' },
    });
    expect(apiResp.status()).toBe(401);
    expect((await apiResp.json()).code).toBe('session_expired');

    // Explicit token transport under a browsery Accept: the no-header
    // condition holds the line for non-browser clients (and the backend
    // suite, which always sends the header).
    const headerResp = await page.request.get(`${E2E_BACKEND_URL}/requests/my-requests`, {
      headers: { Accept: NAV_ACCEPT, 'X-Session-Token': deadToken! },
    });
    expect(headerResp.status()).toBe(401);
    expect((await headerResp.json()).code).toBe('session_expired');
  });

  test('document navigation with a live mid-2FA session falls through WITHOUT clearing the cookie (addendum-128)', async ({ page }) => {
    // Password phase ONLY — the login mints a live but unverified session
    // and the verify/enroll modal is up. A refresh here hit the twin of the
    // 108 trap before addendum-128: 403 twofa_required JSON where only the
    // SPA shell could drive the modal.
    await login(page, SUPERADMIN.email, SUPERADMIN.password);

    const resp = await page.request.get(`${E2E_BACKEND_URL}/`, { headers: { Accept: NAV_ACCEPT } });

    // Never the trap…
    expect(resp.status()).not.toBe(403);
    expect(await resp.text()).not.toContain('twofa_required');
    // …and the mirror-difference of the dead arm: NO active expiry rides
    // the response — the session is alive and the handshake needs it.
    expect(
      setCookiesOf(resp).some((c) => c.startsWith('ffs_session=;') && /max-age=0/i.test(c)),
    ).toBe(false);
    expect(await getSessionCookie(page)).not.toBeNull();

    // Recovery end state, driven end to end: the booted SPA arms the 2FA
    // modal from /auth/me (allowlisted) and the handshake completes.
    await page.goto('/');
    await completeTwoFactor(page, SUPERADMIN.email);
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
  });

  test('the same live mid-2FA session presented API-style keeps the 403 twofa_required signal (addendum-128)', async ({ page }) => {
    // Use loginPasswordOnly: stops after password phase, leaving the session
    // in mid-2FA state (verify modal visible, twofa_verified_at = null).
    // login() would call completeTwoFactor() and give a fully-authenticated
    // session, which returns 200 instead of 403 for API calls.
    await loginPasswordOnly(page, SUPERADMIN.email, SUPERADMIN.password);
    const pendingToken = await getSessionCookie(page);
    expect(pendingToken).toBeTruthy();

    // Non-HTML Accept (the SPA's own fetch calls): the http layer keys its
    // 2FA-gate branch on this code — it must survive the carve-out.
    const apiResp = await page.request.get(`${E2E_BACKEND_URL}/requests/my-requests`, {
      headers: { Accept: 'application/json' },
    });
    expect(apiResp.status()).toBe(403);
    expect((await apiResp.json()).code).toBe('twofa_required');

    // Explicit token transport under a browsery Accept: non-browser clients
    // keep the machine-readable 403 too.
    const headerResp = await page.request.get(`${E2E_BACKEND_URL}/requests/my-requests`, {
      headers: { Accept: NAV_ACCEPT, 'X-Session-Token': pendingToken! },
    });
    expect(headerResp.status()).toBe(403);
    expect((await headerResp.json()).code).toBe('twofa_required');
  });
});
