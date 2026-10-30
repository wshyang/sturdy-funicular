// E2E coverage for the admin Data tab (AdminData.tsx — export/import/reset,
// POST/GET .../admin/data/* — server/routes-admin-data.tsx). Previously
// untested at the UI level entirely (only reachable via API in existing
// helpers). Exercises: reset-and-seed (native confirm() dialog), export
// (browser download event), and import (file upload via setInputFiles on
// the hidden input, bypassing the "Choose Bundle File…" button's native OS
// file picker, which Playwright cannot drive directly).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('admin data tab', () => {
  test('export downloads a JSON bundle, import restores it, reset reseeds demo data', async ({ page }) => {
    let exportedPath: string;

    await test.step('log in as superadmin and open the Data tab', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      // Click-through, not a URL deep link (addendum-099).
      await openAdminTab(page, 'data', 'admin-data__export-button');
    });

    await test.step('export downloads a JSON bundle', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('admin-data__export-button').click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^breakglass-export-\d{4}-\d{2}-\d{2}\.json$/);
      exportedPath = (await download.path())!;
      expect(exportedPath).toBeTruthy();
      await expect(page.getByText(/Exported \d+ records\./)).toBeVisible();
    });

    await test.step('import re-uploads the exported bundle without wiping first', async () => {
      await page.getByTestId('admin-data__wipe-first-checkbox').uncheck();
      await page.getByTestId('admin-data__import-file-input').setInputFiles(exportedPath);
      // Response-gated: the success message only renders after the import
      // POST resolves — wait for the response so the assertion can never
      // read a pre-flight (or never-dispatched) state.
      //
      // The wait is explicitly bounded well above the 15s `actionTimeout`
      // because this POST's duration scales with how much data the bundle
      // holds, and the bundle is a snapshot of the SHARED breakglass_test
      // database: run this spec alone and the import returns in ~0.8s, but
      // after the specs that precede it in a full regression run it has been
      // measured at 21.3s server-side. Inheriting actionTimeout made the spec
      // pass in isolation and fail in-suite purely on accumulated row count.
      // The per-test budget (180s cold) still bounds this.
      await Promise.all([
        page.waitForResponse(
          (res) =>
            /\/admin\/data\/import$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
          { timeout: 90_000 },
        ),
        page.getByTestId('admin-data__import-button').click(),
      ]);
      await expect(page.getByText(/Import complete — \d+ records written\./)).toBeVisible();
    });

    await test.step('an invalid (non-JSON) file surfaces a client-side error', async () => {
      await page.getByTestId('admin-data__import-file-input').setInputFiles({
        name: 'bad-bundle.json',
        mimeType: 'application/json',
        buffer: Buffer.from('not valid json'),
      });
      await page.getByTestId('admin-data__import-button').click();
      await expect(page.getByText('Invalid JSON bundle. Select a valid export file.')).toBeVisible();
    });

    await test.step('reset and seed wipes and repopulates demo data, preserving the admin session', async () => {
      page.once('dialog', (dialog) => dialog.accept());
      // Same rationale as the import wait above: reset-and-seed is a bulk
      // server operation, not a UI interaction, so it must not inherit the
      // 15s actionTimeout.
      await Promise.all([
        page.waitForResponse(
          (res) =>
            /\/admin\/data\/reset-seed$/.test(new URL(res.url()).pathname) && res.request().method() === 'POST',
          { timeout: 90_000 },
        ),
        page.getByTestId('admin-data__reset-button').click(),
      ]);
      await expect(page.getByText(/Demo data reset\. Seeded \d+ users/)).toBeVisible();
      await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
    });

    // addendum-032-entra-id-sso-login.md's Access Log tab — the login that
    // opened this test itself should already appear as a captured row.
    await test.step('Access Log tab renders Method/URI/Status rows', async () => {
      // Click-through (addendum-099) — tab-to-tab navigation is the real user path.
      await openAdminTab(page, 'access-log', 'admin-access-log__table');
      const rows = page.getByTestId('admin-access-log__row');
      await expect(rows.first()).toBeVisible();
      await expect(rows.first().getByTestId('admin-access-log__method-cell')).toBeVisible();
      await expect(rows.first().getByTestId('admin-access-log__uri-cell')).toBeVisible();
      await expect(rows.first().getByTestId('admin-access-log__status-cell')).toBeVisible();
    });
  });
});
