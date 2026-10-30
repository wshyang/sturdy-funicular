// E2E coverage for ORG-SCOPED admin grants — the "<Org> only" option in the
// Edit Roles modal — and the org boundary they are supposed to enforce.
//
// WHY THIS SPEC EXISTS
//
// Two independent gaps met here:
//
// 1. Every existing e2e spec grants `full_admin` or `user_admin`, always
//    GLOBAL. The scope <select> (admin-users__edit-role-scope-<key>) that
//    turns a grant into "Org X only" had jsdom unit coverage but had never
//    been driven end-to-end — nothing asserted that choosing an org in that
//    dropdown actually constrains what the grantee can see.
//
// 2. That un-exercised path was hiding a real cross-org data leak.
//    getCapabilitySnapshot() derived its admin flag from isAdminUser(), which
//    counts org-SCOPED grants, so ANY scoped grant set
//    visibleSystemIds = VISIBLE_ALL — a system-wide read bypass. One scoped
//    grant exposed every system and every break-glass request in the
//    deployment. Fixed by switching to hasGlobalAdminGrant()
//    (addendum-207 §3.3 had pinned the over-reach as accepted; addendum-211
//    resolves it).
//
// The backend suites lock the API behaviour down. This spec locks down what
// an operator actually experiences: after granting "Org B only" through the
// real modal, the grantee's dashboard must not surface another org's systems.
// A regression in the snapshot would turn the dropdown into decoration, and
// only a UI-level test notices that.
//
// Suite invariants honoured: exactly 2 tests (even), zero screenshot calls,
// real-UI discipline — every mutation goes through the admin UI.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, logout, signup, openAdminTab, approveUser } from '../helpers/ui';
import { provisionOrganization } from '../helpers/scenario';
import type { Page } from '@playwright/test';

// The SPA talks to the backend at VITE_API_BASE (an absolute origin in e2e,
// see config/playwright.config.ts), not a same-origin /api prefix. Read the
// snapshot the same way the app does so this asserts the real wire response.
const API_BASE = process.env['VITE_API_BASE'] ?? 'http://localhost:8789';

async function getJson(page: Page, path: string): Promise<{ status: number; body: any }> {
  return await page.evaluate(async ([base, p]) => {
    const res = await fetch(`${base}${p}`, { credentials: 'include' });
    return { status: res.status, body: await res.json() };
  }, [API_BASE, path] as const);
}

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

// Unique per run so repeated runs against the shared breakglass_test database
// never collide on the org name / email uniqueness constraints.
const RUN = `sab${Date.now().toString(36)}`;
const ORG_ALPHA = `Scoped Alpha ${RUN}`;
const ORG_BETA = `Scoped Beta ${RUN}`;

const scopedAdmin = {
  fullName: `Scoped Admin ${RUN}`,
  email: `scoped.admin.${RUN}@test.local`,
  password: `ScopedPass!2026${RUN}`,
};

// Opens Edit Roles for `email` and returns the modal locator. Edit Roles is
// offered only for agency-affiliated users (AdminUsersRowActionsMenu.tsx).
async function openEditRoles(page: Page, email: string) {
  await openAdminTab(page, 'users', 'admin-users__view-pending-tab');
  // Approved users live under "All Users", not the default Pending view.
  await page.getByTestId('admin-users__view-all-tab').click();

  const row = page.locator('tr', { hasText: email });
  await expect(row).toBeVisible({ timeout: 15000 });
  await row.getByTestId('admin-users__row-menu-button').click();
  await page.getByTestId('admin-users__edit-roles-button').click();

  const modal = page.getByTestId('admin-users__edit-roles-modal');
  await expect(modal).toBeVisible();
  return modal;
}

test.describe('org-scoped admin grants (addendum-137 §4 / addendum-211)', () => {
  test('the Edit Roles scope picker offers Global vs per-org, and persists an org-scoped grant', async ({ page }) => {
    await test.step('log in as superadmin and create two organisations', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'organizations', 'admin-orgs__table');
      await provisionOrganization(page, { name: ORG_ALPHA, shortCode: `A${RUN.slice(-4)}`.toUpperCase().slice(0, 10) });
      await provisionOrganization(page, { name: ORG_BETA, shortCode: `B${RUN.slice(-4)}`.toUpperCase().slice(0, 10) });
    });

    await test.step('sign up an agency user and approve them into Alpha', async () => {
      await logout(page);
      await signup(page, scopedAdmin);
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await openAdminTab(page, 'users', 'admin-users__view-pending-tab');
      await approveUser(page, scopedAdmin.email, 'agency', 0, ORG_ALPHA);
    });

    await test.step('the scope picker appears only once a role is checked', async () => {
      const modal = await openEditRoles(page, scopedAdmin.email);

      // Unchecked → no scope <select> for that role. The dropdown is
      // deliberately conditional: scoping nothing is meaningless.
      await expect(modal.getByTestId('admin-users__edit-role-scope-org_structure_admin')).toHaveCount(0);

      await modal.getByTestId('admin-users__edit-role-org_structure_admin').check();
      const scope = modal.getByTestId('admin-users__edit-role-scope-org_structure_admin');
      await expect(scope).toBeVisible();

      // Defaults to global, and both organisations are offered by name.
      await expect(scope).toHaveValue('');
      await expect(scope.locator('option')).toContainText([
        'Global — all organisations',
        `${ORG_ALPHA} only`,
        `${ORG_BETA} only`,
      ]);
    });

    await test.step('choosing "Beta only" saves an org-scoped grant that survives a reopen', async () => {
      const modal = page.getByTestId('admin-users__edit-roles-modal');
      const scope = modal.getByTestId('admin-users__edit-role-scope-org_structure_admin');
      await scope.selectOption({ label: `${ORG_BETA} only` });
      await modal.getByTestId('admin-users__edit-roles-save').click();
      await expect(modal).toBeHidden();

      // Reopen: the checkbox is still checked and the scope still reads Beta —
      // i.e. the scope round-tripped to the server, it is not just local state.
      const reopened = await openEditRoles(page, scopedAdmin.email);
      await expect(reopened.getByTestId('admin-users__edit-role-org_structure_admin')).toBeChecked();
      const persisted = reopened.getByTestId('admin-users__edit-role-scope-org_structure_admin');
      await expect(persisted).toBeVisible();
      await expect(persisted.locator('option:checked')).toHaveText(`${ORG_BETA} only`);
      await reopened.getByTestId('admin-users__edit-roles-save').click();
      await expect(reopened).toBeHidden();
    });
  });

  test('a scoped admin does not gain global system visibility (addendum-211 leak regression)', async ({ page }) => {
    // The user from test 1 now holds exactly one grant: org_structure_admin
    // scoped to Beta. They own no system, review no system and submitted
    // nothing, so their RUNTIME plane must be empty — a scoped grant confers
    // an admin surface for its own org, never a system-wide read bypass.
    //
    // Before the fix this failed loudly: the snapshot handed them VISIBLE_ALL
    // and the dashboard listed every system in the deployment.
    await test.step('log in as the scoped admin', async () => {
      await login(page, scopedAdmin.email, scopedAdmin.password);
    });

    await test.step('the capability snapshot is NOT the global-admin bypass', async () => {
      // Read the app's own snapshot endpoint through the authenticated page
      // context, so this asserts what the SPA itself was handed.
      const snap = await getJson(page, '/me/capability-snapshot');
      expect(snap.status).toBe(200);

      // '*' is VISIBLE_ALL. A scoped admin must get a concrete (here empty)
      // list instead — that single character is the whole bug.
      expect(snap.body.snapshot.visibleSystemIds).not.toBe('*');
      expect(Array.isArray(snap.body.snapshot.visibleSystemIds)).toBe(true);
      expect(snap.body.snapshot.visibleSystemIds).toEqual([]);

      // isAdmin is the GLOBAL-admin flag; a scoped holder is not one…
      expect(snap.body.snapshot.isAdmin).toBe(false);
      // …but their scoped reach is still reported, so the admin surface works.
      expect(snap.body.snapshot.scopedGrants.length).toBeGreaterThan(0);
      expect(snap.body.snapshot.organizations.length).toBeGreaterThan(0);
    });

    await test.step('/my-systems returns no systems for a scoped admin who owns none', async () => {
      const mine = await getJson(page, '/my-systems');
      expect(mine.status).toBe(200);
      expect(mine.body.systems).toEqual([]);
    });

    await test.step('the superadmin, by contrast, still sees the global surface', async () => {
      // Guards the other direction: the fix must not have narrowed a genuine
      // global admin. Without this, "everyone sees nothing" would also pass.
      await logout(page);
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      const snap = (await getJson(page, '/me/capability-snapshot')).body;
      expect(snap.snapshot.visibleSystemIds).toBe('*');
      expect(snap.snapshot.isAdmin).toBe(true);
    });
  });
});
