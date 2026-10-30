// E2E coverage for the organisation dimension (addendum-109 — test-first,
// RED BY DESIGN, rev 2026-08-05: NO GATES).
//
// The whole file runs LIVE and fails now by design: the Organisations tab,
// the admin-orgs__* form ids, the approval-modal org picker and the user-row
// org chips mount only with the addendum-110+ implementation. Every failure
// here is the TDD contract the implementation will turn green — no skip, no
// ignore (owner direction 2026-08-05). The element ids exercised here ARE
// the ideated contract (see addendum-109 §"UI element id registry") — the
// implementation adopts them, it does not re-invent them.
//
// Suite invariants honoured: exactly 2 tests (even), ZERO screenshot capture
// calls (the screenshot-count even-delta invariant is untouched), real-UI
// discipline (every mutation goes through the real Admin tab, no DB shortcuts).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, logout, signup, openAdminTab } from '../helpers/ui';
import { provisionOrganization } from '../helpers/scenario';
import {
  DEFAULT_ORG_NAME,
  DEFAULT_ORG_SHORT_CODE,
} from '../../../org-dimension.ts';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('organisations tab + approval-time org assignment (addendum-109)', () => {
  test('superadmin creates the Default organisation; duplicate live names are rejected', async ({ page }) => {
    await test.step('log in as superadmin and open the Organisations tab by clicking it', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'organizations', 'admin-orgs__table');
    });

    await test.step('create the single Default organisation', async () => {
      await provisionOrganization(page, { name: DEFAULT_ORG_NAME, shortCode: DEFAULT_ORG_SHORT_CODE });
      await expect(page.locator('tr', { hasText: DEFAULT_ORG_NAME })).toBeVisible();
    });

    await test.step('duplicate live name shows the form error', async () => {
      await page.getByTestId('admin-orgs__toggle-create-form-button').click();
      await page.getByTestId('admin-orgs__name-input').fill(DEFAULT_ORG_NAME);
      // addendum-200: the short code is natively required — supply a valid,
      // distinct one so the submission goes through and the 400 can only come
      // from the duplicate NAME.
      await page.getByTestId('admin-orgs__short-code-input').fill('DUP');
      await page.getByTestId('admin-orgs__submit-button').click();
      await expect(page.getByTestId('admin-orgs__form-error')).toBeVisible();
    });

    await test.step('duplicate live short code shows the form error (addendum-200), lowercase input normalized', async () => {
      // Same form session: a fresh name but the Default org's own code, typed
      // lowercase — the field normalizes to DEF and the server rejects it.
      await page.getByTestId('admin-orgs__name-input').fill(`Second Org ${Date.now()}`);
      await page.getByTestId('admin-orgs__short-code-input').fill('def');
      await expect(page.getByTestId('admin-orgs__short-code-input')).toHaveValue('DEF');
      await page.getByTestId('admin-orgs__submit-button').click();
      await expect(page.getByTestId('admin-orgs__form-error')).toContainText('short code "DEF" already exists');
    });
  });

  test('approves a pending signup into the Default organisation; its chip renders on the user row', async ({ page }) => {
    const runId = `${Date.now()}`;
    const pendingUser = {
      fullName: `Org Pending ${runId}`,
      email: `org-pending.${runId}@test.local`,
      password: `OrgPending!2026`,
    };

    await test.step('provision the Default organisation', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionOrganization(page, { name: DEFAULT_ORG_NAME, shortCode: DEFAULT_ORG_SHORT_CODE });
      await logout(page);
    });

    await test.step('a new user signs up and lands in the pending list', async () => {
      await signup(page, pendingUser);
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'users');
    });

    await test.step('approval modal assigns Default (approved via the ideated picker)', async () => {
      const row = page.locator('tr', { hasText: pendingUser.email });
      await row.getByTestId('admin-users__row-menu-button').click();
      await row.getByTestId('admin-users__approve-button').click();
      const modal = page.getByTestId('admin-users__action-modal');
      await modal.getByTestId('admin-users__affiliation-select').selectOption('agency');
      const picker = modal.getByTestId('admin-users__approve-org-picker');
      await picker.getByLabel(DEFAULT_ORG_NAME).check();
      await modal.getByTestId('admin-users__confirm-button').click();
      await expect(modal).not.toBeVisible();
    });

    await test.step('the user row shows its Default-organisation chip', async () => {
      await page.getByTestId('admin-users__view-all-tab').click();
      const row = page.locator('tr', { hasText: pendingUser.email });
      await expect(row.getByTestId('admin-users__org-chip')).toHaveCount(1);
      await expect(row.getByTestId('admin-users__org-chip').filter({ hasText: DEFAULT_ORG_NAME })).toBeVisible();
    });
  });
});
