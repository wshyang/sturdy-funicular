// E2E helpers for the email direct-link feature (plan_link_mapping.md /
// addendum-059). These drive everything through the real UI:
//   * openSentNotificationsTab — navigate the admin panel to the Sent Notifications outbox
//   * extractDirectLinkForTrigger — read the rendered <a href="…?dl=…"> out of
//     the outbox row for a given trigger (the super-admin's own view of what
//     the email actually contains — this IS the "assert from the outbox" path)
//   * followDirectLinkAsRecipient — open the captured ?dl= URL in a fresh page,
//     log the recipient in, clear the 2FA gate, and land on the request
import type { Page, Browser } from '@playwright/test';
import { expect } from '@playwright/test';
import { login, getSessionCookie, openAdminTab } from './ui';

// Open the admin Sent Notifications tab. Assumes the current page is logged in as an
// admin (AdminPanel renders inline on the admin dashboard).
export async function openSentNotificationsTab(page: Page): Promise<void> {
  // AdminSentNotifications fetches once on mount (useEffect []). If we're already on
  // the tab, re-clicking it does nothing and we'd see a stale outbox, so
  // openAdminTab's refresh option bounces through another tab first (two
  // clicks) to force a remount → fresh GET /admin/sent-notifications. Never a URL
  // GOTO: this suite reaches admin tabs by clicking (addendum-099) — the old
  // deep-link's race rationale (tab clicks racing the async capability
  // reload) is gone because openAdminTab waits for the tab button before
  // clicking it.
  await openAdminTab(page, 'sent-notifications', 'admin-sent-notifications__table', { refresh: true });
}

// From the Sent Notifications outbox, find the most-recent row for `triggerKey` and
// return the absolute direct-link URL rendered inside its body cell. Throws
// (via Playwright's built-in waits/expects) if the row or a ?dl= anchor is
// absent — that's a real failure: the email should carry the link.
export async function extractDirectLinkForTrigger(page: Page, triggerKey: string): Promise<string> {
  await openSentNotificationsTab(page);
  // Scope to the first row whose trigger-key cell matches, then read the
  // rendered anchor's href out of that row's body cell.
  const row = page.locator('[data-testid="admin-sent-notifications__row"]', {
    has: page.locator('[data-testid="admin-sent-notifications__trigger-key-cell"]', { hasText: new RegExp(`^${escapeRegExp(triggerKey)}$`) }),
  }).first();
  await expect(row).toBeVisible();
  const link = row.locator('[data-testid="admin-sent-notifications__body-cell"] a[href*="?dl="]').first();
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  if (!href) throw new Error(`no ?dl= href for trigger ${triggerKey}`);
  return href;
}

// Assert a URL is a well-formed direct link: same-origin path with a ?dl=<key>
// query carrying a 12-char base62 key (matches server/direct-links.ts).
export function assertValidDirectLink(url: string): string {
  const m = url.match(/[?&]dl=([0-9A-Za-z]{12})(?:&|$)/);
  const key = m?.[1];
  if (!key) throw new Error(`not a valid direct link: ${url}`);
  return key;
}

// Open the captured direct link in a brand-new, isolated browser context (a
// clean recipient with NO lingering session — exactly like clicking the link
// from an email client in a fresh browser), authenticate as `email`, clear the
// 2FA gate, and return the recipient page sitting on the resolved
// RequestDetailView. Returns the context too so the caller can close it.
export async function followDirectLinkAsRecipient(
  browser: Browser,
  directLinkUrl: string,
  email: string,
  password: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const key = assertValidDirectLink(directLinkUrl);
  const context = await browser.newContext();
  const page = await context.newPage();
  // Authenticate FIRST — login() does its own page.goto('/') (which would
  // strip a ?dl= param set beforehand), and the 2FA enrollment/verify gate
  // stands between the login POST and the dashboard. Once the session is fully
  // 2FA-verified we navigate to /?dl=<key>: App.tsx captures + strips it, and
  // because a user is already present and past the gate, Dashboard resolves it
  // immediately and opens the RequestDetailView. (This models the real flow:
  // the held-across-gate path is covered by the frontend unit tests;
  // end-to-end, a recipient who is already signed in just clicks the link.)
  await login(page, email, password);
  await page.goto(`/?dl=${key}`);
  return { page, close: () => context.close() };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Workflow API driver ──────────────────────────────────────────────────
//
// Advancing a request through 16 distinct notification-producing states purely
// by clicking through the UI for every actor would be enormous and is already
// covered by happy-path/rejection/owner specs. Here the UI's job is only to
// (a) authenticate each actor for real (login + live TOTP 2FA, via login())
// and (b) let a recipient FOLLOW a direct link. The state transitions between
// those are driven through the real backend HTTP API, issued from inside the
// page's own context (real browser requests, same session/idempotency headers
// the app itself sends) — mirroring ui.ts's directGetRequestStatus rationale.
const E2E_BACKEND_URL = process.env['E2E_BACKEND_URL'] ?? `http://localhost:${8789 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;

export interface ApiDriver {
  get(path: string): Promise<{ status: number; json: any }>;
  post(path: string, body: unknown): Promise<{ status: number; json: any }>;
  put(path: string, body: unknown): Promise<{ status: number; json: any }>;
}

// Capture the 2FA-verified session token from a page that just logged in.
// The session now rides on the HttpOnly `ffs_session` cookie (addendum-080),
// NOT localStorage — so read it from the browser context's cookie jar. The
// captured value is still fed to the API driver as an X-Session-Token header,
// which the backend accepts on the retained dual-path (header OR cookie).
export async function captureSession(page: Page): Promise<string> {
  const token = await getSessionCookie(page);
  if (!token) throw new Error('no ffs_session cookie after login');
  return token;
}

// Build a driver bound to one actor's session. It seeds an idempotency token
// from GET /me/capability-snapshot (the one endpoint that mints one), then
// rotates it from each mutating response's X-Idempotency-Token header — exactly
// how the real frontend threads the token (addendum-008/014).
export async function makeApiDriver(page: Page, sessionToken: string): Promise<ApiDriver> {
  let idemToken: string = await page.evaluate(async ({ base, session }) => {
    const res = await fetch(`${base}/me/capability-snapshot`, { headers: { 'X-Session-Token': session } });
    const data = await res.json();
    return data.idempotencyToken as string;
  }, { base: E2E_BACKEND_URL, session: sessionToken });

  async function send(method: 'POST' | 'PUT', path: string, body: unknown) {
    const result = await page.evaluate(async ({ base, session, idem, method, path, body }) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'X-Session-Token': session,
          'X-Idempotency-Token': idem,
        },
        body: JSON.stringify(body ?? {}),
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json, nextToken: res.headers.get('X-Idempotency-Token') };
    }, { base: E2E_BACKEND_URL, session: sessionToken, idem: idemToken, method, path, body });
    if (result.nextToken) idemToken = result.nextToken; // rotate for the next mutating call
    return { status: result.status, json: result.json };
  }

  async function get(path: string) {
    return page.evaluate(async ({ base, session, path }) => {
      const res = await fetch(`${base}${path}`, { headers: { 'X-Session-Token': session } });
      let json: any = null;
      try { json = await res.json(); } catch { /* empty body */ }
      return { status: res.status, json };
    }, { base: E2E_BACKEND_URL, session: sessionToken, path });
  }

  return {
    get,
    post: (path, body) => send('POST', path, body),
    put: (path, body) => send('PUT', path, body),
  };
}
