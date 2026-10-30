// S2 — Greg the global full_admin. The explicit role switch is load-bearing:
// his Agency L1 queue has pending work, so current role-summary logic defaults
// him to Engineer rather than Administrator after login.
import { test, expect } from '../helpers/harness';
import { login, openAdminTab } from '../helpers/ui';

test.describe.configure({ mode: 'serial' });

test('S2 — global admin showcase (Greg): global registry, global settings, cross-org runtime', async ({ page }) => {
  await test.step('Greg logs in, completes real 2FA enrollment, and switches to Administrator', async () => {
    await login(page, 'greg.global@demo.local', 'Greg.Demo.2026');
    await page.getByTestId('dashboard__role-select').selectOption('admin');
    await expect(page.getByTestId('admin-panel__tab-organizations')).toBeVisible();
  });

  await test.step('registry shows every seeded organization to Greg', async () => {
    await openAdminTab(page, 'organizations', 'admin-orgs__table');
    const rows = page.locator('[data-testid="admin-orgs__table"] tbody tr');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Org Aurora' })).toHaveCount(1);
    await expect(rows.filter({ hasText: 'Org Cobalt' })).toHaveCount(1);
  });

  await test.step('global settings have no organization-provenance chips', async () => {
    await openAdminTab(page, 'app-settings', 'admin-app-settings');
    await expect(page.getByTestId('admin-app-settings').getByTestId('provenance-chip')).toHaveCount(0);
  });

  await test.step('an organization-scoped settings view does show provenance chips', async () => {
    await openAdminTab(page, 'organizations', 'admin-orgs__table');
    const auroraRow = page.locator('[data-testid="admin-orgs__table"] tbody tr', { hasText: 'Org Aurora' });
    await auroraRow.getByTestId('admin-orgs__settings-button').click();
    const modal = page.getByTestId('org-settings-modal');
    await expect(modal).toBeVisible();
    // Wait for async settings load before counting — modal container becomes
    // visible before the API call for org settings completes.
    await expect(modal.getByTestId('provenance-chip').first()).toBeVisible();
    expect(await modal.getByTestId('provenance-chip').count()).toBeGreaterThan(0);
    await page.getByTestId('org-settings-modal__close-button').click();
    await expect(modal).toBeHidden();
  });

  await test.step('cross-org request is already actionable in Greg’s Agency Engineer pending dashboard', async () => {
    await page.getByTestId('dashboard__role-select').selectOption('engineer');
    await expect(page.getByText('Agency Engineer Dashboard')).toBeVisible();
    const requestRow = page.locator('tr', { hasText: 'BG-HRIS-20260801-002' });
    await expect(requestRow).toHaveCount(1);
    await expect(requestRow).toBeVisible();
    // Addendum-192/-196: Approve lives behind the row kebab (Radix dropdown,
    // portaled); open this row's menu, assert the menu item, then close it.
    await requestRow.getByTestId('agency-dashboard__actions-menu-button').click();
    const menu = page.getByTestId('agency-dashboard__actions-menu');
    await expect(menu.getByTestId('agency-dashboard__approve-button')).toBeEnabled();
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  });
});
