// Companion, at the UI/browser level, to server/tests/auth.test.tsx's
// backend coverage of tombstone invalidating an existing session (401 on
// next request) — see CLAUDE.md's backend test discipline section and
// addendum-005. Two things this spec proves that a backend-only test
// cannot: (1) the actual admin-facing Deactivate flow in AdminUsers.tsx
// works end-to-end against a real browser + real backend, and (2) a session
// token a tombstoned user's browser already held BEFORE the tombstone is
// rejected on its very next use — not just that a *fresh* login attempt is
// blocked (routes-auth.tsx has two distinct checks: a login-time block and a
// separate per-request active-status check in getCurrentUserInfo at
// /auth/me — this spec exercises the second one specifically).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, signup, approveUser, rowButton, modalByTestId, directFetchStatus, getSessionCookie } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('tombstone (deactivate) action', () => {
  test('deactivating a user invalidates their existing session and blocks future login', async ({ page }) => {
    const target = {
      fullName: 'Tombstone Target',
      email: 'tombstone-target@test.local',
      password: 'TombstonePass!2026',
    };

    await test.step('signup and approve the target user', async () => {
      await signup(page, target);
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await approveUser(page, target.email, 'agency');
    });

    let targetSessionToken: string | null = null;
    await test.step('log in as the target and capture their live session token', async () => {
      await login(page, target.email, target.password);
      // Session is an HttpOnly cookie now (addendum-080) — read it from the
      // browser context; the value doubles as an X-Session-Token (dual-path).
      targetSessionToken = await getSessionCookie(page);
      expect(targetSessionToken).toBeTruthy();

      // Sanity check: the token is live right now, before any tombstone.
      const statusBefore = await directFetchStatus(page, '/auth/me', targetSessionToken);
      expect(statusBefore).toBe(200);
    });

    await test.step('superadmin deactivates the target via AdminUsers', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await page.getByTestId('admin-panel__tab-users').click();
      await page.getByTestId('admin-users__view-all-tab').click();

      // Row actions are behind the ⋮ hamburger (addendum-077) — open it first.
      await rowButton(page, target.email, 'admin-users__row-menu-button').click();
      await rowButton(page, target.email, 'admin-users__deactivate-button').click();
      const modal = modalByTestId(page, 'admin-users__action-modal');
      await expect(modal).toContainText('will deactivate the user account');
      await modal.getByTestId('admin-users__confirm-button').click();
      await expect(modal).not.toBeVisible();

      // Tombstoned rows have no actions at all — no hamburger, no items.
      await expect(rowButton(page, target.email, 'admin-users__row-menu-button')).toHaveCount(0);
    });

    await test.step('the target\'s pre-existing session token is rejected on its next use', async () => {
      const statusAfter = await directFetchStatus(page, '/auth/me', targetSessionToken);
      expect(statusAfter).toBe(401);
    });

    await test.step('the target can no longer log in at all', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password); // ensure a clean logged-in state to sign out from
      await page.getByTestId('dashboard__sign-out-button').click();
      // Sign-out returns to LoginChooserPage — navigate through the email-login
      // link to reach LoginPage where login__email-input lives.
      await page.getByTestId('login-chooser__email-login-link').click();
      await expect(page.getByTestId('login__email-input')).toBeVisible();

      await page.getByTestId('login__email-input').fill(target.email);
      await page.getByTestId('login__password-input').fill(target.password);
      await page.getByTestId('login__sign-in-button').click();

      await expect(page.getByText('Account not found.')).toBeVisible();
      await expect(page.getByTestId('dashboard__sign-out-button')).not.toBeVisible();
    });
  });
});
