// E2E coverage for the owner delegation UI (OwnerSystemsView.tsx —
// GET/POST/DELETE .../owner/systems/:id/delegates[/:delegateId] —
// server/routes-owner.tsx). Only the primary owner may add/remove delegates
// (non-transitive — a delegate cannot further delegate). Previously untested
// at the UI level entirely.
import { test, expect } from '../helpers/harness';
import { E2E_USER_EMAIL, E2E_USER_PASSWORD } from '../global-setup';
import { login } from '../helpers/ui';
import { provisionActorsAndTeams, provisionSystem, type ProvisionedScenario } from '../helpers/scenario';

const SUPERADMIN = { email: E2E_USER_EMAIL, password: E2E_USER_PASSWORD };

test.describe('owner delegation', () => {
  test('primary owner adds and removes a delegate', async ({ page }) => {
    let scenario!: ProvisionedScenario;

    await test.step('provision the actor/team roster and one system', async () => {
      scenario = await provisionActorsAndTeams(page, SUPERADMIN, 'dlg');
      await login(page, SUPERADMIN.email, SUPERADMIN.password);
      await provisionSystem(page, scenario, { shortCode: 'DLG1', name: 'Delegation Test System' });
    });

    await test.step('primary owner expands the system and adds a delegate', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await page.getByTestId('owner-dashboard__tab-systems').click();

      const header = page.locator('div', { hasText: 'Delegation Test System' })
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
      await expect(page.getByText(scenario.agencyL1B.fullName, { exact: true })).toBeVisible();
    });

    await test.step('the delegate can now access the Delegate Approvals dashboard', async () => {
      await login(page, scenario.agencyL1B.email, scenario.agencyL1B.password);
      // agencyL1B is a delegate, not an owner — their dashboard is
      // /dashboard/delegate (Delegated Approvals), reached via the role droplist.
      // owner-dashboard__tab-requests only renders for system owners.
      const roleSelect = page.getByTestId('dashboard__role-select');
      await expect(roleSelect.locator('option', { hasText: 'Delegate Approver' })).toHaveCount(1);
      await roleSelect.selectOption('delegate');
      await expect(page).toHaveURL(/\/dashboard\/delegate$/);
      await expect(page.getByRole('heading', { name: 'Delegated Approvals' })).toBeVisible();
    });

    await test.step('primary owner removes the delegate', async () => {
      await login(page, scenario.owner.email, scenario.owner.password);
      await page.getByTestId('owner-dashboard__tab-systems').click();

      const header = page.locator('div', { hasText: 'Delegation Test System' })
        .filter({ has: page.getByTestId('owner-systems-view__system-header') })
        .getByTestId('owner-systems-view__system-header')
        .first();
      await header.click();

      page.once('dialog', (dialog) => dialog.accept());
      await page.getByTestId('owner-systems-view__remove-delegate-button').click();

      await expect(page.getByText('Delegate removed.')).toBeVisible();
      await expect(page.getByText(scenario.agencyL1B.fullName)).toHaveCount(0);
    });
  });
});
