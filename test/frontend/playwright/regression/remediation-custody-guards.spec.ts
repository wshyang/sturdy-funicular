// Conversation-remediation exercise: custody role/state/selection guards and
// attachment rejection. New suite; existing custody regression is unchanged.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  fillCredentialItemCombobox,
  login,
  modalByTestId,
  pickDateTime,
  rowButton,
  clickCustodyActionAndWait,
} from '../helpers/ui';
import {
  provisionActorsAndTeams,
  provisionSystem,
  type Actor,
  type ProvisionedScenario,
} from '../helpers/scenario';
import type { Page } from '@playwright/test';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM = { shortCode: 'CUSTGUARD', name: 'Custody Guard Exercise' };
let scenario: ProvisionedScenario;

test.describe.configure({ mode: 'serial' });

async function createAsset(page: Page, hostname: string, name: string, first = false) {
  if (first) {
    await page.getByTestId('admin-panel__tab-assets').click();
    await page.getByTestId('admin-assets__system-select').selectOption({
      label: `${SYSTEM.shortCode} — ${SYSTEM.name}`,
    });
  }
  await page.getByTestId('admin-assets__toggle-create-form-button').click();
  await page.getByTestId('admin-assets__create-hostname-input').fill(hostname);
  await page.getByTestId('admin-assets__create-credential-name-input').fill(name);
  await page.getByTestId('admin-assets__create-credential-type-select').selectOption('device');
  await page.getByTestId('admin-assets__management-mode-select').selectOption('manual');
  await page.getByTestId('admin-assets__create-submit-button').click();
  // Server-reconciled wait: the create form closes only after the asset POST
  // resolves. Without this, the next call's toggle click can hit the still-open
  // form (closing it instead of opening it) and the fill below times out.
  await expect(page.getByTestId('admin-assets__create-submit-button')).not.toBeVisible();
}

async function submitRequest(page: Page, actor: Actor) {
  await login(page, actor.email, actor.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select').selectOption({
    label: `${SYSTEM.name} (${SYSTEM.shortCode})`,
  });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-CUSTODY-GUARDS');
  await page.getByTestId('vendor-dashboard__justification-textarea').fill(
    'Exercise custody role and item-level isolation guards.',
  );
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), {
    hour: '00', minute: '00',
  });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), {
    hour: '23', minute: '59',
  });
  await fillCredentialItemCombobox(
    page.getByTestId('vendor-dashboard__credential-item').first(),
    'guard-laptop-a',
    'Guard laptop A',
  );
  await page.getByTestId('vendor-dashboard__add-credential-item-button').click();
  await fillCredentialItemCombobox(
    page.getByTestId('vendor-dashboard__credential-item').nth(1),
    'guard-laptop-b',
    'Guard laptop B',
  );
  await page.getByTestId('vendor-dashboard__submit-request-button').click();
  await expect(page.getByTestId('vendor-dashboard__submit-request-button')).not.toBeVisible();
}

async function approveStep(page: Page, actor: Actor, dashboard: 'vendor' | 'agency') {
  await login(page, actor.email, actor.password);
  await rowButton(page, SYSTEM.name, `${dashboard}-dashboard__view-button`).click();
  await page.getByTestId('request-detail-view__step-approve-button').click();
  const dialog = modalByTestId(page, 'request-detail-view__action-modal');
  await dialog.getByTestId('request-detail-view__confirm-button').click();
  // Server-reconciled wait: the confirm modal only closes after the
  // decision POST resolves. Without this, the next navigation can abort the
  // in-flight POST and the decision silently never lands.
  await expect(dialog).not.toBeVisible();
}

async function approveToCustody(page: Page) {
  await approveStep(page, scenario.vendorL2A, 'vendor');
  await approveStep(page, scenario.agencyL1A, 'agency');
  await approveStep(page, scenario.agencyL2A, 'agency');
  await login(page, scenario.owner.email, scenario.owner.password);
  await page.goto('/dashboard/owner');
  await rowButton(page, SYSTEM.name, 'owner-dashboard__view-button').click();
  await page.getByTestId('request-detail-view__owner-approve-button').click();
  const ownerDialog = modalByTestId(page, 'request-detail-view__action-modal');
  await ownerDialog.getByTestId('request-detail-view__confirm-button').click();
  // Server-reconciled wait: the confirm modal only closes after the
  // decision POST resolves. Without this, the next navigation can abort the
  // in-flight POST and the decision silently never lands.
  await expect(ownerDialog).not.toBeVisible();
}

async function openRequest(page: Page, actor: Actor, dashboard: 'vendor' | 'agency') {
  await login(page, actor.email, actor.password);
  await rowButton(page, SYSTEM.name, `${dashboard}-dashboard__view-button`).first().click();
  await expect(page.getByTestId('request-custody__section')).toBeVisible();
}

function custodyRow(page: Page, name: string) {
  return page.getByTestId('request-custody__case-list')
    .getByRole('article').filter({ hasText: name });
}

test.describe('remediation exercise — custody guards', () => {
  test('only the agency can prepare, and a selected item advances without mutating its sibling', async ({ page }) => {
    scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'custguard');
    await provisionSystem(page, scenario, SYSTEM);
    await createAsset(page, 'guard-laptop-a', 'Guard laptop A', true);
    await createAsset(page, 'guard-laptop-b', 'Guard laptop B');
    await submitRequest(page, scenario.vendorL1A);
    await approveToCustody(page);

    await openRequest(page, scenario.vendorL1A, 'vendor');
    await expect(custodyRow(page, 'Guard laptop A').getByRole('button', {
      name: 'Prepare & initiate handover',
    })).toHaveCount(0);

    await openRequest(page, scenario.agencyL1A, 'agency');
    await custodyRow(page, 'Guard laptop A').getByRole('checkbox').check();
    await page.getByTestId('request-custody__batch-prepare_and_handover').click();
    // Server-reconciled wait: the batch bar unmounts only after the POST
    // succeeds (selection clears on success, not on the optimistic
    // projection). Without this the next page navigation can abort the
    // in-flight POST and the asserted state is only client-side projection.
      await expect(page.getByTestId('request-custody__batch-bar')).toBeHidden();
    await expect(custodyRow(page, 'Guard laptop A')).toContainText(/handover pending/i);
    await expect(custodyRow(page, 'Guard laptop B')).toContainText(/awaiting preparation/i);
    await expect(custodyRow(page, 'Guard laptop B')).not.toContainText(/handover pending/i);

    await openRequest(page, scenario.vendorL1A, 'vendor');
    await clickCustodyActionAndWait(page, custodyRow(page, 'Guard laptop A').getByRole('button', {
      name: 'Confirm receipt',
    }));
    await expect(custodyRow(page, 'Guard laptop A')).toContainText(/requester custody/i);
    await expect(custodyRow(page, 'Guard laptop B')).toContainText(/awaiting preparation/i);
  });

  test('oversized evidence is rejected and does not put the asset into exception state', async ({ page }) => {
    await openRequest(page, scenario.agencyL1A, 'agency');
    const row = custodyRow(page, 'Guard laptop B');
    await row.getByRole('button', { name: 'Report a problem' }).click();
    const modal = modalByTestId(page, 'custody-problem-modal__dialog');
    await modal.getByTestId('custody-problem-modal__type-select').selectOption('damaged');
    await modal.getByTestId('custody-problem-modal__description-input').fill(
      'Attempting an invalid oversized evidence upload.',
    );
    await modal.getByTestId('custody-problem-modal__attachments-input').setInputFiles({
      name: 'too-large.txt',
      mimeType: 'text/plain',
      buffer: Buffer.alloc(10 * 1024 * 1024 + 1, 65),
    });
    await expect(modal.getByTestId('custody-problem-modal__error')).toContainText(
      /no larger than 10 MB/i,
    );
    await modal.getByTestId('custody-problem-modal__cancel-button').click();
    await expect(modal).not.toBeVisible();
    await expect(row).toContainText(/awaiting preparation/i);
    await expect(row).not.toContainText(/exception open|damaged/i);
  });
});
