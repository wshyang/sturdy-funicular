// E2E coverage for the admin Access Log tab (AdminAccessLog.tsx —
// GET /admin/access-log, server/routes-audit.tsx). The login + navigation that
// opened this test already produced real access-log rows, so this asserts the
// table renders them, the filter panel works (apply narrows, clear restores),
// and the live/refresh affordances are present.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('admin access-log tab', () => {
  test('renders access-log rows and applies/clears filters', async ({ page }) => {
    await test.step('log in as superadmin and open the Access Log tab by clicking it', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      // Click-through, not a URL deep link (addendum-099): the slug GOTO this
      // replaced could never catch a broken tab-bar navigation.
      await openAdminTab(page, 'access-log', 'admin-access-log__table');
    });

    await test.step('real access-log rows render with their key cells', async () => {
      const rows = page.getByTestId('admin-access-log__row');
      await expect(rows.first()).toBeVisible();
      await expect(rows.first().getByTestId('admin-access-log__method-cell')).toBeVisible();
      await expect(rows.first().getByTestId('admin-access-log__uri-cell')).toBeVisible();
      await expect(rows.first().getByTestId('admin-access-log__status-cell')).toBeVisible();
    });

    await test.step('the filter panel exposes method/status/actor/path filters with apply + clear', async () => {
      await expect(page.getByTestId('admin-access-log__filter-panel')).toBeVisible();
      await expect(page.getByTestId('admin-access-log__apply-button')).toBeVisible();
      await expect(page.getByTestId('admin-access-log__clear-button')).toBeVisible();
    });

    await test.step('filtering by method GET narrows the result set', async () => {
      // Check the GET method checkbox and apply.
      await page.getByTestId('admin-access-log__filter-method-get').check();
      await page.getByTestId('admin-access-log__apply-button').click();
      // The table still renders (and GET requests are abundant — the login/nav
      // flow issues many), so at least one row remains.
      await expect(page.getByTestId('admin-access-log__row').first()).toBeVisible();
    });

    await test.step('clearing restores the full result set', async () => {
      await page.getByTestId('admin-access-log__clear-button').click();
      await expect(page.getByTestId('admin-access-log__row').first()).toBeVisible();
    });

    await test.step('actor filter by email narrows to that actor only (regression: uuid ILIKE 500)', async () => {
      // The actor filter matches full_name, email, or user_id::text
      // (server/db/entities/audit.tsx). The user_id branch used to run
      // `ILIKE` directly against the uuid column, which Postgres rejects
      // (`operator does not exist: uuid ~~* unknown`) — a 500 the UI turned
      // into an empty/erroring table. Applying a real actor value end-to-end
      // pins that fix at the browser level: the exact SQL path the UI drives.
      await page.getByTestId('admin-access-log__filter-actor').fill(E2E_USER_EMAIL);
      await page.getByTestId('admin-access-log__apply-button').click();

      // The filtered response reports a real match count (not "Latest").
      const resultsCount = page.getByTestId('admin-access-log__results-count');
      await expect(resultsCount).toContainText('matching');
      // …and that count is non-zero. Anchored to the start of the string on
      // purpose: this used to read `not.toContainText('0 matching')`, but
      // "0 matching" is a substring of "60 matching" (and of 10/20/…/100), so
      // the assertion failed on any run where the accumulated access-log total
      // happened to end in a zero — an order-dependent flake, since the row
      // count depends on how much traffic the earlier specs generated.
      await expect(resultsCount).toHaveText(/^[1-9][0-9]* matching/);

      // Every visible row must belong to the fixture actor — other actors'
      // rows (name/email/user_id) cannot contain the admin's email.
      const rows = page.getByTestId('admin-access-log__row');
      expect(await rows.count()).toBeGreaterThan(0);
      for (let i = 0; i < await rows.count(); i++) {
        await expect(rows.nth(i).getByTestId('admin-access-log__actor-cell'))
          .toContainText(/E2E Test User|e2e-user@test\.local/);
      }
    });

    await test.step('clearing the actor filter restores the full result set', async () => {
      await page.getByTestId('admin-access-log__clear-button').click();
      await expect(page.getByTestId('admin-access-log__row').first()).toBeVisible();
    });
  });
});
