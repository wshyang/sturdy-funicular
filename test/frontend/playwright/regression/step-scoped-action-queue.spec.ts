// Regression spec for addendum-096-step-scoped-queue-actionability.md.
//
// THE BUG (reported against the demo-live seed, setup/sql/003_seed_demo_live.sql):
// an agency engineer who ALSO held an admin grant saw every in-flight request
// in their dashboard glow amber with Edit/Approve/Reject/Return affordances,
// and the role droplist badge counted all of them ("Agency Engineer (9)"),
// when only the requests parked at THEIR OWN current step were genuinely
// pending them. Root cause: filterVisibleRequests (server/auth.tsx)
// deliberately short-circuits its step-scoped surfacing rule for admins
// (VISIBLE_ALL), and every downstream surface — dashboard action buttons,
// statusBadge.ts's glow, and the /me/role-summary engineer count — trusted
// "row is in my list" == "row is at my current step". The my-requests list
// response carried no per-row actionability signal (the detail view already
// computed viewerIsCurrentStepReviewer; the list never did).
//
// REPRO PATH this spec encodes: grant full_admin to real agency reviewers,
// stage three requests one step apart (vendor L2's step / agency L1's step /
// agency L2's step — the live-demo seed's Batch A/B/C pattern), then assert
// that for the admin+reviewer only their own-step row glows and is actionable
// while the other rows stay visible-but-INERT, and the droplist badge counts
// only own-step pending work.
//
// Why the admin grant matters: without it the non-admin queue is already
// step-scoped (visibility-and-override.spec.ts locks that in) — the bug
// needed the admin VISIBLE_ALL short-circuit to surface, which is exactly
// the combination no existing spec covered.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, rowButton, modalByTestId, pickDateTime, submitRequestIdentityWithCapture,
  createAssetViaAdminUI, fillCredentialItemCombobox, pendingDashboardAction,
  confirmDecisionAndWait,} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';
import type { Page } from '@playwright/test';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

// Grants full_admin to an agency user via the real Admin Users UI (row ⋮ ->
// Edit Roles -> check full_admin -> Save). Edit Roles is only offered for
// agency-affiliated users (AdminUsersRowActionsMenu.tsx), which is why this
// spec covers the agency side of the matrix.
async function grantFullAdminViaUI(page: Page, email: string) {
  await page.getByTestId('admin-panel__tab-users').click();
  // AdminUsers defaults to 'pending' view (0 pending users) — switch to all.
  await page.getByTestId('admin-users__view-all-tab').click();
  const row = page.locator('tr', { hasText: email });
  await row.getByTestId('admin-users__row-menu-button').click();
  await expect(page.getByTestId('admin-users__row-menu')).toBeVisible();
  await page.getByTestId('admin-users__edit-roles-button').click();
  const modal = modalByTestId(page, 'admin-users__edit-roles-modal');
  await modal.getByTestId('admin-users__edit-role-full_admin').check();
  await modal.getByTestId('admin-users__edit-roles-save').click();
  await expect(modal).not.toBeVisible();
}

async function submitRequestAsVendorL1(page: Page, scenario: ProvisionedScenario, systemName: string, systemShortCode: string, srNumber: string, testSuiteId: string): Promise<string> {
  await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select')
    .selectOption({ label: `${systemName} (${systemShortCode})` });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(srNumber);
  await page.getByTestId('vendor-dashboard__justification-textarea')
    .fill('Production incident requiring emergency database access.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
  await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), 'host-01', 'svc_test');
  return (await submitRequestIdentityWithCapture(page, testSuiteId, page.getByTestId('vendor-dashboard__submit-request-button'))).requestNumber;
}

// Staging itself proves the current actor's queue contract.
async function approveCurrentStepFromDashboard(
  page: Page,
  actor: { email: string; password: string },
  requestNumber: string,
  role: 'vendor' | 'agency',
) {
  await login(page, actor.email, actor.password);
  const approve = await pendingDashboardAction(page, requestNumber, `${role}-dashboard__approve-button`);
  await approve.click();
  const modal = modalByTestId(page, `${role}-dashboard__action-modal`);
  await confirmDecisionAndWait(page, await modal.getByTestId(`${role}-dashboard__confirm-button`));
  await expect(modal).not.toBeVisible();
}

interface StepWorld {
  scenario: ProvisionedScenario;
  below: string;  // system whose request is parked at the vendor L2 step (below any agency reviewer)
  ownL1: string;  // system whose request is parked at the agency L1 step
  ownL2: string;  // system whose request is parked at the agency L2 step
  requestNumber: { below: string; ownL1: string; ownL2: string };
}

// Builds the Batch-A/B/C world: one request per system, staged so `below`
// sits at vendor L2 (status submitted, ordinal 2), `ownL1` at agency L1,
// `ownL2` at agency L2. Grants full_admin to agencyL1A and agencyL2A so the
// assertions exercise the admin+reviewer combination that triggered the bug.
async function buildStepWorld(page: Page, runId: string, shortCodes: [string, string, string], names: [string, string, string], srs: [string, string, string]): Promise<StepWorld> {
  const scenario = await provisionActorsAndTeams(page, SUPERADMIN, runId);
  for (let i = 0; i < 3; i++) {
    await provisionSystem(page, scenario, { shortCode: shortCodes[i] ?? '', name: names[i] ?? '' });
    // Per addendum-039-asset-gated-submission.md — submission requires a real
    // active asset, curated via the admin UI while superadmin is logged in.
    await createAssetViaAdminUI(page, { systemLabel: `${shortCodes[i]} — ${names[i]}`, hostname: 'host-01', credentialName: 'svc_test', navigateFirst: true });
  }
  await grantFullAdminViaUI(page, scenario.agencyL1A.email);
  await grantFullAdminViaUI(page, scenario.agencyL2A.email);

  const [below, ownL1, ownL2] = names;
  const [srBelow, srOwnL1, srOwnL2] = srs;
  const numberBelow = await submitRequestAsVendorL1(page, scenario, below, shortCodes[0], srBelow, `${runId}-submit-below`);
  const numberOwnL1 = await submitRequestAsVendorL1(page, scenario, ownL1, shortCodes[1], srOwnL1, `${runId}-submit-ownl1`);
  const numberOwnL2 = await submitRequestAsVendorL1(page, scenario, ownL2, shortCodes[2], srOwnL2, `${runId}-submit-ownl2`);

  // Stage positions. Every transition starts from a request already visible
  // and actionable in the assigned actor's dashboard.
  await approveCurrentStepFromDashboard(page, scenario.vendorL2A, numberOwnL1, 'vendor');
  await approveCurrentStepFromDashboard(page, scenario.vendorL2A, numberOwnL2, 'vendor');
  await approveCurrentStepFromDashboard(page, scenario.agencyL1B, numberOwnL2, 'agency');

  return { scenario, below, ownL1, ownL2, requestNumber: { below: numberBelow, ownL1: numberOwnL1, ownL2: numberOwnL2 } };
}

// Asserts one dashboard row's complete actionability profile. Every row must
// be VISIBLE (visible-but-inert is the design — visibility is not
// actionability); `actionable` rows glow and expose all step actions, inert
// rows expose only View.
async function expectRow(page: Page, systemName: string, actionable: boolean) {
  const row = page.locator('tr', { hasText: systemName });
  await expect(row).toBeVisible();
  await expect(rowButton(page, systemName, 'agency-dashboard__view-button')).toBeVisible();
  // Addendum-192/-196: step actions live behind the row kebab (Radix
  // dropdown, portaled out of the <tr>). Actionable ⇒ trigger present and
  // its menu exposes the full step-action set; inert ⇒ only View, no
  // trigger at all.
  const menuTrigger = row.getByTestId('agency-dashboard__actions-menu-button');
  if (actionable) {
    await expect(row.locator('span.golden-pulse')).toHaveCount(1);
    await expect(menuTrigger).toBeVisible();
    await menuTrigger.click();
    const menu = page.getByTestId('agency-dashboard__actions-menu');
    await expect(menu.getByTestId('agency-dashboard__edit-button')).toBeVisible();
    await expect(menu.getByTestId('agency-dashboard__approve-button')).toBeVisible();
    await expect(menu.getByTestId('agency-dashboard__reject-button')).toBeVisible();
    await expect(menu.getByTestId('agency-dashboard__return-button')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).not.toBeVisible();
  } else {
    await expect(row.locator('span.golden-pulse')).toHaveCount(0);
    await expect(menuTrigger).toHaveCount(0);
  }
}

test.describe('step-scoped action queue for admin+reviewer users (addendum-096)', () => {
  test('agency L1 with an admin grant: only the own-step row glows and is actionable; below/above rows are inert', async ({ page }) => {
    const world = await buildStepWorld(
      page, 'sqa',
      ['SQ11', 'SQ12', 'SQ13'],
      ['Step Queue Alpha 1', 'Step Queue Alpha 2', 'Step Queue Alpha 3'],
      ['SR-SQA001', 'SR-SQA002', 'SR-SQA003'],
    );

    await test.step('agency L1 A logs in and opens the Agency Engineer role view', async () => {
      await login(page, world.scenario.agencyL1A.email, world.scenario.agencyL1A.password);
      const roleSelect = page.getByTestId('dashboard__role-select');
      // The badge counts ONLY requests pending this viewer now — exactly one
      // (Step Queue Alpha 2). Pre-fix this read "Agency Engineer (3)".
      await expect(roleSelect.locator('option', { hasText: 'Agency Engineer (1)' })).toBeAttached();
      await expect(roleSelect.locator('option', { hasText: /Agency Engineer \([02-9]\)/ })).toHaveCount(0);
      // The admin role stays available too (the grant is real) — the bug was
      // never about hiding roles, only about the engineer count/queue.
      await expect(roleSelect.locator('option', { hasText: 'Administrator' })).toBeAttached();
      await roleSelect.selectOption('engineer');
      await expect(page.getByText('Agency Engineer Dashboard')).toBeVisible();
    });

    await test.step('own-step row (agency L1 step) glows and is actionable', async () => {
      await expectRow(page, world.requestNumber.ownL1, true);
    });

    await test.step('below-level row (vendor L2 step) is visible but inert', async () => {
      await expectRow(page, world.requestNumber.below, false);
    });

    await test.step('above-level row (agency L2 step) is visible but inert', async () => {
      await expectRow(page, world.requestNumber.ownL2, false);
    });

    await test.step('Search pills follow the same step-scoped glow rule', async () => {
      await page.getByTestId('dashboard__search-button').click();
      await page.getByTestId('search-overlay__query-input').fill('SR-SQA00');
      const results = page.getByTestId('search-overlay__result-button');
      await expect(results).toHaveCount(3);
      await expect(results.filter({ hasText: world.ownL1 }).locator('span.golden-pulse')).toHaveCount(1);
      await expect(results.filter({ hasText: world.below }).locator('span.golden-pulse')).toHaveCount(0);
      await expect(results.filter({ hasText: world.ownL2 }).locator('span.golden-pulse')).toHaveCount(0);
      await page.getByTestId('search-overlay__close-button').click();
    });
  });

  test('agency L2 with an admin grant: symmetric coverage from the above side — only the own-step row glows', async ({ page }) => {
    const world = await buildStepWorld(
      page, 'sqb',
      ['SQ21', 'SQ22', 'SQ23'],
      ['Step Queue Bravo 1', 'Step Queue Bravo 2', 'Step Queue Bravo 3'],
      ['SR-SQB001', 'SR-SQB002', 'SR-SQB003'],
    );

    await test.step('agency L2 A logs in and opens the Agency Engineer role view', async () => {
      await login(page, world.scenario.agencyL2A.email, world.scenario.agencyL2A.password);
      const roleSelect = page.getByTestId('dashboard__role-select');
      await expect(roleSelect.locator('option', { hasText: 'Agency Engineer (1)' })).toBeAttached();
      await expect(roleSelect.locator('option', { hasText: /Agency Engineer \([02-9]\)/ })).toHaveCount(0);
      await roleSelect.selectOption('engineer');
      await expect(page.getByText('Agency Engineer Dashboard')).toBeVisible();
    });

    await test.step('own-step row (agency L2 step) glows and is actionable', async () => {
      await expectRow(page, world.requestNumber.ownL2, true);
    });

    await test.step('both below-level rows (vendor L2 step, agency L1 step) are visible but inert', async () => {
      await expectRow(page, world.requestNumber.below, false);
      await expectRow(page, world.requestNumber.ownL1, false);
    });
  });
});
