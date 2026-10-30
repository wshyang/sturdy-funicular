import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, logout, signup, approveUser, submitWithCapture } from '../helpers/ui';
import { recoverSecretFromEnrollModal, computeTotp } from '../helpers/totp';

// Real, non-mocked TOTP 2FA end-to-end (addendum-046-totp-2fa.md). The
// enrollment code is computed from the QR code's RENDERED PIXELS — the spec
// screenshots the enrollment modal's <img>, decodes the PNG with jsqr to
// recover the otpauth:// URI, parses out the secret, and derives the current
// code with otpauth — exactly as a user's phone would. Nothing is mocked and
// nothing is read out-of-band; the code entered is derived from what the
// browser actually painted.
//
// Runs against the isolated breakglass_test database (global-setup.ts).

test.describe('two-factor authentication', () => {
  // Reach the credential-entry form on LoginPage (past the chooser), without
  // completing 2FA — the individual tests assert the gate state themselves.
  async function fillCredentials(page: import('@playwright/test').Page, email: string, password: string) {
    await page.goto('/');
    const signOut = page.getByTestId('dashboard__sign-out-button');
    const emailLoginLink = page.getByTestId('login-chooser__email-login-link');
    const emailInput = page.getByTestId('login__email-input');
    await Promise.race([
      signOut.waitFor({ state: 'visible' }),
      emailLoginLink.waitFor({ state: 'visible' }),
      emailInput.waitFor({ state: 'visible' }),
    ]);
    if (await signOut.isVisible().catch(() => false)) {
      await signOut.click();
      await expect(emailLoginLink.or(emailInput)).toBeVisible();
    }
    if (await emailLoginLink.isVisible().catch(() => false)) {
      await emailLoginLink.click();
    }
    await emailInput.fill(email);
    await page.getByTestId('login__password-input').fill(password);
  }

  test('first login enrolls via the scanned QR, then a later login verifies against it', async ({ page }) => {
    // A brand-new, un-enrolled user: sign up, then approve as the enrolled
    // fixture admin (login() clears the admin's own verify gate).
    const email = `twofa-new-${Date.now()}@test.local`;
    const password = 'TwoFactorNew!2026';
    await signup(page, { fullName: '2FA New User', email, password });

    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD); // fixture admin
    await approveUser(page, email, 'vendor');
    await logout(page);

    // ── First login → ENROLLMENT gate ──────────────────────────────────────
    await fillCredentials(page, email, password);
    await submitWithCapture(page, '2fa-first-login', page.getByTestId('login__sign-in-button'));

    // The blocking enrollment modal appears (not the dashboard, not verify).
    await expect(page.getByTestId('two-factor-enroll')).toBeVisible();
    await expect(page.getByTestId('two-factor-enroll__qr-image')).toBeVisible();
    await expect(page.getByTestId('dashboard__sign-out-button')).not.toBeVisible();

    // Recover the secret from the QR's rendered pixels and enter a live code.
    const secret = await recoverSecretFromEnrollModal(page);
    // fill() triggers auto-submit (ca166ea onChange → handleVerify); no button click needed.
    await page.getByTestId('two-factor-enroll__code-input').fill(computeTotp(secret));
    await page.waitForLoadState('networkidle');

    // Enrollment complete → dashboard reached.
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();

    // ── Log out, log back in → VERIFY gate (already enrolled) ───────────────
    await logout(page);
    await fillCredentials(page, email, password);
    await submitWithCapture(page, '2fa-return-login', page.getByTestId('login__sign-in-button'));

    // Now the returning-user VERIFY modal appears (no QR — already enrolled).
    await expect(page.getByTestId('two-factor-verify')).toBeVisible();
    await expect(page.getByTestId('two-factor-enroll__qr-image')).not.toBeVisible();

    // Same secret, fresh code. fill() triggers auto-submit; no button click needed.
    await page.getByTestId('two-factor-verify__code-input').fill(computeTotp(secret));
    await page.waitForLoadState('networkidle');
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
  });

  test('a wrong code on the verify gate is rejected inline and does not reach the dashboard', async ({ page }) => {
    // Get a fresh user through enrollment first (so this test doesn't depend on
    // another spec having enrolled the fixture user), then log back in to reach
    // the VERIFY gate and enter a deliberately wrong code.
    const email = `twofa-wrong-${Date.now()}@test.local`;
    const password = 'TwoFactorWrong!2026';
    await signup(page, { fullName: '2FA Wrong Code', email, password });
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD); // fixture admin approves
    await approveUser(page, email, 'vendor');
    await logout(page);

    // First login enrolls (login() decodes the QR + remembers the secret).
    await login(page, email, password);
    await logout(page);

    // Second login → verify gate. Enter a wrong code; it must be rejected.
    await fillCredentials(page, email, password);
    await page.getByTestId('login__sign-in-button').click();
    await expect(page.getByTestId('two-factor-verify')).toBeVisible();
    // fill() auto-submits; wait for the error response instead of clicking the button.
    await page.getByTestId('two-factor-verify__code-input').fill('000000');
    await expect(page.getByTestId('two-factor-verify__error')).toBeVisible();
    await expect(page.getByTestId('dashboard__sign-out-button')).not.toBeVisible();
  });
});
