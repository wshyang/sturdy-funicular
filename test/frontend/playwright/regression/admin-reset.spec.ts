// E2E coverage for the Global Admin Reset action (RequestDetailView.tsx's
// admin-reset-button, POST .../requests/:id/admin-reset —
// server/routes-requests.tsx). Admins have no dashboard queue of their own
// (Dashboard.tsx renders AdminPanel when the capability snapshot's is_admin is
// true, not a request list) — the only UI path to a specific request is Search
// overlay, same pattern as the vendor-tier reviewer flows in
// rejection-flows.spec.ts/approver-edit.spec.ts.
//
// Admin Reset resets the approval-step chain (ordinal > 1) to pending and
// returns the request to the submitter (status='returned_to_vendor',
// current_step_ordinal=2 — ordinal 1, the submitter's own step, is left
// untouched per addendum-027-submitter-as-workflow-step-one.md),
// incrementing return_count — distinct from a plain step-level Return
// (which only affects the current step). This spec proves the reset lands
// the request back with the ORIGINAL submitter and that the button
// disappears once terminal (closed).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, modalByTestId, pickDateTime, submitRequestIdentityWithCapture, submitWithCapture, createAssetViaAdminUI, fillCredentialItemCombobox, pendingDashboardAction, openPendingDashboardRequest, clickCustodyActionAndWait, confirmDecisionAndWait,} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

async function openViaSearch(page: import('@playwright/test').Page, query: string, systemNameHint: string) {
  await page.getByTestId('dashboard__search-button').click();
  await page.getByTestId('search-overlay__query-input').fill(query);
  await page.getByTestId('search-overlay__result-button').filter({ hasText: systemNameHint }).first().click();
}

test.describe('admin reset action', () => {
  test('global admin resets an in-flight request back to the submitter', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await test.step('provision the actor/team roster and one system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'rst');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'RST1', name: 'Admin Reset Test System' });
      // Per addendum-039-asset-gated-submission.md — curate both assets the
      // submit and resubmit steps below will select, up front.
      await createAssetViaAdminUI(page, { systemLabel: 'RST1 — Admin Reset Test System', hostname: 'host-reset', credentialName: 'svc_reset', navigateFirst: true });
      await createAssetViaAdminUI(page, { systemLabel: 'RST1 — Admin Reset Test System', hostname: 'host-reset2', credentialName: 'svc_reset2' });
    });

    await test.step('vendor L1 submits, vendor L2 approves — request reaches agency L1', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: 'Admin Reset Test System (RST1)' });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-RST001');
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('Justification for admin-reset test.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-reset', 'svc_reset');
      requestNumber = (await submitRequestIdentityWithCapture(page, 'admin-reset-submit', page.getByTestId('vendor-dashboard__submit-request-button'))).requestNumber;

      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button')).click();
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('global admin resets the request from agency L1\'s step', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openViaSearch(page, 'SR-RST001', 'Admin Reset Test System');

      await page.getByTestId('request-detail-view__admin-reset-button').click();
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__notes-textarea').fill('Resetting due to a workflow misconfiguration.');
      await submitWithCapture(page, 'admin-reset-confirm', modal.getByTestId('request-detail-view__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('the submitter sees the request back as returned_to_vendor, ready to resubmit', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      const row = page.locator('tr', { hasText: requestNumber });
      await expect(row).toContainText(/returned/i);
      // Resubmit lives in the row kebab (portaled out of <tr> — addendum-192).
      await expect(await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__resubmit-button')).toBeVisible();
    });

    await test.step('a subsequent full lifecycle to closed removes the Reset Request action', async () => {
      // Resubmit, then walk the same 3-step chain to credential_issued -> closed.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__resubmit-button')).click();
      // startResubmit() resets credential_items to a single blank default item —
      // fill it or client-side validation silently blocks the submit.
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-reset2', 'svc_reset2');
      await submitWithCapture(page, 'admin-reset-resubmit', page.getByTestId('vendor-dashboard__submit-request-button'));
      const row = page.locator('tr', { hasText: requestNumber });
      await expect(row).toContainText(/submitted/i);

      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button')).click();
      let modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await (await pendingDashboardAction(page, requestNumber, 'agency-dashboard__approve-button')).click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await (await pendingDashboardAction(page, requestNumber, 'agency-dashboard__approve-button')).click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.owner.email, scenario.owner.password);
      await page.getByTestId('owner-dashboard__tab-requests').click();
      await (await pendingDashboardAction(page, requestNumber, 'owner-dashboard__approve-button')).click();
      modal = modalByTestId(page, 'owner-dashboard__action-modal');
      await modal.getByTestId('owner-dashboard__confirm-button').click();
      await expect(modal).not.toBeVisible();

      // Credential cannot be issued until physical custody reaches the requester.
      // Agency custodian initiates handover; requester confirms receipt (auto-issues).
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await openPendingDashboardRequest(page, requestNumber, 'agency-dashboard__view-button');
      const custodyCase = page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: 'svc_reset2' });
      await custodyCase.getByRole('checkbox').check();
      await page.getByTestId('request-custody__batch-prepare_and_handover').click();
    // Server-reconciled wait: the batch bar unmounts only after the POST
    // succeeds (selection clears on success, not on the optimistic
    // projection). Without this the next page navigation can abort the
    // in-flight POST and the asserted state is only client-side projection.
      await expect(page.getByTestId('request-custody__batch-bar')).toBeHidden();
      await expect(custodyCase).toContainText(/handover pending/i);

      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await openPendingDashboardRequest(page, requestNumber, 'vendor-dashboard__view-button');
      const custodyCaseR = page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: 'svc_reset2' });
      await clickCustodyActionAndWait(page, custodyCaseR.getByRole('button', { name: 'Confirm receipt' }));
      await expect(custodyCaseR).toContainText(/requester custody/i);
      // Credential auto-issues on requester receipt.

      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await (await pendingDashboardAction(page, requestNumber, 'agency-dashboard__close-button')).click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openViaSearch(page, 'SR-RST001', 'Admin Reset Test System');
      await expect(page.getByTestId('request-detail-view__admin-reset-button')).toHaveCount(0);
    });
  });
});
