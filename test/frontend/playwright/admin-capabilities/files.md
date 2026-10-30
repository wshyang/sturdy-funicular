# Admin Capabilities Test Files

## Overview
This directory contains Playwright tests for the Admin Capabilities system (addendum-066).

## Test Files

### 1. admin-panel-capabilities.spec.ts
**Purpose:** Tests for capability-based tab visibility and access control in the AdminPanel
**Tests:** 40+ tests
**Coverage:**
- Admin Panel access control for all role types
- Full Admin role (all capabilities)
- User Admin role (UserRead, UserInvite, UserApprove, UserReject, UserTombstone, UserUntombstone, UserAffiliationChange)
- Organization Admin role (ClusterRead, ClusterCreate, ClusterUpdate, ClusterDelete, TeamRead, TeamCreate, TeamUpdate, TeamDelete, TeamMemberRead, TeamMemberManage)
- Systems Admin role (SystemRead, SystemCreate, SystemUpdate, SystemDelete, SystemMappingRead, SystemMappableTeamsRead, SystemOwnerManage, TeamSystemMappingManage, OwnerPAMappingManage, AssetRead, AssetCreate, AssetUpdate, AssetDelete, AssetSync)
- Data Operator role (DataExport, DataImport, DataResetSeed, RequestAdminReset)
- Configuration Admin role (ConfigAppSettingsRead, ConfigAppSettingsWrite, ConfigEmailTemplateRead, ConfigEmailTemplateWrite, AuditSentNotificationsRead)
- Full Admin Except Audit role (all except AuditLogRead, AuditAccessLogRead)
- User with multiple roles (union of capabilities)
- Tab switching behavior
- Capability count display
- Loading states
- Error states
- Tab order
- Responsive design

### 2. admin-capabilities-user-management.spec.ts
**Purpose:** Tests for User Management capabilities
**Tests:** 35+ tests
**Coverage:**
- UserRead capability (view users, pending users)
- UserInvite capability (invite user modal, form validation, user creation)
- UserApprove capability (approve pending users)
- UserReject capability (reject pending users)
- UserTombstone capability (deactivate users, modal confirmation)
- UserUntombstone capability (reactivate users)
- UserAffiliationChange capability (change user affiliation)
- Role-based access tests
- Navigation between user views

### 3. admin-capabilities-system.spec.ts
**Purpose:** Tests for System & Asset Management capabilities
**Tests:** 40+ tests
**Coverage:**
- SystemRead capability (view systems list)
- SystemCreate capability (create system form, validation)
- SystemUpdate capability (edit systems)
- SystemDelete capability (delete systems)
- AssetRead capability (view assets)
- AssetCreate capability (create assets)
- AssetUpdate capability (edit assets)
- AssetDelete capability (delete assets)
- AssetSync capability (sync assets)
- SystemMappingRead capability (view mappings)
- SystemMappableTeamsRead capability (view mappable teams)
- SystemOwnerManage capability (manage system owners)
- TeamSystemMappingManage capability (manage team-system mappings)
- OwnerPAMappingManage capability (manage owner-PA mappings)
- Role-based access tests

### 4. admin-email-config.spec.ts
**Purpose:** Tests for Email Configuration UI
**Tests:** 25+ tests
**Coverage:**
- Email Configuration access control
- Email delivery toggle
- Provider selection (Disabled, SMTP, SES, Postman)
- SMTP configuration (host, port, username, password, from, security)
- SES configuration (region, from address, configuration set)
- Postman configuration (API key, from address, classification)
- Configuration status display
- Quick action buttons
- Error handling
- Form validation
- Success messages

## Test Structure

```
admin-capabilities/
├── files.md                    # This file
├── README.md                   # README for the admin-capabilities suite
├── PLAN.md                     # Test plan for the admin-capabilities suite
├── global-setup.ts             # Global Playwright setup for this suite
├── fixtures/
│   ├── capability-users.ts      # Test user definitions
│   ├── capability-helpers.ts   # Test helper functions
│   └── setup.ts                # Test setup/teardown
├── admin-panel-capabilities.spec.ts
├── admin-capabilities-user-management.spec.ts
├── admin-capabilities-system.spec.ts
└── admin-email-config.spec.ts
```

## Total Test Count
- **admin-panel-capabilities.spec.ts:** 40+ tests
- **admin-capabilities-user-management.spec.ts:** 35+ tests
- **admin-capabilities-system.spec.ts:** 40+ tests
- **admin-email-config.spec.ts:** 25+ tests
- **Total:** 140+ tests

## Test IDs
All tests use consistent test IDs following the pattern:
- `admin-panel__tab-{tabId}` - Tab buttons
- `admin-users__*` - User management elements
- `admin-systems__*` - System management elements
- `email-config__*` - Email configuration elements
- `admin-capabilities__*` - General capability elements

## Running Tests
```bash
# Run all admin capability tests
npx playwright test test/frontend/playwright/admin-capabilities/

# Run specific test file
npx playwright test test/frontend/playwright/admin-capabilities/admin-panel-capabilities.spec.ts

# Run with headed browser
npx playwright test test/frontend/playwright/admin-capabilities/ --headed

# Run with debug mode
npx playwright test test/frontend/playwright/admin-capabilities/ --debug
```

## Test Data
Test users are defined in `fixtures/capability-users.ts`:
- SUPER_ADMIN - Full admin with all capabilities
- USER_ADMIN - User Administrator role
- ORG_ADMIN - Cluster & Team Structure Administrator role
- SYSTEMS_ADMIN - Systems & Assets Administrator role
- DATA_OPERATOR - Data Operator role
- CONFIG_ADMIN - Configuration & Audit Administrator role
- REGULAR_USER - Regular user with no admin capabilities
- PENDING_USER - Pending user
- USER_ORG_ADMIN - User with both User Admin and Org Admin roles
- FULL_ADMIN_EXCEPT_AUDIT - Full admin without audit capabilities

## Dependencies
- Playwright test runner
- @playwright/test
- Test harness helpers from `test/frontend/playwright/harness/`
- API endpoints from `server/routes-admin-capabilities.tsx`
- AdminPanel component from `src/app/components/AdminPanel.tsx`

## Notes
- Tests assume the backend is running with the admin role grants system seeded
- Tests use the test harness for login, navigation, and assertions
- Navigation (addendum-099): admin-role actors reach the Admin Panel via `goToAdminDashboard` (role-droplet click when multi-role, direct mount otherwise) — never `page.goto('/admin')`, which matches no route and only "worked" through the catch-all redirect. No-capability actors (REGULAR_USER) assert `assertNoAdminSurface` (zero admin chrome, no Administrator droplet option). URL-driven denial is tested against the *canonical* deep link with an admin positive control.
- Tests are designed to be independent and can run in parallel
- Tests follow the page object pattern via test IDs
