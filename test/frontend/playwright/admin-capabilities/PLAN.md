# Frontend Admin Capabilities Test Suite - Plan

## Overview

This document outlines the plan for creating a **Playwright-based frontend test suite** for the Additive Admin Role Grants System. This mirrors the backend test suite but tests the **UI behavior** and **frontend authorization** rather than direct database operations.

## 🎯 Goals

1. Test that UI elements are **visible/hidden** based on user capabilities
2. Test that **actions succeed/fail** based on user capabilities
3. Test **error messages** when users lack required capabilities
4. Test **navigation** to admin pages based on capabilities
5. Follow the **baseline/positive/negative** pattern for each capability

## 🔍 Key Differences from Backend Tests

| Aspect | Backend Tests | Frontend Tests |
|--------|---------------|----------------|
| **Test Level** | Database/API | UI/Browser |
| **User Context** | Direct user ID | Authenticated session |
| **Capability Check** | `hasAdminPrivilege()` | UI element visibility, action success |
| **Setup** | Grant/revoke roles in DB | Log in as user with roles |
| **Assertions** | Boolean return values | Element visibility, navigation, error messages |
| **Speed** | Fast (direct DB) | Slower (browser automation) |

## 📁 Proposed File Structure

```
test/frontend/playwright/admin-capabilities/
├── fixtures/
│   ├── capability-users.ts          # Test user fixtures with specific capabilities
│   └── capability-helpers.ts        # Helper functions for capability testing
├── tests/
│   ├── user-management/
│   │   ├── user-read.test.ts        # Tests for UserRead capability
│   │   ├── user-invite.test.ts      # Tests for UserInvite capability
│   │   └── ...
│   ├── org-structure/
│   │   ├── cluster-read.test.ts
│   │   └── ...
│   ├── systems-assets/
│   │   ├── system-read.test.ts
│   │   └── ...
│   ├── data-operations/
│   │   ├── data-export.test.ts
│   │   └── ...
│   ├── configuration/
│   │   ├── config-app-settings-read.test.ts
│   │   └── ...
│   ├── audit/
│   │   ├── audit-log-read.test.ts
│   │   └── ...
│   └── admin/
│       ├── admin-roles-manage.test.ts
│       └── admin-capabilities-debug-view.test.ts
├── PLAN.md                          # This file
└── README.md                        # Test suite documentation
```

## 🧩 Test Fixtures

### 1. Capability Users Fixture (`fixtures/capability-users.ts`)

Predefined test users with specific capabilities:

```typescript
// Super Admin - has ALL capabilities
export const SUPER_ADMIN = {
  email: 'super.admin@test.local',
  password: 'SuperAdmin!2026',
  roles: ['full_admin'],
  capabilities: ALL_CAPABILITIES
};

// User Admin - has user management capabilities only
export const USER_ADMIN = {
  email: 'user.admin@test.local',
  password: 'UserAdmin!2026',
  roles: ['user_admin'],
  capabilities: new Set(['UserRead', 'UserInvite', 'UserApprove', 'UserReject', 
                          'UserTombstone', 'UserUntombstone', 'UserAffiliationChange'])
};

// Org Structure Admin - has cluster/team capabilities
export const ORG_ADMIN = {
  email: 'org.admin@test.local',
  password: 'OrgAdmin!2026',
  roles: ['org_structure_admin'],
  capabilities: new Set(['ClusterRead', 'ClusterCreate', 'ClusterUpdate', 'ClusterDelete',
                          'TeamRead', 'TeamCreate', 'TeamUpdate', 'TeamDelete',
                          'TeamMemberRead', 'TeamMemberManage'])
};

// Systems Admin - has system/asset capabilities
export const SYSTEMS_ADMIN = {
  email: 'systems.admin@test.local',
  password: 'SystemsAdmin!2026',
  roles: ['systems_assets_admin'],
  capabilities: new Set(['SystemRead', 'SystemCreate', 'SystemUpdate', 'SystemDelete',
                          'SystemMappingRead', 'SystemMappableTeamsRead', 'SystemOwnerManage',
                          'TeamSystemMappingManage', 'OwnerPAMappingManage',
                          'AssetRead', 'AssetCreate', 'AssetUpdate', 'AssetDelete', 'AssetSync'])
};

// Data Operator - has data operation capabilities
export const DATA_OPERATOR = {
  email: 'data.operator@test.local',
  password: 'DataOperator!2026',
  roles: ['data_operator'],
  capabilities: new Set(['DataExport', 'DataImport', 'DataResetSeed', 'RequestAdminReset'])
};

// Config Admin - has configuration capabilities
export const CONFIG_ADMIN = {
  email: 'config.admin@test.local',
  password: 'ConfigAdmin!2026',
  roles: ['config_audit_admin'],
  capabilities: new Set(['ConfigAppSettingsRead', 'ConfigAppSettingsWrite',
                          'ConfigEmailTemplateRead', 'ConfigEmailTemplateWrite',
                          'AuditLogRead', 'AuditAccessLogRead', 'AuditSentNotificationsRead'])
};

// Regular User - has NO admin capabilities
export const REGULAR_USER = {
  email: 'regular.user@test.local',
  password: 'RegularUser!2026',
  roles: [],
  capabilities: new Set()
};

// Custom users with specific capabilities (for edge case testing)
export const CUSTOM_USER_1 = {
  email: 'custom1@test.local',
  password: 'Custom1!2026',
  roles: [],
  capabilities: new Set(['UserRead', 'ClusterRead']) // Custom capability set
};
```

### 2. Capability Helpers Fixture (`fixtures/capability-helpers.ts`)

Utility functions for capability testing:

```typescript
import { Page, Locator } from '@playwright/test';

/**
 * Log in as a specific user with capabilities.
 */
export async function loginAsCapabilityUser(page: Page, user: TestUser): Promise<void> {
  await page.goto('/login');
  await page.fill('input[name="email"]', user.email);
  await page.fill('input[name="password"]', user.password);
  await page.click('button[type="submit"]');
  await page.waitForURL('/dashboard');
}

/**
 * Navigate to admin panel.
 */
export async function navigateToAdminPanel(page: Page): Promise<void> {
  await page.click('a[href="/admin"]');
  await page.waitForURL('/admin');
}

/**
 * Check if an element is visible (for capability-gated UI elements).
 */
export async function assertElementVisible(page: Page, selector: string, shouldBeVisible: boolean): Promise<void> {
  const element = page.locator(selector);
  if (shouldBeVisible) {
    await expect(element).toBeVisible();
  } else {
    await expect(element).not.toBeVisible();
  }
}

/**
 * Check if an action is allowed (doesn't throw error).
 */
export async function assertActionAllowed(page: Page, action: () => Promise<void>, shouldBeAllowed: boolean): Promise<void> {
  if (shouldBeAllowed) {
    await expect(action()).resolves.toBeTruthy();
  } else {
    await expect(action()).rejects.toThrow();
  }
}

/**
 * Check for specific error message.
 */
export async function assertErrorMessage(page: Page, expectedMessage: string): Promise<void> {
  await expect(page.locator('.error-message')).toHaveText(expectedMessage);
}

/**
 * Wait for and dismiss notifications.
 */
export async function dismissNotifications(page: Page): Promise<void> {
  const notifications = page.locator('.notification');
  const count = await notifications.count();
  for (let i = 0; i < count; i++) {
    await notifications.nth(i).click(); // Assuming click dismisses
  }
}

/**
 * Get test user by capability.
 */
export function getUserWithCapability(capability: string): TestUser {
  // Map capabilities to test users
  const userMap: Record<string, TestUser> = {
    // User Management
    'UserRead': USER_ADMIN,
    'UserInvite': USER_ADMIN,
    'UserApprove': USER_ADMIN,
    'UserReject': USER_ADMIN,
    'UserTombstone': USER_ADMIN,
    'UserUntombstone': USER_ADMIN,
    'UserAffiliationChange': USER_ADMIN,
    // Org Structure
    'ClusterRead': ORG_ADMIN,
    'ClusterCreate': ORG_ADMIN,
    'ClusterUpdate': ORG_ADMIN,
    'ClusterDelete': ORG_ADMIN,
    'TeamRead': ORG_ADMIN,
    'TeamCreate': ORG_ADMIN,
    'TeamUpdate': ORG_ADMIN,
    'TeamDelete': ORG_ADMIN,
    'TeamMemberRead': ORG_ADMIN,
    'TeamMemberManage': ORG_ADMIN,
    // Systems & Assets
    'SystemRead': SYSTEMS_ADMIN,
    'SystemCreate': SYSTEMS_ADMIN,
    'SystemUpdate': SYSTEMS_ADMIN,
    'SystemDelete': SYSTEMS_ADMIN,
    'SystemMappingRead': SYSTEMS_ADMIN,
    'SystemMappableTeamsRead': SYSTEMS_ADMIN,
    'SystemOwnerManage': SYSTEMS_ADMIN,
    'TeamSystemMappingManage': SYSTEMS_ADMIN,
    'OwnerPAMappingManage': SYSTEMS_ADMIN,
    'AssetRead': SYSTEMS_ADMIN,
    'AssetCreate': SYSTEMS_ADMIN,
    'AssetUpdate': SYSTEMS_ADMIN,
    'AssetDelete': SYSTEMS_ADMIN,
    'AssetSync': SYSTEMS_ADMIN,
    // Data Operations
    'DataExport': DATA_OPERATOR,
    'DataImport': DATA_OPERATOR,
    'DataResetSeed': DATA_OPERATOR,
    'RequestAdminReset': DATA_OPERATOR,
    // Configuration
    'ConfigAppSettingsRead': CONFIG_ADMIN,
    'ConfigAppSettingsWrite': CONFIG_ADMIN,
    'ConfigEmailTemplateRead': CONFIG_ADMIN,
    'ConfigEmailTemplateWrite': CONFIG_ADMIN,
    // Audit
    'AuditLogRead': CONFIG_ADMIN,
    'AuditAccessLogRead': CONFIG_ADMIN,
    'AuditSentNotificationsRead': CONFIG_ADMIN,
    // Admin
    'AdminRolesManage': SUPER_ADMIN,
    'AdminCapabilitiesDebugView': SUPER_ADMIN,
  };
  return userMap[capability] || REGULAR_USER;
}

/**
 * Get user without specific capability.
 */
export function getUserWithoutCapability(capability: string): TestUser {
  const userWithCap = getUserWithCapability(capability);
  // Return a different user who doesn't have this capability
  if (userWithCap === SUPER_ADMIN) return REGULAR_USER;
  if (userWithCap === USER_ADMIN) return REGULAR_USER;
  if (userWithCap === ORG_ADMIN) return REGULAR_USER;
  if (userWithCap === SYSTEMS_ADMIN) return REGULAR_USER;
  if (userWithCap === DATA_OPERATOR) return REGULAR_USER;
  if (userWithCap === CONFIG_ADMIN) return REGULAR_USER;
  return REGULAR_USER;
}
```

## 🧪 Test Structure

### Individual Capability Test File Structure

Each capability gets its own test file with the baseline/positive/negative pattern:

**File: `tests/user-management/user-read.test.ts`**

```typescript
import { test, expect } from '@playwright/test';
import { 
  loginAsCapabilityUser, 
  navigateToAdminPanel,
  assertElementVisible,
  REGULAR_USER,
  USER_ADMIN
} from '../../fixtures/capability-helpers';

test.describe('UserRead Capability', () => {
  // BASELINE: User without capability cannot see/access user management
  test('BASELINE: Regular user cannot access user management', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await navigateToAdminPanel(page);
    
    // User tab should not be visible
    await assertElementVisible(page, 'a[href="/admin/users"]', false);
    
    // Direct navigation should fail or redirect
    await page.goto('/admin/users');
    await expect(page).not.toHaveURL('/admin/users');
    await expect(page.locator('.error-message')).toHaveText(/not authorized/i);
  });

  // POSITIVE: User with capability can see/access user management
  test('POSITIVE: User Admin can access user management', async ({ page }) => {
    await loginAsCapabilityUser(page, USER_ADMIN);
    await navigateToAdminPanel(page);
    
    // User tab should be visible
    await assertElementVisible(page, 'a[href="/admin/users"]', true);
    
    // Can navigate to users page
    await page.click('a[href="/admin/users"]');
    await expect(page).toHaveURL('/admin/users');
    
    // Can see user list
    await expect(page.locator('.user-list')).toBeVisible();
  });

  // NEGATIVE: After capability removed, user cannot access (simulated by using different user)
  test('NEGATIVE: User without UserRead cannot access user management', async ({ page }) => {
    // This simulates the negative case by using a user without the capability
    await loginAsCapabilityUser(page, REGULAR_USER);
    await navigateToAdminPanel(page);
    
    // User tab should not be visible
    await assertElementVisible(page, 'a[href="/admin/users"]', false);
    
    // Direct navigation should fail
    await page.goto('/admin/users');
    await expect(page).not.toHaveURL('/admin/users');
  });
});
```

### Alternative Approach: Single File with All Capabilities

Given that creating 30+ separate test files might be excessive, an alternative is to create **category-based test files** or a **single comprehensive file**:

**Option A: Category-Based Files**
```
tests/
├── user-management-capabilities.test.ts   # 7 capabilities
├── org-structure-capabilities.test.ts     # 9 capabilities
├── systems-assets-capabilities.test.ts    # 11 capabilities
├── data-operations-capabilities.test.ts   # 4 capabilities
├── configuration-capabilities.test.ts     # 4 capabilities
├── audit-capabilities.test.ts             # 3 capabilities
└── admin-capabilities.test.ts              # 2 capabilities
```

**Option B: Single Comprehensive File**
```
tests/
└── all-capabilities.test.ts   # All 34 capabilities in one file
```

**Recommendation: Option A (Category-Based)**
- Better organization
- Easier to maintain
- Faster test execution (can run specific categories)
- Clearer test reports

## 🎯 Test Patterns by Capability Type

### 1. UI Visibility Capabilities

For capabilities that control UI element visibility:

```typescript
test.describe('UserRead - UI Visibility', () => {
  test('BASELINE: User tab not visible without capability', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await navigateToAdminPanel(page);
    await expect(page.locator('a[href="/admin/users"]')).not.toBeVisible();
  });

  test('POSITIVE: User tab visible with capability', async ({ page }) => {
    await loginAsCapabilityUser(page, USER_ADMIN);
    await navigateToAdminPanel(page);
    await expect(page.locator('a[href="/admin/users"]')).toBeVisible();
  });

  test('NEGATIVE: User tab not visible after capability removed', async ({ page }) => {
    // Use a user without the capability
    await loginAsCapabilityUser(page, REGULAR_USER);
    await navigateToAdminPanel(page);
    await expect(page.locator('a[href="/admin/users"]')).not.toBeVisible();
  });
});
```

### 2. Action Capabilities

For capabilities that control actions (create, update, delete):

```typescript
test.describe('UserCreate - Action', () => {
  test('BASELINE: Create user button disabled without capability', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await navigateToAdminPanel(page);
    await page.goto('/admin/users');
    await expect(page.locator('button[data-testid="create-user"]')).toBeDisabled();
  });

  test('POSITIVE: Create user button enabled with capability', async ({ page }) => {
    await loginAsCapabilityUser(page, USER_ADMIN);
    await navigateToAdminPanel(page);
    await page.goto('/admin/users');
    await expect(page.locator('button[data-testid="create-user"]')).toBeEnabled();
    
    // Can click and open modal
    await page.click('button[data-testid="create-user"]');
    await expect(page.locator('.create-user-modal')).toBeVisible();
  });

  test('NEGATIVE: Create user action fails without capability', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await navigateToAdminPanel(page);
    await page.goto('/admin/users');
    
    // Button might be hidden or disabled
    const createButton = page.locator('button[data-testid="create-user"]');
    await expect(createButton).not.toBeVisible();
    
    // Or if visible but disabled
    // await expect(createButton).toBeDisabled();
  });
});
```

### 3. Navigation Capabilities

For capabilities that control page access:

```typescript
test.describe('ConfigAppSettingsRead - Navigation', () => {
  test('BASELINE: Cannot navigate to settings without capability', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await page.goto('/admin/settings');
    
    // Either redirected or shows error
    await expect(page).not.toHaveURL('/admin/settings');
    await expect(page.locator('.error-message')).toHaveText(/not authorized/i);
  });

  test('POSITIVE: Can navigate to settings with capability', async ({ page }) => {
    await loginAsCapabilityUser(page, CONFIG_ADMIN);
    await page.goto('/admin/settings');
    await expect(page).toHaveURL('/admin/settings');
    await expect(page.locator('.settings-page')).toBeVisible();
  });

  test('NEGATIVE: Cannot access settings after capability removed', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await page.goto('/admin/settings');
    await expect(page).not.toHaveURL('/admin/settings');
  });
});
```

### 4. Data Access Capabilities

For capabilities that control data visibility:

```typescript
test.describe('AuditLogRead - Data Access', () => {
  test('BASELINE: Audit log data not visible without capability', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await navigateToAdminPanel(page);
    await page.goto('/admin/audit-log');
    
    // Either can't access page or data is filtered
    await expect(page).not.toHaveURL('/admin/audit-log');
  });

  test('POSITIVE: Audit log data visible with capability', async ({ page }) => {
    await loginAsCapabilityUser(page, CONFIG_ADMIN);
    await navigateToAdminPanel(page);
    await page.goto('/admin/audit-log');
    
    await expect(page).toHaveURL('/admin/audit-log');
    await expect(page.locator('.audit-log-table')).toBeVisible();
    await expect(page.locator('.audit-log-row')).toHaveCount(10); // Example
  });

  test('NEGATIVE: Audit log data not accessible after capability removed', async ({ page }) => {
    await loginAsCapabilityUser(page, REGULAR_USER);
    await page.goto('/admin/audit-log');
    await expect(page).not.toHaveURL('/admin/audit-log');
  });
});
```

## 🔧 Test Setup Requirements

### 1. Database Setup

Before running frontend tests, the database must have:
- All admin roles seeded
- Test users created with appropriate roles

**Options:**
- **Option A:** Use the existing bootstrap to create a default admin, then create test users via API
- **Option B:** Create a test-specific seed script
- **Option C:** Use the admin UI to manually create test users (not ideal for CI)

**Recommendation: Option A**

Create a test setup file that:
1. Ensures database is seeded with roles
2. Creates test users with specific capabilities
3. Uses the backend API to grant roles

### 2. Authentication Setup

Need to handle:
- Login flows
- Session management
- 2FA (if enabled)
- Token refresh

**Recommendation:**
- Use the existing login helpers from `test/frontend/playwright/helpers/`
- Create a capability-specific login helper

### 3. Test Environment Setup

Need to configure:
- Test base URL
- Database connection for test user setup
- Cleanup between tests

**Recommendation:**
- Extend the existing Playwright configuration
- Use the harness files already created

## 📋 Implementation Plan

### Phase 1: Setup (1-2 hours)

1. **Create directory structure**
   ```bash
   mkdir -p test/frontend/playwright/admin-capabilities/fixtures
   mkdir -p test/frontend/playwright/admin-capabilities/tests/user-management
   mkdir -p test/frontend/playwright/admin-capabilities/tests/org-structure
   mkdir -p test/frontend/playwright/admin-capabilities/tests/systems-assets
   mkdir -p test/frontend/playwright/admin-capabilities/tests/data-operations
   mkdir -p test/frontend/playwright/admin-capabilities/tests/configuration
   mkdir -p test/frontend/playwright/admin-capabilities/tests/audit
   mkdir -p test/frontend/playwright/admin-capabilities/tests/admin
   ```

2. **Create fixture files**
   - `fixtures/capability-users.ts` - Test user definitions
   - `fixtures/capability-helpers.ts` - Helper functions

3. **Create test setup file**
   - `fixtures/setup.ts` - Database setup and teardown

### Phase 2: Create Test Files (3-4 hours)

1. **User Management Tests** (7 capabilities × 3 tests = 21 tests)
   - `tests/user-management/user-read.test.ts`
   - `tests/user-management/user-invite.test.ts`
   - `tests/user-management/user-approve.test.ts`
   - `tests/user-management/user-reject.test.ts`
   - `tests/user-management/user-tombstone.test.ts`
   - `tests/user-management/user-untombstone.test.ts`
   - `tests/user-management/user-affiliation-change.test.ts`

2. **Organization Structure Tests** (9 capabilities × 3 tests = 27 tests)
   - `tests/org-structure/cluster-read.test.ts`
   - `tests/org-structure/cluster-create.test.ts`
   - ... etc

3. **Systems & Assets Tests** (11 capabilities × 3 tests = 33 tests)
4. **Data Operations Tests** (4 capabilities × 3 tests = 12 tests)
5. **Configuration Tests** (4 capabilities × 3 tests = 12 tests)
6. **Audit Tests** (3 capabilities × 3 tests = 9 tests)
7. **Admin Tests** (2 capabilities × 3 tests = 6 tests)

**Total: 34 capabilities × 3 tests = 102 pattern tests**

### Phase 3: Integration Tests (1-2 hours)

1. **Additive Model Tests**
   - Test that users with multiple roles have union of capabilities
   - Test that revoking one role doesn't remove capabilities from other roles

2. **full_admin Tests**
   - Test that full_admin can access everything
   - Test that full_admin can perform all actions

3. **Regular User Tests**
   - Test that regular users cannot access any admin features
   - Test that regular users see appropriate error messages

### Phase 4: Documentation (0.5-1 hour)

1. **Create README.md**
   - Explain test structure
   - Document how to run tests
   - Document test patterns

2. **Update files.md**
   - Inventory all test files

## ⏱️ Estimated Timeline

| Phase | Tasks | Estimated Time |
|-------|-------|----------------|
| 1 | Setup (directory, fixtures, config) | 1-2 hours |
| 2 | Create test files (all categories) | 3-4 hours |
| 3 | Integration tests | 1-2 hours |
| 4 | Documentation | 0.5-1 hour |
| **Total** | | **5.5-9 hours** |

## 🎯 Quick Start (Minimal Viable)

If time is limited, start with:

1. **Create fixtures** (0.5 hour)
2. **Create 1-2 test files as examples** (1 hour)
   - `tests/user-management/user-read.test.ts`
   - `tests/org-structure/cluster-read.test.ts`
3. **Verify pattern works** (0.5 hour)
4. **Expand to all capabilities** (3-4 hours)

**Total Quick Start: 2 hours for first working tests**

## 📝 Next Steps

1. **Review this plan** - Does it meet your expectations?
2. **Adjust as needed** - Should we use category-based files or single file?
3. **Prioritize** - Which capabilities should be tested first?
4. **Implement** - I can start with Phase 1 (setup) immediately

## 💡 Recommendations

1. **Start with category-based files** - Better organization
2. **Use existing test harness** - Leverage `test/frontend/playwright/harness/`
3. **Reuse existing helpers** - Use `test/frontend/playwright/helpers/`
4. **Focus on UI visibility first** - Easier to test and verify
5. **Add action tests later** - More complex, requires actual data

## 🚀 Ready to Implement?

I can start implementing this plan immediately. The first step would be to:

1. Create the directory structure
2. Create the fixture files (`capability-users.ts`, `capability-helpers.ts`)
3. Create a test setup file
4. Create the first category of tests (e.g., User Management)

Would you like me to proceed with Phase 1: Setup?
