// Addendum-144 frontend-first browser contract. These tests deliberately turn
// green only after the backend custody schema/routes land. Every mutation uses
// the real UI; no route interception, request API shortcut, or DB write.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, modalByTestId, pickDateTime, fillCredentialItemCombobox, rowButton, clickCustodyActionAndWait } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type Actor, type ProvisionedScenario } from '../helpers/scenario';
import type { Page } from '@playwright/test';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const HAPPY_SYSTEM = { shortCode: 'CUSTODY', name: 'Physical Custody System' };
const MISSING_SYSTEM = { shortCode: 'CUSTMISS', name: 'Missing Asset Custody System' };
let activeSystem = HAPPY_SYSTEM;
let scenario: ProvisionedScenario;

test.describe.configure({ mode: 'serial' });

async function createManualAsset(page: Page, hostname: string, credentialName: string, navigateFirst = false) {
  if (navigateFirst) {
    await page.getByTestId('admin-panel__tab-assets').click();
    await page.getByTestId('admin-assets__system-select').selectOption({ label: `${activeSystem.shortCode} — ${activeSystem.name}` });
  }
  await page.getByTestId('admin-assets__toggle-create-form-button').click();
  await page.getByTestId('admin-assets__create-hostname-input').fill(hostname);
  await page.getByTestId('admin-assets__create-credential-name-input').fill(credentialName);
  await page.getByTestId('admin-assets__create-credential-type-select').selectOption('device');
  await page.getByTestId('admin-assets__management-mode-select').selectOption('manual');
  await page.getByTestId('admin-assets__create-submit-button').click();
  await expect(page.getByTestId('admin-assets__hostname-input').last()).toHaveValue(hostname);
}

async function submitRequest(page: Page, actor: Actor, assets: Array<[string, string]>, sr: string) {
  await login(page, actor.email, actor.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${activeSystem.name} (${activeSystem.shortCode})` });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(sr);
  await page.getByTestId('vendor-dashboard__justification-textarea').fill('Physical custody workflow browser contract.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '00', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '23', minute: '59' });
  for (const [index, [hostname, credential]] of assets.entries()) {
    if (index > 0) await page.getByTestId('vendor-dashboard__add-credential-item-button').click();
    await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item').nth(index), hostname, credential);
  }
  await page.getByTestId('vendor-dashboard__submit-request-button').click();
  await expect(page.getByTestId('vendor-dashboard__submit-request-button')).not.toBeVisible({ timeout: 30_000 });
}

async function approveStep(page: Page, actor: Actor, dashboard: 'vendor' | 'agency') {
  await login(page, actor.email, actor.password);
  await rowButton(page, activeSystem.name, `${dashboard}-dashboard__view-button`).click();
  await page.getByTestId('request-detail-view__step-approve-button').click();
  const dialog = modalByTestId(page, 'request-detail-view__action-modal');
  await dialog.getByTestId('request-detail-view__confirm-button').click();
  // Server-reconciled wait: the confirm modal only closes after the
  // step-decision POST resolves. Without this, the next login's page.goto
  // can abort the in-flight POST and the approval silently never happens
  // (the request stays on the same step).
  await expect(dialog).not.toBeVisible();
}

async function approveToCustody(page: Page) {
  await approveStep(page, scenario.vendorL2A, 'vendor');
  await approveStep(page, scenario.agencyL1A, 'agency');
  await approveStep(page, scenario.agencyL2A, 'agency');
  await login(page, scenario.owner.email, scenario.owner.password);
  // Owner has a single role so the role-select is absent (Dashboard.tsx:
  // roles.length > 1 guard). Navigate directly to the owner route instead.
  await page.goto('/dashboard/owner');
  await rowButton(page, activeSystem.name, 'owner-dashboard__view-button').click();
  await page.getByTestId('request-detail-view__owner-approve-button').click();
  const ownerDialog = modalByTestId(page, 'request-detail-view__action-modal');
  await ownerDialog.getByTestId('request-detail-view__confirm-button').click();
  // Same server-reconciled wait as approveStep — the owner approval must
  // land before the next navigation, or the in-flight POST is aborted.
  await expect(ownerDialog).not.toBeVisible();
}

async function openLatestRequest(page: Page, actor: Actor, role: 'agency' | 'vendor') {
  await login(page, actor.email, actor.password);
  await rowButton(page, activeSystem.name, `${role}-dashboard__view-button`).first().click();
  await expect(page.getByTestId('request-custody__section')).toBeVisible();
}

function custodyRow(page: Page, assetName: string) {
  return page.getByTestId('request-custody__case-list').getByRole('article').filter({ hasText: assetName });
}

test.describe('physical asset custody', () => {
  test('fixed happy flow exposes relevant user actions and atomically combines same-team agency stages', async ({ page }) => {
    activeSystem = HAPPY_SYSTEM;
    scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'custody');
    await provisionSystem(page, scenario, activeSystem);
    await createManualAsset(page, 'custody-laptop', 'Emergency laptop', true);
    await createManualAsset(page, 'custody-token', 'Hardware token');
    await submitRequest(page, scenario.vendorL1A, [['custody-laptop', 'Emergency laptop'], ['custody-token', 'Hardware token']], 'SR-CUSTODY-HAPPY');
    await approveToCustody(page);

    await openLatestRequest(page, scenario.agencyL1A, 'agency');
    const cases = page.getByTestId('request-custody__case-list');
    await expect(cases.getByRole('article')).toHaveCount(2);
    await cases.getByRole('checkbox').first().check();
    await cases.getByRole('checkbox').nth(1).check();
    await page.getByTestId('request-custody__batch-prepare_and_handover').click();
    // Server-reconciled wait: the batch bar unmounts only after the POST
    // succeeds (selection clears on success, not on the optimistic
    // projection). Without this the next page navigation can abort the
    // in-flight POST and the asserted state is only client-side projection.
      await expect(page.getByTestId('request-custody__batch-bar')).toBeHidden();
    await expect(custodyRow(page, 'Emergency laptop')).toContainText(/handover pending/i);

    await openLatestRequest(page, scenario.vendorL1A, 'vendor');
    await clickCustodyActionAndWait(page, custodyRow(page, 'Emergency laptop').getByRole('button', { name: 'Confirm receipt' }));
    await clickCustodyActionAndWait(page, custodyRow(page, 'Hardware token').getByRole('button', { name: 'Confirm receipt' }));
    await clickCustodyActionAndWait(page, custodyRow(page, 'Emergency laptop').getByRole('button', { name: 'Initiate return' }));
    await clickCustodyActionAndWait(page, custodyRow(page, 'Hardware token').getByRole('button', { name: 'Initiate return' }));

    await openLatestRequest(page, scenario.agencyL1A, 'agency');
    await custodyRow(page, 'Emergency laptop').getByRole('checkbox').check();
    await custodyRow(page, 'Hardware token').getByRole('checkbox').check();
    await page.getByTestId('request-custody__batch-verify_and_restock').click();
    // Server-reconciled wait: the batch bar unmounts only after the POST
    // succeeds (selection clears on success, not on the optimistic
    // projection). Without this the next page navigation can abort the
    // in-flight POST and the asserted state is only client-side projection.
      await expect(page.getByTestId('request-custody__batch-bar')).toBeHidden();
    await expect(page.getByTestId('request-custody__summary')).toContainText('2 of 2 returned');
  });

  test('missing secure phone branches in place, uploads two attachments, and leaves unaffected assets actionable', async ({ page }) => {
    activeSystem = MISSING_SYSTEM;
    scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'custmiss');
    await provisionSystem(page, scenario, activeSystem);
    await createManualAsset(page, 'secure-phone', 'Secure phone', true);
    await createManualAsset(page, 'custody-spare-laptop', 'Spare laptop');
    await submitRequest(page, scenario.vendorL1B, [['secure-phone', 'Secure phone'], ['custody-spare-laptop', 'Spare laptop']], 'SR-CUSTODY-MISSING');
    await approveToCustody(page);

    await openLatestRequest(page, scenario.agencyL1A, 'agency');
    await custodyRow(page, 'Secure phone').getByRole('button', { name: 'Report a problem' }).click();
    const modal = modalByTestId(page, 'custody-problem-modal__dialog');
    await modal.getByTestId('custody-problem-modal__type-select').selectOption('missing');
    await modal.getByTestId('custody-problem-modal__check-expected').check();
    await modal.getByTestId('custody-problem-modal__description-input').fill('Secure phone was not present in Cabinet C2.');
    await modal.getByTestId('custody-problem-modal__attachments-input').setInputFiles([
      { name: 'cabinet.txt', mimeType: 'text/plain', buffer: Buffer.from('Cabinet C2 checked') },
      { name: 'inventory.txt', mimeType: 'text/plain', buffer: Buffer.from('Inventory register checked') },
    ]);
    await expect(modal.getByTestId('custody-problem-modal__attachment-list').getByRole('listitem')).toHaveCount(2);
    await modal.getByTestId('custody-problem-modal__review-button').click();
    await expect(modal.getByTestId('custody-problem-modal__consequences')).toContainText('Other assets remain unchanged');
    await modal.getByTestId('custody-problem-modal__confirm-button').click();
    await expect(modal).not.toBeVisible();

    await expect(custodyRow(page, 'Secure phone')).toContainText(/cannot locate/i);
    await expect(custodyRow(page, 'Spare laptop').getByRole('button', { name: 'Prepare & initiate handover' })).toBeVisible();
    await expect(page.getByTestId('request-custody__attention-warning')).toContainText('unaffected assets may continue');
    await expect(custodyRow(page, 'Secure phone')).toContainText('2 attachments');
  });
});
