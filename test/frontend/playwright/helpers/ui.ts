// Shared Playwright UI helpers for the e2e suite. Extracted because the
// login/signup/row-scoping patterns below recur throughout any multi-actor
// scenario — mirrors the precedent set by the backend suite's
// tests/helpers.tsx fixture builders.
//
// Locators here use data-testid (addendum-005-element-id-catalogue.md /
// CLAUDE.md's "frontend element testid convention") rather than placeholder
// text, accessible role+name, or structural DOM scoping — the app's every
// interactive element now carries a stable testid, so specs no longer need
// the label-scoping/heading-scoping workarounds this file previously used.
import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { computeTotp, recoverSecretFromEnrollModal, rememberSecret, recallSecret } from './totp';

// ── Per-action pacing (used by the demo suite to pace individual actions) ──
//
// Playwright's launchOptions.slowMo is a single value fixed for an entire
// browser session — it cannot express "pace this action's first two
// repetitions, then speed up," which is exactly what a demo video full of
// repeated same-shape actions (9 signups, 9 pending-dashboard approvals,
// sequence run several times, ...) needs. So the demo config sets NO slowMo
// at all; pacing instead happens via an explicit `delayMs` a caller can pass
// into signup()/approveUser() below — a plain wait inserted before that
// call's own actions, computed per-occurrence by the caller (see
// e2e/demo/helpers/index.ts's paceSequence). Every such parameter defaults to 0
// (an immediate action, today's unchanged behavior) so every existing
// caller across the regression suite and the secret-autorelease demo (whose
// OWN config still sets slowMo at the browser level, independent of this)
// is unaffected.
async function pacedWait(page: Page, delayMs: number): Promise<void> {
  if (delayMs > 0) await page.waitForTimeout(delayMs);
}

// ── Auth ─────────────────────────────────────────────────────────────────────

// Complete whichever 2FA gate the app shows after credentials are accepted
// (addendum-046-totp-2fa.md). No mocks and NO out-of-band secret:
//   * ENROLL modal (first login for a user) — decode this user's own QR from
//     its RENDERED PIXELS (screenshot → jsqr), compute the code, and remember
//     the decoded secret keyed by email so later logins can verify against it.
//   * VERIFY modal (a user who already enrolled earlier this run) — recall the
//     secret decoded from that user's QR the first time, and compute a fresh
//     code from it.
// `email` is required so the recalled secret is the right user's. No-op if the
// dashboard is already visible.
export async function completeTwoFactor(page: Page, email: string) {
  const dashboard = page.getByTestId('dashboard__sign-out-button');
  const verifyModal = page.getByTestId('two-factor-verify');
  const enrollModal = page.getByTestId('two-factor-enroll');

  await Promise.race([
    dashboard.waitFor({ state: 'visible' }),
    verifyModal.waitFor({ state: 'visible' }),
    enrollModal.waitFor({ state: 'visible' }),
  ]);

  if (await enrollModal.isVisible().catch(() => false)) {
    const secret = await recoverSecretFromEnrollModal(page);
    rememberSecret(email, secret);
    await page.getByTestId('two-factor-enroll__code-input').fill(computeTotp(secret));
    // onChange auto-submits when 6 digits are entered (ca166ea); button click is not needed.
  } else if (await verifyModal.isVisible().catch(() => false)) {
    const secret = recallSecret(email);
    if (!secret) {
      throw new Error(
        `No enrolled TOTP secret on record for ${email} — the verify gate appeared but this user never enrolled through the QR in this run.`,
      );
    }
    await page.getByTestId('two-factor-verify__code-input').fill(computeTotp(secret));
    // onChange auto-submits when 6 digits are entered (ca166ea); button click is not needed.
  }
  await expect(dashboard).toBeVisible();
}

// Clicks a dashboard action-modal confirm button (vendor/agency approve,
// reject, return, close; owner decisions) and waits for the decision POST
// response before returning. The dashboards close their modals OPTIMISTICALLY
// (addendum-196 — useOptimisticAction runs apply() before commit()), so a
// modal-gone assertion proves nothing about the POST; and under load the
// browser can delay dispatching the POST body well after the preflight
// OPTIONS (observed: an 8s gap), so in-flight counting at the next login is
// equally unreliable. Waiting on the response is the only signal that the
// server has actually recorded the decision.
export async function confirmDecisionAndWait(page: Page, confirmButton: Locator): Promise<void> {
  await Promise.all([
    page.waitForResponse((res) =>
      /\/requests\/[^/]+\/(step-decision|owner-decision|close)$/.test(new URL(res.url()).pathname) &&
      res.request().method() === 'POST'
    ),
    confirmButton.click(),
  ]);
  // Under load a LATE response from an earlier decision can cross-resolve the
  // wait above (the predicate is not request-specific), so the clicked
  // decision's own POST may still be in flight. Drain it before returning —
  // otherwise the next confirm can fire while this POST is pending, both
  // carry the same single-slot idempotency token, and the server answers
  // the loser with 409 (observed as a cascade in approval-flood specs).
  await flushInFlightRequests(page);
}

// Server-reconciliation flush: the previous action may have left a POST in
// flight — the dashboard action modals close optimistically (addendum-196)
// before their step-decision POST resolves, and custody/asset actions
// project too. Navigating now would abort the in-flight request and silently
// undo the decision server-side (observed: preflight OPTIONS logged, POST
// never arrived). Counts actual in-flight HTTP requests (WebSockets/HMR are
// ignored, and `networkidle` proved unusable here — a Vite HMR reconnect
// storm keeps it from ever settling). Bounded at 10s: an abandoned request
// must never hang the suite.
export async function flushInFlightRequests(page: Page): Promise<void> {
  let inFlight = 0;
  const start = () => { inFlight++; };
  const done = () => { inFlight = Math.max(0, inFlight - 1); };
  page.on('request', start);
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  try {
    const deadline = Date.now() + 10_000;
    while (inFlight > 0 && Date.now() < deadline) {
      await page.waitForTimeout(100);
    }
  } finally {
    page.off('request', start);
    page.off('requestfinished', done);
    page.off('requestfailed', done);
  }
}

export async function login(page: Page, email: string, password: string) {
  await flushInFlightRequests(page);
  await page.goto('/');
  // AuthProvider's mount-time checkAuth() re-fetches /auth/me +
  // /me/capability-snapshot before deciding Dashboard vs the chooser —
  // App.tsx shows a loading spinner during that window (none of the testids
  // below exist yet). A one-shot isVisible() sampled right after goto() can
  // land inside that window and wrongly conclude "no sign-out needed",
  // skipping the click and leaving the PREVIOUS actor's session active — the
  // app then never navigates away from Dashboard and every testid below
  // times out. Wait for the bootstrap to resolve one way or the other first.
  //
  // LoginChooserPage (addendum-032-entra-id-sso-login.md) is now the default
  // unauthenticated view — reach LoginPage's email form via its
  // login-chooser__email-login-link first.
  const signOut = page.getByTestId('dashboard__sign-out-button');
  const emailLoginLink = page.getByTestId('login-chooser__email-login-link');
  const emailInput = page.getByTestId('login__email-input');
  const switchToLogin = page.getByTestId('signup__switch-to-login-button');
  await Promise.race([
    signOut.waitFor({ state: 'visible' }),
    emailLoginLink.waitFor({ state: 'visible' }),
    emailInput.waitFor({ state: 'visible' }),
    switchToLogin.waitFor({ state: 'visible' }),
  ]);

  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
    await expect(emailLoginLink.or(emailInput).or(switchToLogin)).toBeVisible();
  }
  if (await emailLoginLink.isVisible().catch(() => false)) {
    await emailLoginLink.click();
  }
  // LoginPage is the default view once past the chooser; if we land on
  // signup instead (shouldn't happen, but defensive), switch back.
  if (await switchToLogin.isVisible().catch(() => false)) {
    await switchToLogin.click();
  }
  await emailInput.fill(email);
  await page.getByTestId('login__password-input').fill(password);
  await page.getByTestId('login__sign-in-button').click();
  // A freshly-created session is 2FA-unverified — clear the gate (enroll+
  // verify on this user's first login, or verify against their earlier-decoded
  // secret on later logins) before the dashboard is reachable. See
  // addendum-046-totp-2fa.md.
  await completeTwoFactor(page, email);
}

// Like login() but stops after the password phase — does NOT complete the 2FA
// gate (enroll or verify). Leaves the session in mid-2FA state: the session
// cookie is set but twofa_verified_at is null. Used by session-expired tests
// that need to assert the 403 twofa_required code path.
export async function loginPasswordOnly(page: Page, email: string, password: string) {
  // Same server-reconciliation flush as login() — never navigate over an
  // in-flight decision POST.
  await flushInFlightRequests(page);
  await page.goto('/');
  const signOut = page.getByTestId('dashboard__sign-out-button');
  const emailLoginLink = page.getByTestId('login-chooser__email-login-link');
  const emailInput = page.getByTestId('login__email-input');
  const switchToLogin = page.getByTestId('signup__switch-to-login-button');
  await Promise.race([
    signOut.waitFor({ state: 'visible' }),
    emailLoginLink.waitFor({ state: 'visible' }),
    emailInput.waitFor({ state: 'visible' }),
    switchToLogin.waitFor({ state: 'visible' }),
  ]);
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
    await expect(emailLoginLink.or(emailInput).or(switchToLogin)).toBeVisible();
  }
  if (await emailLoginLink.isVisible().catch(() => false)) {
    await emailLoginLink.click();
  }
  if (await switchToLogin.isVisible().catch(() => false)) {
    await switchToLogin.click();
  }
  await emailInput.fill(email);
  await page.getByTestId('login__password-input').fill(password);
  await page.getByTestId('login__sign-in-button').click();
  // Wait for the 2FA gate — do NOT complete it.
  const verifyModal = page.getByTestId('two-factor-verify');
  const enrollModal = page.getByTestId('two-factor-enroll');
  await Promise.race([
    verifyModal.waitFor({ state: 'visible' }),
    enrollModal.waitFor({ state: 'visible' }),
  ]);
}

export async function logout(page: Page) {
  const signOut = page.getByTestId('dashboard__sign-out-button');
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
}

// ── Admin Panel tab navigation (addendum-099) ────────────────────────────────
//
// Open an Admin Panel tab by CLICKING its tab-bar button, asserting the switch
// actually happened: canonical URL, the clicked button becomes the ACTIVE one,
// and (optionally) the tab's content mounts. Specs must NOT deep-link
// /dashboard/admin/<slug> with page.goto() — a URL-GOTO never exercises the
// app's own navigation, which is exactly how the slugify() dead-tab regression
// (routes.ts: clicking "Sent Notifications" navigated to /sentemails, a URL matching
// no tab, so the panel silently stayed on the default tab) survived the whole
// suite until manual testing caught it. dashboard-tabs-rendering.spec.ts is
// the dedicated every-tab click-through contract; feature specs use this
// helper for their own entry so they benefit from the same protection.
//
// tabId is the AdminPanel tab id AND the canonical URL slug (AdminPanel.tsx
// keeps them identical): 'access-log' → /dashboard/admin/access-log.
//
// contentTestId: a stable testid that exists only once the tab's component is
// mounted (e.g. 'admin-access-log__table'). Optional — pass it whenever the
// tab has one so mount, not just selection, is proven.
//
// refresh: AdminSentNotifications-style tabs fetch once on mount (useEffect []), so
// re-clicking an ALREADY-active tab refetches nothing and assertions would
// read stale rows. Pass refresh: true to bounce through another tab first
// (both legs via clicks) when the target tab is already active, forcing a
// remount without resorting to a page reload or a URL GOTO.
export async function openAdminTab(
  page: Page,
  tabId: string,
  contentTestId?: string,
  options?: { refresh?: boolean },
): Promise<void> {
  const tab = page.getByTestId(`admin-panel__tab-${tabId}`);
  // The tab bar renders only after AdminPanel's capability fetch resolves —
  // wait for the target button itself rather than sampling (instant one-shot
  // visibility checks were the flake source cited as the old GOTO rationale).
  await expect(tab).toBeVisible({ timeout: 15000 });
  const isActive = ((await tab.getAttribute('class')) ?? '').includes('bg-red-600');
  if (options?.refresh && isActive) {
    const otherTab = page
      .locator(`[data-testid^="admin-panel__tab-"]:not([data-testid="admin-panel__tab-${tabId}"])`)
      .first();
    await otherTab.click();
    await expect(otherTab).toHaveClass(/bg-red-600/);
  }
  await tab.click();
  // Clicking drove real client-side navigation to the tab's canonical slug…
  await expect(page).toHaveURL(new RegExp(`/dashboard/admin/${tabId}$`));
  // …the clicked button became the active one…
  await expect(tab).toHaveClass(/bg-red-600/);
  // …and the tab's component actually mounted when a content testid is given.
  if (contentTestId) {
    await expect(page.getByTestId(contentTestId)).toBeVisible({ timeout: 15000 });
  }
}

// ── Signup ───────────────────────────────────────────────────────────────────

export async function signup(
  page: Page,
  opts: { fullName: string; email: string; password: string },
  delayMs = 0,
) {
  await pacedWait(page, delayMs);
  await page.goto('/');
  // Every OTHER caller of signup() so far (tombstone.spec.ts, and every
  // provisionActorsAndTeams() call — including the demo spec's — while its
  // OWN 9-actor roster is signing up) runs before anyone has logged in, so
  // the app is already on LoginChooserPage/LoginPage and none of this
  // mattered. e2e/demo/happy-path-showcase.spec.ts's delegate signup is the
  // first caller where a PREVIOUS actor's session is still active (the
  // owner, mid owner-feature-tour) — goto('/') then lands straight on
  // Dashboard, none of the signup-flow testids below ever appear, and the
  // fill() calls hang until the whole test times out (confirmed: this, not
  // pacing, was the actual cause of two separate 600s timeouts at this exact
  // step). Sign out first, exactly like login() already does — including
  // login()'s own documented race: AuthProvider's mount-time checkAuth()
  // means none of the testids below exist yet immediately after goto(), so
  // a one-shot isVisible() sampled too early can land inside that window and
  // wrongly read "not logged in" even when a previous actor's session is
  // still active. Wait for the bootstrap to resolve one way or the other
  // first, exactly as login() does.
  const signOut = page.getByTestId('dashboard__sign-out-button');
  const emailLoginLink = page.getByTestId('login-chooser__email-login-link');
  const emailInput = page.getByTestId('login__email-input');
  const switchToLogin = page.getByTestId('signup__switch-to-login-button');
  await Promise.race([
    signOut.waitFor({ state: 'visible' }),
    emailLoginLink.waitFor({ state: 'visible' }),
    emailInput.waitFor({ state: 'visible' }),
    switchToLogin.waitFor({ state: 'visible' }),
  ]);

  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
    await expect(emailLoginLink.or(emailInput).or(switchToLogin)).toBeVisible();
  }
  // LoginChooserPage is the default unauthenticated view — reach LoginPage
  // (and its "Request access" link) via the email-login link first. See
  // addendum-032-entra-id-sso-login.md.
  if (await emailLoginLink.isVisible().catch(() => false)) {
    await emailLoginLink.click();
  }
  // Wait for LoginPage to finish rendering before checking for the signup link.
  // emailLoginLink.click() triggers a navigation; an immediate isVisible() check
  // on login__switch-to-signup-button can race the render and return false,
  // causing the helper to fall through to fill() on the wrong page.
  const requestAccess = page.getByTestId('login__switch-to-signup-button');
  const fullNameInput = page.getByTestId('signup__full-name-input');
  await Promise.race([
    requestAccess.waitFor({ state: 'visible' }),
    fullNameInput.waitFor({ state: 'visible' }),
  ]);
  if (await requestAccess.isVisible().catch(() => false)) {
    await requestAccess.click();
  }
  await fullNameInput.fill(opts.fullName);
  await page.getByTestId('signup__email-input').fill(opts.email);
  await page.getByTestId('signup__password-input').fill(opts.password);
  await page.getByTestId('signup__confirm-password-input').fill(opts.password);
  await page.getByTestId('signup__request-access-button').click();
  // Idempotent: if a concurrent run already created this actor (same email),
  // the server returns "An active account with this email already exists" rather
  // than "Access Request Submitted". Accept either outcome so provisionActorsAndTeams
  // can recover from concurrent-run DB races without false failures.
  const submitted = page.getByText('Access Request Submitted');
  const alreadyExists = page.getByText('An active account with this email already exists');
  await expect(submitted.or(alreadyExists)).toBeVisible({ timeout: 30_000 });
  if (await alreadyExists.isVisible().catch(() => false)) return;
  await page.getByTestId('signup__return-to-signin-button').click();
}

// ── Admin: user approval ─────────────────────────────────────────────────────

export async function approveUser(
  page: Page,
  email: string,
  affiliation: 'agency' | 'vendor',
  delayMs = 0,
  orgName?: string,
) {
  await pacedWait(page, delayMs);
  // Ensure the Pending view is active so the row is visible.
  const pendingTab = page.getByTestId('admin-users__view-pending-tab');
  if (await pendingTab.isVisible().catch(() => false)) {
    await pendingTab.click();
  }
  const row = page.locator('tr', { hasText: email });
  // Row actions are behind the ⋮ hamburger (addendum-077) — open it first.
  // Idempotent guard: if the user is already approved (from a concurrent run),
  // they won't appear in the pending list — skip without failing.
  const menuButton = row.getByTestId('admin-users__row-menu-button');
  const isMenuVisible = await menuButton.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true).catch(() => false);
  if (!isMenuVisible) return;
  await menuButton.click();
  await row.getByTestId('admin-users__approve-button').click();

  const modal = page.getByTestId('admin-users__action-modal');
  await modal.getByTestId('admin-users__affiliation-select').selectOption(affiliation);
  if (orgName) {
    await modal.getByTestId('admin-users__approve-org-picker')
      .locator('label', { hasText: orgName })
      .locator('input[type="checkbox"]')
      .check();
  }
  await modal.getByTestId('admin-users__confirm-button').click();
  await expect(modal).not.toBeVisible();
}

// ── Generic row-scoping helper ────────────────────────────────────────────────

// Finds a <tr> containing `anchorText` and returns the element with the given
// `testId` within it. Centralizes the "ambiguous button text (View/Approve/
// Edit/...), must scope by row" pattern that recurs on every admin/dashboard
// list screen — every action button now shares one testid across all rows
// (per addendum-005's repeated-element rule), so row-scoping is what makes it
// unambiguous.
export function rowButton(page: Page, anchorText: string, testId: string): Locator {
  return page.locator('tr', { hasText: anchorText }).getByTestId(testId);
}

/**
 * Proves an assigned request is already present and actionable in the actor's
 * pending dashboard. Approval suites should use this instead of global Search:
 * the dashboard queue is part of the workflow contract, not merely navigation.
 */
export async function pendingDashboardAction(
  page: Page,
  requestNumber: string,
  actionTestId: string,
): Promise<Locator> {
  const row = page.locator('tr', { hasText: requestNumber });
  await expect(row, `request ${requestNumber} should already be in the actor's pending dashboard`).toBeVisible();
  const direct = row.getByTestId(actionTestId);
  if ((await direct.count()) > 0) {
    // Direct row affordance — e.g. the always-visible View button, which is
    // NOT in the kebab.
    await expect(direct, `${actionTestId} should be ready on request ${requestNumber}`).toBeVisible();
    await expect(direct).toBeEnabled();
    return direct;
  }
  // Addendum-192 / -196: every other row action (Approve / Issue / Close /
  // Edit / Resubmit …) lives behind the row kebab (Radix dropdown). The
  // content is PORTALED out of the <tr> and rendered only while open, so:
  // click THIS row's trigger (row-scoped — one trigger per row), then
  // resolve the item PAGE-scoped (exactly one menu can be open at a time).
  const scope = actionTestId.split('__')[0] ?? '';
  const trigger = row.getByTestId(`${scope}__actions-menu-button`);
  await expect(trigger, `${actionTestId} is neither a direct row button nor reachable via ${requestNumber}'s kebab menu`).toBeVisible();
  // Retry: Radix portal items are rendered on first open; under full-suite DB
  // load the first trigger.click() sometimes does not commit the open state
  // before Playwright starts polling. Retry up to 3 times with Escape between
  // attempts to guarantee a clean closed→open cycle.
  for (let attempt = 0; attempt < 3; attempt++) {
    await trigger.click();
    const item = page.getByTestId(actionTestId);
    const appeared = await item
      .waitFor({ state: 'visible', timeout: 5000 })
      .then(() => true, () => false);
    if (appeared) {
      await expect(item).toBeEnabled();
      return item;
    }
    await page.keyboard.press('Escape');
    // Re-verify trigger is still there before next attempt.
    await expect(trigger, `${actionTestId} is neither a direct row button nor reachable via ${requestNumber}'s kebab menu`).toBeVisible({ timeout: 15000 });
  }
  // If all retries exhausted, let the final attempt fail with a clear message.
  await trigger.click();
  const item = page.getByTestId(actionTestId);
  await expect(item, `${actionTestId} should be in ${requestNumber}'s open row menu`).toBeVisible({ timeout: 10000 });
  await expect(item).toBeEnabled();
  return item;
}

export async function openPendingDashboardRequest(
  page: Page,
  requestNumber: string,
  viewTestId: string,
): Promise<void> {
  await (await pendingDashboardAction(page, requestNumber, viewTestId)).click();
  await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible({ timeout: 30000 });
}

// Same idea, but for card-style (non-<tr>) containers, scoped by a CSS
// selector for the card root plus the anchor text it must contain.
export function cardButton(page: Page, cardSelector: string, anchorText: string, testId: string): Locator {
  return page.locator(cardSelector, { hasText: anchorText }).getByTestId(testId);
}

// ── DateTimePicker (Radix Popover + react-day-picker + native hour/min selects) ─

// Picks TODAY's day cell and then sets hour/minute via the two native selects,
// all scoped to the popover container so they never collide with unrelated
// <select>/<button> elements elsewhere on the page.
//
// The calendar opens on the SELECTED date's month when the field already
// carries a value (DateTimePicker passes defaultMonth, so e.g. the Statistics
// range pickers open on their pre-filled month) and on the current month when
// it is empty. This helper always means "today", so it pages to the current
// month first: clicking today's day NUMBER in a different month would silently
// yield a date a whole month off — which turns an intentionally inverted
// Statistics range into a valid one and the refusal banner never renders.
export async function pickDateTime(
  page: Page,
  trigger: Locator,
  opts: { hour: string; minute: string; date?: Date },
) {
  await trigger.click();
  const popover = page.getByTestId('date-time-picker__popover');
  await expect(popover).toBeVisible();

  // The caption is react-day-picker v8's default formatCaption — date-fns
  // 'LLLL y', e.g. "September 2026". It is the only element RDP marks
  // aria-live="polite" (the class hook is not usable here: this component's
  // classNames map REPLACES the rdp-caption_label default with Tailwind
  // utilities). The nav buttons keep their default aria-labels — the component
  // overrides only the chevron icons.
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  // `date` defaults to today — every existing caller (28 sites) omits it and
  // gets byte-identical behavior to before this option existed.
  const target = opts.date ?? new Date();
  const targetIndex = MONTHS.indexOf(
    target.toLocaleDateString('en-US', { month: 'long' }),
  ) + target.getFullYear() * 12;
  const caption = popover.locator('[aria-live="polite"]').first();
  const prevMonth = popover.getByRole('button', { name: 'Go to previous month' });
  const nextMonth = popover.getByRole('button', { name: 'Go to next month' });
  for (let guard = 0; guard < 24; guard++) {
    const [monthName, yearText] = ((await caption.textContent()) ?? '').trim().split(' ');
    const shownIndex = MONTHS.indexOf(monthName ?? '') + Number(yearText) * 12;
    if (shownIndex === targetIndex) break;
    await (shownIndex < targetIndex ? nextMonth : prevMonth).click();
  }
  await expect(caption).toContainText(
    target.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
  );

  // react-day-picker v8 renders each day as a table <td role="gridcell">,
  // not a <button> — confirmed via Playwright's ARIA snapshot on failure.
  const targetDay = String(target.getDate());
  await popover.getByRole('gridcell', { name: targetDay, exact: true }).first().click();

  await popover.getByTestId('date-time-picker__hour-select').selectOption(opts.hour);
  await popover.getByTestId('date-time-picker__minute-select').selectOption(opts.minute);

  await popover.getByTestId('date-time-picker__done-button').click();
}

// ── Asset-gated credential items (addendum-039-asset-gated-submission.md) ────

// Submission now requires selecting a real, active asset — not free-text
// hostname/userid — via a two-stage hostname -> credential_name combobox
// (AssetCredentialItemRow.tsx, shared by RequestSubmitForm.tsx and
// AEEditPanel.tsx). Fills ONE credential-item row's combobox pair, typing
// enough of the hostname to trigger the >=4-character autocomplete search
// and selecting the exact hostname/credential_name option — the asset
// itself must already exist (created via createAssetViaAdminUI below, or
// by whatever earlier admin-UI step already curated it) before this is
// called, exactly as a real submitter would need a real asset to search for.
export async function fillCredentialItemCombobox(
  itemRow: Locator,
  hostname: string,
  credentialName: string,
) {
  await itemRow.getByTestId('vendor-dashboard__credential-hostname-combobox').click();
  const page = itemRow.page();
  await page.getByPlaceholder('Type at least 4 characters…').fill(hostname);
  await page.getByTestId('vendor-dashboard__credential-hostname-option').filter({ hasText: hostname }).first().click();

  await itemRow.getByTestId('vendor-dashboard__credential-name-combobox').click();
  await page.getByTestId('vendor-dashboard__credential-name-option').filter({ hasText: credentialName }).first().click();
}

// Same combobox pair, but scoped to AEEditPanel.tsx's testid prefix rather
// than RequestSubmitForm.tsx's — the two forms share AssetCredentialItemRow
// but render under different testIdPrefix values.
export async function fillApproverEditCredentialItemCombobox(
  itemRow: Locator,
  hostname: string,
  credentialName: string,
) {
  await itemRow.getByTestId('ae-edit-panel__credential-hostname-combobox').click();
  const page = itemRow.page();
  await page.getByPlaceholder('Type at least 4 characters…').fill(hostname);
  await page.getByTestId('ae-edit-panel__credential-hostname-option').filter({ hasText: hostname }).first().click();

  await itemRow.getByTestId('ae-edit-panel__credential-name-combobox').click();
  await page.getByTestId('ae-edit-panel__credential-name-option').filter({ hasText: credentialName }).first().click();
}

// Curates one manual asset via the admin UI's Assets tab (addendum-037),
// the real precondition submission now needs (addendum-039) — mirrors
// e2e/demo/secret-autorelease-showcase.spec.ts's existing inline pattern,
// extracted here so every spec that needs "a system has one known asset"
// doesn't re-derive this. Caller must already be on a page logged in as an
// admin with the Assets tab open and the target system selected, OR pass
// navigateFirst to have this helper do both.
export async function createAssetViaAdminUI(
  page: Page,
  opts: { systemLabel: string; hostname: string; credentialName: string; credentialType?: 'password' | 'token' | 'device'; navigateFirst?: boolean },
) {
  if (opts.navigateFirst) {
    await page.getByTestId('admin-panel__tab-assets').click();
    // Selecting a system triggers an async GET .../assets — wait for that
    // response directly rather than a UI-visibility proxy, since the
    // loading-state toggle can flip too fast for a plain toBeVisible() to
    // reliably observe the transition (it may already be visible from a
    // previously-selected system and never appear to change).
    await Promise.all([
      page.waitForResponse((res) => /\/admin\/systems\/.+\/assets$/.test(res.url()) && res.request().method() === 'GET'),
      page.getByTestId('admin-assets__system-select').selectOption({ label: opts.systemLabel }),
    ]);
  }
  const rowCountBefore = await page.getByTestId('admin-assets__row').count();
  await page.getByTestId('admin-assets__toggle-create-form-button').click();
  await page.getByTestId('admin-assets__create-hostname-input').fill(opts.hostname);
  await page.getByTestId('admin-assets__create-credential-name-input').fill(opts.credentialName);
  if (opts.credentialType) {
    await page.getByTestId('admin-assets__create-credential-type-select').selectOption(opts.credentialType);
  }
  await page.getByTestId('admin-assets__create-submit-button').click();
  // hostname lives inside a disabled <input>'s value, not text content, so
  // row-scoping by hasText can't find it — wait for the row count to grow
  // instead, then check the new (last) row's hostname input value directly.
  await expect(page.getByTestId('admin-assets__row')).toHaveCount(rowCountBefore + 1);
  await expect(page.getByTestId('admin-assets__hostname-input').last()).toHaveValue(opts.hostname);
}

// Health-check for the LocalStack container backing the gated AWS
// integration's real S3/EventBridge/Lambda round trip (addendum-035,
// addendum-043). Callers that need a real "Sync Now" pull to work should
// check this BEFORE provisioning anything, and fail with an actionable
// message rather than let the sync silently return zero assets.
export async function isLocalStackUp(page: Page): Promise<boolean> {
  try {
    const localstackPort = 4566 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000;
    const res = await page.request.get(`http://localhost:${localstackPort}/_localstack/health`);
    return res.ok();
  } catch {
    return false;
  }
}

// ── Custody action clicks (server-reconciled) ────────────────────────────

// Clicks a per-case custody action button (Prepare & initiate handover /
// Confirm receipt / Initiate return / Verify & restock) and waits for the
// matching POST /requests/:id/asset-custody/actions to COMPLETE before
// returning. RequestAssetCustodySection applies an optimistic projection the
// instant the button is clicked, so asserting the projected badge alone can
// pass while the real POST is still in flight — and the next page.goto()
// (login/logout) then aborts it, silently undoing the action on the server.
// Waiting on the response makes the subsequent state assertions server-true.
export async function clickCustodyActionAndWait(page: Page, button: Locator): Promise<void> {
  await Promise.all([
    page.waitForResponse((res) =>
      /\/requests\/[^/]+\/asset-custody\/actions$/.test(new URL(res.url()).pathname) &&
      res.request().method() === 'POST'
    ),
    button.click(),
  ]);
}

// Drives the Assets admin tab's real "Sync Now" button (addendum-037) until
// the asset table reaches `expectedCount` rows, or gives up. The real S3
// publish -> EventBridge -> Lambda -> S3 response round trip this button
// triggers is eventually consistent, not synchronous — a single click can
// easily race ahead of the (real, containerized) Lambda invocation, exactly
// as test/backend/deno/aws-asset-inventory.test.tsx's own waitFor() polling loop
// already has to account for. Caller must already have the Assets tab open
// with the target system selected (same precondition as
// createAssetViaAdminUI without navigateFirst).
export async function syncAssetsUntilPopulated(
  page: Page,
  expectedCount: number,
  opts: { attempts?: number; delayMs?: number } = {},
): Promise<void> {
  const attempts = opts.attempts ?? 15;
  const delayMs = opts.delayMs ?? 1000;
  const syncButton = page.getByTestId('admin-assets__sync-button');

  for (let attempt = 0; attempt < attempts; attempt++) {
    const [response] = await Promise.all([
      page.waitForResponse((res) => /\/admin\/systems\/.+\/assets\/sync$/.test(res.url()) && res.request().method() === 'POST'),
      syncButton.click(),
    ]);
    const body = await response.json();
    if ((body.assets?.length ?? 0) >= expectedCount) return;
    await page.waitForTimeout(delayMs);
  }

  throw new Error(
    `Asset sync did not reach ${expectedCount} assets after ${attempts} attempts. ` +
    'Is LocalStack running and bootstrapped? Run `docker compose up -d` then `deno task localstack:bootstrap` first.',
  );
}

// ── Visibility assertions (step-scoped request visibility matrix) ────────────

// Scoped to the dashboard's request table, keyed off a unique anchor (system
// name / request number) — the same row-scoping discipline as rowButton, but
// as a plain presence/absence assertion rather than resolving a button.
export async function assertRequestVisible(page: Page, anchor: string): Promise<void> {
  await expect(page.locator('tr', { hasText: anchor })).toBeVisible();
}

export async function assertRequestNotVisible(page: Page, anchor: string): Promise<void> {
  await expect(page.locator('tr', { hasText: anchor })).toHaveCount(0);
}

// Direct-GET check hitting the backend for the CURRENTLY LOGGED-IN actor,
// bypassing any UI-level list filtering entirely — proves the BACKEND
// enforces visibility (per the user's explicit "the backend code literally
// won't send you any details" requirement), not just that the dashboard
// happens to hide a row. Reads the session token out of the same
// localStorage key api.ts uses and issues the fetch from within the page's
// own context (so it's a byte-for-byte real browser request, not a
// Node-side bypass). Backend port/path mirror playwright.config.ts's
// E2E_BACKEND_URL — hardcoded here the same way global-setup.ts hardcodes
// its own E2E_DB_URL, since both are fixed values for this suite's run.
const E2E_BACKEND_URL = process.env['E2E_BACKEND_URL'] ??
  `http://localhost:${8789 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`;

export async function directGetRequestStatus(page: Page, requestId: string): Promise<number> {
  return page.evaluate(async ({ base, id }) => {
    // Session auth now rides on the HttpOnly cookie (addendum-080) — sent
    // automatically with credentials:'include'.
    const res = await fetch(`${base}/requests/${id}`, { credentials: 'include' });
    return res.status;
  }, { base: E2E_BACKEND_URL, id: requestId });
}

export async function assertRequestNotVisibleViaDirectFetch(page: Page, requestId: string): Promise<void> {
  const status = await directGetRequestStatus(page, requestId);
  expect(status).toBe(404);
}

// Generic sibling of directGetRequestStatus for callers that need to supply
// an EXPLICIT session token rather than whatever's currently in the page's
// own localStorage — e.g. proving a session captured from actor A, before
// switching the page to actor B, is now dead after some intervening action
// (tombstone.spec.ts). Still issued from within the page's own context, same
// "real browser request" rationale as directGetRequestStatus.
export async function directFetchStatus(page: Page, path: string, token: string | null): Promise<number> {
  return page.evaluate(async ({ base, path, token }) => {
    const res = await fetch(`${base}${path}`, {
      headers: token ? { 'X-Session-Token': token } : {},
    });
    return res.status;
  }, { base: E2E_BACKEND_URL, path, token });
}

// ── Generic modal helpers ─────────────────────────────────────────────────────

// Scopes to a modal/panel container by its own testid — every modal in this
// app now carries one (per addendum-005), so no heading-text/DOM-structure
// fallback is needed.
// Read the HttpOnly session cookie value the browser holds (addendum-080).
// Useful for cross-actor proofs (capture actor A's cookie, then show it is
// dead after an action) — the value is an opaque session id that can also be
// sent as X-Session-Token (the server's dual-path), which is exactly what
// directFetchStatus does.
export async function getSessionCookie(page: Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  const session = cookies.find(
    (c) => c.name === 'ffs_session' || c.name === '__Host-ffs_session',
  );
  return session?.value ?? null;
}

export function modalByTestId(page: Page, testId: string): Locator {
  return page.getByTestId(testId);
}

// ── Before/after screenshot capture (Pending Refinements.md item 9) ──────────

// test_output/e2e/screenshots/ is gitignored — a run-artifact directory, not
// checked-in fixtures. Created on first import so specs never have to
// remember to. Lives under test_output/ (not e2e/) so run artifacts never
// intermingle with source — see addendum-052-test-output-consolidation.md.
const SCREENSHOT_DIR = join(process.cwd(), 'test_output', 'e2e', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  // Hyphens, not colons, in the time portion — colons aren't filename-safe
  // on every filesystem this repo might run tests on.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// "Before" = called with the form fully filled, immediately before the
// submit click. "After" = called once the click's resulting network
// activity has settled (page.waitForLoadState('networkidle')).
export async function captureBefore(page: Page, testSuiteId: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${timestamp()} (${testSuiteId}) - Before.png`) });
}

export async function captureAfter(page: Page, testSuiteId: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${timestamp()} (${testSuiteId}) - After.png`) });
}

// Wraps a submit/action click with the before/after pair above, so specs
// don't have to hand-roll the timing at every submission moment. `testSuiteId`
// should identify the specific action (e.g. "happy-path-submit-request"), not
// just the spec file, so screenshots from the same run don't collide.
export async function submitWithCapture(page: Page, testSuiteId: string, submitLocator: Locator): Promise<void> {
  await captureBefore(page, testSuiteId);
  await submitLocator.click();
  await page.waitForLoadState('networkidle');
  await captureAfter(page, testSuiteId);
}

// Same as submitWithCapture, but for the ONE submission that a later stage
// needs the server-assigned id from (POST /requests) — every subsequent
// visibility check in the expanded matrix keys off request.id, not just the
// system-name anchor the row-scoping helpers use. Races the click against
// the matching response so the id is captured regardless of how fast the
// UI itself re-renders.
export type SubmittedRequestIdentity = { id: string; requestNumber: string };

export async function submitRequestIdentityWithCapture(
  page: Page,
  testSuiteId: string,
  submitLocator: Locator,
): Promise<SubmittedRequestIdentity> {
  await captureBefore(page, testSuiteId);
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/requests') && res.request().method() === 'POST'),
    submitLocator.click(),
  ]);
  await page.waitForLoadState('networkidle');
  await captureAfter(page, testSuiteId);
  const body = await response.json();
  return {
    id: body.request.id as string,
    requestNumber: body.request.requestNumber as string,
  };
}

export async function submitRequestWithCapture(page: Page, testSuiteId: string, submitLocator: Locator): Promise<string> {
  return (await submitRequestIdentityWithCapture(page, testSuiteId, submitLocator)).id;
}

// submitWithCapture's sibling for interactions that AREN'T form submissions —
// opening a detail view, opening an action modal, clicking into a row's
// action-trigger before the confirm click. Extends screenshot coverage to
// "all interactions", not just submissions (per the user's explicit ask:
// "just before he clicks the Approve link, and after he clicks the approve
// link"). Defaults to NOT waiting for anything extra, since opening a modal
// is typically a pure client-side state change.
//
// `waitForNetworkIdle: true` (kept for callers that already pass it) is a
// KNOWN-UNRELIABLE signal for a click that triggers a fetch indirectly via a
// React effect rather than synchronously in the click handler — e.g.
// RequestDetailView's data load happens in a useEffect on mount, one render
// pass AFTER the click just flips local state (setSelectedRequest). Network
// activity can start late enough that waitForLoadState('networkidle')
// observes "nothing in flight yet" and resolves before the fetch even
// begins, capturing the "After" screenshot mid-spinner (confirmed: this is
// exactly what produced a bare "Loading request…" screenshot in
// owner-pending-count.spec.ts's captures). Prefer `waitForLocator` for any
// click that lands on a page with a real loaded-state element to wait for.
export async function clickWithCapture(
  page: Page,
  testSuiteId: string,
  locator: Locator,
  opts: { waitForNetworkIdle?: boolean; waitForLocator?: Locator } = {},
): Promise<void> {
  await captureBefore(page, testSuiteId);
  await locator.click();
  if (opts.waitForLocator) await expect(opts.waitForLocator).toBeVisible();
  else if (opts.waitForNetworkIdle) await page.waitForLoadState('networkidle');
  await captureAfter(page, testSuiteId);
}
