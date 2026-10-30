// E2E coverage for the admin App Settings tab (AdminAppSettings.tsx —
// GET/PUT /admin/app-settings, server/routes-admin-app-settings.tsx). Exercises
// the per-row in-place edit+save path for a non-secret setting (scoped to the
// row by the setting key) and the secret-masking + clear path for a secret row.
// Mutations are restored so the shared e2e DB's setting defaults are unchanged
// for any later spec.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, completeTwoFactor, openAdminTab } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('admin app-settings tab', () => {
  test('edits a non-secret setting in place, and masks/clears a secret setting', async ({ page }) => {
    await test.step('log in as superadmin and open the App Settings tab by clicking it', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      // Click-through, not a URL deep link (addendum-099).
      await openAdminTab(page, 'app-settings', 'admin-app-settings');
      await expect(page.getByTestId('admin-app-settings__row').first()).toBeVisible();
    });

    await test.step('edit a non-secret setting in place and see the saved indicator', async () => {
      // Scope to the row for postman_default_classification (a non-secret
      // string setting) by its key label, then read the current value so we can
      // restore it afterwards.
      const row = page.locator('[data-testid="admin-app-settings__row"]', { hasText: 'postman_default_classification' });
      const input = row.getByTestId('admin-app-settings__input');
      const save = row.getByTestId('admin-app-settings__save-button');
      const original = await input.inputValue();

      await input.fill(original === 'URGENT' ? 'FOR_INFO' : 'URGENT');
      await save.click();
      await expect(row.getByTestId('admin-app-settings__row-saved')).toBeVisible();

      // Restore the original value so the shared DB keeps its default.
      await input.fill(original);
      await save.click();
      await expect(row.getByTestId('admin-app-settings__row-saved')).toBeVisible();
    });

    await test.step('a secret setting is masked — its stored value is never revealed', async () => {
      // postman_api_key is an is_secret row. Its display shows a placeholder
      // ('(not set)' when empty / a mask once set) — never the real value.
      const secretRow = page.locator('[data-testid="admin-app-settings__row"]', { hasText: 'postman_api_key' });
      const display = secretRow.getByTestId('admin-app-settings__secret-display');
      await expect(display).toBeVisible();
      await expect(display).not.toHaveValue(''); // not an editable, empty real-value field
      // The secret input + clear checkbox are present.
      await expect(secretRow.getByTestId('admin-app-settings__secret-input')).toBeVisible();
      await expect(secretRow.getByTestId('admin-app-settings__secret-clear-checkbox')).toBeVisible();
    });
  });
});

test.describe('admin app-settings bulk transfer (addendum-097)', () => {
  test('export downloads the registry; editing then importing the export restores the original value', async ({ page }) => {
    await test.step('log in and open the App Settings tab', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await completeTwoFactor(page, SUPERADMIN.email);
      // Click-through, not a URL deep link (addendum-099).
      await openAdminTab(page, 'app-settings', 'admin-app-settings');
      // full_admin holds ConfigAppSettingsBulkTransfer (migration 056), so the
      // bulk-transfer section renders.
      await expect(page.getByTestId('admin-app-settings__bulk-transfer')).toBeVisible();
    });

    let downloadedPath: string;
    await test.step('export downloads the whole registry as JSON', async () => {
      const downloadPromise = page.waitForEvent('download');
      await page.getByTestId('admin-app-settings__export-button').click();
      const download = await downloadPromise;
      downloadedPath = await download.path();
      await expect(page.getByTestId('admin-app-settings__transfer-message')).toBeVisible();
    });

    await test.step('edit a setting in place, then importing the export restores it', async () => {
      const row = page.locator('[data-testid="admin-app-settings__row"]', { hasText: 'postman_default_classification' });
      const input = row.getByTestId('admin-app-settings__input');
      const save = row.getByTestId('admin-app-settings__save-button');
      const original = await input.inputValue();

      // Change the value in place and persist it.
      const flipped = original === 'URGENT' ? 'FOR_INFO' : 'URGENT';
      await input.fill(flipped);
      await save.click();
      await expect(row.getByTestId('admin-app-settings__row-saved')).toBeVisible();
      await expect(input).toHaveValue(flipped);

      // Import the (pre-edit) export — the original value comes back, and the
      // visible settings are reloaded to reflect it.
      await page.getByTestId('admin-app-settings__import-file-input').setInputFiles(downloadedPath);
      await page.getByTestId('admin-app-settings__import-button').click();
      await expect(page.getByTestId('admin-app-settings__transfer-message')).toBeVisible();
      await expect(input).toHaveValue(original);
    });
  });

  test('an import containing an unknown key is rejected wholesale — nothing is applied, every failure is listed', async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await completeTwoFactor(page, SUPERADMIN.email);
    // Click-through, not a URL deep link (addendum-099).
    await openAdminTab(page, 'app-settings', 'admin-app-settings');
    await expect(page.getByTestId('admin-app-settings__bulk-transfer')).toBeVisible();

    const row = page.locator('[data-testid="admin-app-settings__row"]', { hasText: 'postman_default_classification' });
    const input = row.getByTestId('admin-app-settings__input');
    const original = await input.inputValue();

    // One VALID change plus one UNKNOWN key in the same batch: the whole
    // batch must be rejected and the valid change must NOT be applied.
    const bundle = {
      version: 1,
      settings: [
        { key: 'postman_default_classification', value: 'CHANGED_BY_IMPORT' },
        { key: 'nonsense_key_xyz', value: '1' },
      ],
    };
    await page.getByTestId('admin-app-settings__import-file-input').setInputFiles({
      name: 'settings.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(bundle)),
    });
    await page.getByTestId('admin-app-settings__import-button').click();

    await expect(page.getByTestId('admin-app-settings__transfer-error')).toBeVisible();
    await expect(page.getByTestId('admin-app-settings__import-failures')).toContainText('nonsense_key_xyz');
    // All-or-nothing: the row still shows the untouched original value.
    await expect(input).toHaveValue(original);
  });
});
