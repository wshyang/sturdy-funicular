import { test, expect } from '../helpers/harness';

// Runs against the isolated breakglass_test database and a backend instance
// with ENTRA_TENANT_ID/etc. explicitly cleared (see playwright.config.ts) —
// so every assertion here exercises the "Entra not configured" path. A real
// callback round-trip against a live Entra tenant is untestable in this
// suite; see addendum-032-entra-id-sso-login.md.

test.describe('entra sso', () => {
  test('fresh page load shows the chooser, not the email form', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login-chooser__entra-button')).toBeVisible();
    await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible();
    await expect(page.getByTestId('login__email-input')).not.toBeVisible();
  });

  test('clicking "Login with Entra ID" round-trips to a friendly not-configured banner', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-chooser__entra-button').click();
    await expect(page.getByTestId('login-chooser__error-banner')).toBeVisible();
    await expect(page.getByTestId('login-chooser__error-banner')).toContainText(
      'Entra ID login is not available yet',
    );
    // Round-tripped back to the chooser, not stuck on some intermediate page.
    await expect(page.getByTestId('login-chooser__entra-button')).toBeVisible();
  });

  test('clicking "Login / Sign up with Email" reveals today\'s email login form', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-chooser__email-login-link').click();
    await expect(page.getByTestId('login__email-input')).toBeVisible();
    await expect(page.getByTestId('login__password-input')).toBeVisible();
  });

  test('the back link on the email login form returns to the chooser', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-chooser__email-login-link').click();
    await expect(page.getByTestId('login__email-input')).toBeVisible();

    await page.getByTestId('login__back-to-chooser-button').click();
    await expect(page.getByTestId('login-chooser__entra-button')).toBeVisible();
  });

  test('the back link on the signup form returns to the chooser', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('login-chooser__email-login-link').click();
    await page.getByTestId('login__switch-to-signup-button').click();
    await expect(page.getByTestId('signup__full-name-input')).toBeVisible();

    await page.getByTestId('signup__back-to-chooser-button').click();
    await expect(page.getByTestId('login-chooser__entra-button')).toBeVisible();
  });
});
