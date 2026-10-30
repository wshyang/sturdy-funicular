// E2E coverage for the RENAMED admin Sent Notifications (outbox) tab —
// red-regiment ledger row 5 (assessment
// docs/assessments/2026-08-04-sent-notifications-tab-rename-status-honesty-detail-modal.md;
// implemented in addendum-111). GREEN CONTRACT: the tab is now
// 'sent-notifications' and the table/content testids are
// admin-sent-notifications__*; the spec replaced the legacy
// admin-sent-notifications.spec.ts wholesale (same route surface: GET
// /admin/sent-notifications, server/routes-admin-notification-templates.tsx).
//
// Suite invariants honoured: 1 test (parity with the legacy spec it
// replaces), ZERO screenshot capture calls, click-through navigation
// (addendum-099).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('admin sent-notifications (outbox) tab — renamed surface', () => {
  test('renders the outbox table under the sent-notifications tab id and testids', async ({ page }) => {
    await test.step('log in as superadmin and open the Sent Notifications tab by clicking it', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      // Click-through, not a URL deep link (addendum-099).
      await openAdminTab(page, 'sent-notifications', 'admin-sent-notifications__table');
    });

    await test.step('the outbox table renders its header columns', async () => {
      await expect(page.getByText('Trigger')).toBeVisible();
      await expect(page.getByText('Recipients')).toBeVisible();
      await expect(page.getByText('Subject')).toBeVisible();
      await expect(page.getByText('Deliveries')).toBeVisible();
      await expect(page.getByText('Time')).toBeVisible();
      await expect(page.getByText('Body')).toBeVisible();
    });
  });
});
