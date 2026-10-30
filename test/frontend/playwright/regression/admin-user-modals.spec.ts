// Regression coverage for two AdminUsers modal defects found in-session
// (see CLAUDE-test-discipline.md → "Standing rule: a Playwright regression
// test for every reported frontend bug").
//
// Bug 1 — Edit Roles hamburger → black screen. EditRolesModal (AdminUserModals.tsx)
//   destructured the prop `keys` but its checkbox referenced an undefined
//   `modalKeys`, throwing a ReferenceError that blanked the whole app when the
//   modal mounted. Repro: open the row menu for an active agency user and click
//   Edit Roles — the modal must render its role picker, not crash.
//
// Bug 2 — Invite User modal could not be dismissed. <InviteUserModal> was
//   rendered unconditionally (no `inviteOpen` guard, no internal null-return
//   like its siblings), so onClose flipped state the render ignored — the
//   overlay stayed up. Repro: open Invite, click Cancel, overlay must disappear;
//   and it must NOT be present on first load of the Users tab.
//
// The seeded E2E superadmin (global-setup.ts) is an agency, active, full_admin
// user, so its own row exposes the Edit Roles action — a self-contained repro
// with no extra fixture users.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login } from '../helpers/ui';
import { provisionOrganization } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('admin users modals — regression', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, SUPERADMIN.email, SUPERADMIN.password);
    await page.getByTestId('admin-panel__tab-users').click();
    await page.getByTestId('admin-users__view-all-tab').click();
    await expect(page.getByText(SUPERADMIN.email)).toBeVisible();
  });

  test('Edit Roles opens the role picker instead of crashing to a black screen', async ({ page }) => {
    // Scope to the superadmin's own row, then open its actions (⋮) menu.
    const row = page.locator('tr', { hasText: SUPERADMIN.email });
    await row.getByTestId('admin-users__row-menu-button').click();
    await expect(page.getByTestId('admin-users__row-menu')).toBeVisible();

    await page.getByTestId('admin-users__edit-roles-button').click();

    // The modal (and its role picker) must render — the ReferenceError used to
    // unmount the entire tree here, leaving a blank page.
    await expect(page.getByTestId('admin-users__edit-roles-modal')).toBeVisible();
    await expect(page.getByTestId('admin-users__edit-roles-picker')).toBeVisible();

    // The app is still alive: the modal closes cleanly.
    await page.getByTestId('admin-users__edit-roles-modal').getByText('Cancel').click();
    await expect(page.getByTestId('admin-users__edit-roles-modal')).not.toBeVisible();
  });

  test('Invite User modal is absent until opened, and closes on demand', async ({ page }) => {
    // Not rendered on first paint of the Users tab (was stuck open before).
    await expect(page.getByTestId('admin-users__invite-modal')).not.toBeVisible();

    await page.getByTestId('admin-users__invite-button').click();
    await expect(page.getByTestId('admin-users__invite-modal')).toBeVisible();

    // Dismiss must actually remove the overlay.
    await page.getByTestId('admin-users__invite-cancel-button').click();
    await expect(page.getByTestId('admin-users__invite-modal')).not.toBeVisible();
  });

  // Addendum-199 — CSV bulk invite: template download, staged preview with
  // pre-flight validation, sequential invites through the real invite API,
  // the org-scoped grants follow-up PUT (the invite endpoint's roleKeys are
  // GLOBAL-only — `key@Org` rows compose invite + the additive grants PUT,
  // which replaces the grant set and therefore carries the complete list),
  // and the downloadable results artifact. Unit contracts live in
  // inviteCsv.test.ts / AdminUsers.test.tsx — this pins the real browser
  // path: download event, setInputFiles upload, request payloads, and
  // partial-failure staging retention.
  test('CSV bulk invite: template, staged pre-flight flags, sequential invites + org-scoped grants PUT, results download', async ({ page }) => {
    // A fresh runId per run: invited users are GLOBAL rows in the shared e2e
    // database, so a rerun must never collide with its predecessor.
    const runId = `${Date.now()}`;
    const ORG = `Invite CSV Org ${runId}`;
    // Addendum-200: CSV org references are short codes — unique, ≤10 chars.
    const CODE = `CSV${runId.slice(-7)}`;
    const HEADER = 'full_name,email,affiliation,notify,full_admin,org_codes,roles';
    const CSV = [
      HEADER,
      `Csv Vendor ${runId},csv-vendor.${runId}@test.local,vendor,n`,
      `Csv Agency ${runId},csv-agency.${runId}@test.local,agency,y,n,${CODE},user_admin`,
      `Csv Scoped ${runId},csv-scoped.${runId}@test.local,agency,y,n,${CODE},user_admin@${CODE}`,
      `Csv Broken ${runId},,vendor`,
    ].join('\n');

    await test.step('provision a fresh organisation to reference from the CSV', async () => {
      await provisionOrganization(page, { name: ORG, shortCode: CODE });
      // provisionOrganization leaves us on the Organisations tab — return to Users.
      await page.getByTestId('admin-panel__tab-users').click();
      await page.getByTestId('admin-users__view-all-tab').click();
      await expect(page.getByText(SUPERADMIN.email)).toBeVisible();
    });

    await test.step('the CSV affordances sit beside Invite User', async () => {
      await expect(page.getByTestId('admin-users__csv-template-download')).toBeVisible();
      await expect(page.getByTestId('admin-users__csv-upload-button')).toBeVisible();
    });

    await test.step('the template link downloads user-invites-template.csv', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('admin-users__csv-template-download').click(),
      ]);
      expect(download.suggestedFilename()).toBe('user-invites-template.csv');
    });

    await test.step('uploading a 4-row CSV stages every row; the broken row carries its reason', async () => {
      await page.getByTestId('admin-users__csv-upload-input').setInputFiles({
        name: 'invites.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf-8'),
      });
      await expect(page.getByTestId('admin-users__csv-import-panel')).toBeVisible();
      const rows = page.getByTestId('admin-users__csv-row');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0).getByTestId('admin-users__csv-row-status')).toHaveText('Pending');
      await expect(rows.nth(1).getByTestId('admin-users__csv-row-status')).toHaveText('Pending');
      await expect(rows.nth(2).getByTestId('admin-users__csv-row-status')).toHaveText('Pending');
      await expect(rows.nth(3).getByTestId('admin-users__csv-row-status')).toContainText('email is required');
      await expect(page.getByTestId('admin-users__csv-create-button')).toHaveText('Invite 3 users');
      // Addendum-201: the preview confirms RESOLVED names (not the raw keyed
      // codes) so the reviewer verifies intent before inviting.
      await expect(rows.nth(1)).toContainText(`${CODE} — ${ORG}`);
      await expect(rows.nth(2)).toContainText(`User Administrator @ ${ORG} (${CODE})`);
    });

    await test.step('Invite posts the three valid rows in order; the @ row follows with a grants PUT', async () => {
      const invites: any[] = [];
      const grantsPuts: any[] = [];
      page.on('request', (req) => {
        if (/\/admin\/users\/invite$/.test(req.url()) && req.method() === 'POST') invites.push(req.postDataJSON());
        if (/\/admin\/users\/[^/]+\/roles$/.test(req.url()) && req.method() === 'PUT') grantsPuts.push(req.postDataJSON());
      });
      await page.getByTestId('admin-users__csv-create-button').click();
      await expect(page.getByTestId('admin-users__csv-summary')).toContainText('Invited 3 users.');
      await expect(page.getByTestId('admin-users__csv-summary')).toContainText('1 row skipped');

      expect(invites.map((payload) => payload.email)).toEqual([
        `csv-vendor.${runId}@test.local`,
        `csv-agency.${runId}@test.local`,
        `csv-scoped.${runId}@test.local`,
      ]);
      // Modal-identical payloads: vendor notify off, no roles; the agency row
      // carries the GLOBAL key + org membership in the invite itself.
      expect(invites[0]).toMatchObject({ affiliation: 'vendor', notify: false, grantFullAdmin: false, roleKeys: [], organizationIds: [] });
      expect(invites[1]).toMatchObject({ affiliation: 'agency', notify: true, grantFullAdmin: false, roleKeys: ['user_admin'] });
      expect(invites[1].organizationIds).toHaveLength(1);
      // The @ row invites with membership but an empty global key list…
      expect(invites[2]).toMatchObject({ affiliation: 'agency', notify: true, roleKeys: [] });
      expect(invites[2].organizationIds).toEqual(invites[1].organizationIds);
      // …and exactly ONE grants PUT follows — the complete grant list, because
      // that PUT replaces the set.
      expect(grantsPuts).toHaveLength(1);
      expect(grantsPuts[0].grants).toEqual([{ roleKey: 'user_admin', organizationId: invites[1].organizationIds[0] }]);

      // Successful rows are consumed; the broken row stays staged.
      await expect(page.getByTestId('admin-users__csv-row')).toHaveCount(1);
    });

    await test.step('the results artifact downloads with one row per invite', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('admin-users__csv-results-download').click(),
      ]);
      expect(download.suggestedFilename()).toBe('user-invites-results.csv');
    });
  });
});
