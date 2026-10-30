// Security headers + HttpOnly session cookie — e2e (addendum-080, Batch A).
// Runs on the SAME http://localhost:4173 (vite) + :8789 (deno) servers as the
// rest of the regression suite, which is exactly the point: everything here
// asserts the DEV-mode posture (dev CSP on the served HTML, no HSTS, no
// Secure cookie) — the prod/https variants are covered by the backend
// builder-matrix unit tests, which need no real HTTPS.
import { test, expect } from '../helpers/harness';
import { login, logout } from '../helpers/ui';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';

const E2E_BACKEND_URL = process.env['E2E_BACKEND_URL'] ?? `http://localhost:${8789 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;

test.describe('security headers & HttpOnly session (dev/http posture)', () => {
  test('served HTML carries the dev CSP and the non-HSTS header set', async ({ page }) => {
    const response = await page.goto('/');
    expect(response).not.toBeNull();
    const headers = response!.headers();

    expect(headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(headers['content-security-policy']).toContain('ws://localhost:*');
    expect(headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    // Dev/e2e run over plain http — HSTS must never appear.
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  test('API responses carry no-store and no HSTS over http', async ({ request }) => {
    const res = await request.get(`${E2E_BACKEND_URL}/health`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toBe('no-store');
    expect(res.headers()['x-content-type-options']).toBe('nosniff');
    expect(res.headers()['strict-transport-security']).toBeUndefined();
  });

  test('after login the session cookie is HttpOnly SameSite=Lax and localStorage has no session', async ({ page }) => {
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);

    const cookies = await page.context().cookies();
    const session = cookies.find((c) => c.name === 'ffs_session' || c.name === '__Host-ffs_session');
    expect(session).toBeTruthy();
    expect(session!.httpOnly).toBe(true);
    expect(session!.sameSite).toBe('Lax');
    expect(session!.secure).toBe(false); // http-only dev/e2e

    const stored = await page.evaluate(() => localStorage.getItem('session'));
    expect(stored).toBeNull();
  });

  test('a browser request still authenticates across a page reload (cookie persists)', async ({ page }) => {
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);
    await page.reload();
    // The dashboard renders for an authenticated user (cookie survived reload
    // without any localStorage token) — sign-out button is dashboard-only.
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
  });

  test('CSRF double-submit: mutation without X-CSRF-Token is rejected when the cookie is present', async ({ page }) => {
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);

    // Omit the CSRF header on purpose — must be 403.
    const withoutHeader = await page.evaluate(async (base) => {
      const res = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      return res.status;
    }, E2E_BACKEND_URL);
    expect(withoutHeader).toBe(403);

    // With the header echoed from the cookie — allowed (ends the session).
    const withHeader = await page.evaluate(async (base) => {
      const csrf = document.cookie
        .split(';')
        .map((p) => p.trim())
        .find((p) => p.startsWith('ffs_csrf='))
        ?.split('=')[1];
      const res = await fetch(`${base}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf ?? '' },
      });
      return res.status;
    }, E2E_BACKEND_URL);
    expect(withHeader).toBe(200);
  });

  test('logout clears the session cookie and sends Clear-Site-Data', async ({ page }) => {
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);

    const clearSiteData = page.waitForResponse(
      (r) => r.url().includes('/auth/logout') && r.request().method() === 'POST',
    );
    await logout(page);
    const res = await clearSiteData;
    // Use allHeaders() (awaited, complete set) rather than the synchronous
    // headers() snapshot: Clear-Site-Data is a response-processing directive
    // the browser applies internally and does not surface in the eager
    // headers() map, so headers()['clear-site-data'] reads undefined even
    // though the server sent it. allHeaders() resolves the full response
    // header set and sees it.
    const allHeaders = await res.allHeaders();
    expect(allHeaders['clear-site-data']).toBe('"cache", "cookies", "storage"');

    const cookies = await page.context().cookies();
    expect(cookies.find((c) => c.name === 'ffs_session' || c.name === '__Host-ffs_session')).toBeUndefined();
  });
});
