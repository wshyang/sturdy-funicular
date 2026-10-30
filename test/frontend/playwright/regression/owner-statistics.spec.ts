// E2E screenshot coverage for the System Owner "Statistics" tab
// (StatisticsView.tsx — GET /owner/statistics — server/routes-owner.tsx).
//
// Per addendum-020-owner-statistics-tab.md point 11, this feature was
// deliberately shipped WITHOUT e2e coverage: it's a read-only analytics view
// with no lifecycle/workflow transitions, and the real risk surface
// (aggregation SQL, scoping, date-math) is already covered by
// server/tests/owner.test.tsx + StatisticsView.test.tsx. This spec does not
// change that reasoning — it adds no assertions on chart *correctness* (the
// pie/bar rendering itself isn't something Playwright can meaningfully
// verify beyond "an SVG with the right testid exists"). It exists purely to
// produce durable screenshot artifacts of the real chart rendering against
// the real app + real breakglass_test DB, per explicit request, so a human
// can visually confirm chart shape/rendering without hand-running a
// throwaway script each time. Uses the suite's standard submitWithCapture/
// clickWithCapture before/after full-page screenshots for every action,
// PLUS a dedicated close-up capture of just the chart container (via
// captureChart below) after each render, since the chart itself sits below
// the fold in a full-page screenshot at the suite's default viewport.
import { test, expect } from '../helpers/harness';
import type { Locator } from '@playwright/test';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, pickDateTime, submitWithCapture, clickWithCapture, createAssetViaAdminUI, fillCredentialItemCombobox } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_A = { shortCode: 'STA1', name: 'Statistics Test System A' };
const SYSTEM_B = { shortCode: 'STA2', name: 'Statistics Test System B' };

// submitWithCapture/clickWithCapture's before/after pair screenshots the
// FULL page — useful for context, but the chart itself sits below the fold
// at the suite's default viewport, so it's absent from those captures. This
// takes a dedicated close-up of just the chart container, which is the part
// of this feature the user actually wants to see.
async function captureChart(chartLocator: Locator, testSuiteId: string) {
  await chartLocator.scrollIntoViewIfNeeded();
  await chartLocator.screenshot({ path: `test_output/e2e/screenshots/[chart] ${testSuiteId}.png` });
}

async function submitBasicRequest(
  page: import('@playwright/test').Page,
  systemLabel: string,
  srNumber: string,
  hostname: string,
) {
  await page.getByTestId('vendor-dashboard__open-submit-button').click();
  await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: systemLabel });
  await page.getByTestId('vendor-dashboard__sr-number-input').fill(srNumber);
  await page.getByTestId('vendor-dashboard__justification-textarea')
    .fill('Statistics tab fixture data — emergency access for chart rendering coverage.');
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
  await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
  await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), hostname, `tok-${srNumber}`);

  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/requests') && res.request().method() === 'POST'),
    page.getByTestId('vendor-dashboard__submit-request-button').click(),
  ]);
  await page.waitForLoadState('networkidle');
  expect(response.status()).toBe(201);
}

test.describe('owner statistics tab', () => {
  test('pie/bar charts render for by-system and by-hostname breakdowns', async ({ page }) => {
    let scenario!: ProvisionedScenario;

    await test.step('provision actors/teams and two systems owned by the same owner', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'stat');
      await provisionSystem(page, scenario, SYSTEM_A);
      await provisionSystem(page, scenario, SYSTEM_B);
      // Per addendum-039-asset-gated-submission.md — curate the three
      // (hostname, credential_name) pairs the fixture requests below select.
      await createAssetViaAdminUI(page, { systemLabel: `${SYSTEM_A.shortCode} — ${SYSTEM_A.name}`, hostname: 'stat-host-alpha', credentialName: 'tok-SR-STAT0001', credentialType: 'token', navigateFirst: true });
      await createAssetViaAdminUI(page, { systemLabel: `${SYSTEM_A.shortCode} — ${SYSTEM_A.name}`, hostname: 'stat-host-beta', credentialName: 'tok-SR-STAT0002', credentialType: 'token' });
      await createAssetViaAdminUI(page, { systemLabel: `${SYSTEM_B.shortCode} — ${SYSTEM_B.name}`, hostname: 'stat-host-gamma', credentialName: 'tok-SR-STAT0003', credentialType: 'token', navigateFirst: true });
    });

    await test.step('vendor L1 submits fixture requests across both systems and two hostnames on system A', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await submitBasicRequest(page, `${SYSTEM_A.name} (${SYSTEM_A.shortCode})`, 'SR-STAT0001', 'stat-host-alpha');
      await submitBasicRequest(page, `${SYSTEM_A.name} (${SYSTEM_A.shortCode})`, 'SR-STAT0002', 'stat-host-beta');
      await submitBasicRequest(page, `${SYSTEM_B.name} (${SYSTEM_B.shortCode})`, 'SR-STAT0003', 'stat-host-gamma');
    });

    await test.step('owner applies filters: by-system pie chart', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await page.getByTestId('owner-dashboard__tab-statistics').click();
      await expect(page.getByTestId('statistics-view__apply-button')).toBeVisible();

      // Default "To" is frozen at mount time truncated to the minute
      // (defaultRange() formats with "yyyy-MM-dd'T'HH:mm", dropping
      // seconds) — by the time Apply is clicked, real "now" has moved past
      // that truncated instant, excluding the just-submitted fixture
      // requests from the half-open `created_at < to` interval. Widen "To"
      // to end-of-day so it safely brackets the fixture data regardless of
      // exact submission time.
      await pickDateTime(page, page.getByTestId('statistics-view__to-picker'), { hour: '23', minute: '59' });

      await submitWithCapture(page, 'owner-statistics-bysystem-pie', page.getByTestId('statistics-view__apply-button'));
      const pieChart = page.getByTestId('statistics-view__pie-chart');
      await expect(pieChart).toBeVisible();
      await expect(page.locator('.recharts-pie-sector path')).toHaveCount(2);
      await captureChart(pieChart, 'owner-statistics-bysystem-pie');
    });

    await test.step('toggle to bar chart: by-system bar chart', async () => {
      await clickWithCapture(
        page, 'owner-statistics-bysystem-bar',
        page.getByTestId('statistics-view__chart-type-bar'),
        { waitForLocator: page.getByTestId('statistics-view__bar-chart') },
      );
      const barChart = page.getByTestId('statistics-view__bar-chart');
      await expect(page.locator('.recharts-bar-rectangle')).toHaveCount(2);
      await captureChart(barChart, 'owner-statistics-bysystem-bar');
    });

    await test.step('scope to System A, switch back to pie: by-hostname pie chart', async () => {
      await page.getByTestId('statistics-view__chart-type-pie').click();
      await page.getByTestId('statistics-view__system-select').selectOption({ label: SYSTEM_A.name });

      await submitWithCapture(page, 'owner-statistics-byhostname-pie', page.getByTestId('statistics-view__apply-button'));
      const pieChart = page.getByTestId('statistics-view__pie-chart');
      await expect(pieChart).toBeVisible();
      await expect(page.locator('.recharts-pie-sector path')).toHaveCount(2);
      await captureChart(pieChart, 'owner-statistics-byhostname-pie');
    });

    await test.step('toggle to bar chart: by-hostname bar chart', async () => {
      await clickWithCapture(
        page, 'owner-statistics-byhostname-bar',
        page.getByTestId('statistics-view__chart-type-bar'),
        { waitForLocator: page.getByTestId('statistics-view__bar-chart') },
      );
      const barChart = page.getByTestId('statistics-view__bar-chart');
      await expect(page.locator('.recharts-bar-rectangle')).toHaveCount(2);
      await captureChart(barChart, 'owner-statistics-byhostname-bar');
    });
  });
});
