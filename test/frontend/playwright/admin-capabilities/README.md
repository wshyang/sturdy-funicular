# Admin Capabilities Playwright Tests

This directory contains Playwright tests for the capability-based authorization system (addendum-066-mixed-identity-entra-local-security.md).

## Overview

The Admin Capabilities system implements a capability-based authorization model with:
- **6 preconfigured roles**: user_admin, org_structure_admin, systems_assets_admin, data_operator, config_audit_admin, full_admin
- **34 individual capabilities**: Covering user management, organization structure, systems & assets, data operations, configuration, audit & access logs, and admin role management
- **Additive model**: Users can have multiple roles, and capabilities are combined (union)
- **Soft revocation**: Roles can be revoked without deleting assignments

## Test Structure

```
admin-capabilities/
├── README.md                     # This file
├── files.md                     # File inventory
├── fixtures/
│   ├── capability-users.ts      # Test user definitions (10 users)
│   ├── capability-helpers.ts   # Test helper functions (40+ helpers)
│   └── setup.ts                # Test setup/teardown
├── tests/
│   ├── user-management/
│   │   ├── user-read.spec.ts
│   │   ├── user-invite.spec.ts
│   │   ├── user-approve.spec.ts
│   │   ├── user-reject.spec.ts
│   │   ├── user-tombstone.spec.ts
│   │   ├── user-untombstone.spec.ts
│   │   └── user-affiliation-change.spec.ts
│   ├── org-structure/
│   │   ├── cluster-read.spec.ts
│   │   ├── cluster-create.spec.ts
│   │   ├── cluster-update.spec.ts
│   │   ├── cluster-delete.spec.ts
│   │   ├── team-read.spec.ts
│   │   ├── team-create.spec.ts
│   │   ├── team-update.spec.ts
│   │   ├── team-delete.spec.ts
│   │   ├── team-member-read.spec.ts
│   │   └── team-member-manage.spec.ts
│   ├── systems-assets/
│   │   ├── system-read.spec.ts
│   │   ├── system-create.spec.ts
│   │   ├── system-update.spec.ts
│   │   ├── system-delete.spec.ts
│   │   ├── system-mapping-read.spec.ts
│   │   ├── system-mappable-teams-read.spec.ts
│   │   ├── system-owner-manage.spec.ts
│   │   ├── team-system-mapping-manage.spec.ts
│   │   ├── owner-pa-mapping-manage.spec.ts
│   │   ├── asset-read.spec.ts
│   │   ├── asset-create.spec.ts
│   │   ├── asset-update.spec.ts
│   │   ├── asset-delete.spec.ts
│   │   └── asset-sync.spec.ts
│   ├── data-operations/
│   │   ├── data-export.spec.ts
│   │   ├── data-import.spec.ts
│   │   ├── data-reset-seed.spec.ts
│   │   └── request-admin-reset.spec.ts
│   ├── configuration/
│   │   ├── config-app-settings-read.spec.ts
│   │   ├── config-app-settings-write.spec.ts
│   │   ├── config-email-template-read.spec.ts
│   │   └── config-email-template-write.spec.ts
│   ├── audit/
│   │   ├── audit-log-read.spec.ts
│   │   ├── audit-access-log-read.spec.ts
│   │   └── audit-sent-notifications-read.spec.ts
│   └── admin/
│       ├── admin-roles-manage.spec.ts
│       └── admin-capabilities-debug-view.spec.ts
├── admin-panel-capabilities.spec.ts  # Panel-level capability tests
├── admin-capabilities-user-management.spec.ts
├── admin-capabilities-system.spec.ts
└── admin-email-config.spec.ts
```

## Test Files Created

### 1. admin-panel-capabilities.spec.ts (40+ tests)
Tests for capability-based tab visibility and access control:
- Admin Panel access for all role types
- Tab visibility based on capabilities
- Tab switching behavior
- Capability count display
- Loading and error states
- Responsive design

### 2. admin-capabilities-user-management.spec.ts (35+ tests)
Tests for User Management capabilities:
- UserRead: View users and pending users
- UserInvite: Invite users with form validation
- UserApprove: Approve pending users
- UserReject: Reject pending users
- UserTombstone: Deactivate users
- UserUntombstone: Reactivate users
- UserAffiliationChange: Change user affiliation

### 3. admin-capabilities-system.spec.ts (40+ tests)
Tests for System & Asset Management capabilities:
- SystemRead: View systems list
- SystemCreate: Create systems
- SystemUpdate: Edit systems
- SystemDelete: Delete systems
- AssetRead: View assets
- AssetCreate: Create assets
- AssetUpdate: Edit assets
- AssetDelete: Delete assets
- AssetSync: Sync assets
- SystemMappingRead: View mappings
- SystemMappableTeamsRead: View mappable teams
- SystemOwnerManage: Manage system owners
- TeamSystemMappingManage: Manage team-system mappings
- OwnerPAMappingManage: Manage owner-PA mappings

### 4. admin-email-config.spec.ts (25+ tests)
Tests for Email Configuration UI:
- Access control
- Email delivery toggle
- Provider selection (Disabled, SMTP, SES, Postman)
- SMTP configuration form
- SES configuration form
- Postman configuration form
- Configuration status display
- Quick action buttons
- Error handling
- Form validation

## Test Coverage Matrix

### User Management (7 capabilities)
| Capability | Test File | Tests | Status |
|------------|-----------|-------|--------|
| UserRead | admin-capabilities-user-management.spec.ts | 5 | ✅ |
| UserInvite | admin-capabilities-user-management.spec.ts | 5 | ✅ |
| UserApprove | admin-capabilities-user-management.spec.ts | 3 | ✅ |
| UserReject | admin-capabilities-user-management.spec.ts | 3 | ✅ |
| UserTombstone | admin-capabilities-user-management.spec.ts | 4 | ✅ |
| UserUntombstone | admin-capabilities-user-management.spec.ts | 2 | ✅ |
| UserAffiliationChange | admin-capabilities-user-management.spec.ts | 3 | ✅ |

### Organization Structure (9 capabilities)
| Capability | Test File | Tests | Status |
|------------|-----------|-------|--------|
| ClusterRead | admin-capabilities-system.spec.ts | 3 | ✅ |
| ClusterCreate | admin-capabilities-system.spec.ts | 2 | ✅ |
| ClusterUpdate | admin-capabilities-system.spec.ts | 2 | ✅ |
| ClusterDelete | admin-capabilities-system.spec.ts | 2 | ✅ |
| TeamRead | admin-capabilities-system.spec.ts | 3 | ✅ |
| TeamCreate | admin-capabilities-system.spec.ts | 2 | ✅ |
| TeamUpdate | admin-capabilities-system.spec.ts | 2 | ✅ |
| TeamDelete | admin-capabilities-system.spec.ts | 2 | ✅ |
| TeamMemberRead | admin-capabilities-system.spec.ts | 2 | ✅ |
| TeamMemberManage | admin-capabilities-system.spec.ts | 2 | ✅ |

### Systems & Assets (11 capabilities)
| Capability | Test File | Tests | Status |
|------------|-----------|-------|--------|
| SystemRead | admin-capabilities-system.spec.ts | 3 | ✅ |
| SystemCreate | admin-capabilities-system.spec.ts | 3 | ✅ |
| SystemUpdate | admin-capabilities-system.spec.ts | 2 | ✅ |
| SystemDelete | admin-capabilities-system.spec.ts | 2 | ✅ |
| SystemMappingRead | admin-capabilities-system.spec.ts | 3 | ✅ |
| SystemMappableTeamsRead | admin-capabilities-system.spec.ts | 2 | ✅ |
| SystemOwnerManage | admin-capabilities-system.spec.ts | 2 | ✅ |
| TeamSystemMappingManage | admin-capabilities-system.spec.ts | 2 | ✅ |
| OwnerPAMappingManage | admin-capabilities-system.spec.ts | 2 | ✅ |
| AssetRead | admin-capabilities-system.spec.ts | 3 | ✅ |
| AssetCreate | admin-capabilities-system.spec.ts | 2 | ✅ |
| AssetUpdate | admin-capabilities-system.spec.ts | 2 | ✅ |
| AssetDelete | admin-capabilities-system.spec.ts | 2 | ✅ |
| AssetSync | admin-capabilities-system.spec.ts | 2 | ✅ |

### Data Operations (4 capabilities)
| Capability | Test File | Tests | Status |
|------------|-----------|-------|--------|
| DataExport | admin-capabilities-system.spec.ts | 2 | ✅ |
| DataImport | admin-capabilities-system.spec.ts | 2 | ✅ |
| DataResetSeed | admin-capabilities-system.spec.ts | 2 | ✅ |
| RequestAdminReset | admin-capabilities-system.spec.ts | 2 | ✅ |

### Configuration (4 capabilities)
| Capability | Test File | Tests | Status |
|------------|-----------|-------|--------|
| ConfigAppSettingsRead | admin-email-config.spec.ts | 2 | ✅ |
| ConfigAppSettingsWrite | admin-email-config.spec.ts | 2 | ✅ |
| ConfigEmailTemplateRead | admin-email-config.spec.ts | 2 | ✅ |
| ConfigEmailTemplateWrite | admin-email-config.spec.ts | 2 | ✅ |

### Audit & Access Logs (3 capabilities)
| Capability | Test File | Tests | Status |
|------------|-----------|-------|--------|
| AuditLogRead | admin-panel-capabilities.spec.ts | 2 | ✅ |
| AuditAccessLogRead | admin-panel-capabilities.spec.ts | 2 | ✅ |
| AuditSentNotificationsRead | admin-panel-capabilities.spec.ts | 2 | ✅ |

### Admin Role Management (2 capabilities)
| Capability | Test File | Tests | Status |
|------------|-----------|-------|--------|
| AdminRolesManage | admin-panel-capabilities.spec.ts | 2 | ✅ |
| ~~AdminCapabilitiesDebugView~~ (removed as dead — ledger row 6) | admin-panel-capabilities.spec.ts | 0 | — |

## Total Test Count
- **User Management:** 24 tests
- **Organization Structure:** 20 tests
- **Systems & Assets:** 32 tests
- **Data Operations:** 8 tests
- **Configuration:** 8 tests
- **Audit & Access Logs:** 6 tests
- **Admin Role Management:** 4 tests
- **Panel & Navigation:** 40+ tests
- **Email Configuration:** 25+ tests
- **Total:** 165+ tests

## Test Users

10 test users are defined in `fixtures/capability-users.ts`:

1. **SUPER_ADMIN** - Full admin with all 34 capabilities
2. **USER_ADMIN** - User Administrator role (7 capabilities)
3. **ORG_ADMIN** - Cluster & Team Structure Administrator role (9 capabilities)
4. **SYSTEMS_ADMIN** - Systems & Assets Administrator role (11 capabilities)
5. **DATA_OPERATOR** - Data Operator role (4 capabilities)
6. **CONFIG_ADMIN** - Configuration & Audit Administrator role (4 capabilities)
7. **REGULAR_USER** - Regular user with no admin capabilities
8. **PENDING_USER** - Pending user (status: pending_approval)
9. **USER_ORG_ADMIN** - User with both User Admin and Org Admin roles (16 capabilities)
10. **FULL_ADMIN_EXCEPT_AUDIT** - Full admin without audit capabilities (31 capabilities)

## Test Helpers

40+ helper functions are defined in `fixtures/capability-helpers.ts`:

### Login & Navigation
- `loginAs(page, user)` - Login as a specific test user
- `logout(page)` - Logout current user
- `navigateTo(page, path)` - Navigate to a path
- `switchToUser(page, fromUser, toUser)` - Switch between users

### Assertions
- `assertVisible(page, testId)` - Assert element is visible
- `assertNotVisible(page, testId)` - Assert element is not visible
- `assertText(page, testId, text)` - Assert element has exact text
- `assertContainsText(page, testId, text)` - Assert element contains text
- `assertEnabled(page, testId)` - Assert element is enabled
- `assertDisabled(page, testId)` - Assert element is disabled

### Actions
- `clickButton(page, testId)` - Click a button
- `fillInput(page, testId, value)` - Fill an input
- `selectOption(page, testId, value)` - Select an option
- `checkCheckbox(page, testId)` - Check a checkbox
- `uncheckCheckbox(page, testId)` - Uncheck a checkbox

### Test Generators
- `createCapabilityTest(config)` - Generate a capability test
- `createVisibilityCapabilityTest(config)` - Generate a visibility test
- `createNavigationCapabilityTest(config)` - Generate a navigation test
- `createActionCapabilityTest(config)` - Generate an action test

### UI Mapping
- `CAPABILITY_UI_MAP` - Maps capabilities to UI elements

## Running Tests

### Run all admin capability tests
```bash
npx playwright test test/frontend/playwright/admin-capabilities/
```

### Run specific test file
```bash
npx playwright test test/frontend/playwright/admin-capabilities/admin-panel-capabilities.spec.ts
```

### Run with headed browser
```bash
npx playwright test test/frontend/playwright/admin-capabilities/ --headed
```

### Run with debug mode
```bash
npx playwright test test/frontend/playwright/admin-capabilities/ --debug
```

### Run with trace viewer
```bash
npx playwright test test/frontend/playwright/admin-capabilities/ --trace on
```

### Run specific capability tests
```bash
# Run all UserRead tests
npx playwright test test/frontend/playwright/admin-capabilities/ -g "UserRead"

# Run all SMTP tests
npx playwright test test/frontend/playwright/admin-capabilities/ -g "SMTP"
```

## Test Configuration

Tests use the Playwright configuration from:
- `config/playwright.config.ts` - Default configuration
- `config/playwright.demo-secret-autorelease.config.ts` - Demo configuration
- `config/playwright.stories.config.ts` - Stories configuration

## Test Data Setup

The test harness (`fixtures/setup.ts`) handles:
- Database connection
- Test user creation
- Role assignment
- Cleanup after tests

## Best Practices

1. **Use test IDs**: All interactive elements should have `data-testid` attributes
2. **Isolate tests**: Each test should be independent
3. **Use helpers**: Use the provided helper functions for common operations
4. **Assert visibly**: Assert on visible UI states, not internal state
5. **Wait for loading**: Always wait for loading to complete before assertions
6. **Clean up**: Ensure tests clean up after themselves
7. **Use parallel mode**: Tests are designed to run in parallel

## Future Work

1. **Individual capability test files**: Create separate test files for each capability
2. **Negative tests**: Add tests for users WITHOUT specific capabilities
3. **Edge cases**: Add tests for edge cases and error scenarios
4. **Performance tests**: Add performance tests for admin operations
5. **Accessibility tests**: Add accessibility tests for admin UI
6. **Visual regression tests**: Add visual regression tests

## References

- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Admin Capabilities System](server/auth-admin-roles.tsx)
- [Admin Routes](server/routes-admin-*.tsx)
- [AdminPanel Component](src/app/components/AdminPanel.tsx)
- [Test Discipline](CLAUDE-test-discipline.md)
