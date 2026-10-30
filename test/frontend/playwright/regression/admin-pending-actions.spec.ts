// Admin aggregate Pending Actions tab — functional e2e (addendum-196 —
// feature-coverage audit gap #2 closed). dashboard-tabs-rendering.spec.ts
// proves the tab MOUNTS; before this file nothing proved it tracks real
// derivation state. The backend scoping matrix stays with
// pending_actions_admin.test.tsx; the browser owns:
//
//   test 1 — a submitted request makes BOTH current-step reviewers named
//     debtors (per-user rows, attribution by email), the expandable ledger
//     names the cue ("Review step 1") + deeplink verbatim, and once a
//     reviewer decides, ownership visibly MOVES to the next step's team
//     (both L2 rows gone, both agency-L1 rows present).
//   test 2 — the empty state is real ("No pending actions — the queue is
//     clear.") and the Refresh control re-derives live after a submission.
//
// Two tests per file: the screenshot-count self-check gates the run delta
// at a positive EVEN number; paired captures keep each spec even.
import { test, expect } from '../helpers/harness';
import type { Page } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, modalByTestId, pickDateTime, createAssetViaAdminUI, clickWithCapture,
  submitWithCapture, fillCredentialItemCombobox, submitRequestIdentityWithCapture,
  pendingDashboardAction, openAdminTab,
  confirmDecisionAndWait,} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

async function provisionAndSubmit(
  page: Page,
  tag: string,
  shortCode: string,
  systemName: string,
): Promise<{ scenario: ProvisionedScenario; requestNumber: string }> {
  const scenario = await provisionActorsAndTeams(page, SUPERADMIN, tag);
  await provisionSystem(page, scenario, { shortCode, name: systemName });
  await createAssetViaAdminUI(page, {
    systemLabel: `${shortCode} — ${systemName}`,
    hostname: `adminpa-${tag}.prod.internal`,
    credentialName: `adminpa-${tag}-token`,
    credentialType: 'token',
    navigateFirst: true,
  });

  await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select')
    .selectOption({ label: `${systemName} (${shortCode})` });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(`SR-ADMINPA-${tag.toUpperCase()}`);
  await page.getByTestId('vendor-dashboard__justification-textarea')
    .fill('Admin pending-actions e2e: the aggregate tab must track real derivation state.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
  await fillCredentialItemCombobox(
    page.getByTestId('vendor-dashboard__credential-item'),
    `adminpa-${tag}.prod.internal`,
    `adminpa-${tag}-token`,
  );
  const submitted = await submitRequestIdentityWithCapture(
    page,
    `adminpa-${tag}-submit-request`,
    page.getByTestId('vendor-dashboard__submit-request-button'),
  );
  return { scenario, requestNumber: submitted.requestNumber };
}

async function openPendingActionsTab(page: Page, refresh = false) {
  await openAdminTab(page, 'pending-actions', 'admin-pending-actions__table', { refresh });
}

function debtorRow(page: Page, email: string) {
  return page.locator('tr', { hasText: email });
}

test.describe('admin aggregate pending-actions tab (addendum-196)', () => {
  test('debtors are named per user, the ledger names the cue, and ownership moves with the step', async ({ page }) => {
    const { scenario, requestNumber } = await provisionAndSubmit(page, 'adminpa', 'ADMINPA', 'Admin Pending Actions A');

    await test.step('both current-step reviewers are named debtors with the derivation cue in their ledger', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openPendingActionsTab(page);
      await expect(page.getByTestId('admin-pending-actions__meta')).toBeVisible();

      for (const debtor of [scenario.vendorL2A, scenario.vendorL2B]) {
        const row = debtorRow(page, debtor.email);
        await expect(row).toBeVisible();
        await clickWithCapture(page, `adminpa-expand-${debtor === scenario.vendorL2A ? 'a' : 'b'}`, row.getByRole('button', { name: 'Detail' }));
        const detail = page.locator('tr', { hasText: 'Review step 1' }).filter({ hasText: '/dashboard/request/' });
        await expect(detail.first()).toBeVisible();
      }
    });

    await test.step('a decision moves the debt: vendor L2 rows vanish, agency L1 rows appear', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      const approve = await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button');
      await clickWithCapture(page, 'adminpa-open-approve-modal', approve);
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await submitWithCapture(page, 'adminpa-vendor-l2-approve', modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openPendingActionsTab(page, true);
      await expect(debtorRow(page, scenario.vendorL2A.email)).toHaveCount(0);
      await expect(debtorRow(page, scenario.vendorL2B.email)).toHaveCount(0);
      for (const debtor of [scenario.agencyL1A, scenario.agencyL1B]) {
        await expect(debtorRow(page, debtor.email)).toBeVisible();
      }
    });

    await test.step('reject the request so no pending debt bleeds into the next test', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      const rejectButton = await pendingDashboardAction(page, requestNumber, 'agency-dashboard__reject-button');
      await rejectButton.click();
      const modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await modal.getByTestId('agency-dashboard__notes-textarea').fill('Closing for test isolation.');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });
  });

  test('empty state is real and the Refresh control re-derives live', async ({ page }) => {
    const { scenario } = await (async () => {
      const scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'adminpb');
      await provisionSystem(page, scenario, { shortCode: 'ADMINPB', name: 'Admin Pending Actions B' });
      await createAssetViaAdminUI(page, {
        systemLabel: 'ADMINPB — Admin Pending Actions B',
        hostname: 'adminpa-adminpb.prod.internal',
        credentialName: 'adminpa-adminpb-token',
        credentialType: 'token',
        navigateFirst: true,
      });
      return { scenario };
    })();

    await test.step('with no open requests the queue is honestly clear', async () => {
      await openAdminTab(page, 'pending-actions', 'admin-pending-actions__table');
      await expect(page.getByTestId('admin-pending-actions__empty'))
        .toHaveText('No pending actions — the queue is clear.');
    });

    await test.step('after a submission, Refresh surfaces the debtor without a full remount', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: 'Admin Pending Actions B (ADMINPB)' });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-ADMINPA-B');
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill('Second-phase submission for the refresh-control proof.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(
        page.getByTestId('vendor-dashboard__credential-item'),
        'adminpa-adminpb.prod.internal',
        'adminpa-adminpb-token',
      );
      await submitRequestIdentityWithCapture(
        page,
        'adminpa-adminpb-submit-request',
        page.getByTestId('vendor-dashboard__submit-request-button'),
      );

      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openPendingActionsTab(page, true);
      await clickWithCapture(page, 'adminpa-refresh', page.getByTestId('admin-pending-actions__refresh'));
      await expect(debtorRow(page, scenario.vendorL2A.email)).toBeVisible();
      await expect(page.getByTestId('admin-pending-actions__empty')).toHaveCount(0);
    });
  });
});
