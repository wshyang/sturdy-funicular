import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login } from '../helpers/ui';

// E-41: the User Profile dropdown + modal + Slack integration row, reachable
// from the dashboard after a real 2FA login (global-setup.ts seeds the fixture
// user). Slack is NOT configured in this suite (no client id/secret, exactly
// like entra-sso.spec.ts), so every assertion exercises the "not linked" path;
// a live Slack OAuth round-trip is untestable here — see slack_plan.md §13.

test.describe('user profile — slack integration', () => {
  test('avatar dropdown opens the User Profile modal with a Slack row', async ({ page }) => {
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);

    // Open the avatar menu and pick User Profile.
    await page.getByTestId('dashboard__user-avatar').click();
    await page.getByTestId('dashboard__user-profile-menu-item').click();

    // Modal + Integrations section render.
    await expect(page.getByTestId('user-profile-modal')).toBeVisible();
    await expect(page.getByTestId('user-profile__integrations-section')).toBeVisible();
    await expect(page.getByTestId('user-profile__slack-icon')).toBeVisible();

    // Not-linked state: Connect button + "Not linked" status, no connected badge.
    await expect(page.getByTestId('user-profile__slack-connect-button')).toContainText(/Connect Slack/i);
    await expect(page.getByTestId('user-profile__slack-status')).toContainText(/Not linked/i);
    await expect(page.getByTestId('user-profile__slack-connected-badge')).toHaveCount(0);
  });

  test('the close button dismisses the modal', async ({ page }) => {
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);

    await page.getByTestId('dashboard__user-avatar').click();
    await page.getByTestId('dashboard__user-profile-menu-item').click();
    await expect(page.getByTestId('user-profile-modal')).toBeVisible();

    await page.getByTestId('user-profile__close-button').click();
    await expect(page.getByTestId('user-profile-modal')).toHaveCount(0);
  });

  test('clicking Connect Slack surfaces the not-configured error inline', async ({ page }) => {
    await login(page, E2E_USER_EMAIL, E2E_USER_PASSWORD);

    await page.getByTestId('dashboard__user-avatar').click();
    await page.getByTestId('dashboard__user-profile-menu-item').click();
    await expect(page.getByTestId('user-profile-modal')).toBeVisible();

    // GET /auth/slack/login returns 503 (Slack unconfigured); initiateSlackLink
    // throws, the modal shows its error banner rather than navigating away.
    await page.getByTestId('user-profile__slack-connect-button').click();
    await expect(page.getByTestId('user-profile__error')).toBeVisible();
  });
});
