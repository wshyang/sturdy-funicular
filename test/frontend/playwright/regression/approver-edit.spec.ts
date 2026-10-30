// E2E coverage for the approver in-cycle edit flow (AEEditPanel.tsx, PUT
// .../requests/:id/approver-edit — server/routes-requests.tsx), driven from
// AgencyDashboard.tsx's row-scoped Edit button (canEdit() — shown only while
// the request is awaiting THIS approver's own step decision). Previously
// only unit-tested in isolation (RequestDetailView.test.tsx confirms Edit
// Request opens AEEditPanel) — this spec drives the full save round-trip
// against the real backend and confirms the edited fields persist.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, modalByTestId, pickDateTime, submitRequestIdentityWithCapture, submitWithCapture, createAssetViaAdminUI, fillCredentialItemCombobox, pendingDashboardAction, openPendingDashboardRequest, confirmDecisionAndWait,} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('approver in-cycle edit', () => {
  test('agency L1 approver edits justification/SR number/credential item while the request is at their step', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await test.step('provision the actor/team roster and one system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'edt');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'EDT1', name: 'Approver Edit Test System' });
      // Per addendum-039-asset-gated-submission.md.
      await createAssetViaAdminUI(page, { systemLabel: 'EDT1 — Approver Edit Test System', hostname: 'host-original', credentialName: 'svc_original', navigateFirst: true });
    });

    await test.step('vendor L1 submits, vendor L2 approves — request reaches agency L1', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: 'Approver Edit Test System (EDT1)' });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-EDT001');
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('Original justification text.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-original', 'svc_original');
      requestNumber = (await submitRequestIdentityWithCapture(page, 'approver-edit-submit', page.getByTestId('vendor-dashboard__submit-request-button'))).requestNumber;

      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button')).click();
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('agency L1 opens Edit Request and saves changes', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await (await pendingDashboardAction(page, requestNumber, 'agency-dashboard__edit-button')).click();

      const panel = page.getByTestId('ae-edit-panel');
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('ae-edit-panel__sr-number-input')).toHaveValue('SR-EDT001');
      await expect(panel.getByTestId('ae-edit-panel__justification-textarea')).toHaveValue('Original justification text.');

      await panel.getByTestId('ae-edit-panel__sr-number-input').fill('SR-EDT001-REV2');
      await panel.getByTestId('ae-edit-panel__justification-textarea').fill('Amended justification with additional detail.');
      await panel.getByTestId('ae-edit-panel__credential-hostname-description-input').fill('Production database server, edited by approver.');

      await submitWithCapture(page, 'approver-edit-save', panel.getByTestId('ae-edit-panel__save-button'));
      await expect(panel).not.toBeVisible();
    });

    await test.step('the edit is visible in the request detail and audit timeline', async () => {
      await openPendingDashboardRequest(page, requestNumber, 'agency-dashboard__view-button');

      await expect(page.getByText('SR-EDT001-REV2').first()).toBeVisible();
      await expect(page.getByText('Amended justification with additional detail.').first()).toBeVisible();
      // The audit timeline disclosure is expanded by default — assert directly.
      await expect(page.getByText('Request › Edited By Approver')).toBeVisible();
    });

    await test.step('blank justification is rejected client-side without calling the API', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await (await pendingDashboardAction(page, requestNumber, 'agency-dashboard__edit-button')).click();
      const panel = page.getByTestId('ae-edit-panel');
      await panel.getByTestId('ae-edit-panel__justification-textarea').fill('');
      await panel.getByTestId('ae-edit-panel__save-button').click();
      await expect(panel.getByText('Justification is required.')).toBeVisible();
      await panel.getByTestId('ae-edit-panel__cancel-button').click();
      await expect(panel).not.toBeVisible();
    });
  });
});
