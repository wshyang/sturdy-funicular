// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md), §A onboarding surfaces — browser-real pins for the element
// behaviours jsdom (EntryOnboarding.coverage.test.tsx) can only simulate and
// the deep-flow specs deliberately do not repeat:
//   * accept-invite's client-side confirm-mismatch refusal (the token never
//     posts — accept-invite.spec owns the weak-password and fabricated-token
//     server arms, 2fa.spec owns the wrong-code verify arm; neither repeats
//     the pure client gate);
//   * the enroll gate's digit-only code input and its wrong-code
//     error → clear → re-arm cycle;
//   * BOTH 2FA gates' cancel affordance logging the half-authenticated
//     session back out to the chooser instead of leaving it parked mid-2FA.
// SetupPage (dev-only /setup) stays jsdom-only by design: the production
// bundle this stack serves never mounts the route.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, logout, signup, approveUser, loginPasswordOnly, completeTwoFactor, openAdminTab,
} from '../helpers/ui';
import { computeTotp, recoverSecretFromEnrollModal } from '../helpers/totp';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('§A onboarding elements — invite client gate + 2FA gate affordances', () => {
  test('invite confirm-mismatch refused client-side; enroll strips junk and re-arms after a wrong code; both gate cancels log out', async ({ page }) => {
    await test.step('accept-invite: submit stays disabled while empty, then a mismatched confirmation is refused before the token posts', async () => {
      await page.goto('/invite/not-a-real-token-eso');
      await expect(page.getByTestId('accept-invite-page')).toBeVisible();
      // Empty-password arm: the submit control itself is unarmed.
      await expect(page.getByTestId('accept-invite-page__submit-button')).toBeDisabled();
      await page.getByTestId('accept-invite-page__password-input').fill('Invited!2026xYz');
      await page.getByTestId('accept-invite-page__confirm-input').fill('Different!2026');
      await page.getByTestId('accept-invite-page__submit-button').click();
      await expect(page.getByTestId('accept-invite-page__error')).toContainText('Passwords do not match.');
      // No redeem POST left the page: the form persists and no 2FA gate opened.
      await expect(page.getByTestId('accept-invite-page')).toBeVisible();
      await expect(page.getByTestId('two-factor-enroll__qr-image')).toHaveCount(0);
    });

    const runId = `${Date.now()}`;
    const actor = {
      fullName: `ESO Onboard ${runId}`,
      email: `eso-onboard-${runId}@test.local`,
      password: `OnboardPass!2026${runId}`,
    };

    await test.step('provision a fresh approved actor (signup → superadmin approve)', async () => {
      await signup(page, actor);
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'users', 'admin-users__view-pending-tab');
      await approveUser(page, actor.email, 'vendor');
      await logout(page);
    });

    await test.step('enroll gate: QR + manual secret render, junk is stripped from the code, a wrong code errors, clears, and re-arms', async () => {
      await loginPasswordOnly(page, actor.email, actor.password);
      await expect(page.getByTestId('two-factor-enroll')).toBeVisible();
      await expect(page.getByTestId('two-factor-enroll__qr-image')).toBeVisible();
      await expect(page.getByTestId('two-factor-enroll__secret')).not.toBeEmpty();
      const codeInput = page.getByTestId('two-factor-enroll__code-input');
      // Non-digits are stripped as you type — junk can never arm Verify.
      await codeInput.fill('a1b2c3');
      await expect(codeInput).toHaveValue('123');
      // A deterministically-WRONG six-digit code auto-submits on the 6th
      // digit, shows the server message, CLEARS the field, and re-arms.
      const secret = await recoverSecretFromEnrollModal(page);
      const wrong = computeTotp(secret) === '000000' ? '000001' : '000000';
      await codeInput.fill(wrong);
      await expect(page.getByTestId('two-factor-enroll__error')).toBeVisible({ timeout: 15000 });
      await expect(codeInput).toHaveValue('');
      // The failed arm never leaked the dashboard.
      await expect(page.getByTestId('dashboard__sign-out-button')).toHaveCount(0);
    });

    await test.step('enroll cancel logs the half-authenticated session back out to the chooser', async () => {
      await page.getByTestId('two-factor-enroll__cancel-button').click();
      await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('dashboard__sign-out-button')).toHaveCount(0);
    });

    await test.step('complete enrollment once so the verify gate exists for later logins', async () => {
      await loginPasswordOnly(page, actor.email, actor.password);
      await expect(page.getByTestId('two-factor-enroll')).toBeVisible();
      // Decodes THIS user's rendered QR, remembers the secret, submits the code.
      await completeTwoFactor(page, actor.email);
      await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
      await logout(page);
    });

    await test.step('verify gate: junk is stripped; cancel logs out instead of bypassing the gate', async () => {
      await loginPasswordOnly(page, actor.email, actor.password);
      await expect(page.getByTestId('two-factor-verify')).toBeVisible();
      const codeInput = page.getByTestId('two-factor-verify__code-input');
      await codeInput.fill('x9y8z7');
      await expect(codeInput).toHaveValue('987');
      await page.getByTestId('two-factor-verify__cancel-button').click();
      await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible({ timeout: 15000 });
      await expect(page.getByTestId('dashboard__sign-out-button')).toHaveCount(0);
    });
  });
});
