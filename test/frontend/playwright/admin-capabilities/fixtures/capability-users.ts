// Capability Users Fixture for Frontend Testing
// 
// Defines test users with specific admin capabilities for Playwright tests.
// Each user has a predefined set of roles and capabilities.
//
// Usage:
//   import { SUPER_ADMIN, USER_ADMIN, REGULAR_USER } from './capability-users';
//   await loginAs(page, SUPER_ADMIN);
//
// See: server/auth-admin-roles.tsx for capability definitions
// See: PLAN.md for test suite design

import type { AdminCapability } from "../../../../../server/auth-admin-roles.tsx";

/**
 * Test user definition with roles and capabilities.
 */
export interface TestUser {
  email: string;
  password: string;
  fullName: string;
  roles: string[];
  capabilities: Set<AdminCapability>;
  description: string;
}

// ============================================================================
// PREDEFINED TEST USERS
// ============================================================================

/**
 * Super Administrator - has ALL capabilities
 * Can access all admin features
 */
export const SUPER_ADMIN: TestUser = {
  email: "super.admin@test.local",
  password: "SuperAdmin!2026",
  fullName: "Super Administrator",
  roles: ["full_admin"],
  capabilities: new Set([
    // User Management
    "UserRead", "UserInvite", "UserApprove", "UserReject",
    "UserTombstone", "UserUntombstone", "UserAffiliationChange",
    // Organization Structure
    "ClusterRead", "ClusterCreate", "ClusterUpdate", "ClusterDelete",
    "TeamRead", "TeamCreate", "TeamUpdate", "TeamDelete",
    "TeamMemberRead", "TeamMemberManage",
    // Systems & Assets
    "SystemRead", "SystemCreate", "SystemUpdate", "SystemDelete",
    "SystemMappingRead", "SystemMappableTeamsRead", "SystemOwnerManage",
    "TeamSystemMappingManage", "OwnerPAMappingManage",
    "AssetRead", "AssetCreate", "AssetUpdate", "AssetDelete", "AssetSync",
    // Data Operations
    "DataExport", "DataImport", "DataResetSeed", "RequestAdminReset",
    // Configuration
    "ConfigAppSettingsRead", "ConfigAppSettingsWrite",
    "ConfigEmailTemplateRead", "ConfigEmailTemplateWrite",
    // Audit
    "AuditLogRead", "AuditAccessLogRead", "AuditSentNotificationsRead",
    // Admin
    "AdminRolesManage",
  ] as Set<AdminCapability>),
  description: "Full access to all admin features and capabilities",
};

/**
 * User Administrator - manages user accounts
 * Can: view, invite, approve, reject, tombstone, untombstone users
 */
export const USER_ADMIN: TestUser = {
  email: "user.admin@test.local",
  password: "UserAdmin!2026",
  fullName: "User Administrator",
  roles: ["user_admin"],
  capabilities: new Set([
    "UserRead", "UserInvite", "UserApprove", "UserReject",
    "UserTombstone", "UserUntombstone", "UserAffiliationChange",
  ] as Set<AdminCapability>),
  description: "Can manage user accounts but nothing else",
};

/**
 * Cluster & Team Structure Administrator - manages clusters and teams
 * Can: view, create, update, delete clusters and teams
 */
export const ORG_ADMIN: TestUser = {
  email: "org.admin@test.local",
  password: "OrgAdmin!2026",
  fullName: "Organization Administrator",
  roles: ["org_structure_admin"],
  capabilities: new Set([
    "ClusterRead", "ClusterCreate", "ClusterUpdate", "ClusterDelete",
    "TeamRead", "TeamCreate", "TeamUpdate", "TeamDelete",
    "TeamMemberRead", "TeamMemberManage",
  ] as Set<AdminCapability>),
  description: "Can manage organization structure (clusters, teams) but nothing else",
};

/**
 * Systems & Assets Administrator - manages systems and assets
 * Can: view, create, update, delete systems and assets
 */
export const SYSTEMS_ADMIN: TestUser = {
  email: "systems.admin@test.local",
  password: "SystemsAdmin!2026",
  fullName: "Systems Administrator",
  roles: ["systems_assets_admin"],
  capabilities: new Set([
    "SystemRead", "SystemCreate", "SystemUpdate", "SystemDelete",
    "SystemMappingRead", "SystemMappableTeamsRead", "SystemOwnerManage",
    "TeamSystemMappingManage", "OwnerPAMappingManage",
    "AssetRead", "AssetCreate", "AssetUpdate", "AssetDelete", "AssetSync",
  ] as Set<AdminCapability>),
  description: "Can manage systems and assets but nothing else",
};

/**
 * Data Operator - performs data operations
 * Can: export, import, reset seed, admin reset requests
 */
export const DATA_OPERATOR: TestUser = {
  email: "data.operator@test.local",
  password: "DataOperator!2026",
  fullName: "Data Operator",
  roles: ["data_operator"],
  capabilities: new Set([
    "DataExport", "DataImport", "DataResetSeed", "RequestAdminReset",
  ] as Set<AdminCapability>),
  description: "Can perform data operations but nothing else",
};

/**
 * Configuration & Audit Administrator - manages settings and views audit logs
 * Can: read/write app settings, read/write email templates, view audit logs
 */
export const CONFIG_ADMIN: TestUser = {
  email: "config.admin@test.local",
  password: "ConfigAdmin!2026",
  fullName: "Configuration Administrator",
  roles: ["config_audit_admin"],
  capabilities: new Set([
    "ConfigAppSettingsRead", "ConfigAppSettingsWrite",
    "ConfigEmailTemplateRead", "ConfigEmailTemplateWrite",
    "AuditLogRead", "AuditAccessLogRead", "AuditSentNotificationsRead",
  ] as Set<AdminCapability>),
  description: "Can manage configuration and view audit logs but nothing else",
};

/**
 * Regular User - has NO admin capabilities
 * Can: access their own dashboard, submit requests (if allowed)
 * Cannot: access any admin features
 */
export const REGULAR_USER: TestUser = {
  email: "regular.user@test.local",
  password: "RegularUser!2026",
  fullName: "Regular User",
  roles: [],
  capabilities: new Set() as Set<AdminCapability>,
  description: "Regular user with no admin capabilities",
};

/**
 * Pending User - has not been approved yet
 * Cannot: access any features until approved
 */
export const PENDING_USER: TestUser = {
  email: "pending.user@test.local",
  password: "PendingUser!2026",
  fullName: "Pending User",
  roles: [],
  capabilities: new Set() as Set<AdminCapability>,
  description: "User pending approval, cannot access any features",
};

// ============================================================================
// COMBINATION USERS (for testing additive model)
// ============================================================================

/**
 * User + Org Admin - has both user and org structure capabilities
 */
export const USER_ORG_ADMIN: TestUser = {
  email: "user.org.admin@test.local",
  password: "UserOrgAdmin!2026",
  fullName: "User and Org Administrator",
  roles: ["user_admin", "org_structure_admin"],
  capabilities: new Set([
    // From user_admin
    "UserRead", "UserInvite", "UserApprove", "UserReject",
    "UserTombstone", "UserUntombstone", "UserAffiliationChange",
    // From org_structure_admin
    "ClusterRead", "ClusterCreate", "ClusterUpdate", "ClusterDelete",
    "TeamRead", "TeamCreate", "TeamUpdate", "TeamDelete",
    "TeamMemberRead", "TeamMemberManage",
  ] as Set<AdminCapability>),
  description: "Has both user management and org structure capabilities",
};

/**
 * Full Admin Except One - has all capabilities except one (for testing)
 * This is a synthetic user for edge case testing
 */
export const FULL_ADMIN_EXCEPT_AUDIT: TestUser = {
  email: "full.admin.except.audit@test.local",
  password: "FullAdminExceptAudit!2026",
  fullName: "Full Admin Except Audit",
  roles: ["full_admin"],
  capabilities: new Set([
    // All capabilities EXCEPT audit ones
    "UserRead", "UserInvite", "UserApprove", "UserReject",
    "UserTombstone", "UserUntombstone", "UserAffiliationChange",
    "ClusterRead", "ClusterCreate", "ClusterUpdate", "ClusterDelete",
    "TeamRead", "TeamCreate", "TeamUpdate", "TeamDelete",
    "TeamMemberRead", "TeamMemberManage",
    "SystemRead", "SystemCreate", "SystemUpdate", "SystemDelete",
    "SystemMappingRead", "SystemMappableTeamsRead", "SystemOwnerManage",
    "TeamSystemMappingManage", "OwnerPAMappingManage",
    "AssetRead", "AssetCreate", "AssetUpdate", "AssetDelete", "AssetSync",
    "DataExport", "DataImport", "DataResetSeed", "RequestAdminReset",
    "ConfigAppSettingsRead", "ConfigAppSettingsWrite",
    "ConfigEmailTemplateRead", "ConfigEmailTemplateWrite",
    // Missing: AuditLogRead, AuditAccessLogRead, AuditSentNotificationsRead
    "AdminRolesManage",
  ] as Set<AdminCapability>),
  description: "Has all capabilities except audit-related ones",
};

// ============================================================================
// ALL TEST USERS ARRAY
// ============================================================================

/**
 * Array of all predefined test users.
 */
export const ALL_TEST_USERS: TestUser[] = [
  SUPER_ADMIN,
  USER_ADMIN,
  ORG_ADMIN,
  SYSTEMS_ADMIN,
  DATA_OPERATOR,
  CONFIG_ADMIN,
  REGULAR_USER,
  PENDING_USER,
  USER_ORG_ADMIN,
  FULL_ADMIN_EXCEPT_AUDIT,
];

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Get a test user that has a specific capability.
 * Returns the most specific user with that capability.
 */
export function getUserWithCapability(capability: string): TestUser {
  const userMap: Record<string, TestUser> = {
    // User Management
    "UserRead": USER_ADMIN,
    "UserInvite": USER_ADMIN,
    "UserApprove": USER_ADMIN,
    "UserReject": USER_ADMIN,
    "UserTombstone": USER_ADMIN,
    "UserUntombstone": USER_ADMIN,
    "UserAffiliationChange": USER_ADMIN,
    // Org Structure
    "ClusterRead": ORG_ADMIN,
    "ClusterCreate": ORG_ADMIN,
    "ClusterUpdate": ORG_ADMIN,
    "ClusterDelete": ORG_ADMIN,
    "TeamRead": ORG_ADMIN,
    "TeamCreate": ORG_ADMIN,
    "TeamUpdate": ORG_ADMIN,
    "TeamDelete": ORG_ADMIN,
    "TeamMemberRead": ORG_ADMIN,
    "TeamMemberManage": ORG_ADMIN,
    // Systems & Assets
    "SystemRead": SYSTEMS_ADMIN,
    "SystemCreate": SYSTEMS_ADMIN,
    "SystemUpdate": SYSTEMS_ADMIN,
    "SystemDelete": SYSTEMS_ADMIN,
    "SystemMappingRead": SYSTEMS_ADMIN,
    "SystemMappableTeamsRead": SYSTEMS_ADMIN,
    "SystemOwnerManage": SYSTEMS_ADMIN,
    "TeamSystemMappingManage": SYSTEMS_ADMIN,
    "OwnerPAMappingManage": SYSTEMS_ADMIN,
    "AssetRead": SYSTEMS_ADMIN,
    "AssetCreate": SYSTEMS_ADMIN,
    "AssetUpdate": SYSTEMS_ADMIN,
    "AssetDelete": SYSTEMS_ADMIN,
    "AssetSync": SYSTEMS_ADMIN,
    // Data Operations
    "DataExport": DATA_OPERATOR,
    "DataImport": DATA_OPERATOR,
    "DataResetSeed": DATA_OPERATOR,
    "RequestAdminReset": DATA_OPERATOR,
    // Configuration
    "ConfigAppSettingsRead": CONFIG_ADMIN,
    "ConfigAppSettingsWrite": CONFIG_ADMIN,
    "ConfigEmailTemplateRead": CONFIG_ADMIN,
    "ConfigEmailTemplateWrite": CONFIG_ADMIN,
    // Audit
    "AuditLogRead": CONFIG_ADMIN,
    "AuditAccessLogRead": CONFIG_ADMIN,
    "AuditSentNotificationsRead": CONFIG_ADMIN,
    // Admin
    "AdminRolesManage": SUPER_ADMIN,
  };
  return userMap[capability] || REGULAR_USER;
}

/**
 * Get a test user that does NOT have a specific capability.
 * Returns REGULAR_USER if the capability is in any non-super-admin role.
 */
export function getUserWithoutCapability(capability: string): TestUser {
  // For most capabilities, REGULAR_USER doesn't have it
  return REGULAR_USER;
}

/**
 * Get all test users that have a specific capability.
 */
export function getUsersWithCapability(capability: string): TestUser[] {
  return ALL_TEST_USERS.filter((user) => user.capabilities.has(capability as AdminCapability));
}

/**
 * Get all test users that do NOT have a specific capability.
 */
export function getUsersWithoutCapability(capability: string): TestUser[] {
  return ALL_TEST_USERS.filter((user) => !user.capabilities.has(capability as AdminCapability));
}

/**
 * Check if a test user has a specific capability.
 */
export function userHasCapability(user: TestUser, capability: string): boolean {
  return user.capabilities.has(capability as AdminCapability);
}

// ============================================================================
// EXPORTS
// ============================================================================

// All symbols above are individually exported with `export` at their declaration.
