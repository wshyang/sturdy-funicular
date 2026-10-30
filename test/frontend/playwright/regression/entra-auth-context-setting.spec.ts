// Regression coverage for the Entra SSO acrs auth-context setting
// (entra_sso_auth_context_id) — the configurable MFA step-up lever added so
// SSO can force the Authenticator number-match prompt, while staying fully
// optional (empty = plain SSO). See the addendum on Entra acrs step-up and
// CLAUDE-test-discipline.md → "a Playwright regression test for every reported
// frontend bug".
//
// Asserts the new setting:
//   * renders under the Entra ID SSO category with its greyed example-value
//     placeholder (the "show possible values in greyed text" requirement),
//   * accepts a value and persists it (Save → ✓ Saved),
//   * can be cleared back to empty (plain SSO), which the generic non-empty
//     validator would otherwise reject.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const KEY = 'entra_sso_auth_context_id';

test.describe('entra sso auth-context setting — regression', () => {
  test('renders under Entra with a greyed example placeholder, saves and clears', async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    // Click-through, not a URL deep link (addendum-099).
    await openAdminTab(page, 'app-settings', 'admin-app-settings');

    // The row lives under the Entra ID SSO category and shows a greyed
    // placeholder advertising an example value while empty.
    const entra = page.getByTestId('admin-app-settings__category-entra');
    await expect(entra).toBeVisible();
    const row = entra.locator('[data-testid="admin-app-settings__row"]', { hasText: KEY });
    await expect(row).toBeVisible();
    const input = row.getByTestId('admin-app-settings__input');
    await expect(input).toHaveAttribute('placeholder', /e\.g\. c1/);

    // Idempotency: a prior incomplete run may have left 'c1' in the DB.
    // If the input already holds a value, clear it first — the save button
    // stays disabled when the draft equals the stored value (dirty check),
    // so filling 'c1' into a DB that already has 'c1' would leave save locked.
    const initialValue = await input.inputValue();
    if (initialValue !== '') {
      await input.fill('');
      await row.getByTestId('admin-app-settings__save-button').click();
      await expect(row.getByTestId('admin-app-settings__row-saved')).toBeVisible();
    }

    await test.step('save a value', async () => {
      await input.fill('c1');
      await row.getByTestId('admin-app-settings__save-button').click();
      await expect(row.getByTestId('admin-app-settings__row-saved')).toBeVisible();
    });

    await test.step('clear back to empty (plain SSO) — allowed for this key', async () => {
      await input.fill('');
      await row.getByTestId('admin-app-settings__save-button').click();
      await expect(row.getByTestId('admin-app-settings__row-saved')).toBeVisible();
      await expect(row.getByTestId('admin-app-settings__row-error')).toHaveCount(0);
      await expect(input).toHaveValue('');
    });
  });
});
