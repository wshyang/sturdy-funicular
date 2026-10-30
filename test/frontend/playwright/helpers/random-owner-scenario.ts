// Provisioning for owner-pending-count.spec.ts — a randomized-structure,
// multi-system volume scenario distinct from happy-path.spec.ts/
// rejection-flows.spec.ts's fixed 9-actor roster. Three systems are built
// with DELIBERATELY different vendor/agency cluster shapes (vendor side
// fixed per the user's spec: System A has vendor L1+L2, Systems B/C have
// vendor L1 only; agency side randomized per-system at RUN TIME between
// {L1 only, L2 only, both}), owners are drawn randomly from a shared pool
// (so one person can end up owning/backing up more than one system), and
// each system's 2 vendor L1 users each submit a random 1-3 requests.
//
// Names/short codes are pregenerated (static pools below) — only the
// ASSIGNMENT of levels/owners/request-counts to systems is randomized at
// test-run time, per the user's explicit instruction.
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { login, signup, approveUser, rowButton, modalByTestId } from './ui';
import { provisionOrganization } from './scenario';

export interface Actor {
  fullName: string;
  email: string;
  password: string;
}

export type AgencyLevelSet = readonly number[];

// One of {L1 only, L2 only, both} — decided per-system at run time.
const AGENCY_LEVEL_OPTIONS: AgencyLevelSet[] = [[1], [2], [1, 2]];

function pickRandom<T>(arr: readonly T[]): T {
  const item = arr[Math.floor(Math.random() * arr.length)];
  if (item === undefined) throw new Error('pickRandom: empty source array');
  return item;
}

// Fisher-Yates-ish partial shuffle: returns `count` distinct random elements.
function pickDistinct<T>(arr: readonly T[], count: number): T[] {
  const pool = [...arr];
  const picked: T[] = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    const [item] = pool.splice(idx, 1);
    if (item !== undefined) picked.push(item);
  }
  return picked;
}

function randomInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

interface SystemDef {
  slot: 'A' | 'B' | 'C';
  name: string;
  shortCode: string;
  hasVendorL2: boolean;
}

// Pregenerated, deliberately non-overlapping names — no system's name/cluster
// name is a substring of another's, since AdminSystems.tsx's vendor-cluster
// checkboxes and agency-cluster <select> are labelled only by cluster name
// (no type/id suffix), so Playwright's hasText substring match would
// otherwise collide across systems sharing this one Playwright run's DB.
const SYSTEM_DEFS: SystemDef[] = [
  { slot: 'A', name: 'Nebula Ledger Platform', shortCode: 'NEBULA', hasVendorL2: true },
  { slot: 'B', name: 'Solstice Vault Registry', shortCode: 'SOLSTC', hasVendorL2: false },
  { slot: 'C', name: 'Ironclad Custody Archive', shortCode: 'IRONCL', hasVendorL2: false },
];

const OWNER_POOL_NAMES = ['Marlowe Vex Osgood', 'Perpetua Finch Okonkwo', 'Thaddeus Brix Delacroix', 'Wilhelmina Sable Quintrell'];

// Enough distinct names to cover every L1 user + every needed approver across
// all 3 systems without reuse (6 L1 users + up to 1 vendor-L2 + up to 6
// agency approvers = up to 13; padded to 16 for headroom).
const PERSONNEL_POOL_NAMES = [
  'Bramwell Ostrand Kessick', 'Cordelia Thrane Blackwood', 'Ezekiel Marrow Fenwick', 'Fauna Odile Ravensworth',
  'Grimshaw Aldous Pemberton', 'Halcyon Vesper Thistlewood', 'Ignatius Corbeau Wrenfield', 'Jocasta Merrin Ashgrove',
  'Kelwin Farrow Nightshade', 'Lysandra Brogue Everhart', 'Mordecai Quill Stonebridge', 'Novara Sinclaire Duskwatch',
  'Orsolya Bramblewick Frost', 'Peregrine Hollis Vance', 'Quenby Ashworth Fairweather', 'Rosalind Threnody Blackthorn',
];

export interface SystemScenario {
  slot: 'A' | 'B' | 'C';
  name: string;
  shortCode: string;
  vendorL1Users: Actor[];
  vendorL2Approver: Actor | null;
  agencyLevels: readonly number[];
  agencyApproversByLevel: Map<number, Actor>;
  primaryOwner: Actor;
  backupOwner: Actor;
  requestCountsByUser: Map<string, number>; // keyed by Actor.email
}

export interface RandomScenario {
  systems: SystemScenario[];
  ownerPool: Actor[];
}

function actor(label: string, fullName: string, runId: string): Actor {
  const email = `${label}.${runId}@test.local`;
  return { fullName: `${fullName} ${runId}`, email, password: `Pw${label.replace(/[^a-zA-Z0-9]/g, '')}!2026${runId}` };
}

// ── Phase 1: pure random-decision algorithm (no UI) ─────────────────────────
// Decides the whole scenario's shape up front so provisioning only creates
// exactly what's needed, and the spec can compute expected pending counts
// without re-deriving randomness later.
export function planRandomScenario(runId: string): RandomScenario {
  let personnelIdx = 0;
  const nextPersonnel = (label: string) => actor(label, nextPersonnelName(), runId);

  const nextPersonnelName = (): string => {
    const name = PERSONNEL_POOL_NAMES[personnelIdx++];
    if (name === undefined) throw new Error('planRandomScenario: personnel pool exhausted');
    return name;
  };

  const ownerPool = OWNER_POOL_NAMES.map((name, i) => actor(`owner${i}`, name, runId));

  const systems: SystemScenario[] = SYSTEM_DEFS.map((def) => {
    const agencyLevels = pickRandom(AGENCY_LEVEL_OPTIONS);
    const [primaryOwner, backupOwner] = pickDistinct(ownerPool, 2);
    if (!primaryOwner || !backupOwner) {
      throw new Error('planRandomScenario: owner pool must contain at least two owners');
    }

    const vendorL1Users = [
      nextPersonnel(`${def.slot}-vl1a`),
      nextPersonnel(`${def.slot}-vl1b`),
    ];
    const vendorL2Approver = def.hasVendorL2 ? nextPersonnel(`${def.slot}-vl2`) : null;

    const agencyApproversByLevel = new Map<number, Actor>();
    for (const level of agencyLevels) {
      agencyApproversByLevel.set(level, nextPersonnel(`${def.slot}-al${level}`));
    }

    const requestCountsByUser = new Map<string, number>();
    for (const u of vendorL1Users) {
      requestCountsByUser.set(u.email, randomInt(1, 3));
    }

    return {
      slot: def.slot, name: def.name, shortCode: def.shortCode,
      vendorL1Users, vendorL2Approver, agencyLevels, agencyApproversByLevel,
      primaryOwner, backupOwner, requestCountsByUser,
    };
  });

  return { systems, ownerPool };
}

// ── Phase 2: drive the real UI to build exactly what the plan calls for ────
export async function provisionRandomScenario(
  page: Page,
  superadmin: { email: string; password: string },
  runId: string,
): Promise<RandomScenario> {
  const plan = planRandomScenario(runId);

  // Sign up every actor actually referenced by the plan (owner pool + every
  // system's L1 users/approvers) — no wasted signups for unused personnel.
  const allActors: Array<{ actor: Actor; affiliation: 'agency' | 'vendor' }> = [
    ...plan.ownerPool.map((a) => ({ actor: a, affiliation: 'agency' as const })),
  ];
  for (const sys of plan.systems) {
    for (const u of sys.vendorL1Users) allActors.push({ actor: u, affiliation: 'vendor' });
    if (sys.vendorL2Approver) allActors.push({ actor: sys.vendorL2Approver, affiliation: 'vendor' });
    for (const approver of sys.agencyApproversByLevel.values()) allActors.push({ actor: approver, affiliation: 'agency' });
  }

  for (const { actor: u } of allActors) {
    await signup(page, u);
  }

  await login(page, superadmin.email, superadmin.password);

  // Addendum-206 D2: clusters need a live org anchor, and agency actors
  // approved into that org make the org-edges system<->org wiring real
  // (mirrors provisionActorsAndTeams' agencyOrg). Short code derived from
  // the runId so parallel spec worlds never collide.
  const agencyOrg = `Agency Org ${runId}`;
  const agencyOrgCode = `AG${runId.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8)}`;
  await provisionOrganization(page, { name: agencyOrg, shortCode: agencyOrgCode });
  // Back to Users for the approval pass.
  await page.getByTestId('admin-panel__tab-users').click();

  for (const { actor: u, affiliation } of allActors) {
    await approveUser(page, u.email, affiliation, 0, affiliation === 'agency' ? agencyOrg : undefined);
  }

  // Per-system cluster/team/system/workflow/mapping setup.
  for (const sys of plan.systems) {
    const vendorCluster = `${sys.name} Vendor Cluster`;
    const agencyCluster = `${sys.name} Agency Cluster`;
    const vendorL1Team = `${sys.name} Vendor L1 Team`;
    const vendorL2Team = `${sys.name} Vendor L2 Team`;
    const agencyTeamByLevel = new Map(sys.agencyLevels.map((l) => [l, `${sys.name} Agency L${l} Team`]));

    await page.getByTestId('admin-panel__tab-clusters').click();
    await page.getByTestId('admin-clusters__toggle-create-form-button').click();
    await page.getByTestId('admin-clusters__name-input').fill(vendorCluster);
    await page.getByTestId('admin-clusters__type-select').selectOption('vendor');
    // Addendum-206 D2: every cluster needs a live org anchor — a
    // vendor-typed cluster anchors to the agency org it serves.
    await page.getByTestId('admin-clusters__org-select').selectOption({ label: agencyOrg });
    await page.getByTestId('admin-clusters__submit-button').click();
    await expect(page.locator('tr', { hasText: vendorCluster })).toBeVisible();

    await page.getByTestId('admin-clusters__toggle-create-form-button').click();
    await page.getByTestId('admin-clusters__name-input').fill(agencyCluster);
    await page.getByTestId('admin-clusters__type-select').selectOption('agency');
    await page.getByTestId('admin-clusters__org-select').selectOption({ label: agencyOrg });
    await page.getByTestId('admin-clusters__submit-button').click();
    await expect(page.locator('tr', { hasText: agencyCluster })).toBeVisible();

    await page.getByTestId('admin-panel__tab-teams').click();
    const teamsToCreate: Array<[string, string, number]> = [
      [vendorL1Team, `${vendorCluster} (vendor)`, 1],
    ];
    if (sys.vendorL2Approver) teamsToCreate.push([vendorL2Team, `${vendorCluster} (vendor)`, 2]);
    for (const [level, teamName] of agencyTeamByLevel) {
      teamsToCreate.push([teamName, `${agencyCluster} (agency)`, level]);
    }
    for (const [teamName, clusterLabel, level] of teamsToCreate) {
      await page.getByTestId('admin-teams__toggle-create-form-button').click();
      await page.getByTestId('admin-teams__name-input').fill(teamName);
      await page.getByTestId('admin-teams__cluster-select').selectOption({ label: clusterLabel });
      await page.getByTestId('admin-teams__level-select').selectOption({ label: `Level ${level}` });
      await page.getByTestId('admin-teams__submit-button').click();
      await expect(page.locator('tr', { hasText: teamName })).toBeVisible();
    }

    // Membership: both vendor L1 users always; the vendor L2 approver if this
    // system has one; each agency level's approver.
    const membershipAssignments: Array<[string, Actor[]]> = [[vendorL1Team, sys.vendorL1Users]];
    if (sys.vendorL2Approver) membershipAssignments.push([vendorL2Team, [sys.vendorL2Approver]]);
    for (const [level, teamName] of agencyTeamByLevel) {
      membershipAssignments.push([teamName, [sys.agencyApproversByLevel.get(level)!]]);
    }
    for (const [teamName, members] of membershipAssignments) {
      await rowButton(page, teamName, 'admin-teams__manage-members-button').click();
      const modal = modalByTestId(page, 'team-members-modal');
      for (const member of members) {
        const affiliation = teamName === vendorL1Team || teamName === vendorL2Team ? 'vendor' : 'agency';
        await modal.getByTestId('team-members-modal__user-select')
          .selectOption({ label: `${member.fullName} (${member.email}) — ${affiliation}` });
        await modal.getByTestId('team-members-modal__add-button').click();
        await expect(modal.locator('li', { hasText: member.fullName })).toBeVisible();
      }
      await modal.getByTestId('team-members-modal__close-button').click();
    }

    // Create the system: owner pair, clusters, and a workflow built from
    // exactly the steps this system's random draw calls for (vendor L2 first,
    // if present, then each agency level ascending).
    await page.getByTestId('admin-panel__tab-systems').click();
    await page.getByTestId('admin-systems__toggle-create-form-button').click();
    await page.getByTestId('admin-systems__short-code-input').fill(sys.shortCode);
    await page.getByTestId('admin-systems__name-input').fill(sys.name);
    await page.getByTestId('admin-systems__primary-owner-select')
      .selectOption({ label: `${sys.primaryOwner.fullName} (${sys.primaryOwner.email})` });
    await page.getByTestId('admin-systems__backup-owner-select')
      .selectOption({ label: `${sys.backupOwner.fullName} (${sys.backupOwner.email})` });
    await page.locator('label', { hasText: vendorCluster }).locator('input[type="checkbox"]').check();
    await page.getByTestId('admin-systems__agency-cluster-select').selectOption({ label: agencyCluster });

    // Custody stage teams — required by form validation (addendum-144).
    // Use the first available agency team for every stage.
    const custodyTeamName = agencyTeamByLevel.values().next().value as string;
    for (const stage of ['prepare', 'initiate_handover', 'verify_return', 'return_to_inventory', 'investigate_exception']) {
      const custodySelect = page.getByTestId(`admin-systems__custody-team-${stage}`);
      const teamValue = await custodySelect.locator('option', { hasText: custodyTeamName }).getAttribute('value');
      await custodySelect.selectOption(teamValue!);
    }

    const stepBlocks = page.getByTestId('admin-systems__workflow-step');
    let stepIdx = 0;
    // Step 1 is always the SUBMITTER step (vendor L1) — per
    // addendum-027-submitter-as-workflow-step-one.md. Every system here maps
    // a vendor L1 team already (its two vendorL1Users); this wires it into
    // the workflow as the submitter, which is what actually grants those
    // users canSubmit() for this system now.
    await page.getByTestId('admin-systems__add-step-button').click();
    {
      const step = stepBlocks.nth(stepIdx++);
      await step.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await step.getByTestId('admin-systems__step-cluster-select').selectOption({ label: `${vendorCluster} (vendor)` });
      await step.getByTestId('admin-systems__step-level-select').selectOption({ label: 'Level 1' });
    }
    if (sys.vendorL2Approver) {
      await page.getByTestId('admin-systems__add-step-button').click();
      const step = stepBlocks.nth(stepIdx++);
      await step.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await step.getByTestId('admin-systems__step-cluster-select').selectOption({ label: `${vendorCluster} (vendor)` });
      await step.getByTestId('admin-systems__step-level-select').selectOption({ label: 'Level 2' });
    }
    for (const level of sys.agencyLevels) {
      await page.getByTestId('admin-systems__add-step-button').click();
      const step = stepBlocks.nth(stepIdx++);
      await step.evaluate((el) => el.scrollIntoView({ block: 'center' }));
      await step.getByTestId('admin-systems__step-cluster-select').selectOption({ label: `${agencyCluster} (agency)` });
      await step.getByTestId('admin-systems__step-level-select').selectOption({ label: `Level ${level}` });
    }

    await page.getByTestId('admin-systems__submit-create-button').click();
    await expect(page.locator('tr', { hasText: sys.name })).toBeVisible();
    // Mappings auto-sync on system create (Fix 1 / addendum-127) — the
    // manual mappings-tab loop that used to live here is gone; those POST
    // calls now answer 400 "already mapped" and the team-select is empty.
  }

  return plan;
}
