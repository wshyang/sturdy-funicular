// Coverage: Additive Admin Role Grants System (server/auth-admin-roles.tsx).
//
// Tests the capability-based authorization system with 6 preconfigured roles
// and 30+ individual capabilities. Tests cover:
// - Role and capability definitions
// - Role grant/revocation
// - Capability checking
// - Effective capabilities calculation
//
// See: docs/specs/addenda/addendum-066-mixed-identity-entra-local-security.md

import { assertEquals, assert, assertRejects } from "jsr:@std/assert";
import * as adminRoleModule from "../../../../server/auth-admin-roles.tsx";
import {
  ALL_CAPABILITIES,
  PRECONFIGURED_ROLES,
  grantAdminRole,
  revokeAdminRole,
  revokeAllAdminRoles,
  listAdminRoleGrants,
  listAllActiveAdminRoleGrants,
  getEffectiveAdminCapabilities,
  isAdminUser,
  getUsersWithRole,
  seedAdminRoles,
  getAdminRoleMetadata,
  listAdminRoles,
  isSystemRole,
  isValidCapability,
  isValidRole,
  getRoleCapabilities,
  roleHasCapability,
} from "../../../../server/auth-admin-roles.tsx";
import {
  hasAdminPrivilege,
  requireAdminPrivilege,
} from "../../../../server/auth.tsx";
import { AuthorizationError } from "../../../../server/utils.tsx";
import { query } from "../../../../server/pg.tsx";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
} from "../helpers.tsx";

import type { SuiteContext } from "./00-context.ts";

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession, user1Id, user2Id } = context;
  await t.step("authorization decisions are exported only by auth.tsx", () => {
    assertEquals(typeof hasAdminPrivilege, "function");
    assertEquals(typeof requireAdminPrivilege, "function");
    assertEquals("hasAdminPrivilege" in adminRoleModule, false);
    assertEquals("requireAdminPrivilege" in adminRoleModule, false);
    assertEquals("hasAdminPrivilegeForOrganization" in adminRoleModule, false);
  });

  // ==========================================================================
  // Capability Definitions Tests
  // ==========================================================================

  await t.step("capability definitions: ALL_CAPABILITIES contains all expected capabilities", async () => {
    // The live registry pinned verbatim (addendum-141: repaired stale list —
    // it still expected the removed AdminCapabilitiesDebugView and missed the
    // addendum-114 Org* family + addendum-097's ConfigAppSettingsBulkTransfer,
    // leaving this step RED against the 50-capability registry).
    const expectedCapabilities = [
      // User Management
      "UserRead", "UserInvite", "UserApprove", "UserReject", "UserTombstone", "UserUntombstone", "UserAffiliationChange",
      "UserResetTwofa", "UserResetPassword",
      // Organizations (addendum-114)
      "OrgRead", "OrgCreate", "OrgUpdate", "OrgDelete",
      // Cluster/Team Structure
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
      "ConfigAppSettingsRead", "ConfigAppSettingsWrite", "ConfigAppSettingsBulkTransfer",
      "ConfigEmailTemplateRead", "ConfigEmailTemplateWrite",
      // Audit
      "AuditLogRead", "AuditAccessLogRead", "AuditSentNotificationsRead",
      // Org-scoped config siblings (addendum-137 §6 — extended with the
      // subsystem, mirroring the addendum-141 convention of keeping this
      // pin at the live ALL_CAPABILITIES size; 50 → 54)
      "OrgAppSettingsRead", "OrgAppSettingsWrite", "OrgTemplateRead", "OrgTemplateWrite",
      // Admin
      "AdminRolesManage",
    ];

    for (const capability of expectedCapabilities) {
      assert(ALL_CAPABILITIES.has(capability), `Missing capability: ${capability}`);
    }

    assertEquals(ALL_CAPABILITIES.size, expectedCapabilities.length);
  });

  await t.step("capability definitions: isValidCapability returns true for valid capabilities", async () => {
    assert(isValidCapability("UserRead"));
    assert(isValidCapability("SystemDelete"));
    assert(isValidCapability("AdminRolesManage"));
  });

  await t.step("capability definitions: isValidCapability returns false for invalid capabilities", async () => {
    assert(!isValidCapability("InvalidCapability"));
    assert(!isValidCapability(""));
    assert(!isValidCapability("user_read")); // Case sensitive
  });

  // ==========================================================================
  // Role Definitions Tests
  // ==========================================================================

  await t.step("role definitions: PRECONFIGURED_ROLES contains all expected roles", async () => {
    const expectedRoles = ["user_admin", "org_structure_admin", "systems_assets_admin", "data_operator", "config_audit_admin", "full_admin"];

    for (const roleKey of expectedRoles) {
      assert(PRECONFIGURED_ROLES.has(roleKey), `Missing role: ${roleKey}`);
    }

    assertEquals(PRECONFIGURED_ROLES.size, expectedRoles.length);
  });

  await t.step("role definitions: isValidRole returns true for valid roles", async () => {
    assert(await isValidRole("user_admin"));
    assert(await isValidRole("full_admin"));
    assert(await isValidRole("config_audit_admin"));
  });

  await t.step("role definitions: isValidRole returns false for invalid roles", async () => {
    assert(!(await isValidRole("invalid_role")));
    assert(!(await isValidRole("")));
  });

  await t.step("role definitions: all roles are system roles", async () => {
    for (const [, role] of PRECONFIGURED_ROLES) {
      assert(role.isSystemRole, `Role ${role.key} should be a system role`);
    }
  });

  await t.step("role definitions: isSystemRole returns true for system roles", async () => {
    assert(isSystemRole("user_admin"));
    assert(isSystemRole("full_admin"));
  });

  await t.step("role definitions: isSystemRole returns false for non-existent roles", async () => {
    assert(!isSystemRole("non_existent_role"));
  });

  // ==========================================================================
  // Role Capability Mapping Tests
  // ==========================================================================

  await t.step("role capabilities: user_admin has expected capabilities", async () => {
    const role = PRECONFIGURED_ROLES.get("user_admin");
    assert(role);
    const capabilities = role.capabilities;

    assert(capabilities.has("UserRead"));
    assert(capabilities.has("UserInvite"));
    assert(capabilities.has("UserApprove"));
    assert(capabilities.has("UserReject"));
    assert(capabilities.has("UserTombstone"));
    assert(capabilities.has("UserUntombstone"));
    assert(capabilities.has("UserAffiliationChange"));

    // Should not have capabilities from other roles
    assert(!capabilities.has("SystemRead"));
    assert(!capabilities.has("ClusterRead"));
  });

  await t.step("role capabilities: org_structure_admin has expected capabilities", async () => {
    const role = PRECONFIGURED_ROLES.get("org_structure_admin");
    assert(role);
    const capabilities = role.capabilities;

    assert(capabilities.has("ClusterRead"));
    assert(capabilities.has("ClusterCreate"));
    assert(capabilities.has("ClusterUpdate"));
    assert(capabilities.has("ClusterDelete"));
    assert(capabilities.has("TeamRead"));
    assert(capabilities.has("TeamCreate"));
    assert(capabilities.has("TeamUpdate"));
    assert(capabilities.has("TeamDelete"));
    assert(capabilities.has("TeamMemberRead"));
    assert(capabilities.has("TeamMemberManage"));
  });

  await t.step("role capabilities: systems_assets_admin has expected capabilities", async () => {
    const role = PRECONFIGURED_ROLES.get("systems_assets_admin");
    assert(role);
    const capabilities = role.capabilities;

    assert(capabilities.has("SystemRead"));
    assert(capabilities.has("SystemCreate"));
    assert(capabilities.has("SystemUpdate"));
    assert(capabilities.has("SystemDelete"));
    assert(capabilities.has("AssetRead"));
    assert(capabilities.has("AssetCreate"));
    assert(capabilities.has("AssetUpdate"));
    assert(capabilities.has("AssetDelete"));
    assert(capabilities.has("AssetSync"));
  });

  await t.step("role capabilities: data_operator has expected capabilities", async () => {
    const role = PRECONFIGURED_ROLES.get("data_operator");
    assert(role);
    const capabilities = role.capabilities;

    assert(capabilities.has("DataExport"));
    assert(capabilities.has("DataImport"));
    assert(capabilities.has("DataResetSeed"));
    assert(capabilities.has("RequestAdminReset"));
  });

  await t.step("role capabilities: config_audit_admin has expected capabilities", async () => {
    const role = PRECONFIGURED_ROLES.get("config_audit_admin");
    assert(role);
    const capabilities = role.capabilities;

    assert(capabilities.has("ConfigAppSettingsRead"));
    assert(capabilities.has("ConfigAppSettingsWrite"));
    assert(capabilities.has("ConfigEmailTemplateRead"));
    assert(capabilities.has("ConfigEmailTemplateWrite"));
    assert(capabilities.has("AuditLogRead"));
    assert(capabilities.has("AuditAccessLogRead"));
    assert(capabilities.has("AuditSentNotificationsRead"));
  });

  await t.step("role capabilities: full_admin has all capabilities", async () => {
    const role = PRECONFIGURED_ROLES.get("full_admin");
    assert(role);
    const capabilities = role.capabilities;

    // full_admin should have all capabilities
    for (const capability of ALL_CAPABILITIES) {
      assert(capabilities.has(capability), `full_admin missing capability: ${capability}`);
    }
  });

  await t.step("role capabilities: getRoleCapabilities returns correct capabilities for role", async () => {
    const userAdminCaps = await getRoleCapabilities("user_admin");
    assert(userAdminCaps.has("UserRead"));
    assert(userAdminCaps.has("UserInvite"));
    assert(!userAdminCaps.has("SystemRead"));

    const fullAdminCaps = await getRoleCapabilities("full_admin");
    assert(fullAdminCaps.has("UserRead"));
    assert(fullAdminCaps.has("SystemRead"));
  });

  await t.step("role capabilities: roleHasCapability returns correct boolean", async () => {
    assert(await roleHasCapability("user_admin", "UserRead"));
    assert(await roleHasCapability("user_admin", "UserInvite"));
    assert(!(await roleHasCapability("user_admin", "SystemRead")));

    assert(await roleHasCapability("full_admin", "UserRead"));
    assert(await roleHasCapability("full_admin", "SystemRead"));
    assert(await roleHasCapability("full_admin", "AdminRolesManage"));
  });

  await t.step("role capabilities: roleHasCapability returns false for invalid role", async () => {
    assert(!(await roleHasCapability("invalid_role", "UserRead")));
  });

  // ==========================================================================
  // Database Operations Tests
  // ==========================================================================

  await t.step("database: seedAdminRoles seeds all roles", async () => {
    // Clear any existing roles. Grants reference admin_roles via the
    // user_admin_role_grants_role_key_fkey FK, so earlier steps' grants must
    // be cleared first or the DELETE violates that constraint.
    await query(`DELETE FROM user_admin_role_grants`);
    await query(`DELETE FROM admin_roles`);

    // Seed roles
    await seedAdminRoles();

    // Verify all roles were seeded
    const roles = await listAdminRoles();
    assertEquals(roles.length, 6);

    const roleKeys = roles.map((r) => r.key);
    assert(roleKeys.includes("user_admin"));
    assert(roleKeys.includes("org_structure_admin"));
    assert(roleKeys.includes("systems_assets_admin"));
    assert(roleKeys.includes("data_operator"));
    assert(roleKeys.includes("config_audit_admin"));
    assert(roleKeys.includes("full_admin"));
  });

  await t.step("database: getAdminRoleMetadata returns role by key", async () => {
    const role = await getAdminRoleMetadata("user_admin");
    assert(role);
    assertEquals(role?.key, "user_admin");
    assertEquals(role?.name, "User Administrator");
  });
}
