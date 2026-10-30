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

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession, testUserId } = context;
  await t.step("UserRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserRead");
    assert(!hasPrivilege);
  });

  await t.step("UserRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("UserRead");
    assert(roleKey, "No role found for UserRead capability");
    await grantAdminRole(testUserId, roleKey, adminId, "Test grant");
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserRead");
    assert(hasPrivilege);
  });

  await t.step("UserRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const userReadGrant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserRead");
    });
    assert(userReadGrant, "UserRead grant not found");
    await revokeAdminRole(userReadGrant.id, adminId, "Test revocation");
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserRead");
    assert(!hasPrivilege);
  });

  await t.step("UserInvite: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserInvite");
    assert(!hasPrivilege);
  });

  await t.step("UserInvite: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("UserInvite");
    assert(roleKey, "No role found for UserInvite capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserInvite");
    assert(hasPrivilege);
  });

  await t.step("UserInvite: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserInvite");
    });
    assert(grant, "UserInvite grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserInvite");
    assert(!hasPrivilege);
  });

  await t.step("UserApprove: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserApprove");
    assert(!hasPrivilege);
  });

  await t.step("UserApprove: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("UserApprove");
    assert(roleKey, "No role found for UserApprove capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserApprove");
    assert(hasPrivilege);
  });

  await t.step("UserApprove: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserApprove");
    });
    assert(grant, "UserApprove grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserApprove");
    assert(!hasPrivilege);
  });

  await t.step("UserReject: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserReject");
    assert(!hasPrivilege);
  });

  await t.step("UserReject: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("UserReject");
    assert(roleKey, "No role found for UserReject capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserReject");
    assert(hasPrivilege);
  });

  await t.step("UserReject: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserReject");
    });
    assert(grant, "UserReject grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserReject");
    assert(!hasPrivilege);
  });

  await t.step("UserTombstone: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserTombstone");
    assert(!hasPrivilege);
  });

  await t.step("UserTombstone: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("UserTombstone");
    assert(roleKey, "No role found for UserTombstone capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserTombstone");
    assert(hasPrivilege);
  });

  await t.step("UserTombstone: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserTombstone");
    });
    assert(grant, "UserTombstone grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserTombstone");
    assert(!hasPrivilege);
  });

  await t.step("UserUntombstone: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserUntombstone");
    assert(!hasPrivilege);
  });

  await t.step("UserUntombstone: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("UserUntombstone");
    assert(roleKey, "No role found for UserUntombstone capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserUntombstone");
    assert(hasPrivilege);
  });

  await t.step("UserUntombstone: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserUntombstone");
    });
    assert(grant, "UserUntombstone grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserUntombstone");
    assert(!hasPrivilege);
  });

  await t.step("UserAffiliationChange: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserAffiliationChange");
    assert(!hasPrivilege);
  });

  await t.step("UserAffiliationChange: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("UserAffiliationChange");
    assert(roleKey, "No role found for UserAffiliationChange capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserAffiliationChange");
    assert(hasPrivilege);
  });

  await t.step("UserAffiliationChange: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("UserAffiliationChange");
    });
    assert(grant, "UserAffiliationChange grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "UserAffiliationChange");
    assert(!hasPrivilege);
  });

  // -- Organization Structure Capabilities (9) --

  await t.step("ClusterRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterRead");
    assert(!hasPrivilege);
  });

  await t.step("ClusterRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ClusterRead");
    assert(roleKey, "No role found for ClusterRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterRead");
    assert(hasPrivilege);
  });

  await t.step("ClusterRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ClusterRead");
    });
    assert(grant, "ClusterRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterRead");
    assert(!hasPrivilege);
  });

  await t.step("ClusterCreate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterCreate");
    assert(!hasPrivilege);
  });

  await t.step("ClusterCreate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ClusterCreate");
    assert(roleKey, "No role found for ClusterCreate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterCreate");
    assert(hasPrivilege);
  });

  await t.step("ClusterCreate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ClusterCreate");
    });
    assert(grant, "ClusterCreate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterCreate");
    assert(!hasPrivilege);
  });

  await t.step("ClusterUpdate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterUpdate");
    assert(!hasPrivilege);
  });

  await t.step("ClusterUpdate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ClusterUpdate");
    assert(roleKey, "No role found for ClusterUpdate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterUpdate");
    assert(hasPrivilege);
  });

  await t.step("ClusterUpdate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ClusterUpdate");
    });
    assert(grant, "ClusterUpdate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterUpdate");
    assert(!hasPrivilege);
  });

  await t.step("ClusterDelete: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterDelete");
    assert(!hasPrivilege);
  });

  await t.step("ClusterDelete: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("ClusterDelete");
    assert(roleKey, "No role found for ClusterDelete capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterDelete");
    assert(hasPrivilege);
  });

  await t.step("ClusterDelete: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("ClusterDelete");
    });
    assert(grant, "ClusterDelete grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "ClusterDelete");
    assert(!hasPrivilege);
  });

  await t.step("TeamRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamRead");
    assert(!hasPrivilege);
  });

  await t.step("TeamRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("TeamRead");
    assert(roleKey, "No role found for TeamRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamRead");
    assert(hasPrivilege);
  });

  await t.step("TeamRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("TeamRead");
    });
    assert(grant, "TeamRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamRead");
    assert(!hasPrivilege);
  });

  await t.step("TeamCreate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamCreate");
    assert(!hasPrivilege);
  });

  await t.step("TeamCreate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("TeamCreate");
    assert(roleKey, "No role found for TeamCreate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamCreate");
    assert(hasPrivilege);
  });

  await t.step("TeamCreate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("TeamCreate");
    });
    assert(grant, "TeamCreate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamCreate");
    assert(!hasPrivilege);
  });

  await t.step("TeamUpdate: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamUpdate");
    assert(!hasPrivilege);
  });

  await t.step("TeamUpdate: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("TeamUpdate");
    assert(roleKey, "No role found for TeamUpdate capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamUpdate");
    assert(hasPrivilege);
  });

  await t.step("TeamUpdate: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("TeamUpdate");
    });
    assert(grant, "TeamUpdate grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamUpdate");
    assert(!hasPrivilege);
  });

  await t.step("TeamDelete: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamDelete");
    assert(!hasPrivilege);
  });

  await t.step("TeamDelete: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("TeamDelete");
    assert(roleKey, "No role found for TeamDelete capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamDelete");
    assert(hasPrivilege);
  });

  await t.step("TeamDelete: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("TeamDelete");
    });
    assert(grant, "TeamDelete grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamDelete");
    assert(!hasPrivilege);
  });

  await t.step("TeamMemberRead: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamMemberRead");
    assert(!hasPrivilege);
  });

  await t.step("TeamMemberRead: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("TeamMemberRead");
    assert(roleKey, "No role found for TeamMemberRead capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamMemberRead");
    assert(hasPrivilege);
  });

  await t.step("TeamMemberRead: NEGATIVE - after removed, returns false", async () => {
    const grants = await listAdminRoleGrants(testUserId);
    const grant = grants.find((g) => {
      const role = PRECONFIGURED_ROLES.get(g.roleKey);
      return role?.capabilities.has("TeamMemberRead");
    });
    assert(grant, "TeamMemberRead grant not found");
    await revokeAdminRole(grant.id, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamMemberRead");
    assert(!hasPrivilege);
  });

  await t.step("TeamMemberManage: BASELINE - not granted, returns false", async () => {
    await clearUserGrants(testUserId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamMemberManage");
    assert(!hasPrivilege);
  });

  await t.step("TeamMemberManage: POSITIVE - after granted, returns true", async () => {
    const roleKey = getRoleForCapability("TeamMemberManage");
    assert(roleKey, "No role found for TeamMemberManage capability");
    await grantAdminRole(testUserId, roleKey, adminId);
    const hasPrivilege = await hasAdminPrivilege(testUserId, "TeamMemberManage");
    assert(hasPrivilege);
  });
}
