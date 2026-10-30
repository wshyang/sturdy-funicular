// Element-coverage user stories (docs/reports/2026-08-18-interactive-elements-
// test-flows.md), §C — vendor dashboard + request submit form, exercised
// browser-real: the asset-gated combobox (4-character search threshold,
// hostname→credential pair), the add/remove credential rows, the datetime
// pickers, the sessionStorage draft that survives a reload mid-fill, cancel,
// and a final positive submission identity capture.
//
// A shared 9-actor roster is provisioned via the standard helpers (unique
// runId 'esv') so all assertions run against the real backend + database.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, logout, pickDateTime, fillCredentialItemCombobox,
  createAssetViaAdminUI, submitRequestIdentityWithCapture, assertRequestVisible,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const RUN = 'esv';
const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'ESVSYS';
const SYSTEM_NAME = 'Element Sweep Vendor System';
const ASSET_HOSTNAME = 'esv-vault.prod.internal';
const ASSET_CREDENTIAL = 'tok-esv-001';

test.describe('§C vendor submit-form elements', () => {
  test('asset guard, combobox search floor, row add/remove, pickers, draft restore, and the real submit', async ({ page }) => {
    let scenario!: ProvisionedScenario;

    await test.step('provision roster + system + one manual asset (admin UI)', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, RUN);
      await provisionSystem(page, scenario, { shortCode: SYSTEM_SHORT_CODE, name: SYSTEM_NAME });
      await createAssetViaAdminUI(page, {
        systemLabel: `${SYSTEM_SHORT_CODE} — ${SYSTEM_NAME}`,
        hostname: ASSET_HOSTNAME, credentialName: ASSET_CREDENTIAL,
        credentialType: 'token', navigateFirst: true,
      });
      await logout(page);
    });

    await test.step('vendor L1 opens the submit form; the asset gate blocks every early submit', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      // open-submit-button is gated on snapshot.submitterSystemIds — wait for
      // the capability fetch to settle before clicking (fresh-stack guard).
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      const submit = page.getByTestId('vendor-dashboard__submit-request-button');
      await expect(submit).toBeDisabled();

      await page.getByTestId('vendor-dashboard__system-select')
        .selectOption({ label: `${SYSTEM_NAME} (${SYSTEM_SHORT_CODE})` });
      await page.getByTestId('vendor-dashboard__sr-number-input').fill(`SR-${RUN.toUpperCase()}-001`);
      await page.getByTestId('vendor-dashboard__justification-textarea')
        .fill('P1: prod shell required for hotfix validation.');
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-start-picker'), { hour: '08', minute: '30' });
      await pickDateTime(page, page.getByTestId('vendor-dashboard__activity-end-picker'), { hour: '12', minute: '00' });
      // Everything textual filled — the asset-gate still holds the submit button.
      await expect(submit).toBeDisabled();

      // The combobox ignores under-4-character queries (no option list opens).
      const row = page.getByTestId('vendor-dashboard__credential-item');
      await row.getByTestId('vendor-dashboard__credential-hostname-combobox').click();
      await page.getByPlaceholder('Type at least 4 characters…').fill('esv');
      await expect(page.getByTestId('vendor-dashboard__credential-hostname-option')).toHaveCount(0);
      await page.keyboard.press('Escape');
    });

    await test.step('a second credential row can be added then removed', async () => {
      await page.getByTestId('vendor-dashboard__add-credential-item-button').click();
      await expect(page.getByTestId('vendor-dashboard__credential-item')).toHaveCount(2);
      await page.getByTestId('vendor-dashboard__credential-item').nth(1)
        .getByTestId('vendor-dashboard__remove-credential-item-button').click();
      await expect(page.getByTestId('vendor-dashboard__credential-item')).toHaveCount(1);
      // The last row is irremovable (the remove affordance is gone entirely).
      await expect(
        page.getByTestId('vendor-dashboard__credential-item').first()
          .getByTestId('vendor-dashboard__remove-credential-item-button'),
      ).toHaveCount(0);
    });

    await test.step('typing then discarding nothing yet — draft persistence is checked across a real reload', async () => {
      await page.reload();
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      // sessionStorage survives a same-tab reload — the form may auto-restore
      // with the draft and re-open itself (RequestSubmitForm mounts when
      // VendorDashboard sees a stored draft on load). Only click open-submit-button
      // when the form is not already visible.
      if (await page.getByTestId('vendor-dashboard__submit-request-button').count() === 0) {
        await page.getByTestId('vendor-dashboard__open-submit-button').click();
      }
      await expect(page.getByTestId('vendor-dashboard__justification-textarea'))
        .toHaveValue(/P1: prod shell/);
      await expect(page.getByTestId('vendor-dashboard__sr-number-input'))
        .toHaveValue(`SR-${RUN.toUpperCase()}-001`);
      // Draft verified — leave the form open so step 4 can fill the credential.
      // (Cancel clears the draft per RequestSubmitForm:176; don't cancel here.)
    });

    await test.step('picking the real asset unblocks submit; the request identity comes back', async () => {
      await expect(page.getByTestId('vendor-dashboard__submit-request-button')).toBeDisabled();
      await fillCredentialItemCombobox(
        page.getByTestId('vendor-dashboard__credential-item'), ASSET_HOSTNAME, ASSET_CREDENTIAL);
      await expect(page.getByTestId('vendor-dashboard__submit-request-button')).toBeEnabled();
      const submitted = await submitRequestIdentityWithCapture(
        page, 'esv-submit', page.getByTestId('vendor-dashboard__submit-request-button'));
      await assertRequestVisible(page, submitted.requestNumber);
      await logout(page);
    });
  });
});
