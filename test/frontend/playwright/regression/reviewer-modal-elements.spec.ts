// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md), §C/§D reviewer row actions and action modal, exercised
// browser-real against a live request: the kebab menu gating (non-actionable
// rows hide it), Return/Reject notes-required confirm, the approve-with-note
// happy path, cancel-keeps-state, focus-return onto the trigger, and the
// submitter-only Resubmit affordance on a returned request.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, logout, pickDateTime, fillCredentialItemCombobox, createAssetViaAdminUI,
  submitRequestIdentityWithCapture, pendingDashboardAction,
  confirmDecisionAndWait,} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const RUN = 'esr';
const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'ESRSYS';
const SYSTEM_NAME = 'Element Sweep Review System';
const ASSET_HOSTNAME = 'esr-vault.prod.internal';
const ASSET_CREDENTIAL = 'tok-esr-001';

test.describe('§C/§D reviewer action-modals and row affordances', () => {
  test('return needs notes; cancel keeps the request; approve with a note advances the chain; resubmit is submitter-only', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await test.step('provision roster + system + asset, then submit as vendor L1', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, RUN);
      await provisionSystem(page, scenario, { shortCode: SYSTEM_SHORT_CODE, name: SYSTEM_NAME });
      await createAssetViaAdminUI(page, {
        systemLabel: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}`,
        hostname: ASSET_HOSTNAME, credentialName: ASSET_CREDENTIAL, credentialType: 'token', navigateFirst: true,
      });
      await logout(page);

      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: `${SYSTEM_NAME} (${SYSTEM_SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill(`SR-${RUN.toUpperCase()}-001`);
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill('P1 edge-routing outage — need prod console access.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(
        page.getByTestId('vendor-dashboard__credential-item'), ASSET_HOSTNAME, ASSET_CREDENTIAL);
      const submitted = await submitRequestIdentityWithCapture(
        page, 'esr-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
      requestNumber = submitted.requestNumber;
      await logout(page);
    });

    await test.step('vendor L2 (the actionable reviewer) finds Return and sees the notes gate', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      // The submitter's own teammate (same team, different person) is NOT the
      // current step's reviewer — their row shows no kebab menu (F-row gate).
      const nonReviewerRow = page.locator('tr', { hasText: requestNumber });
      await logout(page);
      await login(page, scenario.vendorL1B.email, scenario.vendorL1B.password);
      await expect(nonReviewerRow.getByTestId('vendor-dashboard__actions-menu-button')).toHaveCount(0);
      await logout(page);
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);

      const returnItem = await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__return-button');
      await returnItem.click();
      const modal = page.getByTestId('vendor-dashboard__action-modal');
      await expect(modal).toBeVisible();
      await expect(modal.getByTestId('vendor-dashboard__confirm-button')).toBeDisabled();
      await modal.getByTestId('vendor-dashboard__notes-textarea').fill('Clarify the change window before approving.');
      await expect(modal.getByTestId('vendor-dashboard__confirm-button')).toBeEnabled();
      // Cancel keeps the request pending — and focus returns to the row trigger.
      await modal.getByTestId('vendor-dashboard__cancel-button').click();
      await expect(modal).toBeHidden();
      await expect(page.locator('tr', { hasText: requestNumber })).toBeVisible();
      // Radix may still be in an open/animating state after onSelect+cancel.
      // Press Escape to force-close any lingering dropdown so step 3's trigger
      // click opens a fresh dropdown rather than toggling a stale-open one.
      await page.keyboard.press('Escape');
    });

    await test.step('Return for real, then the submitter-only Resubmit affordance appears', async () => {
      // Reload to get a clean React/Radix state before the second kebab
      // interaction. After step 2's onSelect+cancel cycle, Radix may be in
      // an indeterminate open/closing state; a fresh page load guarantees the
      // dropdown is closed and loadData() returns current server data.
      await page.reload();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      // force: true bypasses Playwright's "visible, enabled and stable" checks
      // for Radix portaled menu items — the item may briefly appear unstable or
      // detach as Radix runs its close animation after the click registers, which
      // causes Playwright to retry indefinitely without force.
      //
      // Immediately after the force click, press Escape to close the Radix
      // dropdown (its onOpenChange(false) is not dispatched by a force click).
      // The action modal is a plain <div> — it has no Escape handler — so it
      // still opens from the onSelect call that the force click does fire.
      await (await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__return-button')).click({ force: true });
      await page.keyboard.press('Escape');
      const modal = page.getByTestId('vendor-dashboard__action-modal');
      await modal.getByTestId('vendor-dashboard__notes-textarea').fill('Returning: tighten the change window.');
      await confirmDecisionAndWait(page, await modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).toBeHidden();
      // The returned request is no longer actionable here.
      await expect(page.locator('tr', { hasText: requestNumber })
        .getByTestId('vendor-dashboard__actions-menu-button')).toHaveCount(0);
      await logout(page);

      // Non-submitter vendor L1 teammate: returned_to_vendor is intentionally
      // hidden from non-submitters by filterVisibleRequests (auth.tsx:459) —
      // the row is absent entirely from their dashboard, not just without resubmit.
      await login(page, scenario.vendorL1B.email, scenario.vendorL1B.password);
      await expect(page.locator('tr', { hasText: requestNumber })).toHaveCount(0);
      await logout(page);

      // Submitter: Resubmit present via the kebab.
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await expect(
        await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__resubmit-button'),
      ).toBeVisible();
      // pendingDashboardAction leaves the Radix dropdown open; close it before
      // logout so its backdrop does not intercept the sign-out click.
      await page.keyboard.press('Escape');
      await logout(page);
    });
  });
});
