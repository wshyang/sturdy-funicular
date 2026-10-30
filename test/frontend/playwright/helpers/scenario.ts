// Shared multi-actor provisioning for the expanded e2e suite (happy-path +
// rejection-flows). Both spec files need the SAME 9-actor roster (2 members
// per level × 4 levels + 1 owner), 2 clusters, and 4 teams — provisioning
// this inline in every scenario would be ~150 lines of duplication per
// scenario. provisionActorsAndTeams() is called ONCE per spec file (actors
// and teams are realistically reused across systems); provisionSystem() is
// called once PER SCENARIO within that file (each scenario gets its own
// system so requests never collide with another scenario sharing the run).
//
// Workflow topology (corrected from the previous sprint's 2-step version —
// see the plan / addendum-013): vendor L1 SUBMITS, then a genuine 3-step
// approval chain — vendor L2 -> agency L1 -> agency L2 -> owner terminal.
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { login, signup, approveUser, rowButton, modalByTestId } from './ui';
import { singaporeanName, vendorName } from '../../../backend/deno/name-seeds.ts';

export interface Actor {
  fullName: string;
  email: string;
  password: string;
}

export interface ProvisionedScenario {
  vendorL1A: Actor; vendorL1B: Actor;
  vendorL2A: Actor; vendorL2B: Actor;
  agencyL1A: Actor; agencyL1B: Actor;
  agencyL2A: Actor; agencyL2B: Actor;
  owner: Actor;
  vendorCluster: string;
  agencyCluster: string;
  agencyOrgName: string;
  vendorL1Team: string; vendorL2Team: string;
  agencyL1Team: string; agencyL2Team: string;
}

// Creates one organisation via the real Admin UI (addendum-109 ideated ids —
// the Organisations tab/panel mount with the addendum-110+ implementation).
// Idempotent by name: re-invoking for an org that is already listed is a
// no-op, so specs sharing a roster/run never collide on the live-name
// uniqueness constraint. Callers must be logged in as a user that can see
// the Organisations admin tab (superadmin in practice).
// addendum-200: the short code column is NOT NULL + live-unique, so real-UI
// provisioning must always bring one (uppercase alphanumeric, ≤10 chars).
export async function provisionOrganization(
  page: Page,
  org: { name: string; shortCode: string },
): Promise<void> {
  await page.getByTestId('admin-panel__tab-organizations').click();
  const existingRow = page.locator('tr', { hasText: org.name });
  if (await existingRow.first().isVisible().catch(() => false)) return;
  await page.getByTestId('admin-orgs__toggle-create-form-button').click();
  await page.getByTestId('admin-orgs__name-input').fill(org.name);
  await page.getByTestId('admin-orgs__short-code-input').fill(org.shortCode);
  await page.getByTestId('admin-orgs__submit-button').click();
  await expect(page.locator('tr', { hasText: org.name })).toBeVisible();
}

// Builds a unique-per-run actor so two spec files (or two runs) never clash
// on email uniqueness within the same breakglass_test database.
function actor(label: string, runId: string): Actor {
  const email = `${label}.${runId}@test.local`;
  // Seed realistic affiliation-appropriate names: Singaporean names for
  // agency actors, Indian/Filipino names for vendor actors (see
  // test/backend/deno/name-seeds.ts). The label still encodes affiliation.
  // vendor-* labels are vendor actors; agency-* and owner are agency actors.
  const isVendor = /^vendor/i.test(label);
  const fullName = isVendor ? vendorName() : singaporeanName();
  return { fullName: `${fullName} (${label})`, email, password: `${label}Pass!2026${runId}` };
}

// Provisions the full 9-actor / 2-cluster / 4-team roster via the real UI
// (signups, superadmin approval, cluster/team creation, membership
// assignment) — no API/DB shortcuts, per this suite's "real app" discipline.
// `runId` disambiguates actors/clusters/teams across spec files that share
// one e2e run (e.g. "hp" for happy-path, "rej" for rejection-flows).
export async function provisionActorsAndTeams(
  page: Page,
  superadmin: { email: string; password: string },
  runId: string,
  // Optional per-occurrence delay (ms) for each signup()/approveUser() call
  // below, keyed by a 0-based index within its own loop — lets a caller
  // (e2e/demo/happy-path-showcase.spec.ts) pace the FIRST couple of each at
  // full human speed and the rest at zero delay, without this shared helper
  // (used by every other regression spec too, always with no pacing) having
  // any pacing opinion of its own. Every other caller omits this and gets
  // today's unchanged zero-delay behavior.
  paceDelayMs: (index: number) => number = () => 0,
): Promise<ProvisionedScenario> {
  const vendorL1A = actor('vendor-l1-a', runId);
  const vendorL1B = actor('vendor-l1-b', runId);
  const vendorL2A = actor('vendor-l2-a', runId);
  const vendorL2B = actor('vendor-l2-b', runId);
  const agencyL1A = actor('agency-l1-a', runId);
  const agencyL1B = actor('agency-l1-b', runId);
  const agencyL2A = actor('agency-l2-a', runId);
  const agencyL2B = actor('agency-l2-b', runId);
  const owner = actor('owner', runId);

  const vendorCluster = `Vendor Cluster ${runId}`;
  const agencyCluster = `Agency Cluster ${runId}`;
  const agencyOrg = `Agency Org ${runId}`;
  const vendorL1Team = `Vendor L1 Team ${runId}`;
  const vendorL2Team = `Vendor L2 Team ${runId}`;
  const agencyL1Team = `Agency L1 Team ${runId}`;
  const agencyL2Team = `Agency L2 Team ${runId}`;

  const allVendors = [vendorL1A, vendorL1B, vendorL2A, vendorL2B];
  const allAgency = [agencyL1A, agencyL1B, agencyL2A, agencyL2B, owner];
  const allActors = [...allVendors, ...allAgency];

  for (const [i, u] of allActors.entries()) {
    await signup(page, u, paceDelayMs(i));
  }

  await login(page, superadmin.email, superadmin.password);

  // Create the agency org before approvals so it's available in the
  // approve-user modal's org picker (addendum-109: delegates must share an
  // org with the system; systems derive their org through the agency cluster).
  // Org short codes are required (addendum-200): uppercase-alnum, ≤10 —
  // derived from the runId so parallel spec worlds never collide.
  const agencyOrgCode = `AG${runId.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}`;
  await provisionOrganization(page, { name: agencyOrg, shortCode: agencyOrgCode });
  // Navigate back to the Users tab so approveUser finds the pending rows.
  await page.getByTestId('admin-panel__tab-users').click();

  const allApprovals: Array<[Actor, 'vendor' | 'agency']> = [
    ...allVendors.map((u): [Actor, 'vendor' | 'agency'] => [u, 'vendor']),
    ...allAgency.map((u): [Actor, 'vendor' | 'agency'] => [u, 'agency']),
  ];
  for (const [i, [u, affiliation]] of allApprovals.entries()) {
    await approveUser(
      page,
      u.email,
      affiliation,
      paceDelayMs(i),
      affiliation === 'agency' ? agencyOrg : undefined,
    );
  }

  await page.getByTestId('admin-panel__tab-clusters').click();
  await page.getByTestId('admin-clusters__toggle-create-form-button').click();
  await page.getByTestId('admin-clusters__name-input').fill(vendorCluster);
  await page.getByTestId('admin-clusters__type-select').selectOption('vendor');
  // Addendum-206 D2: every cluster must be anchored to a live organisation
  // ("no NULL-org objects anywhere") — a vendor-typed cluster anchors to the
  // agency org it serves. The server 400s unanchored creates, and the admin
  // form's org select is now required.
  await page.getByTestId('admin-clusters__org-select').selectOption({ label: agencyOrg });
  await page.getByTestId('admin-clusters__submit-button').click();
  await expect(page.locator('tr', { hasText: vendorCluster })).toBeVisible();

  await page.getByTestId('admin-clusters__toggle-create-form-button').click();
  await page.getByTestId('admin-clusters__name-input').fill(agencyCluster);
  await page.getByTestId('admin-clusters__type-select').selectOption('agency');
  // Anchor the agency cluster to the org so all systems + delegates in
  // this run share one organisation (required for delegate eligibility).
  await page.getByTestId('admin-clusters__org-select').selectOption({ label: agencyOrg });
  await page.getByTestId('admin-clusters__submit-button').click();
  await expect(page.locator('tr', { hasText: agencyCluster })).toBeVisible();

  await page.getByTestId('admin-panel__tab-teams').click();
  for (const [teamName, clusterLabel, level] of [
    [vendorL1Team, `${vendorCluster} (vendor)`, 1],
    [vendorL2Team, `${vendorCluster} (vendor)`, 2],
    [agencyL1Team, `${agencyCluster} (agency)`, 1],
    [agencyL2Team, `${agencyCluster} (agency)`, 2],
  ] as const) {
    await page.getByTestId('admin-teams__toggle-create-form-button').click();
    await page.getByTestId('admin-teams__name-input').fill(teamName);
    await page.getByTestId('admin-teams__cluster-select').selectOption({ label: clusterLabel });
    await page.getByTestId('admin-teams__level-select').selectOption({ label: `Level ${level}` });
    await page.getByTestId('admin-teams__submit-button').click();
    await expect(page.locator('tr', { hasText: teamName })).toBeVisible();
  }

  // vendorL1A is team_admin so the §E element-gate spec (owner-elements.spec.ts)
  // can exercise the team_admin dashboard path; all other members default to
  // 'member'. vendorL1A's team occupies the SUBMITTER step (ordinal 1, not an
  // approval step), so team_admin here grants no reviewer visibility — the
  // happy-path visibility matrix is unaffected.
  const teamAssignments: Array<[string, Array<{actor: Actor; role?: 'team_admin' | 'member'}>, 'vendor' | 'agency']> = [
    [vendorL1Team, [{actor: vendorL1A, role: 'team_admin'}, {actor: vendorL1B}], 'vendor'],
    [vendorL2Team, [{actor: vendorL2A}, {actor: vendorL2B}], 'vendor'],
    [agencyL1Team, [{actor: agencyL1A}, {actor: agencyL1B}], 'agency'],
    [agencyL2Team, [{actor: agencyL2A}, {actor: agencyL2B}], 'agency'],
  ];
  for (const [teamName, members, affiliation] of teamAssignments) {
    await rowButton(page, teamName, 'admin-teams__manage-members-button').click();
    const modal = modalByTestId(page, 'team-members-modal');
    for (const {actor: member, role} of members) {
      if (role) {
        await modal.getByTestId('team-members-modal__role-select').selectOption(role);
      }
      await modal.getByTestId('team-members-modal__user-select')
        .selectOption({ label: `${member.fullName} (${member.email}) — ${affiliation}` });
      await modal.getByTestId('team-members-modal__add-button').click();
      await expect(modal.locator('li', { hasText: member.fullName })).toBeVisible();
    }
    await modal.getByTestId('team-members-modal__close-button').click();
  }

  return {
    vendorL1A, vendorL1B, vendorL2A, vendorL2B,
    agencyL1A, agencyL1B, agencyL2A, agencyL2B, owner,
    vendorCluster, agencyCluster, agencyOrgName: agencyOrg,
    vendorL1Team, vendorL2Team, agencyL1Team, agencyL2Team,
  };
}

// Creates one system with the corrected 3-step workflow (vendor L2 ->
// agency L1 -> agency L2, terminating at the owner) and maps all 4 teams to
// it. Callable once per scenario within a spec file that shares one
// provisionActorsAndTeams() roster, so each scenario's requests never
// collide with another scenario's on the same system.
export async function provisionSystem(
  page: Page,
  scenario: ProvisionedScenario,
  // awsRoleArnNote is optional and omitted by every caller except the
  // secret-autorelease demo/LocalStack specs (addendum-043) — filling the
  // real admin-systems__aws-role-arn-note-input field is what lets that
  // system's Assets tab "Sync Now" button do a real S3 publish/poll.
  opts: { shortCode: string; name: string; awsRoleArnNote?: string },
): Promise<void> {
  await page.getByTestId('admin-panel__tab-systems').click();
  await page.getByTestId('admin-systems__toggle-create-form-button').click();
  await page.getByTestId('admin-systems__short-code-input').fill(opts.shortCode);
  await page.getByTestId('admin-systems__name-input').fill(opts.name);
  if (opts.awsRoleArnNote) {
    await page.getByTestId('admin-systems__aws-role-arn-note-input').fill(opts.awsRoleArnNote);
  }
  await page.getByTestId('admin-systems__primary-owner-select')
    .selectOption({ label: `${scenario.owner.fullName} (${scenario.owner.email})` });
  // Scoped to THIS scenario's own vendor cluster by name, not .first() — the
  // vendor-cluster checkbox list accumulates every scenario's cluster across
  // a shared provisionActorsAndTeams() roster (e.g. rejection-flows.spec.ts's
  // 3 chains all reuse one roster), so .first() would silently check a
  // DIFFERENT scenario's cluster once more than one exists on the page.
  await page.locator('label', { hasText: scenario.vendorCluster })
    .locator('input[type="checkbox"]')
    .check();
  await page.getByTestId('admin-systems__agency-cluster-select').selectOption({ label: scenario.agencyCluster });

  // Addendum-144: every manual asset uses the fixed custody lifecycle. The
  // shared fixture assigns every agency stage to Agency L1; this deliberately
  // exercises the two safe same-team compound actions in every inherited flow.
  for (const stage of ['prepare', 'initiate_handover', 'verify_return', 'return_to_inventory', 'investigate_exception']) {
    const custodySelect = page.getByTestId(`admin-systems__custody-team-${stage}`);
    const teamValue = await custodySelect.locator('option', { hasText: scenario.agencyL1Team }).getAttribute('value');
    await custodySelect.selectOption(teamValue!);
  }

  const stepBlocks = page.getByTestId('admin-systems__workflow-step');

  // The create-form (unlike the edit-modal, which caps itself at
  // max-h-[90vh] overflow-y-auto) has no nested scroll container of its own
  // — it grows the ordinary page flow, so appending steps pushes later ones
  // below the fold. Playwright auto-scrolls just enough for an element to be
  // actionable (nearest-edge scroll), which lands a freshly-added step right
  // at the viewport's bottom edge rather than comfortably in view — fine for
  // headless correctness, but means a recorded video (e2e/demo/) shows each
  // new step block clipped at the very edge of the frame instead of clearly.
  // scrollIntoView({block:'center'}) after each Add Step click gives every
  // step comfortable padding above/below in the viewport for BOTH suites.
  // Step 1 is always the SUBMITTER step, per
  // addendum-027-submitter-as-workflow-step-one.md — the vendorL1Team
  // roster this suite already provisions (but previously never wired into
  // the workflow at all) is exactly the submitter here.
  await page.getByTestId('admin-systems__add-step-button').click();
  const step1 = stepBlocks.nth(0);
  await step1.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await step1.getByTestId('admin-systems__step-cluster-select').selectOption({ label: `${scenario.vendorCluster} (vendor)` });
  await step1.getByTestId('admin-systems__step-level-select').selectOption({ label: 'Level 1' });

  await page.getByTestId('admin-systems__add-step-button').click();
  const step2 = stepBlocks.nth(1);
  await step2.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await step2.getByTestId('admin-systems__step-cluster-select').selectOption({ label: `${scenario.vendorCluster} (vendor)` });
  await step2.getByTestId('admin-systems__step-level-select').selectOption({ label: 'Level 2' });

  await page.getByTestId('admin-systems__add-step-button').click();
  const step3 = stepBlocks.nth(2);
  await step3.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await step3.getByTestId('admin-systems__step-cluster-select').selectOption({ label: `${scenario.agencyCluster} (agency)` });
  await step3.getByTestId('admin-systems__step-level-select').selectOption({ label: 'Level 1' });

  await page.getByTestId('admin-systems__add-step-button').click();
  const step4 = stepBlocks.nth(3);
  await step4.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await step4.getByTestId('admin-systems__step-cluster-select').selectOption({ label: `${scenario.agencyCluster} (agency)` });
  await step4.getByTestId('admin-systems__step-level-select').selectOption({ label: 'Level 2' });

  await page.getByTestId('admin-systems__submit-create-button').click();
  // Keyed off opts.name (unique per scenario), not opts.shortCode — every
  // system in this suite shares the same workflow shape AND the same
  // "...rej"-suffixed cluster names, so a row's concatenated text content
  // can read "...Cluster rej" immediately followed by the step-count text
  // with no whitespace between them, producing a "rej3" substring that
  // Playwright's case-insensitive hasText would match against EVERY row,
  // not just this scenario's own short code.
  await expect(page.locator('tr', { hasText: opts.name })).toBeVisible();
  // 1 submitter step + 3 approval steps — see
  // addendum-027-submitter-as-workflow-step-one.md.
  await expect(page.locator('tr', { hasText: opts.name })).toContainText('submitter + 3 approval steps');

  // Addendum-127 (red-regiment row 9): the create above already materialized
  // all four teams' mappings via mappings auto-sync on workflow save — the
  // manual mappings-tab drive this helper used to perform is gone (under
  // auto-sync those POST /admin/mappings/team-system calls would now answer
  // 400 "already mapped", and the mappable-teams droplist would be empty).
  // The regression/admin-mappings spec asserts the synced card render.
}
