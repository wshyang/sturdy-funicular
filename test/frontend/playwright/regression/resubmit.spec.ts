// Companion e2e coverage for the vendor "Resubmit after Return" flow
// (VendorDashboard.tsx's `view === 'resubmit'` form, PUT
// .../requests/:id/resubmit — server/routes-requests.tsx) — previously only
// exercised implicitly by unit tests (VendorDashboard.test.tsx covers the
// button's visibility + pre-filled form in isolation) and never driven
// end-to-end against a real backend/lifecycle. Reuses the standard 3-step
// scenario roster (vendor L2 -> agency L1 -> agency L2 -> owner): the
// submitting vendor L1 actor submits, the vendor L2 reviewer returns it
// (Return to Vendor at the first step), and the ORIGINAL submitter resubmits
// via the pre-filled form, after which the request goes back to `submitted`
// and reaches the vendor L2 reviewer again.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, modalByTestId, pickDateTime, submitRequestIdentityWithCapture, submitWithCapture, createAssetViaAdminUI, fillCredentialItemCombobox, pendingDashboardAction } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('resubmit after return', () => {
  test('vendor resubmits a returned_to_vendor request via the pre-filled form', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await test.step('provision the actor/team roster and one system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'rsm');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'RSM1', name: 'Resubmit Test System' });
      // Per addendum-039-asset-gated-submission.md — one asset for the
      // original submission, one for the corrected resubmission.
      await createAssetViaAdminUI(page, { systemLabel: 'RSM1 — Resubmit Test System', hostname: 'host-original', credentialName: 'svc_original', navigateFirst: true });
      await createAssetViaAdminUI(page, { systemLabel: 'RSM1 — Resubmit Test System', hostname: 'host-corrected', credentialName: 'svc_corrected' });
    });

    await test.step('vendor L1 submits the original request', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: 'Resubmit Test System (RSM1)' });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-RSM001');
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('Original justification needing correction.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-original', 'svc_original');
      requestNumber = (await submitRequestIdentityWithCapture(page, 'resubmit-original-submit', page.getByTestId('vendor-dashboard__submit-request-button'))).requestNumber;
    });

    await test.step('vendor L2 returns the request to the vendor', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__return-button')).click();
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await modal.getByTestId('vendor-dashboard__notes-textarea').fill('SR number needs verification — please confirm and resubmit.');
      await submitWithCapture(page, 'resubmit-vendor-l2-return', modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('the original submitter sees Resubmit and the form is pre-filled', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.locator('tr', { hasText: requestNumber })).toContainText(/returned/i);

      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__resubmit-button')).click();

      await expect(page.getByRole('heading', { name: 'Resubmit Request' })).toBeVisible();
      await expect(page.getByTestId('vendor-dashboard__sr-number-input')).toHaveValue('SR-RSM001');
      await expect(page.getByTestId('vendor-dashboard__justification-textarea')).toHaveValue('Original justification needing correction.');
      await expect(page.getByTestId('vendor-dashboard__system-select')).toHaveCount(0);
    });

    await test.step('editing and resubmitting sends the request back to submitted', async () => {
      await page.getByTestId('vendor-dashboard__justification-textarea').fill('Corrected justification, SR number verified.');
      // Resubmit reuses the credential items shown by the form as-is; fill
      // the single default item since startResubmit() resets credential_items.
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-corrected', 'svc_corrected');
      await submitWithCapture(page, 'resubmit-corrected-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
      // The form closes and navigates back to the list asynchronously after the
      // PUT resolves — wait for the heading to disappear before checking the row.
      await expect(page.getByRole('heading', { name: 'Resubmit Request' })).not.toBeVisible();

      await expect(page.locator('tr', { hasText: requestNumber })).toContainText(/submitted/i);
      await expect(page.locator('tr', { hasText: requestNumber })).not.toContainText(/returned/i);
    });

    await test.step('vendor L2 sees the resubmitted request again at the same step', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button');
    });
  });
});
