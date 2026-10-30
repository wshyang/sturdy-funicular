// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md), §G–§K — the admin panel tabs and their control surfaces,
// exercised browser-real from the shared admin session: user roster modals,
// role registry validation, org membership backstop, cluster/team/system
// create-form guards, asset/mapping pair gates, app-settings bulk transfer,
// email configuration quick actions, notification-template editor, outbox
// disclosure, pending-actions expand, log filters, and the data export lane.
//
// The suite only mutates state it restores (delivery toggle flip-flops) or
// uniquely-namespaced rows it cleans up; everything else is read/negative.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';

const ADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('§G–§K admin panel element sweep', () => {
  test('every tab renders its surface; inline guards and disclosures behave', async ({ page }) => {
    await login(page, ADMIN.email, ADMIN.password);

    await test.step('§G users: tabs, row hamburger, invite error + cancel, CSV affordances', async () => {
      await openAdminTab(page, 'users', 'admin-users__view-pending-tab');
      await page.getByTestId('admin-users__view-all-tab').click();
      const rows = page.locator('tr', { has: page.getByTestId('admin-users__row-menu-button') });
      await expect(rows.first()).toBeVisible();
      await rows.first().getByTestId('admin-users__row-menu-button').click();
      // A healthy active row exposes the credential-rescue lane.
      await expect(page.getByTestId('admin-users__reset-password-button').first()).toBeVisible();
      await page.keyboard.press('Escape');

      await page.getByTestId('admin-users__invite-button').click();
      await page.getByTestId('admin-users__invite-name-input').fill('No Mail');
      await page.getByTestId('admin-users__invite-email-input').fill('not-an-email');
      await page.getByTestId('admin-users__invite-affiliation-select').selectOption('agency');
      await page.getByTestId('admin-users__invite-submit-button').click();
      await expect(page.getByTestId('admin-users__invite-error')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('admin-users__invite-cancel-button').click();
      await expect(page.getByTestId('admin-users__invite-error')).toBeHidden();
      await expect(page.getByTestId('admin-users__csv-template-download')).toBeVisible();
      await expect(page.getByTestId('admin-users__csv-upload-input')).toBeAttached();
    });

    await test.step('§K roles: invalid key refused inline; System rows have no delete', async () => {
      await openAdminTab(page, 'roles', 'admin-roles__table');
      await page.getByTestId('admin-roles__create-button').click();
      await page.getByTestId('admin-roles__key-input').fill('BAD KEY!');
      await page.getByTestId('admin-roles__name-input').fill('Nope');
      await page.getByTestId('admin-roles__save-button').click();
      await expect(page.getByText(/Role key must be/)).toBeVisible();
      await page.keyboard.press('Escape');
      const systemRow = page.locator('tr', { hasText: 'Full Administrator' }).first();
      await expect(systemRow).toBeVisible();
      await expect(systemRow.getByTestId('admin-roles__delete-button')).toHaveCount(0);
    });

    await test.step('§H organisations: register → members backstop rejects an unknown id → delete cleanup', async () => {
      await openAdminTab(page, 'organizations', 'admin-orgs__table');
      const ORG_NAME = `ES Admin Org ${Date.now() % 100000}`;
      await page.getByTestId('admin-orgs__toggle-create-form-button').click();
      await page.getByTestId('admin-orgs__name-input').fill(ORG_NAME);
      await page.getByTestId('admin-orgs__short-code-input').fill('esa1');
      await page.getByTestId('admin-orgs__submit-button').click();
      const row = page.locator('tr', { hasText: ORG_NAME });
      await expect(row).toBeVisible({ timeout: 15000 });
      await expect(row.getByTestId('admin-orgs__short-code-cell')).toHaveText('ESA1');
      await row.getByTestId('admin-orgs__members-button').click();
      await page.getByTestId('org-members-modal__add-user-input').fill('u-does-not-exist');
      await page.getByTestId('org-members-modal__add-button').click();
      await expect(page.getByTestId('org-members-modal__error')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('org-members-modal__close-button').click();
      page.once('dialog', (d) => void d.accept());
      await row.getByTestId('admin-orgs__delete-button').click();
      await expect(row).toHaveCount(0);
    });

    await test.step('§H clusters: short-create guard holds the form open on a native-required miss', async () => {
      await openAdminTab(page, 'clusters', 'admin-clusters__toggle-create-form-button');
      await page.getByTestId('admin-clusters__toggle-create-form-button').click();
      // Name is required — clicking submit with nothing typed must not create.
      await page.getByTestId('admin-clusters__submit-button').click();
      await expect(page.getByTestId('admin-clusters__name-input')).toBeFocused();

      // Addendum-206 D2: the organisation select is required too (the server
      // 400s unanchored clusters). A real browser's native validation blocks
      // the submit and focuses the select — no POST /admin/clusters fires and
      // no row appears.
      await page.getByTestId('admin-clusters__name-input').fill('Unanchored Probe');
      await page.getByTestId('admin-clusters__submit-button').click();
      await expect(page.getByTestId('admin-clusters__org-select')).toBeFocused();
      await expect(page.getByTestId('admin-clusters__submit-button')).toBeVisible();
      await expect(page.locator('tr', { hasText: 'Unanchored Probe' })).toHaveCount(0);
    });

    await test.step('§H/§I systems + custody editor + aws-info placeholder', async () => {
      await openAdminTab(page, 'systems', 'admin-systems__toggle-create-form-button');
      await page.getByTestId('admin-systems__toggle-create-form-button').click();
      await page.getByTestId('admin-systems__aws-info-link').click();
      await expect(page.getByTestId('admin-systems__aws-info-modal-close-button')).toBeVisible();
      await page.getByTestId('admin-systems__aws-info-modal-close-button').click();
      // Empty submit runs: no cluster selected → inline cluster error (no navigation).
      await page.getByTestId('admin-systems__name-input').fill('Sweep NoTopology');
      await page.getByTestId('admin-systems__short-code-input').fill('swn');
      await page.getByTestId('admin-systems__submit-create-button').click();
      await expect(page.getByText(/Select at least one vendor cluster/)).toBeVisible();
    });

    await test.step('§I assets + mappings: selectors mount; mutation affordances gate correctly', async () => {
      await openAdminTab(page, 'assets');
      await expect(page.getByTestId('admin-assets__system-select')).toBeVisible();
      await openAdminTab(page, 'mappings');
      await expect(page.getByTestId('admin-mappings__system-select')).toBeVisible();
      await expect(page.getByTestId('admin-mappings__submit-button')).toBeDisabled();
    });

    await test.step('§J app settings: registry + bulk-transfer lane; §J email: delivery toggle flip-flops', async () => {
      await openAdminTab(page, 'app-settings', 'admin-app-settings');
      await expect(page.getByTestId('admin-app-settings__bulk-transfer')).toBeVisible();
      // No file chosen → import is disabled (positive: choose-file control exists).
      await expect(page.getByTestId('admin-app-settings__import-button')).toBeDisabled();
      await expect(page.getByTestId('admin-app-settings__choose-file-button')).toBeVisible();

      await openAdminTab(page, 'email-config', 'email-config__delivery-enabled-toggle');
      const toggle = page.getByTestId('email-config__delivery-enabled-toggle');
      await toggle.click({ force: true });
      await expect(page.getByTestId('email-config__success')).toBeVisible({ timeout: 15000 });
      await toggle.click({ force: true });
      await expect(page.getByTestId('email-config__success')).toBeVisible({ timeout: 15000 });
    });

    await test.step('§J templates editor: variables legend + toolbar; §J data: export downloads', async () => {
      await openAdminTab(page, 'notification-templates', 'admin-notification-templates__table');
      const row = page.getByTestId('admin-notification-templates__row').first();
      await row.getByTestId('admin-notification-templates__edit-button').click();
      await expect(page.getByTestId('admin-notification-templates__edit-subject-input')).toBeVisible();
      // Untagged legend buttons (report appendix) are addressable by name.
      const legend = page.getByTestId('admin-notification-templates__variables-legend');
      await expect(legend.getByRole('button').first()).toBeVisible();
      await expect(page.getByTestId('admin-notification-templates__rich-toolbar')).toBeVisible();
      await page.getByTestId('admin-notification-templates__edit-modal-close-button').click();

      await openAdminTab(page, 'data');
      await expect(page.getByTestId('admin-data__import-button')).toBeDisabled();
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 30000 }),
        page.getByTestId('admin-data__export-button').click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/breakglass-export-.*\.json/);
    });

    await test.step('§K outbox + pending actions + log filters', async () => {
      await openAdminTab(page, 'sent-notifications', 'admin-sent-notifications__table');
      await expect(page.getByTestId('admin-sent-notifications__status-legend')).toBeVisible();
      if ((await page.getByTestId('admin-sent-notifications__row').count()) > 0) {
        await page.getByTestId('admin-sent-notifications__row').first().click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await page.getByTestId('admin-sent-notifications__detail-close-button').click();
        await expect(page.getByRole('dialog')).toBeHidden();
      }

      await openAdminTab(page, 'pending-actions', 'admin-pending-actions');
      const expand = page.locator('[data-testid^="admin-pending-actions__expand-"]').first();
      if (await expand.isVisible().catch(() => false)) {
        await expand.click();
        await expect(page.locator('[data-testid^="admin-pending-actions__detail-"]').first()).toBeVisible();
      }
      await page.getByTestId('admin-pending-actions__refresh').click();
      await expect(page.getByTestId('admin-pending-actions')).toBeVisible();

      await openAdminTab(page, 'access-log', 'admin-access-log__container');
      const accessPanel = page.getByTestId('admin-access-log__filter-panel');
      await accessPanel.getByTestId('admin-access-log__filter-path').fill('/api/requests');
      await accessPanel.getByTestId('admin-access-log__apply-button').click();
      await accessPanel.getByTestId('admin-access-log__clear-button').click();
      await expect(accessPanel.getByTestId('admin-access-log__filter-path')).toHaveValue('');

      await openAdminTab(page, 'audit-log', 'admin-audit-log__container');
      const auditPanel = page.getByTestId('admin-audit-log__filter-panel');
      await auditPanel.getByTestId('admin-audit-log__filter-actor').fill('nobody@example.test');
      await auditPanel.getByTestId('admin-audit-log__apply-button').click();
      await auditPanel.getByTestId('admin-audit-log__clear-button').click();
      await expect(auditPanel.getByTestId('admin-audit-log__filter-actor')).toHaveValue('');
    });
  });
});
