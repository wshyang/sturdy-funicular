// Conversation-remediation exercise: normalized sent-notification surface and
// notify/no-notify branching. Existing notification specs remain unchanged.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login } from '../helpers/ui';
import { openSentNotificationsTab } from '../helpers/direct-link';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

async function openInvite(page: import('@playwright/test').Page) {
  await login(page, SUPERADMIN.email, SUPERADMIN.password);
  await page.getByTestId('admin-panel__tab-users').click();
  await page.getByTestId('admin-users__invite-button').click();
  await expect(page.getByTestId('admin-users__invite-modal')).toBeVisible();
}

async function submitInvite(
  page: import('@playwright/test').Page,
  email: string,
  notify: boolean,
) {
  await page.getByTestId('admin-users__invite-name-input').fill(`Outbox ${email}`);
  await page.getByTestId('admin-users__invite-email-input').fill(email);
  await page.getByTestId('admin-users__invite-affiliation-select').selectOption('agency');
  const checkbox = page.getByTestId('admin-users__invite-notify-checkbox');
  if (notify) await checkbox.check();
  else await checkbox.uncheck();
  await page.getByTestId('admin-users__invite-submit-button').click();
  await expect(page.getByTestId('admin-users__invite-link')).toContainText('/invite/');
  await page.getByTestId('admin-users__invite-done-button').click();
}

test.describe('remediation exercise — notification outbox', () => {
  test('notify-on invite produces a normalized staged delivery and detail view', async ({ page }) => {
    const email = `outbox-on-${Date.now()}@test.local`;
    await openInvite(page);
    await submitInvite(page, email, true);
    await openSentNotificationsTab(page);

    const row = page.getByTestId('admin-sent-notifications__row').filter({
      hasText: email,
    }).first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId('admin-sent-notifications__trigger-key-cell'))
      .toHaveText('user.invited');
    await expect(row.getByTestId('admin-sent-notifications__recipients-cell'))
      .toContainText(email);
    await expect(row.getByTestId('admin-sent-notifications__deliveries-cell'))
      .toContainText(/Staged|Pending|Delivered/);
    await expect(row.getByTestId('admin-sent-notifications__deliveries-cell'))
      .not.toContainText('Failed');

    await row.click();
    const detail = page.getByTestId('admin-sent-notifications__detail-modal');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText(email);
    await expect(detail).toContainText(/Deliveries/);
    await detail.getByTestId('admin-sent-notifications__detail-close-button').click();
    await expect(detail).not.toBeVisible();
  });

  test('notify-off invite creates the user invitation but no notification row', async ({ page }) => {
    const email = `outbox-off-${Date.now()}@test.local`;
    await openInvite(page);
    await submitInvite(page, email, false);
    await openSentNotificationsTab(page);

    await expect(page.getByTestId('admin-sent-notifications__table')).toBeVisible();
    await expect(page.getByTestId('admin-sent-notifications__row').filter({
      hasText: email,
    })).toHaveCount(0);
    await expect(page.getByTestId('admin-sent-notifications__detail-modal'))
      .toHaveCount(0);
  });
});
