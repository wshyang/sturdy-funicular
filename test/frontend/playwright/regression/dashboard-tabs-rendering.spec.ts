// E2E coverage for ROLE-DASHBOARD TAB NAVIGATION — the suite's first spec
// that reaches every tab by CLICKING its real UI control instead of deep-
// linking with page.goto(). Every older admin spec opens its tab via
// `page.goto('/dashboard/admin/<slug>')`, which is exactly why the
// slugify() dash-stripping regression (src/app/lib/routes.ts: clicking the
// "Sent Notifications"/"Notification Templates" buttons navigated to
// /dashboard/admin/sentemails — a URL matching NO tab id, so the panel
// silently fell back to the default tab, i.e. "links that do not go
// anywhere") survived the whole suite until manual testing caught it.
//
// For each dashboard role (addendum-093: admin, owner, engineer — vendor and
// agency —, delegate, team_admin) this logs in as a real provisioned actor
// and drives that role's actual navigation controls, asserting after every
// interaction that:
//   (a) the URL lands on the tab/screen's canonical slug,
//   (b) the clicked control becomes the ACTIVE one, and
//   (c) the tab's content actually mounts (a real component testid, not just
//       the absence of an error).
//
// The roster/system/delegation are provisioned once in the FIRST test and
// shared via describe-scope (the provisionActorsAndTeams() convention) — the
// suite runs sequentially against one shared DB. Two tests, not one: the
// screenshot-count self-check enforces an even screenshot delta per run and
// each test contributes exactly one automatic end-of-test shot.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SYSTEM_SHORT_CODE = 'TABS1';
const SYSTEM_NAME = 'Tabs Rendering Test System';

// Mirrors AdminPanel.tsx's `tabs` array (id = the admin-panel__tab-<id>
// testid suffix AND the canonical URL slug) + one stable content testid that
// only exists when that tab's component really mounted. Keep in sync with
// AdminPanel.tsx when a tab is added/renamed — this array is the contract
// the dead-tab regression violated.
const ADMIN_TABS: Array<{ id: string; contentTestId: string }> = [
  { id: 'users', contentTestId: 'admin-users__view-all-tab' },
  // Q12 admin oversight (addendum-138): the 16th admin tab.
  { id: 'pending-actions', contentTestId: 'admin-pending-actions__table' },
  // Organisation dimension (addendum-114): the 15th admin tab.
  { id: 'organizations', contentTestId: 'admin-orgs__table' },
  { id: 'clusters', contentTestId: 'admin-clusters__toggle-create-form-button' },
  { id: 'teams', contentTestId: 'admin-teams__toggle-create-form-button' },
  { id: 'systems', contentTestId: 'admin-systems__toggle-create-form-button' },
  { id: 'mappings', contentTestId: 'admin-mappings__system-select' },
  { id: 'assets', contentTestId: 'admin-assets__system-select' },
  { id: 'roles', contentTestId: 'admin-roles__table' },
  { id: 'notification-templates', contentTestId: 'admin-notification-templates__table' },
  { id: 'sent-notifications', contentTestId: 'admin-sent-notifications__table' },
  { id: 'data', contentTestId: 'admin-data__export-button' },
  { id: 'access-log', contentTestId: 'admin-access-log__container' },
  { id: 'audit-log', contentTestId: 'admin-audit-log__container' },
  { id: 'app-settings', contentTestId: 'admin-app-settings' },
  { id: 'email-config', contentTestId: 'email-config__delivery-enabled-toggle' },
];

// The two tabs from the original dead-link report — these get the extra
// reload-persistence assertion (deepest possible encoding of the bug).
const REPORTED_BROKEN_TABS = new Set(['sent-notifications', 'notification-templates']);

// Owner tab ids (OwnerDashboard.tsx's TABS).
const OWNER_TABS = ['requests', 'systems', 'statistics'];

test.describe('role dashboards: every tab reachable via its real UI control', () => {
  let scenario!: ProvisionedScenario;

  test('admin and owner roles: every tab renders via click-through', async ({ page }) => {

    await test.step('provision the actor roster, one fully-mapped system, and a delegation', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'tabs');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: SYSTEM_SHORT_CODE, name: SYSTEM_NAME });

      // Owner delegates the system to agencyL1B (mirrors owner-delegation.spec.ts),
      // giving agencyL1B BOTH the engineer and delegate roles — the two-role
      // actor the second test uses to exercise the role droplist.
      await login(page, scenario.owner.email, scenario.owner.password);
      await page.getByTestId('owner-dashboard__tab-systems').click();
      const header = page.locator('div', { hasText: SYSTEM_NAME })
        .filter({ has: page.getByTestId('owner-systems-view__system-header') })
        .getByTestId('owner-systems-view__system-header')
        .first();
      await header.click();
      await page.getByTestId('owner-systems-view__add-delegate-button').click();
      const select = page.getByTestId('owner-systems-view__delegate-select');
      const optionValue = await select
        .locator('option', { hasText: scenario.agencyL1B.fullName })
        .getAttribute('value');
      await select.selectOption(optionValue!);
      await page.getByTestId('owner-systems-view__confirm-add-delegate-button').click();
      await expect(page.getByText('Delegate added successfully.')).toBeVisible();
    });

    // ── admin ────────────────────────────────────────────────────────────
    await test.step('admin role: tab bar renders all 14 tabs', async () => {
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await page.goto('/dashboard/admin');
      for (const t of ADMIN_TABS) {
        await expect(page.getByTestId(`admin-panel__tab-${t.id}`)).toBeVisible();
      }
    });

    for (const t of ADMIN_TABS) {
      await test.step(`admin tab "${t.id}" renders when clicked`, async () => {
        const btn = page.getByTestId(`admin-panel__tab-${t.id}`);
        await btn.click();
        // (a) canonical URL — the regression turned dashed ids into dashless
        // slugs (/dashboard/admin/sentemails), which this assertion catches.
        await expect(page).toHaveURL(new RegExp(`/dashboard/admin/${t.id}$`));
        // (b) the clicked tab is the ACTIVE one.
        await expect(btn).toHaveClass(/bg-red-600/);
        // (c) the tab's component actually mounted.
        await expect(page.getByTestId(t.contentTestId)).toBeVisible();

        if (REPORTED_BROKEN_TABS.has(t.id)) {
          // Deep-link resilience for the exact two URLs from the bug report:
          // reload (a fresh parse of the pathname) must stay on this tab.
          await page.reload();
          await expect(page).toHaveURL(new RegExp(`/dashboard/admin/${t.id}$`));
          await expect(page.getByTestId(t.contentTestId)).toBeVisible();
        }
      });
    }

    // ── owner ────────────────────────────────────────────────────────────
    await test.step('owner role: tab bar renders all 3 tabs', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await page.goto('/dashboard/owner');
      for (const id of OWNER_TABS) {
        await expect(page.getByTestId(`owner-dashboard__tab-${id}`)).toBeVisible();
      }
    });

    for (const id of OWNER_TABS) {
      await test.step(`owner tab "${id}" renders when clicked`, async () => {
        const btn = page.getByTestId(`owner-dashboard__tab-${id}`);
        await btn.click();
        await expect(page).toHaveURL(new RegExp(`/dashboard/owner/${id}$`));
        await expect(btn).toHaveClass(/border-emerald-500/);
        if (id === 'requests') {
          await expect(page.getByTestId('owner-dashboard__stat-pending-review-count')).toBeVisible();
        } else if (id === 'systems') {
          // OwnerSystemsView mounts with the provisioned system card.
          await expect(page.getByTestId('owner-systems-view__system-header').first()).toBeVisible();
        } else {
          // StatisticsView always mounts its filter panel (charts only render
          // after Apply Filters).
          await expect(page.getByTestId('statistics-view__system-select')).toBeVisible();
        }
      });
    }
  });

  test('engineer, delegate and team_admin roles: screens render via view controls and the role droplist', async ({ page }) => {
    // scenario was provisioned by the first test in this describe (shared
    // roster convention — provisionActorsAndTeams() runs once per spec file).

    // ── engineer (vendor) — list + submit-form views via the real button ──
    await test.step('engineer (vendor): request list and submit-form views are reachable', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      await page.goto('/dashboard/engineer');
      const openSubmit = page.getByTestId('vendor-dashboard__open-submit-button');
      await expect(openSubmit).toBeVisible();
      await expect(page.getByRole('heading', { name: 'My Requests' })).toBeVisible();

      await openSubmit.click();
      await expect(page).toHaveURL(/\/dashboard\/engineer\/new$/);
      await expect(page.getByTestId('vendor-dashboard__system-select')).toBeVisible();

      await page.getByTestId('vendor-dashboard__cancel-submit-button').click();
      await expect(page).toHaveURL(/\/dashboard\/engineer$/);
      await expect(openSubmit).toBeVisible();
    });

    // ── engineer (agency) — the agency variant of the same dashboard ──────
    await test.step('engineer (agency): agency request list renders', async () => {
      await login(page, scenario.agencyL1A.email, scenario.agencyL1A.password);
      await page.goto('/dashboard/engineer');
      await expect(page.getByRole('heading', { name: 'Agency Engineer Dashboard' })).toBeVisible();
      await expect(page.getByText('Request #').first()).toBeVisible();
    });

    // ── delegate — reached through the real role-droplist control ─────────
    await test.step('delegate: role droplist switches to the Delegate Approval panel', async () => {
      await login(page, scenario.agencyL1B.email, scenario.agencyL1B.password);
      // agencyL1B holds engineer + delegate — the droplist is the real
      // UI control a two-role user uses to reach this screen.
      const roleSelect = page.getByTestId('dashboard__role-select');
      await expect(roleSelect).toBeVisible();
      await expect(roleSelect.locator('option', { hasText: 'Agency Engineer' })).toHaveCount(1);
      await expect(roleSelect.locator('option', { hasText: 'Delegate Approver' })).toHaveCount(1);

      await roleSelect.selectOption('delegate');
      await expect(page).toHaveURL(/\/dashboard\/delegate$/);
      await expect(page.getByRole('heading', { name: 'Delegated Approvals' })).toBeVisible();
    });

    // ── team_admin — the underscore role key and its dashed slug ─────────
    await test.step('team_admin: role droplist switches to My Teams (team-admin slug)', async () => {
      await login(page, scenario.vendorL1A.email, scenario.vendorL1A.password);
      // vendorL1A holds engineer + team_admin (first member added to the
      // vendor L1 team — Constraint #15).
      const roleSelect = page.getByTestId('dashboard__role-select');
      await expect(roleSelect).toBeVisible();

      await roleSelect.selectOption('team_admin');
      // Role key team_admin normalizes to the dashed slug team-admin.
      await expect(page).toHaveURL(/\/dashboard\/team-admin$/);
      await expect(page.getByRole('heading', { name: 'My Teams' })).toBeVisible();
      await expect(page.getByTestId('my-teams__manage-members-button').first()).toBeVisible();
    });
  });
});
