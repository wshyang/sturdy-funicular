// E2E coverage for the full RETURN-to-engineer lifecycle at EVERY level of the
// approval chain (vendor L2 → agency L1 → agency L2 → system owner terminal):
//
//   * FOUR requests are submitted by the same vendor engineer, one per
//     provisioned system (row anchors are system names — four same-system
//     rows would collide since queue rows render no SR number).
//   * Each request is RETURNED to the submitter from a different level: #1 by
//     the vendor L2 reviewer, #2 by agency L1, #3 by agency L2, #4 by the
//     owner from the terminal step (owner RETURN only exists on the request
//     detail view, never as a queue-row action).
//   * The submitter then RESUBMITS all four via the pre-filled form (one
//     login, sequential), and in test 2 all four proceed through the full
//     chain again to the system owner's terminal approval.
//
// Extends the single-request precedent of resubmit.spec.ts (which covered
// only a vendor-L2 return) to every return-capable level, per the scenario
// roster's standard chain (vendor L2 → agency L1 → agency L2 → owner).
//
// Navigation (addendum-099): everything below is click-driven — no
// page.goto() anywhere. Actors land on their role screen directly (every
// scenario actor here holds exactly one role, so no role droplet renders);
// tabs/search/detail views/modals are all reached by clicks. After each
// detail-view decision the approver's step-scoped visibility to the
// just-decided request is usually gone (addendum-013), so the detail view
// lands on its error state — `backFromDetail` clicks whichever back affordance
// the UI shows (request-detail-view__error-back-button exists since
// addendum-099 exactly for this).
//
// Two tests share describe-scoped provisioning (suite runs serially, one
// shared e2e DB) — and two, not one, because the screenshot-count self-check
// requires an even per-run screenshot delta and each test contributes exactly
// one automatic end-of-test shot.
import { test, expect } from '../helpers/harness';
import type { Page } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, modalByTestId, pickDateTime,
  submitRequestIdentityWithCapture, submitWithCapture,
  createAssetViaAdminUI, fillCredentialItemCombobox, openPendingDashboardRequest, pendingDashboardAction,
  confirmDecisionAndWait, captureBefore, captureAfter,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

// One request per system; the array order matches the level that will RETURN
// it in test 1 (index 0 → vendor L2, 1 → agency L1, 2 → agency L2, 3 → owner).
const REQUESTS: Array<{ code: string; systemName: string; sr: string; hostname: string; credentialName: string; requestNumber?: string }> = [
  { code: 'RTV2', systemName: 'ReturnedAtVendorL2 System', sr: 'SR-RTL001', hostname: 'host-rtl1', credentialName: 'svc_rtl1' },
  { code: 'RTA1', systemName: 'ReturnedAtAgencyL1 System', sr: 'SR-RTL002', hostname: 'host-rtl2', credentialName: 'svc_rtl2' },
  { code: 'RTA2', systemName: 'ReturnedAtAgencyL2 System', sr: 'SR-RTL003', hostname: 'host-rtl3', credentialName: 'svc_rtl3' },
  { code: 'RTOW', systemName: 'ReturnedAtOwner System', sr: 'SR-RTL004', hostname: 'host-rtl4', credentialName: 'svc_rtl4' },
];

// Opens an already-assigned dashboard row before making a detail-only decision.
async function detailDecision(
  page: Page,
  requestNumber: string,
  role: 'vendor' | 'agency' | 'owner',
  actionTestId: string,
  opts: { notes?: string; captureName?: string },
): Promise<void> {
  await openPendingDashboardRequest(page, requestNumber, `${role}-dashboard__view-button`);
  await page.getByTestId(actionTestId).click();
  const modal = modalByTestId(page, 'request-detail-view__action-modal');
  if (opts.notes) await modal.getByTestId('request-detail-view__notes-textarea').fill(opts.notes);
  if (opts.captureName) {
    await captureBefore(page, opts.captureName);
    await confirmDecisionAndWait(page, modal.getByTestId('request-detail-view__confirm-button'));
    await captureAfter(page, opts.captureName);
  } else {
    await confirmDecisionAndWait(page, modal.getByTestId('request-detail-view__confirm-button'));
  }
  await expect(modal).not.toBeVisible();
  await backFromDetail(page);
}

// After a detail-view decision the addendum-013 visibility rule often 404s
// the now-off-step request → error state; both back buttons call the same
// onBack. Click whichever renders (idiom established in
// owner-pending-count.spec.ts).
async function backFromDetail(page: Page): Promise<void> {
  const back = page
    .getByTestId('request-detail-view__error-back-button')
    .or(page.getByTestId('request-detail-view__back-button'));
  await expect(back.first()).toBeVisible({ timeout: 15000 });
  await back.first().click();
  await expect(page.getByTestId('dashboard__search-button')).toBeVisible();
}

// Queue-row decision (agency/owner dashboards): click the row's action button,
// fill notes when the decision needs them, confirm, wait for the modal close.
async function rowDecision(
  page: Page,
  role: 'agency' | 'owner',
  requestNumber: string,
  action: 'approve' | 'return',
  opts: { notes?: string; captureName?: string },
): Promise<void> {
  await (await pendingDashboardAction(page, requestNumber, `${role}-dashboard__${action}-button`)).click();
  const modal = modalByTestId(page, `${role}-dashboard__action-modal`);
  if (opts.notes) {
    await modal.getByTestId(`${role}-dashboard__notes-textarea`).fill(opts.notes);
  }
  if (opts.captureName) {
    await captureBefore(page, opts.captureName);
    await confirmDecisionAndWait(page, modal.getByTestId(`${role}-dashboard__confirm-button`));
    await captureAfter(page, opts.captureName);
  } else {
    await confirmDecisionAndWait(page, modal.getByTestId(`${role}-dashboard__confirm-button`));
  }
  await expect(modal).not.toBeVisible();
}

// The vendor engineer's own queue: one labelled row per provisioned system,
// carrying the request's current status pill.
function submitterRow(page: Page, systemName: string) {
  return page.locator('tr', { hasText: systemName });
}

test.describe('return-to-engineer from every chain level, resubmit, full approval', () => {
  let scenario!: ProvisionedScenario;

  test('four requests, each returned from a different approval level, are all resubmitted by the submitter', async ({ page }) => {
    await test.step('provision the roster, four systems (standard chain each) and one asset per system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'rtl');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      for (const req of REQUESTS) {
        await provisionSystem(page, scenario, { shortCode: req.code, name: req.systemName });
        // Per addendum-039-asset-gated-submission.md the credential item must
        // resolve to a real asset; one per system, reused for the original
        // submission and the resubmission.
        // navigateFirst: provisionSystem() leaves the page on the Systems tab;
        // without this, createAssetViaAdminUI clicks the create-form button
        // before navigating to the Assets tab and times out indefinitely.
        await createAssetViaAdminUI(page, {
          systemLabel: `${req.code} — ${req.systemName}`,
          hostname: req.hostname,
          credentialName: req.credentialName,
          navigateFirst: true,
        });
      }
    });

    await test.step('the vendor engineer submits all four requests', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      for (const req of REQUESTS) {
        await page.getByTestId('vendor-dashboard__open-submit-button').click();
        await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${req.systemName} (${req.code})` });
        await page.getByTestId('vendor-dashboard__sr-number-input').fill(req.sr);
        await page.getByTestId('vendor-dashboard__justification-textarea').fill(`Justification for ${req.sr} — original submission.`);
        await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
        await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
        await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), req.hostname, req.credentialName);
        req.requestNumber = (await submitRequestIdentityWithCapture(page, `rtl-submit-${req.code}`, page.getByTestId('vendor-dashboard__submit-request-button'))).requestNumber;
        // The submit form closes back to the list (its open-submit button is
        // the list-view marker) before the next submission can start.
        await expect(page.getByTestId('vendor-dashboard__open-submit-button')).toBeVisible();
      }
      for (const req of REQUESTS) {
        await expect(submitterRow(page, req.systemName)).toContainText(/submitted/i);
      }
    });

    await test.step('vendor L2 returns request #1 and approves #2-#4 on to agency L1 (one actor session)', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await detailDecision(page, REQUESTS[0]!.requestNumber!, 'vendor', 'request-detail-view__step-return-button',
        { notes: 'Vendor L2 return — check and resubmit.', captureName: 'rtl-return-vendor-l2' });
      for (const req of REQUESTS.slice(1)) {
        await detailDecision(page, req.requestNumber!, 'vendor', 'request-detail-view__step-approve-button', { captureName: `rtl-vendor-l2-approve-${req.code}` });
      }
    });

    await test.step('agency L1 returns request #2 and approves #3-#4 on to agency L2', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await rowDecision(page, 'agency', REQUESTS[1]!.requestNumber!, 'return',
        { notes: 'Agency L1 return — needs a stronger justification.', captureName: 'rtl-return-agency-l1' });
      for (const req of REQUESTS.slice(2)) {
        await rowDecision(page, 'agency', req.requestNumber!, 'approve', { captureName: `rtl-agency-l1-approve-${req.code}` });
      }
    });

    await test.step('agency L2 returns request #3 and approves #4 on to the owner', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      await rowDecision(page, 'agency', REQUESTS[2]!.requestNumber!, 'return',
        { notes: 'Agency L2 return — activity window needs review.', captureName: 'rtl-return-agency-l2' });
      await rowDecision(page, 'agency', REQUESTS[3]!.requestNumber!, 'approve', { captureName: 'rtl-agency-l2-approve-rtow' });
    });

    await test.step('the system owner returns request #4 from the terminal step (detail view — owner has no row-level Return)', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await detailDecision(page, REQUESTS[3]!.requestNumber!, 'owner', 'request-detail-view__owner-return-button',
        { notes: 'Owner return — please re-verify access scope and resubmit.', captureName: 'rtl-return-owner' });
    });

    await test.step('the submitter sees all four returned and resubmits each via the pre-filled form', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      for (const req of REQUESTS) {
        await expect(submitterRow(page, req.systemName)).toContainText(/returned/i);
      }
      for (const req of REQUESTS) {
        await (await pendingDashboardAction(page, req.requestNumber!, 'vendor-dashboard__resubmit-button')).click();
        await expect(page.getByRole('heading', { name: 'Resubmit Request' })).toBeVisible();
        // Pre-filled from the returned request (addendum-013's return flow);
        // edit the justification and REFILL the credential item — the resubmit
        // form resets credential_items.
        await expect(page.getByTestId('vendor-dashboard__sr-number-input')).toHaveValue(req.sr);
        await page.getByTestId('vendor-dashboard__justification-textarea').fill(`Justification for ${req.sr} — corrected after return.`);
        await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), req.hostname, req.credentialName);
        await submitWithCapture(page, `rtl-resubmit-${req.code}`, page.getByTestId('vendor-dashboard__submit-request-button'));
        await expect(page.getByRole('heading', { name: 'Resubmit Request' })).not.toBeVisible();
        await expect(submitterRow(page, req.systemName)).toContainText(/submitted/i);
      }
    });
  });

  test('all four resubmitted requests proceed through the full chain to the system owner', async ({ page }) => {
    await test.step('vendor L2 approves all four', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      for (const req of REQUESTS) {
        await detailDecision(page, req.requestNumber!, 'vendor', 'request-detail-view__step-approve-button', {});
      }
    });

    await test.step('agency L1 approves all four', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      for (const req of REQUESTS) {
        await rowDecision(page, 'agency', req.requestNumber!, 'approve', {});
      }
    });

    await test.step('agency L2 approves all four (routing each to the owner terminal)', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      for (const req of REQUESTS) {
        await rowDecision(page, 'agency', req.requestNumber!, 'approve', {});
      }
    });

    await test.step('the system owner grants the final approval on all four', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      for (const [i, req] of REQUESTS.entries()) {
        await rowDecision(page, 'owner', req.requestNumber!, 'approve',
          { captureName: i === REQUESTS.length - 1 ? 'rtl-owner-final-approval' : `rtl-owner-approve-${req.code}` });
      }
    });

    await test.step('the submitter sees all four fully approved', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      for (const req of REQUESTS) {
        await expect(submitterRow(page, req.systemName)).toContainText(/approved/i);
      }
    });
  });
});
