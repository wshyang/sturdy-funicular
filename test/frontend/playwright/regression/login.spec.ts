import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { submitWithCapture, completeTwoFactor } from '../helpers/ui';

// Runs against the isolated breakglass_test database (see global-setup.ts /
// playwright.config.ts) — never the dev database. The fixture user is
// created once in globalSetup before any test runs.

test.describe('login', () => {
  test('user logs in successfully and reaches the dashboard', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-chooser__email-login-link').click();

    await page.getByTestId('login__email-input').fill(E2E_USER_EMAIL);
    await page.getByTestId('login__password-input').fill(E2E_USER_PASSWORD);
    await submitWithCapture(page, 'login-success', page.getByTestId('login__sign-in-button'));

    // A fresh session is 2FA-unverified — a real second-factor step gates the
    // dashboard (enroll+QR-decode on this user's first login of the run, or
    // verify against its earlier-decoded secret on a later one; the suite runs
    // sequentially against one shared DB, so which gate shows depends on run
    // order). completeTwoFactor handles either — no mocks (addendum-046).
    await completeTwoFactor(page, E2E_USER_EMAIL);

    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
  });

  test('wrong password shows an inline error and does not log in', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-chooser__email-login-link').click();

    await page.getByTestId('login__email-input').fill(E2E_USER_EMAIL);
    await page.getByTestId('login__password-input').fill('DefinitelyWrongPassword!2026');
    await submitWithCapture(page, 'login-wrong-password', page.getByTestId('login__sign-in-button'));

    await expect(page.getByText('Invalid email or password.')).toBeVisible();
    await expect(page.getByTestId('dashboard__sign-out-button')).not.toBeVisible();
  });
});
