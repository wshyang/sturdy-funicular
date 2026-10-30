// E2E coverage for the admin Team ↔ System Mappings tab (AdminMappings.tsx —
// GET/POST /admin/mappings/team-system, server/routes-admin-systems.tsx).
// Addendum-127: provisionSystem() no longer drives this tab — the system
// create auto-syncs the four step teams' mappings on workflow save (the sync
// itself is e2e-witnessed here as the rendered card with no manual adds);
// the remaining assertions cover card render + manual removal.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login, openAdminTab } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };
const SHORT_CODE = 'MAP1';
const SYSTEM_NAME = 'Admin Mappings Test System';

test.describe('admin mappings tab', () => {
  test('renders a system mapping card and removes a mapping', async ({ page }) => {
    let scenario!: ProvisionedScenario;

    await test.step('provision actors/teams and a system (create auto-syncs four mappings, addendum-127)', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'mappings');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: SHORT_CODE, name: SYSTEM_NAME });
    });

    await test.step('the system mapping card shows four mapped teams', async () => {
      // Click-through, not a URL deep link (addendum-099).
      await openAdminTab(page, 'mappings', 'admin-mappings__system-select');
      // Scope by the font-mono short-code span so the card locator is unique even
      // when other systems happen to have the same mapping count.
      const card = page.locator('div').filter({ has: page.locator('span.font-mono', { hasText: SHORT_CODE }) }).filter({ hasText: SYSTEM_NAME }).first();
      await expect(card).toBeVisible();
      await expect(card.getByText('4 teams mapped').first()).toBeVisible();
    });

    await test.step('removing a mapping updates the visible count', async () => {
      const card = page.locator('div').filter({ has: page.locator('span.font-mono', { hasText: SHORT_CODE }) }).filter({ hasText: SYSTEM_NAME }).first();
      const removeButton = card.getByTestId('admin-mappings__remove-button').first();
      await expect(removeButton).toBeVisible();
      page.once('dialog', (dialog) => dialog.accept());
      await removeButton.click();
      await expect(card.getByText('3 teams mapped').first()).toBeVisible();
    });
  });
});
