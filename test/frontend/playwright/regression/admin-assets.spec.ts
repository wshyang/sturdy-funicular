// Browser-driven coverage for the Admin Assets inventory + the shared
// AssetCredentialItemRow request-form selection (addendum-037/039/095), all
// driven through the real UI. Covers the four priority admin-asset user
// stories:
//   1. creating an asset credential pair and asserting the immutable fields
//      are disabled after creation,
//   2. rejecting a duplicate hostname+credential_name+service identity,
//   3. the vendor request form only offering valid ACTIVE assets (with the
//      credential-name selector disabled until a hostname is chosen, the
//      "No matching hostnames found." empty state, and visible reflection of
//      both selections),
//   4. the invalidate / restore lifecycle (including both branches of the
//      native confirmation dialog, and verifying an invalidated hostname
//      disappears from the request form and reappears after restore).
//
// Every interaction goes through real browser locators — no API/DB shortcuts.
// Each test provisions its own actor roster + system (distinct runId /
// shortCode / name) so tests are independent within the shared e2e database.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import {
  login, createAssetViaAdminUI, fillCredentialItemCombobox,
} from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

// Logs in as the superadmin, opens the Assets tab, and selects the scenario
// system (waiting for the async assets GET like createAssetViaAdminUI).
async function openAssetsForSystem(page: any, systemLabel: string) {
  await login(page, SUPERADMIN.email, SUPERADMIN.password);
  await page.getByTestId('admin-panel__tab-assets').click();
  await Promise.all([
    page.waitForResponse((res: any) => /\/admin\/systems\/.+\/assets$/.test(res.url()) && res.request().method() === 'GET'),
    page.getByTestId('admin-assets__system-select').selectOption({ label: systemLabel }),
  ]);
}

// Provisions a fresh roster + system and returns the scenario plus label.
async function provision(page: any, runId: string, shortCode: string, name: string): Promise<ProvisionedScenario> {
  const scenario = await provisionActorsAndTeams(page, SUPERADMIN, runId);
  await login(page, SUPERADMIN.email, SUPERADMIN.password);
  await provisionSystem(page, scenario, { shortCode, name });
  return scenario;
}

test.describe('admin assets inventory', () => {
  test('admin creates an asset credential pair; immutable fields are disabled; duplicate identities are rejected', async ({ page }) => {
    const runId = 'ba1';
    const shortCode = 'BA1';
    const systemName = 'Admin Assets Test System';
    const systemLabel = `${shortCode} — ${systemName}`;
    const HOSTNAME = 'dbserver-prod';
    const CRED = 'svc_dba';
    const SERVICE = 'Windows';
    const DESCRIPTION = 'Primary production database admin account';

    await test.step('provision actors/teams and the system', async () => {
      await provision(page, runId, shortCode, systemName);
    });

    await test.step('navigate to Admin → Assets and open the Add Asset form', async () => {
      await openAssetsForSystem(page, systemLabel);
      await page.getByTestId('admin-assets__toggle-create-form-button').click();
      await expect(page.getByTestId('admin-assets__create-hostname-input')).toBeVisible();
    });

    await test.step('fill hostname/credential name/type/service/description and submit', async () => {
      await page.getByTestId('admin-assets__create-hostname-input').fill(HOSTNAME);
      await page.getByTestId('admin-assets__create-credential-name-input').fill(CRED);
      await page.getByTestId('admin-assets__create-credential-type-select').selectOption('password');
      await page.getByTestId('admin-assets__create-service-input').fill(SERVICE);
      await page.getByTestId('admin-assets__create-description-input').fill(DESCRIPTION);
      await page.getByTestId('admin-assets__create-submit-button').click();
    });

    await test.step('assert the asset row appears and all identity fields are displayed', async () => {
      await expect(page.getByTestId('admin-assets__row')).toHaveCount(1);
      const row = page.getByTestId('admin-assets__row');
      await expect(row.getByTestId('admin-assets__hostname-input')).toHaveValue(HOSTNAME);
      await expect(row.getByTestId('admin-assets__credential-name-input')).toHaveValue(CRED);
      await expect(row.getByTestId('admin-assets__credential-type-select')).toHaveValue('password');
      await expect(row.getByTestId('admin-assets__service-input')).toHaveValue(SERVICE);
      await expect(row.getByTestId('admin-assets__description-input')).toHaveValue(DESCRIPTION);
    });

    await test.step('assert immutable fields are disabled after creation', async () => {
      const row = page.getByTestId('admin-assets__row');
      await expect(row.getByTestId('admin-assets__hostname-input')).toBeDisabled();
      await expect(row.getByTestId('admin-assets__credential-name-input')).toBeDisabled();
      await expect(row.getByTestId('admin-assets__credential-type-select')).toBeDisabled();
      await expect(row.getByTestId('admin-assets__service-input')).toBeDisabled();
      await expect(row.getByTestId('admin-assets__description-input')).toBeDisabled();
    });

    await test.step('attempt a duplicate (same hostname + credential name + service) — rejected, no new row', async () => {
      await page.getByTestId('admin-assets__toggle-create-form-button').click();
      await page.getByTestId('admin-assets__create-hostname-input').fill(HOSTNAME);
      await page.getByTestId('admin-assets__create-credential-name-input').fill(CRED);
      await page.getByTestId('admin-assets__create-credential-type-select').selectOption('password');
      await page.getByTestId('admin-assets__create-service-input').fill(SERVICE);
      await page.getByTestId('admin-assets__create-submit-button').click();

      await expect(page.getByTestId('admin-assets__row')).toHaveCount(1);
      await expect(page.getByText(/already exists/i)).toBeVisible();
    });
  });

  test('vendor request form only offers valid active assets (credential-name disabled until hostname selected; unknown hostname shows empty state)', async ({ page }) => {
    const runId = 'ba2';
    const shortCode = 'BA2';
    const systemName = 'Admin Assets Request Form System';
    const systemLabel = `${shortCode} — ${systemName}`;
    const HOSTNAME = 'app-server-01';
    const CRED = 'svc_app';
    let scenario!: ProvisionedScenario;

    await test.step('provision a system with one known active asset', async () => {
      scenario = await provision(page, runId, shortCode, systemName);
      await createAssetViaAdminUI(page, {
        systemLabel, hostname: HOSTNAME, credentialName: CRED, credentialType: 'password', navigateFirst: true,
      });
    });

    await test.step('vendor L1 opens the request form and selects the target system', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${systemName} (${shortCode})` });
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await expect(itemRow).toBeVisible();
    });

    await test.step('credential-name selector is disabled until a hostname is selected', async () => {
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await expect(itemRow.getByTestId('vendor-dashboard__credential-name-combobox')).toBeDisabled();
    });

    await test.step('searching an unknown hostname shows the empty state', async () => {
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await itemRow.getByTestId('vendor-dashboard__credential-hostname-combobox').click();
      await page.getByPlaceholder('Type at least 4 characters…').fill('ghost-host-does-not-exist');
      await expect(page.getByText('No matching hostnames found.')).toBeVisible();
      await page.keyboard.press('Escape');
    });

    await test.step('search a valid hostname, select it, then select the credential pair', async () => {
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), HOSTNAME, CRED);
    });

    await test.step('the form visibly reflects both the hostname and credential selections', async () => {
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await expect(itemRow.getByTestId('vendor-dashboard__credential-hostname-combobox')).toContainText(HOSTNAME);
      await expect(itemRow.getByTestId('vendor-dashboard__credential-name-combobox')).toContainText(CRED);
      await expect(itemRow.getByTestId('vendor-dashboard__credential-name-combobox')).toBeEnabled();
    });
  });

  test('invalidate and restore asset lifecycle (both confirm branches; invalidated host absent from request form, restored host selectable again)', async ({ page }) => {
    const runId = 'ba3';
    const shortCode = 'BA3';
    const systemName = 'Admin Assets Lifecycle System';
    const systemLabel = `${shortCode} — ${systemName}`;
    const HOSTNAME = 'retired-host-01';
    const CRED = 'svc_retired';
    let scenario!: ProvisionedScenario;

    await test.step('provision a system with one known active asset', async () => {
      scenario = await provision(page, runId, shortCode, systemName);
      await createAssetViaAdminUI(page, {
        systemLabel, hostname: HOSTNAME, credentialName: CRED, credentialType: 'password', navigateFirst: true,
      });
    });

    await test.step('dismiss the native Invalidate confirm — asset remains active', async () => {
      await openAssetsForSystem(page, systemLabel);
      const row = page.getByTestId('admin-assets__row');
      await expect(row.getByTestId('admin-assets__invalidate-button')).toBeVisible();
      page.once('dialog', (dialog) => dialog.dismiss());
      await row.getByTestId('admin-assets__invalidate-button').click();
      await expect(page.getByTestId('admin-assets__invalidate-button')).toBeVisible();
      await expect(page.getByTestId('admin-assets__restore-button')).toHaveCount(0);
    });

    await test.step('accept the native Invalidate confirm — asset is invalidated and Restore appears', async () => {
      const row = page.getByTestId('admin-assets__row');
      page.once('dialog', (dialog) => dialog.accept());
      await row.getByTestId('admin-assets__invalidate-button').click();
      await expect(page.getByTestId('admin-assets__restore-button')).toBeVisible();
      await expect(page.getByTestId('admin-assets__invalidate-button')).toHaveCount(0);
    });

    await test.step('vendor request form: the invalidated hostname is absent from search', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${systemName} (${shortCode})` });
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await itemRow.getByTestId('vendor-dashboard__credential-hostname-combobox').click();
      await page.getByPlaceholder('Type at least 4 characters…').fill(HOSTNAME);
      await expect(page.getByText('No matching hostnames found.')).toBeVisible();
      await page.keyboard.press('Escape');
    });

    await test.step('admin restores the asset', async () => {
      await openAssetsForSystem(page, systemLabel);
      await expect(page.getByTestId('admin-assets__restore-button')).toBeVisible();
      await page.getByTestId('admin-assets__restore-button').click();
      await expect(page.getByTestId('admin-assets__invalidate-button')).toBeVisible();
      await expect(page.getByTestId('admin-assets__restore-button')).toHaveCount(0);
    });

    await test.step('vendor request form: the restored hostname + credential pair are selectable again', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.getByTestId('vendor-dashboard__open-submit-button').click();
      await page.getByTestId('vendor-dashboard__system-select').selectOption({ label: `${systemName} (${shortCode})` });
      await fillCredentialItemCombobox(page.getByTestId('vendor-dashboard__credential-item'), HOSTNAME, CRED);
      const itemRow = page.getByTestId('vendor-dashboard__credential-item');
      await expect(itemRow.getByTestId('vendor-dashboard__credential-hostname-combobox')).toContainText(HOSTNAME);
      await expect(itemRow.getByTestId('vendor-dashboard__credential-name-combobox')).toContainText(CRED);
    });
  });

  // Addendum-198 — CSV template download + staged bulk import (unit-contract
  // sits in assetCsv.test.ts / AdminAssets.test.tsx; this pins the real
  // browser path: download event, setInputFiles upload, sequential creation
  // against the real API, partial-failure staging retention).
  test('CSV bulk import: template download, staged preview with per-row validation, sequential creation of the valid rows only', async ({ page }) => {
    const runId = 'ba4';
    const shortCode = 'BA4';
    const systemName = 'Admin Assets CSV Import System';
    const systemLabel = `${shortCode} — ${systemName}`;
    // The scenario system has NO aws_role_arn_note, so a blank management_mode
    // resolves to 'manual' (addendum-119 pinning) — both created rows below
    // must surface the Post-approval chip.
    const CSV = [
      'hostname,credential_name,credential_type,service,description,management_mode',
      'csv-host-01,svc_csv_a,password,Windows,Primary account,manual',
      'csv-host-02,svc_csv_b,token,,,',
      ',svc_csv_broken,password,,,',
      'csv-host-01,svc_csv_a,password,Windows,,', // duplicates line 2 within the file
    ].join('\n');

    await test.step('provision actors/teams and the system', async () => {
      await provision(page, runId, shortCode, systemName);
    });

    await test.step('open Admin → Assets; the CSV affordances sit beside Add Asset', async () => {
      await openAssetsForSystem(page, systemLabel);
      await expect(page.getByTestId('admin-assets__csv-template-download')).toBeVisible();
      await expect(page.getByTestId('admin-assets__csv-upload-button')).toBeVisible();
    });

    await test.step('the template link downloads asset-inventory-template.csv', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('admin-assets__csv-template-download').click(),
      ]);
      expect(download.suggestedFilename()).toBe('asset-inventory-template.csv');
    });

    await test.step('uploading a 4-row CSV stages every row; the two bad rows carry their reasons', async () => {
      await page.getByTestId('admin-assets__csv-upload-input').setInputFiles({
        name: 'assets.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf-8'),
      });
      await expect(page.getByTestId('admin-assets__csv-import-panel')).toBeVisible();
      const rows = page.getByTestId('admin-assets__csv-row');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0).getByTestId('admin-assets__csv-row-status')).toHaveText('Pending');
      await expect(rows.nth(1).getByTestId('admin-assets__csv-row-status')).toHaveText('Pending');
      await expect(rows.nth(2).getByTestId('admin-assets__csv-row-status')).toContainText('hostname is required');
      await expect(rows.nth(3).getByTestId('admin-assets__csv-row-status')).toContainText('duplicates line 2');
      await expect(page.getByTestId('admin-assets__csv-create-button')).toHaveText('Create 2 assets');
    });

    await test.step('Create posts only the two valid rows, in order, and the staged panel keeps the bad rows', async () => {
      const created: string[] = [];
      page.on('request', (req) => {
        if (/\/admin\/systems\/.+\/assets$/.test(req.url()) && req.method() === 'POST') {
          created.push(req.postDataJSON().hostname);
        }
      });
      await page.getByTestId('admin-assets__csv-create-button').click();
      await expect(page.getByTestId('admin-assets__csv-summary')).toContainText('Created 2 assets');
      await expect(page.getByTestId('admin-assets__csv-summary')).toContainText('2 rows skipped');
      expect(created).toEqual(['csv-host-01', 'csv-host-02']);
      await expect(page.getByTestId('admin-assets__csv-row')).toHaveCount(2);

      await expect(page.getByTestId('admin-assets__row')).toHaveCount(2);
      await expect(page.getByTestId('admin-assets__fulfillment-chip').nth(0)).toHaveText('Post-approval');
      await expect(page.getByTestId('admin-assets__fulfillment-chip').nth(1)).toHaveText('Post-approval');
    });

    await test.step('a malformed file surfaces a fatal error without touching the staged rows', async () => {
      await page.getByTestId('admin-assets__csv-upload-input').setInputFiles({
        name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from('host_name,credential_name\nh1,c1\n', 'utf-8'),
      });
      await expect(page.getByTestId('admin-assets__csv-error')).toContainText('host_name');
      await expect(page.getByTestId('admin-assets__csv-row')).toHaveCount(2);
      await page.getByTestId('admin-assets__csv-clear-button').click();
      await expect(page.getByTestId('admin-assets__csv-import-panel')).toHaveCount(0);
    });
  });
});
