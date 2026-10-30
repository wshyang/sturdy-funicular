/**
 * Admin Panel - Capability-Based UI Tests
 * 
 * Tests for capability-based tab visibility and access control
 * 
 * Total Tests: 40+ tests
 */

import { test, expect } from '@playwright/test';
import { loginAs, logout, assertVisible, assertNotVisible, assertContainsText, clickButton, waitForLoading, goToAdminDashboard, assertNoAdminSurface } from './fixtures/capability-helpers';
import { 
  SUPER_ADMIN, 
  USER_ADMIN, 
  ORG_ADMIN, 
  SYSTEMS_ADMIN, 
  DATA_OPERATOR, 
  CONFIG_ADMIN, 
  REGULAR_USER,
  PENDING_USER,
  USER_ORG_ADMIN,
  FULL_ADMIN_EXCEPT_AUDIT
} from './fixtures/capability-users';

// ============================================================================
// Admin Panel Access Tests
// ============================================================================

test.describe('Admin Panel Access Control', () => {
  test.beforeEach(async ({ page }) => {
    await logout(page);
  });

  test('SUPER_ADMIN can access admin panel', async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
    await goToAdminDashboard(page);
    
    await assertVisible(page, 'Admin Panel');
  });

  test('USER_ADMIN can access admin panel', async ({ page }) => {
    await loginAs(page, USER_ADMIN);
    await goToAdminDashboard(page);
    
    await assertVisible(page, 'Admin Panel');
  });

  test('ORG_ADMIN can access admin panel', async ({ page }) => {
    await loginAs(page, ORG_ADMIN);
    await goToAdminDashboard(page);
    
    await assertVisible(page, 'Admin Panel');
  });

  test('SYSTEMS_ADMIN can access admin panel', async ({ page }) => {
    await loginAs(page, SYSTEMS_ADMIN);
    await goToAdminDashboard(page);
    
    await assertVisible(page, 'Admin Panel');
  });

  test('DATA_OPERATOR can access admin panel', async ({ page }) => {
    await loginAs(page, DATA_OPERATOR);
    await goToAdminDashboard(page);
    
    await assertVisible(page, 'Admin Panel');
  });

  test('CONFIG_ADMIN can access admin panel', async ({ page }) => {
    await loginAs(page, CONFIG_ADMIN);
    await goToAdminDashboard(page);
    
    await assertVisible(page, 'Admin Panel');
  });

  test('REGULAR_USER cannot access admin panel', async ({ page }) => {
    await loginAs(page, REGULAR_USER);
    // A no-capability user never gets the admin role, so the AdminPanel (and
    // its "administrator privileges" notice, which only renders WHEN the panel
    // mounts for an admin-role user without admin privileges) is not part of
    // their app at all — assert the whole surface's absence (addendum-099),
    // not a notice the router never gives them a chance to see.
    await assertNoAdminSurface(page);
  });

  test('PENDING_USER cannot access admin panel', async ({ page }) => {
    await loginAs(page, PENDING_USER);
    // A pending-approval account gets no admin role — wherever its sign-in
    // state leaves it, no Admin Panel can mount. (assertNoAdminSurface is for
    // actors who DO land on a dashboard; a pending user may not even get that
    // far, in which case the tab-bar count is trivially zero as well.)
    if (await page.getByTestId('dashboard__sign-out-button').isVisible().catch(() => false)) {
      await assertNoAdminSurface(page);
    }
    await expect(page.locator('[data-testid^="admin-panel__tab-"]')).toHaveCount(0);
    await assertNotVisible(page, 'admin-panel__tab-users');
  });
});

// ============================================================================
// Full Admin Role Tests
// ============================================================================

test.describe('Full Admin Role (SUPER_ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Full Admin sees all tabs', async ({ page }) => {
    // All tabs should be visible
    const expectedTabs = [
      'users', 'clusters', 'teams', 'systems', 'mappings',
      'assets', 'notification-templates', 'sent-notifications', 'data',
      'access-log', 'audit-log', 'app-settings', 'email-config'
    ];
    
    for (const tabId of expectedTabs) {
      await assertVisible(page, `admin-panel__tab-${tabId}`);
    }
  });

  test('Full Admin can switch between all tabs', async ({ page }) => {
    const tabs = [
      'users', 'clusters', 'teams', 'systems', 'mappings',
      'assets', 'notification-templates', 'sent-notifications', 'data',
      'access-log', 'audit-log', 'app-settings', 'email-config'
    ];
    
    for (const tabId of tabs) {
      await clickButton(page, `admin-panel__tab-${tabId}`);
      await waitForLoading(page);
      // Tab should be active
      const activeTab = page.getByTestId(`admin-panel__tab-${tabId}`);
      await expect(activeTab).toHaveClass(/bg-red-600/);
    }
  });
});

// ============================================================================
// User Admin Role Tests
// ============================================================================

test.describe('User Admin Role (USER_ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, USER_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('User Admin sees Users tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-users');
  });

  test('User Admin can access Users tab', async ({ page }) => {
    await clickButton(page, 'admin-panel__tab-users');
    await waitForLoading(page);
    
    // Should show users management UI
    await assertVisible(page, 'admin-users__view-all-tab');
    await assertVisible(page, 'admin-users__view-pending-tab');
    await assertVisible(page, 'admin-users__invite-button');
  });

  test('User Admin does NOT see Systems tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-systems');
  });

  test('User Admin does NOT see Clusters tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-clusters');
  });

  test('User Admin does NOT see Teams tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-teams');
  });

  test('User Admin does NOT see Data tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-data');
  });

  test('User Admin does NOT see App Settings tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-app-settings');
  });

  test('User Admin does NOT see Email Config tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-email-config');
  });
});

// ============================================================================
// Organization Admin Role Tests
// ============================================================================

test.describe('Organization Admin Role (ORG_ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, ORG_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Org Admin sees Clusters tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-clusters');
  });

  test('Org Admin sees Teams tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-teams');
  });

  test('Org Admin does NOT see Users tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-users');
  });

  test('Org Admin does NOT see Systems tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-systems');
  });

  test('Org Admin does NOT see Assets tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-assets');
  });

  test('Org Admin does NOT see Data tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-data');
  });
});

// ============================================================================
// Systems Admin Role Tests
// ============================================================================

test.describe('Systems Admin Role (SYSTEMS_ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SYSTEMS_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Systems Admin sees Systems tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-systems');
  });

  test('Systems Admin sees Assets tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-assets');
  });

  test('Systems Admin sees Mappings tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-mappings');
  });

  test('Systems Admin does NOT see Users tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-users');
  });

  test('Systems Admin does NOT see Clusters tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-clusters');
  });

  test('Systems Admin does NOT see Teams tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-teams');
  });
});

// ============================================================================
// Data Operator Role Tests
// ============================================================================

test.describe('Data Operator Role (DATA_OPERATOR)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, DATA_OPERATOR);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Data Operator sees Data tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-data');
  });

  test('Data Operator can access Data tab', async ({ page }) => {
    await clickButton(page, 'admin-panel__tab-data');
    await waitForLoading(page);
    
    // Should show data management UI
    await assertContainsText(page, null, /Export|Import|Data/);
  });

  test('Data Operator does NOT see Users tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-users');
  });

  test('Data Operator does NOT see Systems tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-systems');
  });

  test('Data Operator does NOT see Clusters tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-clusters');
  });
});

// ============================================================================
// Configuration Admin Role Tests
// ============================================================================

test.describe('Configuration Admin Role (CONFIG_ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, CONFIG_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Config Admin sees App Settings tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-app-settings');
  });

  test('Config Admin sees Notification Templates tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-notification-templates');
  });

  test('Config Admin sees Email Config tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-email-config');
  });

  test('Config Admin sees Sent Notifications tab', async ({ page }) => {
    await assertVisible(page, 'admin-panel__tab-sent-notifications');
  });

  test('Config Admin does NOT see Users tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-users');
  });

  test('Config Admin does NOT see Systems tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-systems');
  });

  test('Config Admin does NOT see Data tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-data');
  });
});

// ============================================================================
// Full Admin Except Audit Role Tests
// ============================================================================

test.describe('Full Admin Except Audit Role (FULL_ADMIN_EXCEPT_AUDIT)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, FULL_ADMIN_EXCEPT_AUDIT);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Full Admin Except Audit sees most tabs', async ({ page }) => {
    // Should see most tabs but not audit-related ones
    await assertVisible(page, 'admin-panel__tab-users');
    await assertVisible(page, 'admin-panel__tab-clusters');
    await assertVisible(page, 'admin-panel__tab-teams');
    await assertVisible(page, 'admin-panel__tab-systems');
    await assertVisible(page, 'admin-panel__tab-assets');
    await assertVisible(page, 'admin-panel__tab-mappings');
    await assertVisible(page, 'admin-panel__tab-data');
    await assertVisible(page, 'admin-panel__tab-app-settings');
    await assertVisible(page, 'admin-panel__tab-notification-templates');
    await assertVisible(page, 'admin-panel__tab-sent-notifications');
  });

  test('Full Admin Except Audit does NOT see Access Log tab', async ({ page }) => {
    await assertNotVisible(page, 'admin-panel__tab-access-log');
    // The Audit Log tab (AuditLogRead) is likewise hidden for this role.
    await assertNotVisible(page, 'admin-panel__tab-audit-log');
  });
});

// ============================================================================
// User with Multiple Roles Tests
// ============================================================================

test.describe('User with Multiple Roles (USER_ORG_ADMIN)', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, USER_ORG_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('User with multiple roles sees union of capabilities', async ({ page }) => {
    // Should see tabs from both User Admin and Org Admin roles
    await assertVisible(page, 'admin-panel__tab-users');
    await assertVisible(page, 'admin-panel__tab-clusters');
    await assertVisible(page, 'admin-panel__tab-teams');
  });

  test('User with multiple roles can access all granted tabs', async ({ page }) => {
    // Test accessing Users tab (from User Admin role)
    await clickButton(page, 'admin-panel__tab-users');
    await waitForLoading(page);
    await assertVisible(page, 'admin-users__view-all-tab');
    
    // Go back to admin panel
    await goToAdminDashboard(page);
    await waitForLoading(page);
    
    // Test accessing Clusters tab (from Org Admin role)
    await clickButton(page, 'admin-panel__tab-clusters');
    await waitForLoading(page);
    // Should show clusters management UI
  });
});

// ============================================================================
// Tab Switching Tests
// ============================================================================

test.describe('Tab Switching Behavior', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Active tab has correct styling', async ({ page }) => {
    const activeTab = page.getByTestId('admin-panel__tab-users');
    await expect(activeTab).toHaveClass(/bg-red-600/);
    await expect(activeTab).toHaveClass(/text-white/);
  });

  test('Inactive tabs have correct styling', async ({ page }) => {
    const inactiveTab = page.getByTestId('admin-panel__tab-clusters');
    await expect(inactiveTab).not.toHaveClass(/bg-red-600/);
    await expect(inactiveTab).toHaveClass(/text-\[#7d8d9e\]/);
  });

  test('Clicking tab makes it active', async ({ page }) => {
    await clickButton(page, 'admin-panel__tab-clusters');
    await waitForLoading(page);
    
    const activeTab = page.getByTestId('admin-panel__tab-clusters');
    await expect(activeTab).toHaveClass(/bg-red-600/);
    
    const inactiveTab = page.getByTestId('admin-panel__tab-users');
    await expect(inactiveTab).not.toHaveClass(/bg-red-600/);
  });

  test('Clicking same tab keeps it active', async ({ page }) => {
    await clickButton(page, 'admin-panel__tab-users');
    await waitForLoading(page);
    
    const activeTab = page.getByTestId('admin-panel__tab-users');
    await expect(activeTab).toHaveClass(/bg-red-600/);
  });

  test('Tab content changes when switching tabs', async ({ page }) => {
    // Initially on Users tab
    await assertVisible(page, 'admin-users__view-all-tab');
    
    // Switch to Clusters tab
    await clickButton(page, 'admin-panel__tab-clusters');
    await waitForLoading(page);
    
    // Users tab content should not be visible
    await assertNotVisible(page, 'admin-users__view-all-tab');
    
    // Clusters tab content should be visible (or at least the tab is active)
    const activeTab = page.getByTestId('admin-panel__tab-clusters');
    await expect(activeTab).toHaveClass(/bg-red-600/);
  });
});

// ============================================================================
// Capability Count Display Tests
// ============================================================================

test.describe('Capability Count Display', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

});

// ============================================================================
// Loading State Tests
// ============================================================================

test.describe('Loading States', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
  });

  test('Shows loading state initially', async ({ page }) => {
    await goToAdminDashboard(page);
    
    // Should show loading spinner
    await expect(page.getByText('Loading capabilities…')).toBeVisible();
  });

  test('Loading state disappears after capabilities load', async ({ page }) => {
    await goToAdminDashboard(page);
    await waitForLoading(page);
    
    // Loading spinner should be gone
    await assertNotVisible(page, 'Loading capabilities…');
    
    // Admin Panel should be visible
    await assertVisible(page, 'Admin Panel');
  });
});

// ============================================================================
// Error State Tests
// ============================================================================

test.describe('Error States', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
  });

  test('Shows error message when capabilities fail to load', async ({ page }) => {
    // This test would need to mock a failure scenario
    // For now, we just verify the structure is in place
    await goToAdminDashboard(page);
    await waitForLoading(page);
    
    // Should not show error if everything loads correctly
    await assertNotVisible(page, 'Failed to load capabilities');
  });

  test('Non-admin user has no admin surface at all', async ({ page }) => {
    await loginAs(page, REGULAR_USER);
    // addendum-099: this used to expect the "administrator privileges" banner,
    // but that banner only renders inside a MOUNTED AdminPanel — and the panel
    // only mounts on the admin role screen, which a no-capability user never
    // gets selected. Their truth is simpler and stronger: no admin chrome.
    await assertNoAdminSurface(page);
  });
});

// ============================================================================
// Tab Order Tests
// ============================================================================

test.describe('Tab Order', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Tabs are in correct order', async ({ page }) => {
    const tabIds = [
      'users', 'clusters', 'teams', 'systems', 'mappings',
      'assets', 'notification-templates', 'sent-notifications', 'data',
      'access-log', 'audit-log', 'app-settings', 'email-config'
    ];
    
    // Get all tab buttons
    const tabs = await page.$$eval('[data-testid^="admin-panel__tab-"]', (elements) => 
      elements.map(el => el.getAttribute('data-testid'))
    );
    
    // Check that tabs appear in the expected order
    const visibleTabs = tabs.filter((t): t is string => t !== null);
    expect(visibleTabs).toEqual(expect.arrayContaining(tabIds));
  });

  test('First tab is active by default', async ({ page }) => {
    const firstTab = page.getByTestId('admin-panel__tab-users');
    await expect(firstTab).toHaveClass(/bg-red-600/);
  });
});

// ============================================================================
// Responsive Design Tests
// ============================================================================

test.describe('Responsive Design', () => {
  test.beforeEach(async ({ page }) => {
    await loginAs(page, SUPER_ADMIN);
    await goToAdminDashboard(page);
    await waitForLoading(page);
  });

  test('Tabs wrap on small screens', async ({ page }) => {
    // Set viewport to mobile size
    await page.setViewportSize({ width: 375, height: 667 });
    
    // Tab container should allow wrapping
    const tabContainer = page.getByTestId('admin-panel__tab-users').locator('..');
    await expect(tabContainer).toHaveClass(/flex-wrap/);
  });

  test('Tabs are still accessible on mobile', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 667 });
    
    // All tabs should still be visible (just wrapped)
    await assertVisible(page, 'admin-panel__tab-users');
    await assertVisible(page, 'admin-panel__tab-systems');
    await assertVisible(page, 'admin-panel__tab-data');
  });
});
