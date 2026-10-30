// E2E coverage for the admin Roles tab (AdminRoles.tsx —
// GET/POST/PUT/DELETE /admin/roles, server/routes-admin-capabilities.tsx).
// Exercises the roles table (system roles present + immutable), creating a
// custom role with capabilities, and deleting it.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const ROLE_KEY = 'e2e_roles_test';

test.describe('admin roles tab', () => {
  test('lists system roles immutably and creates + deletes a custom role', async ({ page }) => {
    await test.step('log in as superadmin and open the Roles tab by clicking it', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      // Click-through, not a URL deep link (addendum-099).
      await openAdminTab(page, 'roles', 'admin-roles__table');
    });

    await test.step('system roles are listed and are NOT deletable', async () => {
      // full_admin is a seeded system role.
      const systemRow = page.locator('[data-testid="admin-roles__row"]', { hasText: 'full_admin' });
      await expect(systemRow).toBeVisible();
      await expect(systemRow.getByText('System')).toBeVisible();
      // Immutable: system roles have no delete button.
      await expect(systemRow.getByTestId('admin-roles__delete-button')).toHaveCount(0);
    });

    await test.step('create a custom role with a capability', async () => {
      await page.getByTestId('admin-roles__create-button').click();
      const modal = page.getByTestId('admin-roles__modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('admin-roles__key-input').fill(ROLE_KEY);
      await modal.getByTestId('admin-roles__name-input').fill('E2E Roles Test Role');
      await modal.getByTestId('admin-roles__description-input').fill('Created by the admin-roles e2e.');
      await modal.getByTestId('admin-roles__cap-UserRead').check();
      await modal.getByTestId('admin-roles__save-button').click();

      // The notice + the new row appear.
      await expect(page.getByText(`Role ${ROLE_KEY} created.`)).toBeVisible();
      const newRow = page.locator('[data-testid="admin-roles__row"]', { hasText: ROLE_KEY });
      await expect(newRow).toBeVisible();
      await expect(newRow.getByText('UserRead')).toBeVisible();
    });

    await test.step('the custom role can be deleted', async () => {
      const newRow = page.locator('[data-testid="admin-roles__row"]', { hasText: ROLE_KEY });
      page.once('dialog', (dialog) => dialog.accept());
      await newRow.getByTestId('admin-roles__delete-button').click();
      await expect(page.getByText(`Role ${ROLE_KEY} deleted.`)).toBeVisible();
      await expect(page.locator('[data-testid="admin-roles__row"]', { hasText: ROLE_KEY })).toHaveCount(0);
    });
  });
});
