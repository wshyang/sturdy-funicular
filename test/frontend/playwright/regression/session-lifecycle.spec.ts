// E2E coverage for the session lifecycle UI contract (addendum-097):
//
//   A. Sign-out is a first-class LINK. The header Sign Out button routes
//      through /logout, and a direct visit to /logout (bookmark/paste) signs
//      the user out and lands on the login chooser at '/'.
//   B. Single-session sign-in + dead-session UX: when the same user signs in
//      on a second device, the first session is invalidated immediately; the
//      first device's next API call is answered `session_expired`, and the
//      app silently returns to the login chooser — exactly as if the user had
//      clicked the sign-out link — instead of showing an error banner.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, completeTwoFactor } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('session lifecycle (addendum-097)', () => {
  test('sign out routes through the /logout link, and a direct /logout visit signs out too', async ({ page }) => {
    await test.step('header Sign Out button → /logout route → login chooser at /', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await completeTwoFactor(page, SUPERADMIN.email);
      await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();

      await page.getByTestId('dashboard__sign-out-button').click();
      await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
    });

    await test.step('direct /logout navigation (bookmark/paste) signs the session out', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await completeTwoFactor(page, SUPERADMIN.email);
      await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();

      await page.goto('/logout');
      await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible();
      await expect(page).toHaveURL(/\/$/);

      // The session is really gone server-side: the dashboard URL now shows
      // the chooser, not the app.
      await page.goto('/dashboard');
      await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible();
    });
  });

  test('signing in on a second device invalidates the first session and auto-signs-out the first device', async ({ page, browser }) => {
    // Device 1: fully signed in past the 2FA gate.
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await completeTwoFactor(page, SUPERADMIN.email);
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();

    // Device 2 (fresh browser context = separate cookie jar): the same user
    // signs in, which deletes device 1's session row at mint time.
    const context2 = await browser.newContext();
    const page2 = await context2.newPage();
    try {
      await login(page2, SUPERADMIN.email, SUPERADMIN.password);
      await completeTwoFactor(page2, SUPERADMIN.email);
      await expect(page2.getByTestId('dashboard__sign-out-button')).toBeVisible();

      // Device 1 discovers its dead session on its next API call: the search
      // overlay's /requests/search comes back session_expired, the http layer
      // fires the registered handler, and the app lands on the login chooser
      // at '/' with NO error banner.
      await page.getByTestId('dashboard__search-button').click();
      await page.getByTestId('search-overlay__query-input').fill('BG');
      await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible();
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByTestId('login-chooser__error-banner')).not.toBeVisible();

      // Device 2 keeps the sole surviving session throughout.
      await expect(page2.getByTestId('dashboard__sign-out-button')).toBeVisible();
    } finally {
      await context2.close();
    }
  });
});
