// E2E coverage for addendum-028-visibility-fix-and-emergency-override.md:
// (1) a past-step reviewer retains the ability to search for/view a
// request even after their own step has been decided — the exact bug the
// user reported (approve as vendor L2, then lose Search access entirely).
// (2) a downstream reviewer (own step ordinal later than the request's
// current stuck step) can search out, view, and — after an explicit
// Override click — decide the currently-stuck step on behalf of the
// actually-assigned team, distinctly audited/flagged.
//
// Both proven via Search (never the dashboard — confirmed with the user
// that a request outside a team's current step never surfaces in their
// dashboard list, override-eligible or not, per addendum-028).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, modalByTestId, pickDateTime, submitRequestIdentityWithCapture,
  submitWithCapture, clickWithCapture, assertRequestNotVisible, createAssetViaAdminUI, fillCredentialItemCombobox,
  pendingDashboardAction, openPendingDashboardRequest,
  confirmDecisionAndWait,} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'VOV1';
const SYSTEM_NAME = 'Visibility Override Test System';
const SR_NUMBER = 'SR-VOV001';

test.describe('search visibility fix + emergency override', () => {
  test('past-step reviewer retains search access; downstream reviewer overrides a stuck step', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await test.step('provision actors, teams, and the system (3-step workflow: vendor L2 -> agency L1 -> agency L2)', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'vov');
      await provisionSystem(page, scenario, { shortCode: SYSTEM_SHORT_CODE, name: SYSTEM_NAME });
      // Per addendum-039-asset-gated-submission.md.
      await createAssetViaAdminUI(page, { systemLabel: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}`, hostname: 'host-01', credentialName: 'svc_test', navigateFirst: true });
    });

    await test.step('vendor L1 A submits a request', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: `${SYSTEM_NAME} (${SYSTEM_SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill(SR_NUMBER);
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill('Production incident requiring emergency database access.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-01', 'svc_test');
      const submitted = await submitRequestIdentityWithCapture(page, 'vov-submit-request', page.getByTestId('vendor-dashboard__submit-request-button'));
      requestNumber = submitted.requestNumber;
    });

    async function openViaSearch(actorEmail: string, actorPassword: string) {
      await login(page, actorEmail, actorPassword);
      await page.getByTestId('dashboard__search-button').click();
      await page.getByTestId('search-overlay__query-input').fill(SR_NUMBER);
      await page.getByTestId('search-overlay__result-button').filter({ hasText: SYSTEM_NAME }).first().click();
    }

    await test.step('vendor L2 A sees step 1 pending in their dashboard and approves', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button')).click();
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await confirmDecisionAndWait(page, await modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    // ── Part 1: the reported bug — vendor L2's own step has passed (request
    // now at agency L1, step 2), but they can still find/view it via Search,
    // and it correctly does NOT appear in their own dashboard list. ────────
    await test.step('vendor L2 A retains search access after their own step passed, but the request is absent from their dashboard', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await assertRequestNotVisible(page, SYSTEM_NAME);

      await clickWithCapture(page, 'vov-vendor-l2-past-step-search', page.getByTestId('dashboard__search-button'));
      await page.getByTestId('search-overlay__query-input').fill(SR_NUMBER);
      const result = page.getByTestId('search-overlay__result-button').filter({ hasText: SYSTEM_NAME }).first();
      await expect(result).toBeVisible();
      await result.click();
      await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible();
      // No Override button — vendor L2's own step is BEHIND the current
      // step (agency L1), not eligible to override something downstream.
      await expect(page.getByTestId('request-detail-view__override-button')).not.toBeVisible();
      // No step-decision actions either — this step already passed them.
      await expect(page.getByTestId('request-detail-view__step-approve-button')).not.toBeVisible();
    });

    // ── Part 2: emergency override — agency L2 (step 3, downstream of the
    // currently-stuck agency L1 step 2) searches out the request, sees the
    // Override affordance (not the real action buttons), activates it, and
    // decides the step on agency L1's behalf. ──────────────────────────────
    await test.step('agency L2 A searches out the request stuck at agency L1, confirms no dashboard surfacing, and sees the Override affordance', async () => {
      await login(page, scenario.agencyL2A.email, scenario.agencyL2A.password);
      // Confirmed with the user: override-eligible or not, this request
      // never appears in agency L2's own dashboard — it's not their step yet.
      await assertRequestNotVisible(page, SYSTEM_NAME);

      await openViaSearch(scenario.agencyL2A.email, scenario.agencyL2A.password);
      await expect(page.getByTestId('request-detail-view__override-button')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__step-approve-button')).not.toBeVisible();
    });

    await test.step('agency L2 A activates the override and approves agency L1\'s stuck step', async () => {
      await clickWithCapture(page, 'vov-activate-override', page.getByTestId('request-detail-view__override-button'));
      await expect(page.getByText('Override active')).toBeVisible();

      await clickWithCapture(page, 'vov-override-open-approve-modal', page.getByTestId('request-detail-view__step-approve-button'));
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__notes-textarea').fill('Agency L1 uncontactable during declared incident; escalating per emergency override procedure.');
      await submitWithCapture(page, 'vov-override-approve', modal.getByTestId('request-detail-view__confirm-button'));
      await expect(modal).not.toBeVisible();
    });

    await test.step('the overridden step shows the "via override" label and the request advanced to agency L2\'s own step', async () => {
      // Request has now advanced to ordinal 3 (agency L2's own step) — a
      // genuine step-approve for agency L2 is now visible AND actionable
      // (they're the real assigned team here, no override needed).
      await page.getByTestId('request-detail-view__back-button').click();
      // Dashboard.tsx re-opens the search overlay when back is clicked from a
      // detail view that was reached via search (fromSearch flag). Wait for it
      // to appear (React async) then dismiss via Escape before proceeding.
      try {
        await page.getByTestId('search-overlay').waitFor({ state: 'visible', timeout: 2000 });
        await page.keyboard.press('Escape');
        await page.getByTestId('search-overlay').waitFor({ state: 'hidden', timeout: 5000 });
      } catch { /* overlay didn't appear; proceed */ }
      await openPendingDashboardRequest(page, requestNumber, 'agency-dashboard__view-button');
      await expect(page.getByTestId('request-detail-view__step-override-label')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__step-approve-button')).toBeVisible();
      await expect(page.getByTestId('request-detail-view__override-button')).not.toBeVisible();
    });

    await test.step('agency L2 A approves their own (real) step, then owner approves', async () => {
      await page.getByTestId('request-detail-view__step-approve-button').click();
      const modal = modalByTestId(page, 'request-detail-view__action-modal');
      await modal.getByTestId('request-detail-view__confirm-button').click();
      await expect(modal).not.toBeVisible();

      await login(page, scenario.owner.email, scenario.owner.password);
      await (await pendingDashboardAction(page, requestNumber, 'owner-dashboard__approve-button')).click();
      const ownerModal = modalByTestId(page, 'owner-dashboard__action-modal');
      await ownerModal.getByTestId('owner-dashboard__confirm-button').click();
      await expect(ownerModal).not.toBeVisible();
    });
  });
});
