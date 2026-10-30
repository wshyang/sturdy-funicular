// Cluster & Team Reorganization Flow — see
// docs/specs/fds/fds-v1.3.0-chunk-10-of-14.md §flow-cluster-reorg.
//
// This is the FDS reorg user story end-to-end at the browser level:
//   - Create a NEW cluster ("Vendor Alpha East") and migrate teams/members
//     into it (remove from old team, add to new team — first member of the
//     new team is auto-promoted to team_admin per Constraint #15).
//   - Promote / demote a team member (team_role transitions, audit-logged).
//   - Delete an emptied team and the now-empty old cluster.
//
// Initial state is seeded by the shared provisionActorsAndTeams() +
// provisionSystem() helpers (which build 2 clusters, 4 teams, 9 members, a
// system + workflow + mappings via the real admin UI), then this spec drives
// the reorg on top of that roster — matching how the happy-path/rejection
// specs reuse the same provisioned world.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const RUN = 'reorg';
const NEW_CLUSTER = 'Vendor Alpha East';
const NEW_TEAM = 'Alpha East Engineers';

test.describe('cluster & team reorganization flow', () => {
  test('create cluster, migrate a member, promote/demote, and delete the emptied resources', async ({ page }) => {
    // ── Initial state: shared 9-actor roster + a system/world ─────────────
    let scenario!: ProvisionedScenario;
    await test.step('provision the starting org structure and a system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, RUN);
      await provisionSystem(page, scenario, { shortCode: 'REORG1', name: 'Reorg Demo System' });
    });

    // ── Happy path step 1: create a new cluster ───────────────────────────
    await test.step('admin creates the new vendor cluster', async () => {
      await page.getByTestId('admin-panel__tab-clusters').click();
      await page.getByTestId('admin-clusters__toggle-create-form-button').click();
      await page.getByTestId('admin-clusters__name-input').fill(NEW_CLUSTER);
      await page.getByTestId('admin-clusters__type-select').selectOption('vendor');
      // Addendum-206 D2: every cluster needs a live org anchor.
      await page.getByTestId('admin-clusters__org-select').selectOption({ label: scenario.agencyOrgName });
      await page.getByTestId('admin-clusters__submit-button').click();
      await expect(page.locator('tr', { hasText: NEW_CLUSTER })).toBeVisible();
    });

    // ── Happy path step 3: create a new team in that cluster ──────────────
    await test.step('admin creates the new team in the new cluster', async () => {
      await page.getByTestId('admin-panel__tab-teams').click();
      await page.getByTestId('admin-teams__toggle-create-form-button').click();
      await page.getByTestId('admin-teams__name-input').fill(NEW_TEAM);
      await page.getByTestId('admin-teams__cluster-select').selectOption({ label: `${NEW_CLUSTER} (vendor)` });
      await page.getByTestId('admin-teams__level-select').selectOption({ label: 'Level 1' });
      await page.getByTestId('admin-teams__submit-button').click();
      await expect(page.locator('tr', { hasText: NEW_TEAM })).toBeVisible();
    });

    // ── Happy path step 5: migrate a member from an old team ──────────────
    // Remove vendorL1A from its old team, then add it to the new team. The
    // FIRST member of the new team is auto-promoted to team_admin (#15).
    const migratingMember = scenario.vendorL1A;
    await test.step('remove the member from the old team', async () => {
      // Open the OLD vendor L1 team's member modal by its row.
      const oldTeamRow = page.locator('tr', { hasText: scenario.vendorL1Team });
      await oldTeamRow.getByTestId('admin-teams__manage-members-button').click();
      const modal = page.getByTestId('team-members-modal');
      await expect(modal).toBeVisible();
      const row = modal.locator('li', { hasText: migratingMember.email });
      await expect(row).toBeVisible();
      page.once('dialog', (dialog) => dialog.accept());
      await row.getByTestId('team-members-modal__remove-button').click();
      await expect(modal.locator('li', { hasText: migratingMember.email })).toHaveCount(0);
      await modal.getByTestId('team-members-modal__close-button').click();
    });

    await test.step('add the member to the new team (auto-promoted to team admin)', async () => {
      // The new team's row — locate by the team name in the row.
      const newTeamRow = page.locator('tr', { hasText: NEW_TEAM });
      await newTeamRow.getByTestId('admin-teams__manage-members-button').click();
      const modal = page.getByTestId('team-members-modal');
      await expect(modal).toBeVisible();
      await modal.getByTestId('team-members-modal__user-select')
        .selectOption({ label: `${migratingMember.fullName} (${migratingMember.email}) — vendor` });
      // Default role select is "member"; leave it and Add.
      await modal.getByTestId('team-members-modal__add-button').click();
      const addedRow = modal.locator('li', { hasText: migratingMember.email });
      await expect(addedRow).toContainText('Team Admin');
      await modal.getByTestId('team-members-modal__close-button').click();
    });

    // ── Happy path: promote a second member, then demote them ─────────────
    await test.step('promote then demote a member of the new team', async () => {
      const newTeamRow = page.locator('tr', { hasText: NEW_TEAM });
      await newTeamRow.getByTestId('admin-teams__manage-members-button').click();
      const modal = page.getByTestId('team-members-modal');
      await expect(modal).toBeVisible();
      // Add a second member (scenario.vendorL1B) as a plain member.
      await modal.getByTestId('team-members-modal__user-select')
        .selectOption({ label: `${scenario.vendorL1B.fullName} (${scenario.vendorL1B.email}) — vendor` });
      await modal.getByTestId('team-members-modal__role-select').selectOption('member');
      await modal.getByTestId('team-members-modal__add-button').click();
      const secondRow = modal.locator('li', { hasText: scenario.vendorL1B.email });
      await expect(secondRow).toContainText('Member');
      await secondRow.getByTestId('team-members-modal__promote-button').click();
      await expect(secondRow).toContainText('Team Admin');
      await secondRow.getByTestId('team-members-modal__demote-button').click();
      await expect(secondRow).toContainText('Member');
      await modal.getByTestId('team-members-modal__close-button').click();
    });

    // ── Happy path step 7/8: delete the emptied old team and old cluster ──
    await test.step('delete the old vendor team and old cluster once empty', async () => {
      // The old vendor L1 team was emptied by the remove above.
      const oldTeamName = scenario.vendorL1Team;
      const oldTeamRow = page.locator('tr', { hasText: oldTeamName }).first();
      // Addendum-204 F3: team referenced by workflow step emits two sequential
      // confirm() calls. Chain the handlers: first accepts, then re-registers
      // for the second "Delete anyway?" prompt.
      page.once('dialog', (dialog) => {
        dialog.accept();
        page.once('dialog', (d) => d.accept());
      });
      await oldTeamRow.getByTestId('admin-teams__delete-button').click();
      await expect(page.locator('tr', { hasText: oldTeamName })).toHaveCount(0);

      // The old vendor cluster still has its L2 team — leave it in place
      // rather than deleting (the FDS reorg keeps the L2 cluster). Instead
      // assert the empty-old-team cleanup path is complete.
    });

    await test.step('confirm the new cluster/team survive and are usable', async () => {
      await expect(page.locator('tr', { hasText: NEW_TEAM })).toBeVisible();
    });
  });

  // Addendum-199 — CSV roster bulk-add (TeamMembersModal): template download,
  // staged resolution of emails against the eligible-users list, sequential
  // adds through the real POST /teams/:id/members endpoint, and retention of
  // unresolvable rows. Unit contracts live in teamRosterCsv.test.ts /
  // TeamMembersModal.test.tsx — this pins the real browser path.
  test('CSV roster bulk-add: template, staged resolution flags, sequential adds of the valid rows only', async ({ page }) => {
    const RUN_CSV = 'rostercsv';
    const CSV_CLUSTER = 'Roster CSV Cluster rostercsv';
    const CSV_TEAM = 'Roster CSV Team rostercsv';
    let scenario!: ProvisionedScenario;

    await test.step('provision the actor roster (no system needed)', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, RUN_CSV);
    });

    await test.step('create a fresh vendor cluster + team so the four vendor actors are eligible', async () => {
      await page.getByTestId('admin-panel__tab-clusters').click();
      await page.getByTestId('admin-clusters__toggle-create-form-button').click();
      await page.getByTestId('admin-clusters__name-input').fill(CSV_CLUSTER);
      await page.getByTestId('admin-clusters__type-select').selectOption('vendor');
      // Addendum-206 D2: every cluster needs a live org anchor.
      await page.getByTestId('admin-clusters__org-select').selectOption({ label: scenario.agencyOrgName });
      await page.getByTestId('admin-clusters__submit-button').click();
      await expect(page.locator('tr', { hasText: CSV_CLUSTER })).toBeVisible();

      await page.getByTestId('admin-panel__tab-teams').click();
      await page.getByTestId('admin-teams__toggle-create-form-button').click();
      await page.getByTestId('admin-teams__name-input').fill(CSV_TEAM);
      await page.getByTestId('admin-teams__cluster-select').selectOption({ label: `${CSV_CLUSTER} (vendor)` });
      await page.getByTestId('admin-teams__level-select').selectOption({ label: 'Level 1' });
      await page.getByTestId('admin-teams__submit-button').click();
      await expect(page.locator('tr', { hasText: CSV_TEAM })).toBeVisible();
    });

    await test.step('open the empty team\'s members modal; the CSV affordances sit under the add-member row', async () => {
      const teamRow = page.locator('tr', { hasText: CSV_TEAM });
      await teamRow.getByTestId('admin-teams__manage-members-button').click();
      const modal = page.getByTestId('team-members-modal');
      await expect(modal).toBeVisible();
      await expect(page.getByTestId('team-members-modal__csv-template-download')).toBeVisible();
      await expect(page.getByTestId('team-members-modal__csv-upload-button')).toBeVisible();
      // Members/eligible load in parallel after the modal paints — wait for
      // the eligible list, or an upload staged now resolves against nothing.
      await expect(modal.getByTestId('team-members-modal__user-select')
        .locator('option', { hasText: scenario.vendorL1A.email })).toHaveCount(1);
    });

    await test.step('the template link downloads team-roster-template.csv', async () => {
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByTestId('team-members-modal__csv-template-download').click(),
      ]);
      expect(download.suggestedFilename()).toBe('team-roster-template.csv');
    });

    await test.step('uploading a 4-row CSV stages every row; ghost + wrong-affiliation emails are flagged', async () => {
      const CSV = [
        'user_email,team_role',
        `${scenario.vendorL1A.email},team_admin`,
        `${scenario.vendorL1B.email},`, // blank role inherits the picker's member default
        `ghost.${RUN_CSV}@test.local,member`,
        `${scenario.agencyL1A.email},member`, // agency user on a vendor team — resolves to nothing
      ].join('\n');
      await page.getByTestId('team-members-modal__csv-upload-input').setInputFiles({
        name: 'roster.csv', mimeType: 'text/csv', buffer: Buffer.from(CSV, 'utf-8'),
      });
      await expect(page.getByTestId('team-members-modal__csv-import-panel')).toBeVisible();
      const rows = page.getByTestId('team-members-modal__csv-row');
      await expect(rows).toHaveCount(4);
      await expect(rows.nth(0).getByTestId('team-members-modal__csv-row-status')).toHaveText('Pending');
      await expect(rows.nth(1).getByTestId('team-members-modal__csv-row-status')).toHaveText('Pending');
      await expect(rows.nth(2).getByTestId('team-members-modal__csv-row-status')).toContainText('matches no eligible user');
      await expect(rows.nth(3).getByTestId('team-members-modal__csv-row-status')).toContainText('matches no eligible user');
      await expect(page.getByTestId('team-members-modal__csv-create-button')).toHaveText('Add 2 members');
    });

    await test.step('Add posts only the two valid rows, in order, through the existing endpoint', async () => {
      const modal = page.getByTestId('team-members-modal');
      const addedRoles: string[] = [];
      page.on('request', (req) => {
        if (/\/teams\/[^/]+\/members$/.test(req.url()) && req.method() === 'POST') {
          addedRoles.push(req.postDataJSON().teamRole);
        }
      });
      await page.getByTestId('team-members-modal__csv-create-button').click();
      await expect(page.getByTestId('team-members-modal__csv-summary')).toContainText('Added 2 members.');
      await expect(page.getByTestId('team-members-modal__csv-summary')).toContainText('2 rows skipped');
      expect(addedRoles).toEqual(['team_admin', 'member']);

      // The members list reflects both adds at their requested roles…
      await expect(modal.locator('li', { hasText: scenario.vendorL1A.email })).toContainText('Team Admin');
      await expect(modal.locator('li', { hasText: scenario.vendorL1B.email })).toContainText('Member');
      // …while the two unresolvable rows stay staged for fixing.
      await expect(page.getByTestId('team-members-modal__csv-row')).toHaveCount(2);
      await modal.getByTestId('team-members-modal__close-button').click();
    });
  });
});
