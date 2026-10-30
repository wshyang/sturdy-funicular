// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md), §F request detail chrome, exercised browser-real: back
// navigation, the credentials/audit disclosures, the next-action card, the
// no-override gate for a plain step reviewer, and the error-state fallback
// for a nonsense request id.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, logout, pickDateTime, fillCredentialItemCombobox, createAssetViaAdminUI,
  submitRequestIdentityWithCapture, openPendingDashboardRequest,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const RUN = 'esd';
const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'ESDSYS';
const SYSTEM_NAME = 'Element Sweep Detail System';
const ASSET_HOSTNAME = 'esd-vault.prod.internal';
const ASSET_CREDENTIAL = 'tok-esd-001';

test.describe('§F request-detail-view elements', () => {
  test('disclosures, next-action card, override gating, back navigation, and the error-state fallback', async ({ page }) => {
    let scenario!: ProvisionedScenario;
    let requestNumber = '';

    await test.step('provision roster + system + asset, submit as vendor L1', async () => {
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
        .fill('Detail-view sweep request.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
      await fillCredentialItemCombobox(
        page.getByTestId('vendor-dashboard__credential-item'), ASSET_HOSTNAME, ASSET_CREDENTIAL);
      const submitted = await submitRequestIdentityWithCapture(
        page, 'esd-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
      requestNumber = submitted.requestNumber;
      await logout(page);
    });

    await test.step('the actionable vendor-L2 reviewer sees the full chrome', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await openPendingDashboardRequest(page, requestNumber, 'vendor-dashboard__view-button');
      await expect(page.getByTestId('request-detail-view__next-action-card')).toBeVisible();

      // Both disclosures are OPEN by default (RequestDetailParts/RequestDetailView
      // render <details open>; pinned by RequestDetailView.coverage.test.tsx and
      // the demo suites) — the summaries toggle each one closed/back open.
      const credDisclosure = page.getByTestId('request-detail-view__credentials-disclosure');
      await expect(credDisclosure).toHaveAttribute('open', '');
      await expect(page.getByTestId('request-detail-view__credential-table')).toBeVisible();
      await credDisclosure.locator('summary').click();
      await expect(page.getByTestId('request-detail-view__credential-table')).toBeHidden();
      await credDisclosure.locator('summary').click();
      await expect(page.getByTestId('request-detail-view__credential-table')).toBeVisible();

      // Audit disclosure opens the timeline container (open by default).
      await expect(page.getByTestId('request-detail-view__audit-disclosure')).toHaveAttribute('open', '');
      await expect(page.getByTestId('request-detail-view__list')).toBeVisible();

      // A plain step reviewer never sees the override affordances.
      await expect(page.getByTestId('request-detail-view__override-button')).toHaveCount(0);
      await expect(page.getByTestId('request-detail-view__step-override-label')).toHaveCount(0);
      // The danger zone (addendum-192 F-13) now holds Reject for any step reviewer,
      // so it will be present. Admin-reset is what a plain step reviewer must NOT see.
      await expect(page.getByTestId('request-detail-view__admin-reset-button')).toHaveCount(0);

      // Back returns to the queue.
      await page.getByTestId('request-detail-view__back-button').click();
      await expect(page.locator('tr', { hasText: requestNumber })).toBeVisible();
      await logout(page);
    });

    await test.step('a nonsense direct request id renders the error state with its own back affordance', async () => {
      await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
      await page.goto('/dashboard/request/req-does-not-exist');
      await expect(page.getByTestId('request-detail-view__error-back-button')).toBeVisible({ timeout: 15000 });
      await page.getByTestId('request-detail-view__error-back-button').click();
      await expect(page.getByTestId('request-detail-view__error-back-button')).toHaveCount(0);
    });
  });
});
