// S1 — Amanda the org-scoped config admin. This runs against the real
// BREAKGLASS_DEV=DEMO startup seed and exercises current role/tab navigation.
import { test, expect } from '../helpers/harness';
import { login, openAdminTab } from '../helpers/ui';

test.describe.configure({ mode: 'serial' });

test('S1 — org-scoped admin showcase (Amanda): org scoping + provenance, live in demo mode', async ({ page }) => {
  await test.step('Amanda logs in and completes real first-login 2FA enrollment', async () => {
    await login(page, 'amanda.scoped@aurora.demo', 'Amanda.Demo.2026');
    // Amanda has one applicable dashboard hat (Administrator), so the role
    // selector is intentionally absent and AdminPanel is her default view.
    await expect(page.getByTestId('admin-panel__tab-organizations')).toBeVisible();
  });

  await test.step('registry shows ONLY Org Aurora to Amanda (server-side scoped list)', async () => {
    await openAdminTab(page, 'organizations', 'admin-orgs__table');
    const rows = page.locator('[data-testid="admin-orgs__table"] tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('Org Aurora');
    await expect(rows.first()).not.toContainText('Org Cobalt');
  });

  await test.step('Settings modal shows both inherited and organization override provenance', async () => {
    const row = page.locator('[data-testid="admin-orgs__table"] tbody tr', { hasText: 'Org Aurora' });
    await row.getByTestId('admin-orgs__settings-button').click();
    const modal = page.getByTestId('org-settings-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByTestId('org-settings-modal__row-slack_client_id').getByTestId('provenance-chip'))
      .toContainText('Org override');
    await expect(modal.getByTestId('org-settings-modal__row-slack_bot_token').getByTestId('provenance-chip'))
      .toContainText('Inherited — global default');
    await page.getByTestId('org-settings-modal__close-button').click();
    await expect(modal).toBeHidden();
  });

  await test.step('Amanda edits an organization template and sees provenance update in-session', async () => {
    const row = page.locator('[data-testid="admin-orgs__table"] tbody tr', { hasText: 'Org Aurora' });
    await row.getByTestId('admin-orgs__templates-button').click();
    const modal = page.getByTestId('org-templates-modal');
    await expect(modal).toBeVisible();
    await page.getByTestId('org-templates-modal__edit-user.approved').click();
    await page.getByTestId('org-templates-modal__subject-input').fill('Aurora welcomes you, {{full_name}}!');
    await page.getByTestId('org-templates-modal__body-html-input').fill('<p>Aurora: welcome aboard, {{full_name}}.</p>');
    await page.getByTestId('org-templates-modal__save-button').click();
    await expect(modal.getByTestId('org-templates-modal__row-user.approved').getByTestId('provenance-chip'))
      .toContainText('Org override');
    await page.getByTestId('org-templates-modal__close-button').click();
    await expect(modal).toBeHidden();
  });

  await test.step('Amanda never receives global parameter surfaces', async () => {
    await expect(page.getByTestId('admin-panel__tab-app-settings')).toHaveCount(0);
    await expect(page.getByTestId('admin-panel__tab-email-config')).toHaveCount(0);
  });

  await test.step('Amanda’s audit view contains her Aurora write and excludes Cobalt', async () => {
    await openAdminTab(page, 'audit-log', 'admin-audit-log__container');
    const container = page.getByTestId('admin-audit-log__container');
    await expect(container).toContainText('organization_template.updated');
    await expect(container).not.toContainText('Org Cobalt');
  });
});
