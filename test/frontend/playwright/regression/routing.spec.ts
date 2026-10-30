// Browser coverage for URL-driven navigation (addendum: URL routing).
//
// Every screen is now reachable via a stable, refresh-restorable URL so a
// reload (or share/bookmark) returns the user to the same page instead of
// dumping them on the default dashboard. These tests drive the real browser
// through the deep links and assert the page + URL persist across a reload,
// using the E2E superadmin (whose only role is `admin`).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, fillCredentialItemCombobox, createAssetViaAdminUI } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('URL routing: deep links, refresh persistence, role slugs', () => {
  test('role deep link /dashboard/admin renders the Admin Panel, and a reload stays on the same role screen', async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    // Navigate to the admin dashboard via its clean deep link.
    await page.goto('/dashboard/admin');
    await expect(page.getByTestId('dashboard__sign-out-button')).toBeVisible();
    // Admin Panel tab bar (Users tab is the default admin tab) is present.
    await expect(page.getByTestId('admin-panel__tab-users')).toBeVisible();

    // Reload — the page must come back to the same deep link, not the default.
    await page.reload();
    await expect(page).toHaveURL(/\/dashboard\/admin$/);
    await expect(page.getByTestId('admin-panel__tab-users')).toBeVisible();
  });

  test('admin tab deep link /dashboard/admin/assets renders the Assets tab and survives refresh', async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await page.goto('/dashboard/admin/assets');
    await expect(page.getByTestId('admin-panel__tab-assets')).toBeVisible();
    // The Assets tab content (system select) is mounted — i.e. the 'assets'
    // tab, not the default 'users' tab.
    await expect(page.getByTestId('admin-assets__system-select')).toBeVisible();

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard\/admin\/assets$/);
    await expect(page.getByTestId('admin-assets__system-select')).toBeVisible();
  });

  test('2nd-order deep link: selected admin-assets system persists in the URL and across refresh', async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await page.goto('/dashboard/admin/assets');
    await expect(page.getByTestId('admin-assets__system-select')).toBeVisible();

    // Pick whatever system the seeded DB exposes (any option). Assert the URL
    // gains ?system=<id> and the selection survives a reload.
    const select = page.getByTestId('admin-assets__system-select');
    const options = await select.locator('option').allTextContents();
    const nonEmpty = options.find((o) => o !== '-- Select a system --');
    if (!nonEmpty) {
      // No systems seeded — nothing to deep-link; skip the selection assertion.
      test.skip();
      return;
    }
    await select.selectOption({ label: nonEmpty });
    await expect(page).toHaveURL(/\?system=/);

    const systemId = new URL(page.url()).searchParams.get('system');
    expect(systemId).toBeTruthy();

    await page.reload();
    await expect(page).toHaveURL(/\/dashboard\/admin\/assets\?system=/);
    await expect(page.getByTestId('admin-assets__system-select')).toHaveValue(systemId!);
  });

  test('milestone 3: a partially-filled submit form is restored across refresh (draft persistence)', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    await test.step('provision a vendor roster and a system with one asset', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'routing');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'RT1', name: 'Routing Draft System' });
      await createAssetViaAdminUI(page, {
        systemLabel: 'RT1 — Routing Draft System', hostname: 'routing-host', credentialName: 'svc_routing', credentialType: 'password', navigateFirst: true,
      });
    });

    await test.step('vendor opens the submit form via its deep link and fills part of it', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      // Deep link directly to the new-request form.
      await page.goto('/dashboard/engineer/new');
      await expect(page.getByTestId('vendor-dashboard__system-select')).toBeVisible();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: 'Routing Draft System (RT1)' });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-DRAFT001');
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('In-progress draft justification.');
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'routing-host', 'svc_routing');
    });

    await test.step('refresh — the same form and its typed values are restored', async () => {
      await page.reload();
      await expect(page).toHaveURL(/\/dashboard\/engineer\/new/);
      await expect(page.getByTestId('vendor-dashboard__sr-number-input')).toHaveValue('SR-DRAFT001');
      await expect(page.getByTestId('vendor-dashboard__justification-textarea')).toHaveValue('In-progress draft justification.');
      // The system was persisted to the URL (?system=...) as the draft's seed —
      // assert the select is non-empty and the URL carries a system id.
      await expect(page.getByTestId('vendor-dashboard__system-select')).not.toHaveValue('');
      expect(new URL(page.url()).searchParams.get('system')).toBeTruthy();
      // The asset-gated credential item hostname/credential name were drafted too.
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await expect(itemRow.getByTestId('vendor-dashboard__credential-hostname-combobox')).toContainText('routing-host');
    });
  });
});
