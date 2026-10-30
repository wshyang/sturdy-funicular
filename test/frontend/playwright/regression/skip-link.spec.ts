// Skip-to-content regression coverage (addendum-196 — feature-coverage
// audit gap #3 closed). The link (addendum-193 F-18, WCAG 2.4.1) was
// previously exercised only by the demo video recording; trimming a demo
// would have silently dropped the only executable check. This suite owns
// the keyboard journey in the regression gate, on two different dashboard
// roles. The static markup contract (href, sr-only pattern, focusable
// target) is jsdom-pinned in Dashboard.skipLink.test.tsx.
//
// Two tests per file: the screenshot-count self-check gates the run delta
// at a positive EVEN number; paired captures keep each spec even.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, pickDateTime, createAssetViaAdminUI, captureBefore, captureAfter,
  fillCredentialItemCombobox, submitRequestIdentityWithCapture,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

async function exerciseSkipLink(page: Parameters<typeof login>[0], captureId: string) {
  // Reset focus to the document start, then a single Tab must reveal and
  // focus the skip link; activating it moves focus straight into the main
  // content region — no keyboard user tabs through the whole header chrome.
  await page.evaluate(() => { (document.activeElement as HTMLElement | null)?.blur(); });
  await page.keyboard.press('Tab');
  const skipLink = page.getByTestId('dashboard__skip-to-content');
  await expect(skipLink).toBeFocused();
  await captureBefore(page, captureId);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await captureAfter(page, captureId);
}

test.describe('skip-to-content link (addendum-193 F-18; addendum-196 coverage)', () => {
  test('global admin dashboard: first Tab focuses the skip link, Enter lands in the main region', async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await exerciseSkipLink(page, 'skip-link-admin-dashboard');
  });

  test('vendor reviewer dashboard with a populated queue: same keyboard journey', async ({ page }) => {
    const scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'skip');
    await provisionSystem(page, scenario, { shortCode: 'SKIPSYS', name: 'Skip-Link System' });
    await createAssetViaAdminUI(page, {
      systemLabel: 'SKIPSYS — Skip-Link System',
      hostname: 'skip.prod.internal',
      credentialName: 'skip-token',
      credentialType: 'token',
      navigateFirst: true,
    });

    // A real pending row ensures the skip target is the region keyboard users
    // actually need — the queue — not an empty shell.
    await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
    await page.getByTestId('vendor-dashboard__open-submit-button').click();
    await page.getByTestId('vendor-dashboard__system-select')
      .selectOption({ label: 'Skip-Link System (SKIPSYS)' });
    await page.getByTestId('vendor-dashboard__sr-number-input').fill('SR-SKIP-001');
    await page.getByTestId('vendor-dashboard__justification-textarea')
      .fill('Skip-link e2e: gives the reviewer queue real content to land on.');
    await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '09', minute: '00' });
    await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '17', minute: '00' });
    await fillCredentialItemCombobox(
      page.getByTestId('vendor-dashboard__credential-item'),
      'skip.prod.internal',
      'skip-token',
    );
    await submitRequestIdentityWithCapture(
      page,
      'skip-link-submit-request',
      page.getByTestId('vendor-dashboard__submit-request-button'),
    );

    await login(page, scenario.vendorL2A.email, scenario.vendorL2A.password);
    await exerciseSkipLink(page, 'skip-link-vendor-dashboard');
  });
});
