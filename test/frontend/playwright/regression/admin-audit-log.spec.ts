// E2E coverage for the admin Audit Log tab (AdminAuditLog.tsx —
// GET /audit/logs, server/routes-audit.tsx). To guarantee a real audit row in
// the freshly-wiped e2e DB, this spec first creates a cluster (an audited
// mutation) and then asserts that audit event surfaces in the log and that the
// filter panel can narrow by action.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';
import { provisionOrganization } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SEED_ORG = { name: 'AuditLog Org', shortCode: 'AUDITLOG' };

test.describe('admin audit-log tab', () => {
  test('records an audited mutation and renders/filters it in the audit log', async ({ page }) => {
    await test.step('log in as superadmin', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
    });

    await test.step('create a cluster (an audited mutation) to seed the audit log', async () => {
      // Addendum-206 D2: clusters need a live org anchor, and a fresh wipe
      // has no organisations — provision one first.
      await provisionOrganization(page, SEED_ORG);
      // Click-through, not a URL deep link (addendum-099).
      await openAdminTab(page, 'clusters', 'admin-clusters__toggle-create-form-button');
      await page.getByTestId('admin-clusters__toggle-create-form-button').click();
      await page.getByTestId('admin-clusters__name-input').fill('AuditLog Cluster');
      await page.getByTestId('admin-clusters__type-select').selectOption('vendor');
      await page.getByTestId('admin-clusters__org-select').selectOption({ label: SEED_ORG.name });
      await page.getByTestId('admin-clusters__description-textarea').fill('Seeds the audit log for the audit-log e2e.');
      await page.getByTestId('admin-clusters__submit-button').click();
      // The created cluster row appears (create-form collapses back to the list).
      await expect(page.getByText('AuditLog Cluster')).toBeVisible();
    });

    await test.step('the audit log renders the cluster.created event', async () => {
      // Click-through again — tab-to-tab navigation is the real user path.
      await openAdminTab(page, 'audit-log', 'admin-audit-log__table');
      // The cluster-created audit event should appear (other specs also create
      // clusters in the same DB — use .first() to avoid strict-mode violations).
      await expect(page.getByText('cluster.created').first()).toBeVisible();
    });

    await test.step('the filter panel narrows by action', async () => {
      await expect(page.getByTestId('admin-audit-log__filter-action')).toBeVisible();
      await page.getByTestId('admin-audit-log__filter-action').fill('cluster.created');
      await page.getByTestId('admin-audit-log__apply-button').click();
      // The targeted row remains after filtering.
      await expect(page.getByTestId('admin-audit-log__row').first()).toBeVisible();
      await page.getByTestId('admin-audit-log__clear-button').click();
      await expect(page.getByTestId('admin-audit-log__row').first()).toBeVisible();
    });
  });
});
