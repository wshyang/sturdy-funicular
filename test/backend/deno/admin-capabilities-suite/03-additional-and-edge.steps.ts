// Comprehensive Capability Test Suite (addendum-066-mixed-identity-entra-local-security.md).
//
// This test suite provides EXHAUSTIVE coverage for all 30+ admin capabilities.
// For EACH capability, we test:
// 1. BASELINE: When not granted, action is NOT possible (returns false/throws)
// 2. POSITIVE: After granted, action IS possible (returns true/succeeds)
// 3. NEGATIVE: After removed, action is NOT possible again (returns false/throws)
//
// Total: 30+ capabilities × 3 test patterns = 90+ individual capability tests
// Plus: Additional validation, edge case, and integration tests
// Total tests: 100+
//
// See: server/auth-admin-roles.tsx for capability definitions
// See: docs/specs/addenda/addendum-066-mixed-identity-entra-local-security.md

import { assertEquals, assert, assertRejects } from "jsr:@std/assert";
import {
  ALL_CAPABILITIES,
  PRECONFIGURED_ROLES,
  grantAdminRole,
  revokeAdminRole,
  listAdminRoleGrants,
  getEffectiveAdminCapabilities,
  isAdminUser,
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

// ============================================================================
// HELPER FUNCTIONS FOR CAPABILITY TESTING
// ============================================================================

/**
 * Clears all role grants for a user.
 */
async function clearUserGrants(userId: string): Promise<void> {
  await query(`DELETE FROM user_admin_role_grants WHERE user_id = $1`, [userId]);
}

/**
 * Gets the role that contains a specific capability.
 * Returns the role key that has the capability, or null if not found.
 */
function getRoleForCapability(capability: string): string | null {
  for (const [roleKey, role] of PRECONFIGURED_ROLES) {
    if (role.capabilities.has(capability as any)) {
      return roleKey;
    }
  }
  return null;
}

/**
 * Gets all capabilities for a specific role.
 */
function getCapabilitiesForRole(roleKey: string): string[] {
  const role = PRECONFIGURED_ROLES.get(roleKey);
  if (!role) return [];
  return Array.from(role.capabilities);
}

// ============================================================================
// MAIN TEST SUITE
// ============================================================================

import type { SuiteContext } from "./00-context.ts";

export async function run03Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession, testUserId } = context;
  await t.step("DataResetSeed: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("DataResetSeed");
    assert(roleKey, "No role found for DataResetSeed capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataResetSeed");
    assert(hasPrivilege);
  });

  await t.step("DataResetSeed: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("DataResetSeed");
    });
    assert(grant, "DataResetSeed grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataResetSeed");
    assert(!hasPrivilege);
  });

  await t.step("RequestAdminReset: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "RequestAdminReset");
    assert(!hasPrivilege);
  });

  await t.step("RequestAdminReset: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("RequestAdminReset");
    assert(roleKey, "No role found for RequestAdminReset capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "RequestAdminReset");
    assert(hasPrivilege);
  });

  await t.step("RequestAdminReset: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("RequestAdminReset");
    });
    assert(grant, "RequestAdminReset grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "RequestAdminReset");
    assert(!hasPrivilege);
  });

  // -- Configuration Capabilities (4) --

  await t.step("ConfigAppSettingsRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigAppSettingsRead");
    assert(!hasPrivilege);
  });

  await t.step("ConfigAppSettingsRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ConfigAppSettingsRead");
    assert(roleKey, "No role found for ConfigAppSettingsRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigAppSettingsRead");
    assert(hasPrivilege);
  });

  await t.step("ConfigAppSettingsRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ConfigAppSettingsRead");
    });
    assert(grant, "ConfigAppSettingsRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigAppSettingsRead");
    assert(!hasPrivilege);
  });

  await t.step("ConfigAppSettingsWrite: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigAppSettingsWrite");
    assert(!hasPrivilege);
  });

  await t.step("ConfigAppSettingsWrite: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ConfigAppSettingsWrite");
    assert(roleKey, "No role found for ConfigAppSettingsWrite capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigAppSettingsWrite");
    assert(hasPrivilege);
  });

  await t.step("ConfigAppSettingsWrite: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ConfigAppSettingsWrite");
    });
    assert(grant, "ConfigAppSettingsWrite grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigAppSettingsWrite");
    assert(!hasPrivilege);
  });

  await t.step("ConfigEmailTemplateRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigEmailTemplateRead");
    assert(!hasPrivilege);
  });

  await t.step("ConfigEmailTemplateRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ConfigEmailTemplateRead");
    assert(roleKey, "No role found for ConfigEmailTemplateRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigEmailTemplateRead");
    assert(hasPrivilege);
  });

  await t.step("ConfigEmailTemplateRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ConfigEmailTemplateRead");
    });
    assert(grant, "ConfigEmailTemplateRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigEmailTemplateRead");
    assert(!hasPrivilege);
  });

  await t.step("ConfigEmailTemplateWrite: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigEmailTemplateWrite");
    assert(!hasPrivilege);
  });

  await t.step("ConfigEmailTemplateWrite: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ConfigEmailTemplateWrite");
    assert(roleKey, "No role found for ConfigEmailTemplateWrite capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigEmailTemplateWrite");
    assert(hasPrivilege);
  });

  await t.step("ConfigEmailTemplateWrite: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ConfigEmailTemplateWrite");
    });
    assert(grant, "ConfigEmailTemplateWrite grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ConfigEmailTemplateWrite");
    assert(!hasPrivilege);
  });

  // -- Audit Capabilities (3) --

  await t.step("AuditLogRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditLogRead");
    assert(!hasPrivilege);
  });

  await t.step("AuditLogRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AuditLogRead");
    assert(roleKey, "No role found for AuditLogRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditLogRead");
    assert(hasPrivilege);
  });

  await t.step("AuditLogRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AuditLogRead");
    });
    assert(grant, "AuditLogRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditLogRead");
    assert(!hasPrivilege);
  });

  await t.step("AuditAccessLogRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditAccessLogRead");
    assert(!hasPrivilege);
  });

  await t.step("AuditAccessLogRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AuditAccessLogRead");
    assert(roleKey, "No role found for AuditAccessLogRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditAccessLogRead");
    assert(hasPrivilege);
  });

  await t.step("AuditAccessLogRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AuditAccessLogRead");
    });
    assert(grant, "AuditAccessLogRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditAccessLogRead");
    assert(!hasPrivilege);
  });

  await t.step("AuditSentNotificationsRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditSentNotificationsRead");
    assert(!hasPrivilege);
  });

  await t.step("AuditSentNotificationsRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AuditSentNotificationsRead");
    assert(roleKey, "No role found for AuditSentNotificationsRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditSentNotificationsRead");
    assert(hasPrivilege);
  });

  await t.step("AuditSentNotificationsRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AuditSentNotificationsRead");
    });
    assert(grant, "AuditSentNotificationsRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AuditSentNotificationsRead");
    assert(!hasPrivilege);
  });

  // -- Admin Capabilities (2) --

  await t.step("AdminRolesManage: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AdminRolesManage");
    assert(!hasPrivilege);
  });

  await t.step("AdminRolesManage: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AdminRolesManage");
    assert(roleKey, "No role found for AdminRolesManage capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AdminRolesManage");
    assert(hasPrivilege);
  });

  await t.step("AdminRolesManage: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AdminRolesManage");
    });
    assert(grant, "AdminRolesManage grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AdminRolesManage");
    assert(!hasPrivilege);
  });

  // NOTE: AdminCapabilitiesDebugView was removed (migration 058, red-regiment
  // ledger row 6) — zero enforcement call sites. Tests for it have been dropped.

  // ==========================================================================
  // ADDITIONAL COMPREHENSIVE TESTS
  // ==========================================================================

  // Test that full_admin has ALL capabilities
  await t.step("full_admin role: has ALL 30+ capabilities when granted", async () => {
    await clearUserGrants(testUserId);
    await grantAdminRole(testUserId, "full_admin", adminId);

    for (const capability of ALL_CAPABILITIES) {
      const hasPrivilege = await hasAdminPrivilege(testUserId, capability);
      assert(hasPrivilege, `full_admin should have capability: ${capability}`);
    }
  });

  // Test that full_admin loses all capabilities when revoked
  await t.step("full_admin role: loses ALL capabilities when revoked", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const fullAdminGrant = grants.find((g) => g.roleKey === "full_admin");
    assert(fullAdminGrant, "full_admin grant not found");
    await revokeAdminRole(fullAdminGrant.id, adminId);

    for (const capability of ALL_CAPABILITIES) {
      const hasPrivilege = await hasAdminPrivilege(testUserId, capability);
      assert(!hasPrivilege, `User should not have capability ${capability} after full_admin revoked`);
    }
  });

  // Test that multiple roles grant union of capabilities
  await t.step("multiple roles: capabilities are additive (union)", async () => {
    await clearUserGrants(testUserId);

    // Grant user_admin role
    await grantAdminRole(testUserId, "user_admin", adminId);
    let capabilities = await getEffectiveAdminCapabilities(testUserId);
    const userAdminCaps = getCapabilitiesForRole("user_admin");
    assertEquals(capabilities.size, userAdminCaps.length);

    // Grant org_structure_admin role
    await grantAdminRole(testUserId, "org_structure_admin", adminId);
    capabilities = await getEffectiveAdminCapabilities(testUserId);
    const orgStructureCaps = getCapabilitiesForRole("org_structure_admin");
    const expectedCount = new Set([...userAdminCaps, ...orgStructureCaps]).size;
    assertEquals(capabilities.size, expectedCount);

    // Verify specific capabilities from both roles
    assert(capabilities.has("UserRead")); // from user_admin
    assert(capabilities.has("ClusterRead")); // from org_structure_admin
  });

  // Test requireAdminPrivilege with baseline/positive/negative
  await t.step("requireAdminPrivilege: throws when not granted (baseline)", async () => {
    await clearUserGrants(testUserId);
    await assertRejects(
      async () => await requireAdminPrivilege(testUserId, "UserRead"),
      AuthorizationError,
      "User lacks required admin capability: UserRead",
    );
  });

  await t.step("requireAdminPrivilege: succeeds when granted (positive)", async () => {
    await grantAdminRole(testUserId, "user_admin", adminId);
    await requireAdminPrivilege(testUserId, "UserRead"); // Should not throw
  });

  await t.step("requireAdminPrivilege: throws when revoked (negative)", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserRead");
    });
    assert(grant, "UserRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    await assertRejects(
      async () => await requireAdminPrivilege(testUserId, "UserRead"),
      AuthorizationError,
      "User lacks required admin capability: UserRead",
    );
  });

  // Test isAdminUser with baseline/positive/negative
  await t.step("isAdminUser: returns false when no roles (baseline)", async () => {
    await clearUserGrants(testUserId);
    const isAdmin = await isAdminUser(testUserId);
    assert(!isAdmin);
  });

  await t.step("isAdminUser: returns true when role granted (positive)", async () => {
    await grantAdminRole(testUserId, "user_admin", adminId);
    const isAdmin = await isAdminUser(testUserId);
    assert(isAdmin);
  });

  await t.step("isAdminUser: returns false when role revoked (negative)", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants[0]; // Any grant
    await revokeAdminRole(grant.id, adminId);
    const isAdmin = await isAdminUser(testUserId);
    assert(!isAdmin);
  });

  // Test that each role has its expected capabilities
  await t.step("role capability mappings: each role has correct capabilities", async () => {
    for (const [roleKey, role] of PRECONFIGURED_ROLES) {
      const capabilities = getCapabilitiesForRole(roleKey);
      assertEquals(capabilities.length, role.capabilities.size);
      for (const cap of capabilities) {
        assert(role.capabilities.has(cap as any), `${roleKey} should have ${cap}`);
      }
    }
  });

  // Test that all capabilities are covered by at least one role
  await t.step("capability coverage: all capabilities are in at least one role", async () => {
    const coveredCapabilities = new Set<string>();
    for (const [, role] of PRECONFIGURED_ROLES) {
      for (const cap of role.capabilities) {
        coveredCapabilities.add(cap);
      }
    }
    for (const capability of ALL_CAPABILITIES) {
      assert(coveredCapabilities.has(capability), `Capability ${capability} not covered by any role`);
    }
  });

  // Test invalid capability handling
  await t.step("invalid capability: hasAdminPrivilege throws for invalid capability", async () => {
    await assertRejects(
      async () => await hasAdminPrivilege(testUserId, "InvalidCapability" as any),
      Error,
      "Unknown capability: InvalidCapability",
    );
  });

  await t.step("invalid capability: requireAdminPrivilege throws for invalid capability", async () => {
    await assertRejects(
      async () => await requireAdminPrivilege(testUserId, "InvalidCapability" as any),
      Error,
      "Unknown capability: InvalidCapability",
    );
  });

  // Test invalid role handling
  await t.step("invalid role: grantAdminRole throws for invalid role", async () => {
    await assertRejects(
      async () => await grantAdminRole(testUserId, "invalid_role", adminId),
      Error,
      "Unknown admin role: invalid_role",
    );
  });

  // Test that a user can have multiple roles for the same capability
  // (through different roles that share the capability)
  await t.step("redundant roles: user can have multiple roles with same capability", async () => {
    await clearUserGrants(testUserId);

    // Grant full_admin (has all capabilities)
    await grantAdminRole(testUserId, "full_admin", adminId);
    const hasPrivilege1 = await hasAdminPrivilege(testUserId, "UserRead");
    assert(hasPrivilege1);

    // Grant user_admin (also has UserRead)
    await grantAdminRole(testUserId, "user_admin", adminId);
    const hasPrivilege2 = await hasAdminPrivilege(testUserId, "UserRead");
    assert(hasPrivilege2);

    // User should still have the capability
    const capabilities = await getEffectiveAdminCapabilities(testUserId);
    assert(capabilities.has("UserRead"));

    // Revoke user_admin
    const grants = await listAdminRoleGrants(testUserId);
    const userAdminGrant = grants.find((g) => g.roleKey === "user_admin");
    assert(userAdminGrant, "user_admin grant not found");
    await revokeAdminRole(userAdminGrant.id, adminId);

    // User should still have the capability from full_admin
    const hasPrivilege3 = await hasAdminPrivilege(testUserId, "UserRead");
    assert(hasPrivilege3);
  });

  // Test that revoking a role that shares a capability with another role
  // doesn't remove the capability
  await t.step("redundant capabilities: revoking one role doesn't remove capability if another role has it", async () => {
    await clearUserGrants(testUserId);

    // Grant both full_admin and user_admin
    await grantAdminRole(testUserId, "full_admin", adminId);
    await grantAdminRole(testUserId, "user_admin", adminId);

    // Verify UserRead is present
    const hasPrivilege1 = await hasAdminPrivilege(testUserId, "UserRead");
    assert(hasPrivilege1);

    // Revoke full_admin
    const grants = await listAdminRoleGrants(testUserId);
    const fullAdminGrant = grants.find((g) => g.roleKey === "full_admin");
    assert(fullAdminGrant, "full_admin grant not found");
    await revokeAdminRole(fullAdminGrant.id, adminId);

    // User should still have UserRead from user_admin
    const hasPrivilege2 = await hasAdminPrivilege(testUserId, "UserRead");
    assert(hasPrivilege2);

    // Revoke user_admin
    const userAdminGrant = await listAdminRoleGrants(testUserId);
    const userAdminGrantObj = userAdminGrant.find((g) => g.roleKey === "user_admin");
    assert(userAdminGrantObj, "user_admin grant not found");
    await revokeAdminRole(userAdminGrantObj.id, adminId);

    // Now UserRead should be gone
    const hasPrivilege3 = await hasAdminPrivilege(testUserId, "UserRead");
    assert(!hasPrivilege3);
  });
}
