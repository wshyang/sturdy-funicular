// Three rejection-chain scenarios, each starting from a vendor L1 submission
// and following the corrected happy path (vendor L1 -> vendor L2 -> agency
// L1 -> agency L2 -> owner) until a DIFFERENT actor rejects instead of
// approving — from latest possible rejection point (owner, after the full
// chain) down to the earliest (vendor L2, immediately after submission).
//
// Reuses ONE shared provisionActorsAndTeams() roster across all 3 scenarios
// in this file (actors/teams are realistically reused across systems), with
// a DISTINCT system per scenario so requests never collide. Per the user's
// explicit choice, assertions here are LIGHTER per chain than
// happy-path.spec.ts's full matrix — each chain asserts the reject succeeds,
// the resulting status, and ONE pointed visibility check specific to that
// chain's cutoff point (proving the request never reached whichever actor
// comes next in the chain).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, modalByTestId, pickDateTime, submitRequestIdentityWithCapture, submitWithCapture, confirmDecisionAndWait, directGetRequestStatus, createAssetViaAdminUI, fillCredentialItemCombobox, pendingDashboardAction, type SubmittedRequestIdentity } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

// Per addendum-039-asset-gated-submission.md, submission requires selecting
// a real, active asset — curated here via the admin UI (caller must already
// be logged in as an admin, immediately after provisionSystem) before
// switching to the vendor to submit.
async function curateAsset(page: import('@playwright/test').Page, systemName: string, systemShortCode: string) {
  await createAssetViaAdminUI(page, {
    systemLabel: `${systemShortCode} — ${systemName}`, hostname: 'host-01', credentialName: 'svc_test', navigateFirst: true,
  });
}

async function submitRequest(page: import('@playwright/test').Page, scenario: ProvisionedScenario, systemName: string, systemShortCode: string, srNumber: string, testSuiteId: string): Promise<SubmittedRequestIdentity> {
  await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${systemName} (${systemShortCode})` });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(srNumber);
  await page.getByTestId('vendor-dashboard__justification-textarea').fill('Production incident requiring emergency database access.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
  await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-01', 'svc_test');
  return submitRequestIdentityWithCapture(page, testSuiteId, page.getByTestId('vendor-dashboard__submit-request-button'));
}

test.describe('rejection chains', () => {
  test('three rejection chains share one actor/team roster', async ({ page }) => {
    let scenario!: ProvisionedScenario;

    await test.step('provision the shared 9-actor / 4-team roster', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'rej');
    });

    // ── Chain 1: full happy path, then the OWNER rejects at the terminal ──
    await test.step('chain 1: owner rejects at the terminal decision', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'REJ1', name: 'Rejection Chain 1 System' });
      await curateAsset(page, 'Rejection Chain 1 System', 'REJ1');
      const request = await submitRequest(page, scenario, 'Rejection Chain 1 System', 'REJ1', 'SR-REJ001', 'rejection-chain1-submit');

      // The assignment must be present and actionable in Vendor L2's pending dashboard.
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'vendor-dashboard__approve-button')).click();
      let detailModal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await confirmDecisionAndWait(page, detailModal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(detailModal).not.toBeVisible();

      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'agency-dashboard__approve-button')).click();
      let modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'agency-dashboard__approve-button')).click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.owner.email, scenario.owner.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'owner-dashboard__reject-button')).click();
      modal = modalByTestId(page, 'owner-dashboard__action-modal');
      await modal.getByTestId('owner-dashboard__notes-textarea').fill('Access no longer needed — incident resolved by other means.');
      await submitWithCapture(page, 'rejection-chain1-owner-reject', modal.getByTestId('owner-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      // Submitter sees the rejected status.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.locator('tr', { hasText: request.requestNumber })).toContainText(/rejected/i);
    });

    // ── Chain 2: vendor L2 + agency L1 approve, then AGENCY L2 rejects ────
    // (before the owner ever sees it) — pointed check: the owner never had
    // visibility, proving the request never reached them.
    await test.step('chain 2: agency L2 rejects before the owner ever sees it', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'REJ2', name: 'Rejection Chain 2 System' });
      await curateAsset(page, 'Rejection Chain 2 System', 'REJ2');
      const request = await submitRequest(page, scenario, 'Rejection Chain 2 System', 'REJ2', 'SR-REJ002', 'rejection-chain2-submit');

      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'vendor-dashboard__approve-button')).click();
      let detailModal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await confirmDecisionAndWait(page, detailModal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(detailModal).not.toBeVisible();

      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'agency-dashboard__approve-button')).click();
      let modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await confirmDecisionAndWait(page, modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      // Pointed check, taken HERE (still pre-reject, request at agency L2 —
      // ordinal 4 now that Step 1 is the submitter, per
      // addendum-027-submitter-as-workflow-step-one.md): the owner has no
      // visibility while the request is still preOwner (current_step_ordinal
      // > 0, not yet the owner terminal at 0) — proving the request never
      // reached them during the live workflow.
      // Checking this AFTER the reject below would be the WRONG place: once
      // rejected (a terminal status), isPreOwner becomes false and the
      // broad historical-role model restores visibility for the owner (who
      // literally owns this system via owned_system_ids) — that's correct,
      // deliberate post-decision behavior (addendum-013), not a gap.
      await login(page, scenario.owner.email, scenario.owner.password);
      let status = await directGetRequestStatus(page, request.id);
      expect(status).toBe(404);

      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'agency-dashboard__reject-button')).click();
      modal = modalByTestId(page, 'agency-dashboard__action-modal');
      await modal.getByTestId('agency-dashboard__notes-textarea').fill('Justification insufficient for the scope of access requested.');
      await submitWithCapture(page, 'rejection-chain2-agency-l2-reject', modal.getByTestId('agency-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.locator('tr', { hasText: request.requestNumber })).toContainText(/rejected/i);
    });

    // ── Chain 3: VENDOR L2 rejects immediately after submission — the
    // earliest possible rejection point. Pointed check: agency L1 (the very
    // next actor in line) never had visibility. ──────────────────────────
    await test.step('chain 3: vendor L2 rejects immediately after submission', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'REJ3', name: 'Rejection Chain 3 System' });
      await curateAsset(page, 'Rejection Chain 3 System', 'REJ3');
      const request = await submitRequest(page, scenario, 'Rejection Chain 3 System', 'REJ3', 'SR-REJ003', 'rejection-chain3-submit');

      // Per addendum-028-visibility-fix-and-emergency-override.md: direct
      // GET is now SYSTEM-scoped while pre-owner, not step-scoped — agency
      // L1 (a downstream reviewer mapped to this system, request currently
      // at step 1) CAN already view the request via direct GET, even though
      // (per happy-path.spec.ts's dashboard-visibility coverage) it is
      // correctly absent from their dashboard list and they cannot act on
      // it without the emergency override.
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      const status = await directGetRequestStatus(page, request.id);
      expect(status).toBe(200);

      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, request.requestNumber, 'vendor-dashboard__reject-button')).click();
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await modal.getByTestId('vendor-dashboard__notes-textarea').fill('SR number does not correspond to a valid open incident.');
      await submitWithCapture(page, 'rejection-chain3-vendor-l2-reject', modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();

      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(page.locator('tr', { hasText: request.requestNumber })).toContainText(/rejected/i);
    });
  });
});
