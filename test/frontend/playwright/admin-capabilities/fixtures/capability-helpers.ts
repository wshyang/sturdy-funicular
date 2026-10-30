// Capability Helpers for Frontend Testing
//
// Provides helper functions for testing admin capabilities in the frontend.
// These functions handle login, navigation, assertions, and common patterns.
//
// Usage:
//   import { loginAs, navigateTo, assertVisible } from './capability-helpers';
//
// See: capability-users.ts for test user definitions
// See: PLAN.md for test suite design

import { expect, Page } from '@playwright/test';
import type { TestUser } from './capability-users';
import { SUPER_ADMIN } from './capability-users';

// ============================================================================
// CONSTANTS
// ============================================================================

/** Default timeout for assertions */
export const DEFAULT_TIMEOUT = 10000; // 10 seconds

/** Short timeout for quick checks */
export const SHORT_TIMEOUT = 5000; // 5 seconds

/** Long timeout for slow operations */
export const LONG_TIMEOUT = 30000; // 30 seconds

// ============================================================================
// LOGIN HELPERS
// ============================================================================

/**
 * Log in as a specific test user via the full login+2FA flow.
 * Uses the real login flow (login chooser → email form → 2FA enrollment/verify).
 *
 * @param page - Playwright page
 * @param user - Test user to log in as
 */
export async function loginAs(page: Page, user: TestUser): Promise<void> {
  await page.goto('/');
  // Wait for the auth bootstrap to settle (AuthProvider's mount-time checkAuth()
  // is async — one-shot isVisible() too early can land inside that window and miss
  // an existing session). Same pattern as helpers/ui.ts login().
  const signOut = page.getByTestId('dashboard__sign-out-button');
  const emailLoginLink = page.getByTestId('login-chooser__email-login-link');
  const emailInput = page.getByTestId('login__email-input');
  const switchToLogin = page.getByTestId('signup__switch-to-login-button');

  await Promise.race([
    signOut.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
    emailLoginLink.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
    emailInput.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
    switchToLogin.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
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

  await emailInput.fill(user.email);
  await page.getByTestId('login__password-input').fill(user.password);
  await page.getByTestId('login__sign-in-button').click();

  // Handle 2FA: if enroll or verify gate appears, complete it.
  const dashboard = page.getByTestId('dashboard__sign-out-button');
  const verifyModal = page.getByTestId('two-factor-verify');
  const enrollModal = page.getByTestId('two-factor-enroll');

  // Use a generous timeout — 2FA gate may need a moment to render.
  try {
    await Promise.race([
      dashboard.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
      verifyModal.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
      enrollModal.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
    ]);
  } catch {
    // If nothing appeared, fall through — the test will fail with a clear error
  }

  if (await enrollModal.isVisible().catch(() => false)) {
    // Dynamically import TOTP helpers to avoid a hard dep at module load time.
    const { recoverSecretFromEnrollModal, rememberSecret, computeTotp } = await import(
      '../../helpers/totp'
    );
    const secret = await recoverSecretFromEnrollModal(page);
    rememberSecret(user.email, secret);
    await page.getByTestId('two-factor-enroll__code-input').fill(computeTotp(secret));
    // The UI may auto-submit on 6-digit fill (button becomes disabled/detached while
    // the request is in flight). Use a short timeout so we don't wait 15 s for a
    // detached element; the dashboard check below confirms the overall flow succeeded.
    await page.getByTestId('two-factor-enroll__verify-button').click({ timeout: 3000 }).catch(() => {});
  } else if (await verifyModal.isVisible().catch(() => false)) {
    const { recallSecret, computeTotp } = await import('../../helpers/totp');
    const secret = recallSecret(user.email);
    if (!secret) {
      throw new Error(
        `No enrolled TOTP secret for ${user.email} — the verify gate appeared but this user never enrolled in this run.`,
      );
    }
    await page.getByTestId('two-factor-verify__code-input').fill(computeTotp(secret));
    // Same auto-submit guard as the enroll path above.
    await page.getByTestId('two-factor-verify__verify-button').click({ timeout: 3000 }).catch(() => {});
  }

  await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible({ timeout: LONG_TIMEOUT });
}

/**
 * Log out the current user.
 */
export async function logout(page: Page): Promise<void> {
  const signOut = page.getByTestId('dashboard__sign-out-button');
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
}

/**
 * Ensure a user is logged out before logging in as another user.
 */
export async function switchToUser(page: Page, user: TestUser): Promise<void> {
  await logout(page);
  await loginAs(page, user);
}

// ============================================================================
// NAVIGATION HELPERS (addendum-099: UI-reachability, no URL GOTO cheats)
// ============================================================================
//
// The admin dashboard is reached through the app's own navigation — NEVER by
// page.goto('/admin') or '/admin/...'. Those /admin* URLs match NO route (the
// App.tsx router only serves '/' and '/dashboard/*'; everything else falls
// through a catch-all redirect to /dashboard), so specs that "navigated" to
// them were really just landing on the default dashboard — and a restricted-
// user's "direct navigation should fail" assertion on them proved nothing,
// because the URL names no page for anyone.
//
// goToAdminDashboard — for actors that HOLD the admin role (any admin
//   capability user): where the role droplet exists (multi-role actor), switch
//   to Administrator via it; where it doesn't (admin-only actor), the
//   AdminPanel is already the only/most-actionable role screen and simply has
//   to mount. Either way the helper only returns once the admin tab bar is
//   actually on screen.
//
// assertNoAdminSurface — for actors with NO admin capabilities (REGULAR_USER):
//   no admin role means the AdminPanel never mounts and the role droplet
//   never offers Administrator — assert exactly that on their own dashboard.

/**
 * Reach the admin dashboard through the app's own role navigation and wait
 * until the Admin Panel tab bar has rendered. Throws (via expect) when the
 * actor holds no admin role — use assertNoAdminSurface for those actors.
 */
export async function goToAdminDashboard(page: Page): Promise<void> {
  // Post-login the dashboard is already mounted; the role summary (and the
  // AdminPanel's own capability fetch) resolve asynchronously.
  await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible({ timeout: LONG_TIMEOUT });
  const roleSelect = page.getByTestId('dashboard__role-select');
  const anyTab = page.locator('[data-testid^="admin-panel__tab-"]').first();
  // Wait for the role summary to settle one way or the other: a droplet
  // (multi-role actor — its default, "most actionable", role may not be
  // admin) or the admin tab bar directly (admin-only actor).
  await Promise.race([
    roleSelect.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
    anyTab.waitFor({ state: 'visible', timeout: LONG_TIMEOUT }),
  ]).catch(() => {
    // Neither appeared (no admin role) — fall through to the hard expect
    // below, which fails with a far more readable message than a bare timeout.
  });
  if (await roleSelect.isVisible().catch(() => false)) {
    // The role droplet is the app's ONLY role-navigation control: switching
    // roles through it is the real user path (selecting the already-active
    // role is a harmless no-op).
    await roleSelect.selectOption('admin');
  }
  await expect(anyTab).toBeVisible({ timeout: LONG_TIMEOUT });
}

/**
 * Assert that a user with no admin capabilities has NO admin surface: on
 * their own dashboard the Admin Panel never mounts (zero admin tab-bar
 * elements), and the role droplet — when the actor holds multiple roles —
 * offers no Administrator option. This is the honest version of the old
 * `navigateTo('/admin') + assertNotVisible(...)` pattern, which passed on a
 * catch-all redirect without ever testing an app route.
 */
export async function assertNoAdminSurface(page: Page): Promise<void> {
  await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible({ timeout: LONG_TIMEOUT });
  await expect(page.locator('[data-testid^="admin-panel__tab-"]')).toHaveCount(0, { timeout: LONG_TIMEOUT });
  const roleSelect = page.getByTestId('dashboard__role-select');
  if (await roleSelect.isVisible().catch(() => false)) {
    await expect(roleSelect.locator('option[value="admin"]')).toHaveCount(0);
  }
  // (The droplet check is best-effort: for a no-admin actor the droplet may
  // legitimately never render when they hold a single role — the count-0
  // tab-bar assertion above is the load-bearing one.)
}

/**
 * Navigate directly to a URL and optionally assert success. Kept for genuine
 * URL-driven flows (entry, direct-link tests); admin-tab navigation must use
 * goToAdminDashboard / clicks instead.
 */
export async function navigateTo(
  page: Page,
  url: string,
  options: { expectSuccess?: boolean } = { expectSuccess: true },
): Promise<void> {
  await page.goto(url);
  if (options.expectSuccess) {
    await page.waitForLoadState('networkidle');
  } else {
    await page.waitForTimeout(500);
  }
}

// ============================================================================
// ASSERTION HELPERS
// ============================================================================

/**
 * Resolve a selector/testid/text to a Playwright locator.
 * - If the string contains '__' (testid convention) → getByTestId
 * - Otherwise → getByText (for plain text strings like 'Admin Panel')
 * When page is also provided but selector is null, returns the page body.
 */
function resolveLocator(page: Page, selector: string | null) {
  if (selector === null) {
    return page.locator('body');
  }
  // testid convention: lowercase__kebab-case
  if (selector.includes('__') || selector.startsWith('admin-') || selector.startsWith('email-') || selector.startsWith('two-factor')) {
    return page.getByTestId(selector);
  }
  return page.getByText(selector, { exact: false });
}

/**
 * Assert that an element/text is visible on the page.
 * Accepts a testid (with '__') or plain text string.
 */
export async function assertVisible(
  page: Page,
  selector: string,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  const locator = resolveLocator(page, selector);
  await expect(locator.first()).toBeVisible({ timeout });
}

/**
 * Assert that an element/text is NOT visible on the page.
 * Accepts a testid (with '__') or plain text string.
 */
export async function assertNotVisible(
  page: Page,
  selector: string,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  const locator = resolveLocator(page, selector);
  await expect(locator.first()).not.toBeVisible({ timeout });
}

/**
 * Assert that an element has exact text.
 * Accepts a testid or plain text string as selector.
 */
export async function assertText(
  page: Page,
  selector: string,
  expectedText: string | RegExp,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  const locator = resolveLocator(page, selector);
  await expect(locator.first()).toHaveText(expectedText, { timeout });
}

/**
 * Assert that an element or the full page body contains specific text.
 * Pass null as selector to search the entire page body.
 */
export async function assertContainsText(
  page: Page,
  selector: string | null,
  expectedText: string | RegExp,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  const locator = resolveLocator(page, selector);
  await expect(locator.first()).toContainText(expectedText, { timeout });
}

/**
 * Assert that an element has a specific CSS class.
 */
export async function assertHasClass(
  page: Page,
  selector: string,
  className: string,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  const locator = resolveLocator(page, selector);
  await expect(locator.first()).toHaveClass(new RegExp(className), { timeout });
}

/**
 * Assert that an error message is displayed.
 */
export async function assertErrorMessage(
  page: Page,
  expectedMessage: string | RegExp,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  await expect(page.locator('.error-message').first()).toContainText(expectedMessage, { timeout });
}

/**
 * Assert that a success message is displayed.
 */
export async function assertSuccessMessage(
  page: Page,
  expectedMessage: string | RegExp,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  await expect(page.locator('.success-message').first()).toContainText(expectedMessage, { timeout });
}

/**
 * Assert that the current URL matches expected.
 */
export async function assertURL(
  page: Page,
  expectedURL: string | RegExp,
  timeout: number = SHORT_TIMEOUT,
): Promise<void> {
  await expect(page).toHaveURL(expectedURL, { timeout });
}

/**
 * Assert that the current URL does NOT match expected.
 */
export async function assertNotURL(
  page: Page,
  unexpectedURL: string | RegExp,
): Promise<void> {
  const currentURL = page.url();
  if (typeof unexpectedURL === 'string') {
    expect(currentURL).not.toBe(unexpectedURL);
  } else {
    expect(unexpectedURL.test(currentURL)).toBe(false);
  }
}

// ============================================================================
// INTERACTION HELPERS
// ============================================================================

/**
 * Click a button by its data-testid.
 */
export async function clickButton(page: Page, testId: string): Promise<void> {
  await page.getByTestId(testId).click();
}

/**
 * Fill an input field identified by data-testid.
 */
export async function fillInput(page: Page, testId: string, value: string): Promise<void> {
  const input = page.getByTestId(testId);
  await input.clear();
  await input.fill(value);
}

/**
 * Select an option in a <select> element identified by data-testid.
 */
export async function selectOption(
  page: Page,
  testId: string,
  valueOrLabel: string,
): Promise<void> {
  await page.getByTestId(testId).selectOption(valueOrLabel);
}

/**
 * Check a checkbox identified by data-testid.
 */
export async function checkCheckbox(page: Page, testId: string): Promise<void> {
  const checkbox = page.getByTestId(testId);
  if (!(await checkbox.isChecked())) {
    await checkbox.check();
  }
}

/**
 * Uncheck a checkbox identified by data-testid.
 */
export async function uncheckCheckbox(page: Page, testId: string): Promise<void> {
  const checkbox = page.getByTestId(testId);
  if (await checkbox.isChecked()) {
    await checkbox.uncheck();
  }
}

/**
 * Wait for a loading spinner/state to disappear.
 * Waits for network to be idle and any loading indicators to resolve.
 */
export async function waitForLoading(page: Page, timeout: number = LONG_TIMEOUT): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout });
}

/**
 * Wait for a specific selector/testid to become visible.
 */
export async function waitForSelector(
  page: Page,
  selector: string,
  timeout: number = LONG_TIMEOUT,
): Promise<void> {
  const locator = resolveLocator(page, selector);
  await locator.first().waitFor({ state: 'visible', timeout });
}

/**
 * Get the current page URL.
 */
export async function getCurrentUrl(page: Page): Promise<string> {
  return page.url();
}

// ============================================================================
// CAPABILITY TESTING HELPERS
// ============================================================================

/**
 * Create a test function (for use as a `test('name', fn)` callback) that:
 *  - Logs in as the given user
 *  - Navigates to /admin
 *  - Asserts the tab (admin-panel__tab-<tabId>) is visible or not visible
 *
 * Usage (matching the spec's call pattern):
 *   test('name', createVisibilityCapabilityTest({ capability, tabId, user, shouldBeVisible }))
 */
export function createVisibilityCapabilityTest(config: {
  capability: string;
  tabId: string;
  user: TestUser;
  shouldBeVisible: boolean;
}): ({ page }: { page: import('@playwright/test').Page }) => Promise<void> {
  return async ({ page }: { page: import('@playwright/test').Page }) => {
    await loginAs(page, config.user);

    // Users with NO admin capabilities (e.g. REGULAR_USER) never get the
    // admin role, so the AdminPanel simply isn't part of their app — the
    // meaningful negative is that no admin surface exists at all, not that
    // one tab is missing from a panel they should never see. (Previously
    // this helper navigateTo('/admin')'d — a URL matching no route that the
    // catch-all silently redirected, making every such "negative" test pass
    // without asserting anything about the app.)
    if (config.user.capabilities.size === 0) {
      await assertNoAdminSurface(page);
      return;
    }

    await goToAdminDashboard(page);
    await waitForLoading(page);
    const testId = `admin-panel__tab-${config.tabId}`;
    if (config.shouldBeVisible) {
      await assertVisible(page, testId);
    } else {
      // A limited-capability admin DOES get the panel; their absent tab is a
      // genuine capability-scoping assertion against the live tab bar.
      await assertNotVisible(page, testId);
    }
  };
}

/**
 * Test the baseline/positive/negative pattern for a capability.
 *
 * Usage (matching the spec's call pattern):
 *   test('name', createCapabilityTest({ capability, tabId, user, shouldBeVisible }))
 *
 * Also supports the object form with elementSelector/pagePath/action.
 */
export function createCapabilityTest(
  config: {
    capability?: string;
    tabId?: string;
    user?: TestUser;
    shouldBeVisible?: boolean;
    elementSelector?: string;
    pagePath?: string;
    action?: (page: import('@playwright/test').Page) => Promise<void>;
    successIndicator?: string;
    errorMessage?: string;
  },
): ({ page }: { page: import('@playwright/test').Page }) => Promise<void> {
  return async ({ page }: { page: import('@playwright/test').Page }) => {
    const user = config.user ?? SUPER_ADMIN;
    await loginAs(page, user);

    if (config.tabId) {
      if (user.capabilities.size === 0) {
        await assertNoAdminSurface(page);
      } else {
        await goToAdminDashboard(page);
      }
    }

    if (config.tabId) {
      const testId = `admin-panel__tab-${config.tabId}`;
      if (config.shouldBeVisible) {
        await assertVisible(page, testId);
      } else {
        await assertNotVisible(page, testId);
      }
    }

    if (config.elementSelector) {
      if (config.shouldBeVisible) {
        await assertVisible(page, config.elementSelector);
      } else {
        await assertNotVisible(page, config.elementSelector);
      }
    }

    if (config.action) {
      await config.action(page);
    }

    if (config.successIndicator) {
      await assertVisible(page, config.successIndicator);
    }
  };
}

// All symbols above are individually exported with `export` at their declaration.
