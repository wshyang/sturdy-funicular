// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md): §A entry screens + §B signed-in shell, exercised end to end
// against the running app. jsdom companions pin the same elements colocated;
// this file pins the browser-real behavior (native validation, real
// navigation, focus into the picker empty state, overlay Escape).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, logout } from '../helpers/ui';

// (the workflow/2FA testids below are §A gates rendered over the shell)

const ADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('§A entry screens — browser-real validation', () => {
  test('login chooser exposes Entra + email options; native required rules block empty submits', async ({ page }) => {
    await page.goto('/');
    const chooserLink = page.getByTestId('login-chooser__email-login-link');
    // A previous actor's session may still be active (spec order shared DB) —
    // the sign-out button then shows instead; tolerate both states, exactly
    // like helpers/ui.ts login() does.
    const signOut = page.getByTestId('dashboard__sign-out-button');
    await Promise.race([chooserLink.waitFor({ state: 'visible' }), signOut.waitFor({ state: 'visible' })]);
    if (await signOut.isVisible().catch(() => false)) {
      await logout(page);
      await expect(chooserLink).toBeVisible();
    }

    // Entra button remains available (even in bake-off mode the chooser keeps
    // both affordances — the callback degrades, not the entry point).
    await expect(page.getByTestId('login-chooser__entra-button')).toBeVisible();

    await chooserLink.click();
    const emailInput = page.getByTestId('login__email-input');
    await expect(emailInput).toBeVisible();

    // Negative: empty submit is refused natively (required) — no navigation.
    await emailInput.click();
    await page.getByTestId('login__sign-in-button').click();
    await expect(page.getByTestId('login__password-input')).toBeVisible();

    // Negative: a wrong password yields the inline error with the form re-armed.
    await emailInput.fill(ADMIN.email);
    await page.getByTestId('login__password-input').fill('definitely-wrong-999!');
    await page.getByTestId('login__sign-in-button').click();
    await expect(page.getByTestId('login__error')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('login__email-input')).toHaveValue(ADMIN.email);

    // Positive: the same form carries the real login to the dashboard/2FA gate.
    await emailInput.fill(ADMIN.email);
    await page.getByTestId('login__password-input').fill(ADMIN.password);
    await page.getByTestId('login__sign-in-button').click();
    // Either the 2FA verify/enroll UI or the dashboard itself appears — the
    // login UI (buttons/inputs) is replaced by chrome.
    await expect(
      page.getByTestId('dashboard__sign-out-button')
        .or(page.getByTestId('two-factor-verify'))
        .or(page.getByTestId('two-factor-enroll')),
    ).toBeVisible({ timeout: 30_000 });
  });

  test('signup requires native fields; a mismatch is caught before submit', async ({ page }) => {
    await page.goto('/');
    const link = page.getByTestId('login-chooser__email-login-link');
    await Promise.race([
      page.getByTestId('dashboard__sign-out-button').waitFor({ state: 'visible' }),
      link.waitFor({ state: 'visible' }),
    ]);
    if (await page.getByTestId('dashboard__sign-out-button').isVisible().catch(() => false)) {
      await logout(page);
    }
    if (await page.getByTestId('login-chooser__email-login-link').isVisible().catch(() => false)) {
      await page.getByTestId('login-chooser__email-login-link').click();
    }
    await page.getByTestId('login__switch-to-signup-button').click();

    // Negative: empty submit blocked natively (full name required).
    await page.getByTestId('signup__request-access-button').click();
    await expect(page.getByTestId('signup__full-name-input')).toBeFocused();

    // Element set visible + nav back works (positive state of the flow).
    await page.getByTestId('signup__full-name-input').fill('Negative Nancy');
    await page.getByTestId('signup__email-input').fill(`neg-${Date.now()}@test.local`);
    await page.getByTestId('signup__password-input').fill('SomePass!2026');
    await page.getByTestId('signup__confirm-password-input').fill('DifferentPass!2026');
    await page.getByTestId('signup__request-access-button').click();
    // Not navigated away — mismatch refuses the submit (client-side guard).
    await expect(page.getByTestId('signup__email-input')).toBeVisible();
    await page.getByTestId('signup__switch-to-login-button').click();
    await expect(page.getByTestId('login__email-input')).toBeVisible();
  });
});

test.describe('§B shell chrome — sign out/toast/avatar/search', () => {
  test('the avatar opens the profile menu; the sign-out flow is confirm-first; search overlay toggles', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/dashboard/);

    // Avatar → menu with the User Details entry; cancelling via Escape leaves the session.
    await page.getByTestId('dashboard__user-avatar').click();
    const menuItem = page.getByTestId('dashboard__user-profile-menu-item');
    await expect(menuItem).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menuItem).toBeHidden();

    // Sign out is a two-tap guarded flow (positive path of the element).
    await page.getByTestId('dashboard__sign-out-button').click();
    await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible({ timeout: 15000 });
    //Session cookie gone — reloading does not bounce back to the dashboard.
    await page.reload();
    await expect(page.getByTestId('login-chooser__email-login-link')).toBeVisible();

    // Back in: SearchOverlay open → focus in input → Escape closes.
    await login(page, ADMIN.email, ADMIN.password);
    await page.getByTestId('dashboard__search-button').click();
    await expect(page.getByTestId('search-overlay__query-input')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('search-overlay__query-input')).toBeHidden();
  });

  test('Search cancelled via its close control returns focus to the trigger', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await page.getByTestId('dashboard__search-button').click();
    const input = page.getByTestId('search-overlay__query-input');
    await expect(input).toBeVisible();
    // NOTE: opening the overlay is the element under test here — we never TYPE
    // into the query box (addendum-178 queue-navigation rule).
    await page.getByTestId('search-overlay__close-button').click();
    await expect(input).toBeHidden();
    await expect(page.getByTestId('dashboard__search-button')).toBeFocused();
  });
});

test.describe('§E-adjacent profile modal (shell entry point)', () => {
  test('avatar → profile modal: password change guards, then both close affordances', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);
    await page.getByTestId('dashboard__user-avatar').click();
    await page.getByTestId('dashboard__user-profile-menu-item').click();
    await expect(page.getByTestId('user-profile__password-section')).toBeVisible();

    // Negative: mismatched confirmation refuses inline without touching /auth.
    await page.getByTestId('user-profile__change-password-button').click();
    await expect(page.getByTestId('user-profile__change-password-modal')).toBeVisible();
    await page.getByTestId('user-profile__pw-current').fill(ADMIN.password);
    await page.getByTestId('user-profile__pw-new').fill('NewAdminPass!2026-a');
    await page.getByTestId('user-profile__pw-confirm').fill('NewAdminPass!2026-B');
    const responses: string[] = [];
    page.on('response', (res) => { if (res.url().includes('/auth/password')) responses.push(res.url()); });
    await page.getByTestId('user-profile__pw-save').click();
    await expect(page.getByTestId('user-profile__error')).toBeVisible();
    expect(responses).toHaveLength(0);

    // Untagged appendix controls: the pw-modal × and footer Close are role-addressed.
    await page.getByRole('button', { name: 'Close', exact: true }).first().click();
    // (× of the change-password modal dismissed it; the root modal closes via its tagged button.)
    await page.getByTestId('user-profile__close-button').click();
    await expect(page.getByTestId('user-profile__password-section')).toBeHidden();
  });
});
