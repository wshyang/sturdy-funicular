// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md), §E owner & delegate surfaces — browser-real pins for the
// client gates jsdom (OwnerDashboard / OwnerViews / MyTeamsViews
// .coverage.test.tsx) simulates and the deep-flow specs deliberately do not
// repeat:
//   * owner Reject: the inline notes-required refusal (no write), and cancel
//     leaving the terminal row actionable;
//   * My Systems delegate form: confirm disabled until a person is picked,
//     and BOTH time-window refusals (empty bounds, inverted bounds) landing
//     before the Add posts — owner-delegation.spec owns the plain add/remove;
//   * Delegated Approvals: reject needing notes inline, then a real
//     delegate approve-with-note closing the request (draining the queue);
//   * My Teams roster modal: Add disabled until a prospect is picked, the
//     non-global team_admin self-lock on their own row, and a promote/demote
//     round trip — dashboard-tabs-rendering.spec only asserts the tab mounts;
//   * Statistics: the To-after-From range refusal before any fetch renders —
//     owner-statistics.spec owns the chart positives.
// The digest toggle is NOT re-covered: pending-actions-digest.spec owns its
// opt-in/persist arms, and the failure arm cannot be failed browser-real
// without route interception (no-interception discipline, addendum-144) —
// OwnerViews.coverage.test.tsx pins that arm in jsdom.
import { test, expect } from '../helpers/harness';
import type { Page } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, logout, pickDateTime, fillCredentialItemCombobox, createAssetViaAdminUI,
  submitRequestIdentityWithCapture, pendingDashboardAction, rowButton,
} from '../helpers/ui';
import {
  provisionActorsAndTeams, provisionSystem, type Actor, type ProvisionedScenario,
} from '../helpers/scenario';

const RUN = 'eso';
const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'ESOSYS';
const SYSTEM_NAME = 'Element Sweep Owner System';
const ASSET_HOSTNAME = 'eso-vault.prod.internal';
const ASSET_CREDENTIAL = 'tok-eso-001';

async function approveStep(page: Page, actor: Actor, dashboard: 'vendor' | 'agency') {
  await login(page, actor.email, actor.password);
  await rowButton(page, SYSTEM_NAME, `${dashboard}-dashboard__view-button`).click();
  await page.getByTestId('request-detail-view__step-approve-button').click();
  const dialog = page.getByTestId('request-detail-view__action-modal');
  await dialog.getByTestId('request-detail-view__confirm-button').click();
  await expect(dialog).toBeHidden();
  // Wait for any post-confirm re-fetch to settle before the next actor logs in.
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await logout(page);
}

test.describe('§E owner / delegate / team-admin element gates', () => {
  test('reject notes refusals, delegate window rules, roster self-lock, and the inverted-range statistics refusal', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await test.step('provision roster + system + asset, submit as vendor L1, approve to the owner terminal', async () => {
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
        .fill('Owner element gates: terminal decision + delegate panel coverage.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(
        page.getByTestId('vendor-dashboard__credential-item'), ASSET_HOSTNAME, ASSET_CREDENTIAL);
      const submitted = await submitRequestIdentityWithCapture(
        page, 'eso-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
      requestNumber = submitted.requestNumber;
      await logout(page);

      await approveStep(page, scenario.vendorL2A, 'vendor');
      await approveStep(page, scenario.agencyL1A, 'agency');
      await approveStep(page, scenario.agencyL2A, 'agency');
    });

    await test.step('owner queue: counters render; reject without notes is refused inline; cancel keeps the row actionable', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      // Owner has a single role so the role-select is absent (Dashboard.tsx:
      // roles.length > 1 guard). Navigate directly to the owner route instead.
      await page.goto('/dashboard/owner');
      await expect(page.getByTestId('owner-dashboard__stat-pending-review-count')).toBeVisible();
      await expect(page.getByTestId('owner-dashboard__stat-approved-count')).toBeVisible();
      await expect(page.getByTestId('owner-dashboard__stat-returned-count')).toBeVisible();
      // page.goto() triggers a full page reload. AuthContext re-fetches
      // /me/capability-snapshot asynchronously. caps.canApprove is false while
      // snapshot is null, so the kebab trigger only renders once BOTH fetches
      // have settled. Wait for the trigger on the specific row — this is
      // stronger than networkidle, which may fire before the snapshot settles.
      await expect(
        page.locator('tr', { hasText: requestNumber })
          .getByTestId('owner-dashboard__actions-menu-button'),
        'owner kebab trigger should appear once caps.canApprove is true',
      ).toBeVisible({ timeout: 20000 });

      const rejectItem = await pendingDashboardAction(page, requestNumber, 'owner-dashboard__reject-button');
      await rejectItem.click();
      const modal = page.getByTestId('owner-dashboard__action-modal');
      await expect(modal).toBeVisible();
      // Bare confirm on an empty-notes reject never reaches the wire.
      await modal.getByTestId('owner-dashboard__confirm-button').click();
      await expect(modal.getByText(/Notes required when rejecting/)).toBeVisible();
      await modal.getByTestId('owner-dashboard__cancel-button').click();
      await expect(modal).toBeHidden();
      // …and the undecided row is still actionable afterwards.
      await expect(
        await pendingDashboardAction(page, requestNumber, 'owner-dashboard__reject-button'),
      ).toBeVisible();
      // pendingDashboardAction leaves the Radix dropdown open; close it before
      // step 3 so its backdrop does not intercept the tab click.
      await page.keyboard.press('Escape');
    });

    await test.step('My Systems: delegate confirm gates plus both window refusals, then a real unbounded add', async () => {
      await page.getByTestId('owner-dashboard__tab-systems').click();
      const header = page.locator('div', { hasText: SYSTEM_NAME })
        .filter({ has: page.getByTestId('owner-systems-view__system-header') })
        .getByTestId('owner-systems-view__system-header')
        .first();
      await header.click();
      await page.getByTestId('owner-systems-view__add-delegate-button').click();
      const confirm = page.getByTestId('owner-systems-view__confirm-add-delegate-button');
      // Nobody picked — confirm stays unarmed.
      await expect(confirm).toBeDisabled();
      const select = page.getByTestId('owner-systems-view__delegate-select');
      const value = await select
        .locator('option', { hasText: scenario.agencyL1B.fullName })
        .getAttribute('value');
      await select.selectOption(value!);
      await expect(confirm).toBeEnabled();
      // Windowed with NO bounds → refused before the POST.
      await page.getByTestId('owner-systems-view__delegate-window-toggle').check();
      await confirm.click();
      await expect(page.getByText(/Pick both window bounds/)).toBeVisible();
      // Inverted bounds → refused before the POST.
      await pickDateTime(page, page.getByTestId('owner-systems-view__delegate-from-picker'), { hour: '23', minute: '59' });
      await pickDateTime(page, page.getByTestId('owner-systems-view__delegate-until-picker'), { hour: '00', minute: '00' });
      await confirm.click();
      await expect(page.getByText(/must be earlier than its Until date/)).toBeVisible();
      // Unbounded add posts for real — the delegate-panel step below needs it.
      await page.getByTestId('owner-systems-view__delegate-window-toggle').uncheck();
      await confirm.click();
      await expect(page.getByText('Delegate added successfully.')).toBeVisible({ timeout: 15000 });
      await logout(page);
    });

    await test.step('Delegated Approvals: reject needs notes inline; approve with a note really closes the request', async () => {
      await login(page, scenario.agencyL1B.email, scenario.agencyL1B.password);
      await page.getByTestId('dashboard__role-select').selectOption('delegate');
      await expect(page.getByRole('heading', { name: 'Delegated Approvals' })).toBeVisible();
      const rejectItem = await pendingDashboardAction(page, requestNumber, 'delegate-approval-panel__reject-button');
      await rejectItem.click();
      const modal = page.getByTestId('delegate-approval-panel__action-modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('delegate-approval-panel__confirm-button').click();
      await expect(modal.getByText(/Notes are required when rejecting/)).toBeVisible();
      await modal.getByTestId('delegate-approval-panel__cancel-button').click();
      await expect(modal).toBeHidden();

      const approveItem = await pendingDashboardAction(page, requestNumber, 'delegate-approval-panel__approve-button');
      await approveItem.click();
      await modal.getByTestId('delegate-approval-panel__notes-textarea')
        .fill('Delegate terminal approval — §E element-gate coverage.');
      await modal.getByTestId('delegate-approval-panel__confirm-button').click();
      await expect(modal).toBeHidden();
      // The decided request drains from the delegate queue.
      await expect(page.locator('tr', { hasText: requestNumber })).toHaveCount(0, { timeout: 15000 });
      await logout(page);
    });

    await test.step('My Teams: Add gates on a prospect, the self-lock hides own-row controls, promote/demote round-trips', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('dashboard__role-select').selectOption('team_admin');
      await expect(page).toHaveURL(/\/dashboard\/team-admin$/);
      await expect(page.getByRole('heading', { name: 'My Teams' })).toBeVisible();
      await page.getByTestId('my-teams__manage-members-button').first().click();
      const modal = page.getByTestId('team-members-modal');
      await expect(modal).toBeVisible();
      // Add stays disabled until a prospect is picked.
      await expect(modal.getByTestId('team-members-modal__add-button')).toBeDisabled();
      // Self-lock: a non-global team_admin's own row renders 'You' — no demote/remove.
      const selfRow = modal.locator('li', { hasText: 'vendor-l1-a' });
      await expect(selfRow).toContainText('You');
      await expect(selfRow.getByTestId('team-members-modal__demote-button')).toHaveCount(0);
      await expect(selfRow.getByTestId('team-members-modal__remove-button')).toHaveCount(0);
      // Promote/demote a teammate round-trips for real (restored afterwards).
      const mateRow = modal.locator('li', { hasText: 'vendor-l1-b' });
      await mateRow.getByTestId('team-members-modal__promote-button').click();
      await expect(mateRow.getByTestId('team-members-modal__demote-button')).toBeVisible({ timeout: 15000 });
      await mateRow.getByTestId('team-members-modal__demote-button').click();
      await expect(mateRow.getByTestId('team-members-modal__promote-button')).toBeVisible({ timeout: 15000 });
      // Both close affordances dismiss the modal (close-button covered by the
      // admin specs; the × twin is the untagged-appendix shape).
      await modal.getByTestId('team-members-modal__close-x-button').click();
      await expect(modal).toBeHidden();
      await logout(page);
    });

    await test.step('Statistics: an inverted range is refused before any fetch renders a chart', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await page.goto('/dashboard/owner');
      await page.getByTestId('owner-dashboard__tab-statistics').click();
      await expect(page.getByTestId('statistics-view__system-select')).toBeVisible();
      await pickDateTime(page, page.getByTestId('statistics-view__from-picker'), { hour: '23', minute: '59' });
      await pickDateTime(page, page.getByTestId('statistics-view__to-picker'), { hour: '00', minute: '00' });
      await page.getByTestId('statistics-view__apply-button').click();
      await expect(page.getByTestId('statistics-view__error-banner')).toContainText('To must be after From.');
      // Refused before the wire — no chart paints.
      await expect(page.getByTestId('statistics-view__pie-chart')).toHaveCount(0);
      await expect(page.getByTestId('statistics-view__bar-chart')).toHaveCount(0);
      await logout(page);
    });
  });
});
