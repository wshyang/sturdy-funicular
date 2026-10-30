// Pending-action chips on REAL dashboard rows (addendum-196 — feature-
// coverage audit gap #1 closed). PendingActionChips.test.tsx already pins
// rendering; these suites pin the full wire: GET /requests/my-requests
// serializes per-row pendingActions (annotateViewerPendingActions →
// deriveViewerPendingActions), and the row chip's label is the SERVER's cue
// verbatim, never client phrasing (assessment §13.4). The backend twin
// (pending_chips_contract.test.tsx) pins the same fields at the API layer;
// this file owns the browser surface:
//
//   test 1 — the current-step reviewer's row carries the review chip
//     (label + golden pulse converge on the same row), the chip CLICK-THROUGH
//     opens the request (chips route to the anchored detail view — the same
//     "dashboard, not Search, drives the action" rule as addendum-178), the
//     approval empties the decider's queue, and the next step's team
//     inherits ITS chip… while the submitter sees the row with NO chip
//     (visibility is not actionability).
//   test 2 — a return decision lands a different cue on the REQUESTER's row
//     ("Revise and resubmit"), and the returned request vanishes from the
//     returner's own queue.
//
// Two tests per file: the screenshot-count self-check gates the run delta
// at a positive EVEN number; paired captures keep each spec even.
import { test, expect } from '../helpers/harness';
import type { Locator, Page } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, modalByTestId, pickDateTime, createAssetViaAdminUI, clickWithCapture,
  submitWithCapture, fillCredentialItemCombobox, submitRequestIdentityWithCapture,
  pendingDashboardAction, assertRequestVisible, assertRequestNotVisible,
} from '../helpers/ui';
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
    hostname: `chip-${tag}.prod.internal`,
    credentialName: `chip-${tag}-token`,
    credentialType: 'token',
    navigateFirst: true,
  });

  await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select')
    .selectOption({ label: `${systemName} (${shortCode})` });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(`SR-CHIP-${tag.toUpperCase()}`);
  await page.getByTestId('vendor-dashboard__justification-textarea')
    .fill('Chips e2e: emergency access to prove derivation cues ride the wire.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
  await fillCredentialItemCombobox(
    page.getByTestId('vendor-dashboard__credential-item'),
    `chip-${tag}.prod.internal`,
    `chip-${tag}-token`,
  );
  const submitted = await submitRequestIdentityWithCapture(
    page,
    `chips-${tag}-submit-request`,
    page.getByTestId('vendor-dashboard__submit-request-button'),
  );
  return { scenario, requestNumber: submitted.requestNumber };
}

function rowFor(page: Page, requestNumber: string): Locator {
  return page.locator('tr', { hasText: requestNumber });
}

test.describe('pending-action chips on dashboard rows (addendum-196)', () => {
  test('review chip: server cue on the right row, click-through to the request, step handoff empties and re-labels', async ({ page }) => {
    const { scenario, requestNumber } = await provisionAndSubmit(page, 'chipa', 'CHIPSA', 'Chips E2E System A');

    await test.step('vendor L2 sees the chip with the derivation label and the golden pulse on the SAME row', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      const row = rowFor(page, requestNumber);
      await expect(row).toBeVisible();
      const chip = row.getByTestId('request-row__action-chip-pre_approval-review_step');
      await expect(chip).toHaveText('Approval · Review step 1');
      await expect(chip).toHaveAttribute('aria-label', 'Review step 1');
      // The golden pulse and the chip are two renderings of ONE derivation —
      // both must ride the same row (addendum-096 + §13.4).
      await expect(row.locator('span.golden-pulse')).toBeVisible();
      await expect(row.getByTestId('request-row__action-count')).toHaveCount(0);

      // The chip is a button: clicking it IS the dashboard-first navigation
      // to the request (addendum-178 — never Search).
      await clickWithCapture(page, 'chips-chip-click-through', chip);
      await expect(page.getByTestId('request-detail-view__back-button')).toBeVisible();
      await page.getByTestId('request-detail-view__back-button').click();
    });

    await test.step('approving empties the decider queue and hands agency L1 its own chip', async () => {
      const approve = await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__approve-button');
      await clickWithCapture(page, 'chips-open-approve-modal', approve);
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await submitWithCapture(page, 'chips-vendor-l2-approve', modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
      await expect(rowFor(page, requestNumber)).toHaveCount(0);

      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await expect(rowFor(page, requestNumber).getByTestId('request-row__action-chip-pre_approval-review_step'))
        .toHaveText('Approval · Review step 2');
    });

    await test.step('the submitter sees their request but owes nothing — no chip on their row', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await assertRequestVisible(page, requestNumber);
      const row = rowFor(page, requestNumber);
      await expect(row).toBeVisible();
      await expect(row.getByTestId('request-row__action-chip-pre_approval-review_step')).toHaveCount(0);
      await expect(row.getByTestId('request-row__action-chip-pre_approval-returned_edit')).toHaveCount(0);
    });
  });

  test('return decision lands "Revise and resubmit" on the requester row only', async ({ page }) => {
    const { scenario, requestNumber } = await provisionAndSubmit(page, 'chipb', 'CHIPSB', 'Chips E2E System B');

    await test.step('vendor L2 returns the request with notes', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      const returnAction = await pendingDashboardAction(page, requestNumber, 'vendor-dashboard__return-button');
      await clickWithCapture(page, 'chips-open-return-modal', returnAction);
      const modal = modalByTestId(page, 'vendor-dashboard__action-modal');
      await modal.getByTestId('vendor-dashboard__notes-textarea').fill('Justification does not name the on-call rotation.');
      await submitWithCapture(page, 'chips-vendor-l2-return', modal.getByTestId('vendor-dashboard__confirm-button'));
      await expect(modal).not.toBeVisible();
      // The returner decided their step — the row leaves THEIR queue.
      await expect(rowFor(page, requestNumber)).toHaveCount(0);
    });

    await test.step('the requester row carries the returned_edit cue — nobody else does', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      const row = rowFor(page, requestNumber);
      await expect(row).toBeVisible();
      const chip = row.getByTestId('request-row__action-chip-pre_approval-returned_edit');
      await expect(chip).toHaveText('Approval · Revise and resubmit');
      await expect(chip).toHaveAttribute('aria-label', 'Revise and resubmit');
      await expect(row.getByTestId('request-row__action-chip-pre_approval-review_step')).toHaveCount(0);

      // The deciding team's other member owes nothing either — for them the
      // row is gone entirely (step-scoped visibility while returned).
      await login(page, scenario.vendorL2B.email, scenario.vendorL2B.password);
      await assertRequestNotVisible(page, 'Chips E2E System B');
      await expect(rowFor(page, requestNumber)).toHaveCount(0);
    });
  });
});
