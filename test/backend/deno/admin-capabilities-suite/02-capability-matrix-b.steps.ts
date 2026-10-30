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

export async function run02Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession, testUserId } = context;
  await t.step("TeamMemberManage: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("TeamMemberManage");
    });
    assert(grant, "TeamMemberManage grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamMemberManage");
    assert(!hasPrivilege);
  });

  // -- Systems & Assets Capabilities (11) --

  await t.step("SystemRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemRead");
    assert(!hasPrivilege);
  });

  await t.step("SystemRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("SystemRead");
    assert(roleKey, "No role found for SystemRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemRead");
    assert(hasPrivilege);
  });

  await t.step("SystemRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("SystemRead");
    });
    assert(grant, "SystemRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemRead");
    assert(!hasPrivilege);
  });

  await t.step("SystemCreate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemCreate");
    assert(!hasPrivilege);
  });

  await t.step("SystemCreate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("SystemCreate");
    assert(roleKey, "No role found for SystemCreate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemCreate");
    assert(hasPrivilege);
  });

  await t.step("SystemCreate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("SystemCreate");
    });
    assert(grant, "SystemCreate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemCreate");
    assert(!hasPrivilege);
  });

  await t.step("SystemUpdate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemUpdate");
    assert(!hasPrivilege);
  });

  await t.step("SystemUpdate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("SystemUpdate");
    assert(roleKey, "No role found for SystemUpdate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemUpdate");
    assert(hasPrivilege);
  });

  await t.step("SystemUpdate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("SystemUpdate");
    });
    assert(grant, "SystemUpdate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemUpdate");
    assert(!hasPrivilege);
  });

  await t.step("SystemDelete: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemDelete");
    assert(!hasPrivilege);
  });

  await t.step("SystemDelete: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("SystemDelete");
    assert(roleKey, "No role found for SystemDelete capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemDelete");
    assert(hasPrivilege);
  });

  await t.step("SystemDelete: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("SystemDelete");
    });
    assert(grant, "SystemDelete grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemDelete");
    assert(!hasPrivilege);
  });

  await t.step("SystemMappingRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemMappingRead");
    assert(!hasPrivilege);
  });

  await t.step("SystemMappingRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("SystemMappingRead");
    assert(roleKey, "No role found for SystemMappingRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemMappingRead");
    assert(hasPrivilege);
  });

  await t.step("SystemMappingRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("SystemMappingRead");
    });
    assert(grant, "SystemMappingRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemMappingRead");
    assert(!hasPrivilege);
  });

  await t.step("SystemMappableTeamsRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemMappableTeamsRead");
    assert(!hasPrivilege);
  });

  await t.step("SystemMappableTeamsRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("SystemMappableTeamsRead");
    assert(roleKey, "No role found for SystemMappableTeamsRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemMappableTeamsRead");
    assert(hasPrivilege);
  });

  await t.step("SystemMappableTeamsRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("SystemMappableTeamsRead");
    });
    assert(grant, "SystemMappableTeamsRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemMappableTeamsRead");
    assert(!hasPrivilege);
  });

  await t.step("SystemOwnerManage: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemOwnerManage");
    assert(!hasPrivilege);
  });

  await t.step("SystemOwnerManage: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("SystemOwnerManage");
    assert(roleKey, "No role found for SystemOwnerManage capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemOwnerManage");
    assert(hasPrivilege);
  });

  await t.step("SystemOwnerManage: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("SystemOwnerManage");
    });
    assert(grant, "SystemOwnerManage grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "SystemOwnerManage");
    assert(!hasPrivilege);
  });

  await t.step("TeamSystemMappingManage: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamSystemMappingManage");
    assert(!hasPrivilege);
  });

  await t.step("TeamSystemMappingManage: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("TeamSystemMappingManage");
    assert(roleKey, "No role found for TeamSystemMappingManage capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamSystemMappingManage");
    assert(hasPrivilege);
  });

  await t.step("TeamSystemMappingManage: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("TeamSystemMappingManage");
    });
    assert(grant, "TeamSystemMappingManage grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamSystemMappingManage");
    assert(!hasPrivilege);
  });

  await t.step("OwnerPAMappingManage: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "OwnerPAMappingManage");
    assert(!hasPrivilege);
  });

  await t.step("OwnerPAMappingManage: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("OwnerPAMappingManage");
    assert(roleKey, "No role found for OwnerPAMappingManage capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "OwnerPAMappingManage");
    assert(hasPrivilege);
  });

  await t.step("OwnerPAMappingManage: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("OwnerPAMappingManage");
    });
    assert(grant, "OwnerPAMappingManage grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "OwnerPAMappingManage");
    assert(!hasPrivilege);
  });

  await t.step("AssetRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetRead");
    assert(!hasPrivilege);
  });

  await t.step("AssetRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AssetRead");
    assert(roleKey, "No role found for AssetRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetRead");
    assert(hasPrivilege);
  });

  await t.step("AssetRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AssetRead");
    });
    assert(grant, "AssetRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetRead");
    assert(!hasPrivilege);
  });

  await t.step("AssetCreate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetCreate");
    assert(!hasPrivilege);
  });

  await t.step("AssetCreate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AssetCreate");
    assert(roleKey, "No role found for AssetCreate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetCreate");
    assert(hasPrivilege);
  });

  await t.step("AssetCreate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AssetCreate");
    });
    assert(grant, "AssetCreate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetCreate");
    assert(!hasPrivilege);
  });

  await t.step("AssetUpdate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetUpdate");
    assert(!hasPrivilege);
  });

  await t.step("AssetUpdate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AssetUpdate");
    assert(roleKey, "No role found for AssetUpdate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetUpdate");
    assert(hasPrivilege);
  });

  await t.step("AssetUpdate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AssetUpdate");
    });
    assert(grant, "AssetUpdate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetUpdate");
    assert(!hasPrivilege);
  });

  await t.step("AssetDelete: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetDelete");
    assert(!hasPrivilege);
  });

  await t.step("AssetDelete: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AssetDelete");
    assert(roleKey, "No role found for AssetDelete capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetDelete");
    assert(hasPrivilege);
  });

  await t.step("AssetDelete: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AssetDelete");
    });
    assert(grant, "AssetDelete grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetDelete");
    assert(!hasPrivilege);
  });

  await t.step("AssetSync: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetSync");
    assert(!hasPrivilege);
  });

  await t.step("AssetSync: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("AssetSync");
    assert(roleKey, "No role found for AssetSync capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetSync");
    assert(hasPrivilege);
  });

  await t.step("AssetSync: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("AssetSync");
    });
    assert(grant, "AssetSync grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "AssetSync");
    assert(!hasPrivilege);
  });

  // -- Data Operations Capabilities (4) --

  await t.step("DataExport: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataExport");
    assert(!hasPrivilege);
  });

  await t.step("DataExport: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("DataExport");
    assert(roleKey, "No role found for DataExport capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataExport");
    assert(hasPrivilege);
  });

  await t.step("DataExport: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("DataExport");
    });
    assert(grant, "DataExport grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataExport");
    assert(!hasPrivilege);
  });

  await t.step("DataImport: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataImport");
    assert(!hasPrivilege);
  });

  await t.step("DataImport: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("DataImport");
    assert(roleKey, "No role found for DataImport capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataImport");
    assert(hasPrivilege);
  });

  await t.step("DataImport: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("DataImport");
    });
    assert(grant, "DataImport grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataImport");
    assert(!hasPrivilege);
  });

  await t.step("DataResetSeed: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "DataResetSeed");
    assert(!hasPrivilege);
  });
}
