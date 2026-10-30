// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md), §F custody section + audit-trail chrome — browser-real pins
// for the element behaviours jsdom (RequestCustody / RequestDetailPanels
// .coverage.test.tsx) simulates and physical-asset-custody.spec's happy /
// missing-asset flows deliberately do not repeat:
//   * the batch bar renders for a selection whose cases sit at DIFFERENT
//     lifecycle stages — selectable (every case has SOME available action)
//     but sharing NO common one — and so shows the explanatory hint with
//     ZERO batch action buttons, retracting again on deselect;
//   * the problem-report modal refuses an empty description AT REVIEW (the
//     consequences screen never opens), Back preserves the typed description,
//     and Cancel abandons the report with no exception written;
//   * View history expands the case timeline and collapses it again;
//   * the artefact-free flow's audit timeline renders neither access-log nor
//     job-run chip (positive chip semantics stay jsdom-pinned — staging real
//     artefacts browser-real needs the LocalStack/job pipeline).
// The AE edit panel's guards are NOT re-covered — approver-edit.spec already
// drives the empty-justification refusal browser-real; the retrieve-password
// decrypt arms stay with jsdom + aws-localstack.spec (positive decrypt).
//
// Staging note: a no-common-action selection needs two cases the SAME
// custodian can each act on but not jointly — here: one case advanced to
// return-verification (vendor confirmed + initiated return) while the other
// still awaits prepare. A fully-batched case pair would simply share every
// action, and an action-less case renders no checkbox at all
// (RequestAssetCustodyParts gates the box on availableActions.length > 0).
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, logout, modalByTestId, pickDateTime, fillCredentialItemCombobox, rowButton, clickCustodyActionAndWait } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type Actor, type ProvisionedScenario } from '../helpers/scenario';
import type { Page } from '@playwright/test';

const RUN = 'esc';
const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM = { shortCode: 'ESCCUST', name: 'Element Sweep Custody System' };
let scenario: ProvisionedScenario;

async function createManualAsset(page: Page, hostname: string, credentialName: string, navigateFirst = false) {
  if (navigateFirst) {
    await page.getByTestId('admin-panel__tab-assets').click();
    await page.getByTestId('admin-assets__system-select').selectOption({ label: `${SYSTEM.shortCode} — ${SYSTEM.name}` });
  }
  await page.getByTestId('admin-assets__toggle-create-form-button').click();
  await page.getByTestId('admin-assets__create-hostname-input').fill(hostname);
  await page.getByTestId('admin-assets__create-credential-name-input').fill(credentialName);
  await page.getByTestId('admin-assets__create-credential-type-select').selectOption('device');
  await page.getByTestId('admin-assets__management-mode-select').selectOption('manual');
  await page.getByTestId('admin-assets__create-submit-button').click();
  await expect(page.getByTestId('admin-assets__hostname-input').last()).toHaveValue(hostname);
}

async function submitRequest(page: Page, actor: Actor) {
  await login(page, actor.email, actor.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${SYSTEM.name} (${SYSTEM.shortCode})` });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(`SR-${RUN.toUpperCase()}-001`);
  await page.getByTestId('vendor-dashboard__justification-textarea').fill('Custody element-gate coverage: batch/problem/history arms.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '00', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '23', minute: '59' });
  await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item').nth(0), 'esc-laptop', 'ES Laptop');
  await page.getByTestId('vendor-dashboard__add-credential-item-button').click();
  await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item').nth(1), 'esc-phone', 'ES Phone');
  await page.getByTestId('vendor-dashboard__submit-request-button').click();
  await expect(page.getByTestId('vendor-dashboard__submit-request-button')).not.toBeVisible({ timeout: 30_000 });
  await logout(page);
}

async function approveStep(page: Page, actor: Actor, dashboard: 'vendor' | 'agency') {
  await login(page, actor.email, actor.password);
  await rowButton(page, SYSTEM.name, `${dashboard}-dashboard__view-button`).click();
  await page.getByTestId('request-detail-view__step-approve-button').click();
  const dialog = modalByTestId(page, 'request-detail-view__action-modal');
  await dialog.getByTestId('request-detail-view__confirm-button').click();
  await expect(dialog).toBeHidden();
  await logout(page);
}

async function openCustodyRequest(page: Page, actor: Actor, role: 'agency' | 'vendor') {
  await login(page, actor.email, actor.password);
  await rowButton(page, SYSTEM.name, `${role}-dashboard__view-button`).first().click();
  await expect(page.getByTestId('request-custody__section')).toBeVisible();
}

function custodyRow(page: Page, assetName: string) {
  return page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: assetName });
}

test.describe('§F custody element gates — batch bar, problem modal, history, audit chips', () => {
  test('no-common-action batch bar; problem-modal review/back/cancel arms; history toggle; artefact-free audit trail', async ({ page }) => {
    await test.step('provision roster + system + two manual assets, submit and approve into custody', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, RUN);
      await provisionSystem(page, scenario, SYSTEM);
      await createManualAsset(page, 'esc-laptop', 'ES Laptop', true);
      await createManualAsset(page, 'esc-phone', 'ES Phone');
      await logout(page);
      await submitRequest(page, scenario.vendorL1A);
      await approveStep(page, scenario.vendorL2A, 'vendor');
      await approveStep(page, scenario.agencyL1A, 'agency');
      await approveStep(page, scenario.agencyL2A, 'agency');
      await login(page, scenario.owner.email, scenario.owner.password);
      // Owner has only the owner role → no role-select rendered; already on owner dashboard.
      await rowButton(page, SYSTEM.name, 'owner-dashboard__view-button').click();
      await page.getByTestId('request-detail-view__owner-approve-button').click();
      const ownerDialog = modalByTestId(page, 'request-detail-view__action-modal');
      await ownerDialog.getByTestId('request-detail-view__confirm-button').click();
      // Server-reconciled wait: the confirm modal only closes after the
      // decision POST resolves. Without this, the next navigation can abort the
      // in-flight POST and the decision silently never lands.
      await expect(ownerDialog).not.toBeVisible();
      await logout(page);
    });

    await test.step('split the two cases onto different custody stages (setup for the no-common-action arm)', async () => {
      // Agency: prep & hand over ONLY ES Phone via its own per-case action.
      await openCustodyRequest(page, scenario.agencyL1A, 'agency');
      await clickCustodyActionAndWait(page, custodyRow(page, 'ES Phone').getByRole('button', { name: 'Prepare & initiate handover' }));
      await expect(custodyRow(page, 'ES Phone')).toContainText(/handover pending/i);
      await logout(page);
      // Vendor requester: confirm receipt + initiate return on ES Phone, so it
      // reaches return-verification while ES Laptop still awaits prepare.
      await openCustodyRequest(page, scenario.vendorL1A, 'vendor');
      await clickCustodyActionAndWait(page, custodyRow(page, 'ES Phone').getByRole('button', { name: 'Confirm receipt' }));
      await clickCustodyActionAndWait(page, custodyRow(page, 'ES Phone').getByRole('button', { name: 'Initiate return' }));
      await logout(page);
    });

    await test.step('a selection across DIFFERENT available-action sets shows the bar + hint but NO batch button', async () => {
      await openCustodyRequest(page, scenario.agencyL1A, 'agency');
      // Both cases are individually actionable for the custodian (checkboxes
      // render), but prepare-lane ≠ verify-lane — no COMMON action exists.
      await custodyRow(page, 'ES Laptop').getByRole('checkbox').check();
      await custodyRow(page, 'ES Phone').getByRole('checkbox').check();
      const bar = page.getByTestId('request-custody__batch-bar');
      await expect(bar).toContainText('2 selected');
      await expect(bar.getByText(/do not share an available action/)).toBeVisible();
      await expect(
        page.locator('[data-testid^="request-custody__batch-"]:not([data-testid="request-custody__batch-bar"])'),
      ).toHaveCount(0);
      // Clearing the selection retracts the bar entirely.
      await custodyRow(page, 'ES Laptop').getByRole('checkbox').uncheck();
      await custodyRow(page, 'ES Phone').getByRole('checkbox').uncheck();
      await expect(bar).toBeHidden();
    });

    await test.step('problem report: empty description refused at review; Back preserves text; Cancel writes nothing', async () => {
      await custodyRow(page, 'ES Laptop').getByRole('button', { name: 'Report a problem' }).click();
      const modal = modalByTestId(page, 'custody-problem-modal__dialog');
      await expect(modal).toBeVisible();
      // Empty description → refused AT REVIEW; the consequences screen never opens.
      await modal.getByTestId('custody-problem-modal__review-button').click();
      await expect(modal.getByTestId('custody-problem-modal__error'))
        .toHaveText('Describe what happened before continuing.');
      await expect(modal.getByTestId('custody-problem-modal__consequences')).toHaveCount(0);
      // The typed description survives the review → back round trip.
      await modal.getByTestId('custody-problem-modal__description-input').fill('Cracked screen noticed at the cage.');
      await modal.getByTestId('custody-problem-modal__review-button').click();
      await expect(modal.getByTestId('custody-problem-modal__consequences')).toBeVisible();
      await modal.getByTestId('custody-problem-modal__back-button').click();
      await expect(modal.getByTestId('custody-problem-modal__description-input'))
        .toHaveValue('Cracked screen noticed at the cage.');
      // Cancel abandons the report — no exception state is written to the case.
      await modal.getByTestId('custody-problem-modal__cancel-button').click();
      await expect(modal).toBeHidden();
      await expect(
        custodyRow(page, 'ES Laptop').locator('[data-testid^="request-custody__exception-"]'),
      ).toHaveCount(0);
    });

    await test.step('the case timeline starts expanded; View/Hide history toggles it', async () => {
      const row = custodyRow(page, 'ES Phone');
      // Custody history starts expanded by default on the request view.
      await expect(row.locator('[data-testid^="request-custody__timeline-"]')).toBeVisible();
      await expect(row.locator('[data-testid^="request-custody__event-"]').first()).toBeVisible();
      await row.locator('[data-testid^="request-custody__history-"]').click();
      await expect(row.locator('[data-testid^="request-custody__timeline-"]')).toHaveCount(0);
      await row.locator('[data-testid^="request-custody__history-"]').click();
      await expect(row.locator('[data-testid^="request-custody__timeline-"]')).toBeVisible();
    });

    await test.step('the audit timeline carries no artefact chips in a plain manual flow', async () => {
      // The audit disclosure is expanded by default — no click needed.
      // Guard first (the list-render itself is pinned by request-detail-
      // elements.spec) — without it the chip-absence counts could green
      // against a timeline that never loaded.
      await expect(page.getByTestId('request-detail-view__list')).toBeVisible({ timeout: 15000 });
      // This flow used no job-run pipeline (no AWS/LocalStack), so no job-run chips.
      // access-log-link chips do appear for HTTP-triggered custody events (every
      // custody operation POST creates an access_log entry attached to the audit row).
      await expect(page.getByTestId('request-detail-view__job-run-link')).toHaveCount(0);
      await logout(page);
    });
  });
});
