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

export async function run02Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession, user1Id, user2Id } = context;
  await t.step("database: getAdminRoleMetadata returns null for non-existent role", async () => {
    const role = await getAdminRoleMetadata("non_existent");
    assert(!role);
  });

  // ==========================================================================
  // Role Grant Tests
  // ==========================================================================

  await t.step("role grants: grantAdminRole creates grant", async () => {
    // Clear any existing grants
    await query(`DELETE FROM user_admin_role_grants`);

    const grant = await grantAdminRole(user1Id, "user_admin", adminId, "Test grant");

    assert(grant);
    assertEquals(grant.userId, user1Id);
    assertEquals(grant.roleKey, "user_admin");
    assertEquals(grant.grantedBy, adminId);
    assert(!grant.revokedAt);

    // Verify in database
    const grants = await listAdminRoleGrants(user1Id);
    assertEquals(grants.length, 1);
    assertEquals(grants[0].roleKey, "user_admin");
  });

  await t.step("role grants: grantAdminRole throws for invalid role", async () => {
    await assertRejects(
      async () => await grantAdminRole(user1Id, "invalid_role", adminId),
      Error,
      "Unknown admin role: invalid_role",
    );
  });

  await t.step("role grants: listAdminRoleGrants returns grants for user", async () => {
    // Clear and create fresh grants
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user1Id, "org_structure_admin", adminId);

    const grants = await listAdminRoleGrants(user1Id);
    assertEquals(grants.length, 2);

    const roleKeys = grants.map((g) => g.roleKey);
    assert(roleKeys.includes("user_admin"));
    assert(roleKeys.includes("org_structure_admin"));
  });

  await t.step("role grants: listAdminRoleGrants excludes revoked grants by default", async () => {
    // Clear and create grant
    await query(`DELETE FROM user_admin_role_grants`);
    const grant = await grantAdminRole(user1Id, "user_admin", adminId);

    // Revoke the grant
    await revokeAdminRole(grant.id, adminId, "Test revocation");

    // List active grants (should be empty)
    const activeGrants = await listAdminRoleGrants(user1Id, false);
    assertEquals(activeGrants.length, 0);

    // List all grants (should include revoked)
    const allGrants = await listAdminRoleGrants(user1Id, true);
    assertEquals(allGrants.length, 1);
    assert(allGrants[0].revokedAt);
  });

  await t.step("role grants: revokeAdminRole revokes grant", async () => {
    // Clear and create grant
    await query(`DELETE FROM user_admin_role_grants`);
    const grant = await grantAdminRole(user1Id, "user_admin", adminId);

    const revoked = await revokeAdminRole(grant.id, adminId, "Test revocation");

    assert(revoked);
    assert(revoked.revokedAt);
    assertEquals(revoked.revokedBy, adminId);
    assertEquals(revoked.revocationReason, "Test revocation");
  });

  await t.step("role grants: revokeAdminRole returns null for non-existent grant", async () => {
    const result = await revokeAdminRole("00000000-0000-0000-0000-000000000000", adminId);
    assert(!result);
  });

  await t.step("role grants: revokeAdminRole returns null for already revoked grant", async () => {
    // Clear and create grant
    await query(`DELETE FROM user_admin_role_grants`);
    const grant = await grantAdminRole(user1Id, "user_admin", adminId);

    // Revoke once
    await revokeAdminRole(grant.id, adminId);

    // Try to revoke again
    const result = await revokeAdminRole(grant.id, adminId);
    assert(!result);
  });

  await t.step("role grants: revokeAllAdminRoles revokes all grants for user", async () => {
    // Clear and create multiple grants
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user1Id, "org_structure_admin", adminId);
    await grantAdminRole(user1Id, "systems_assets_admin", adminId);

    const revoked = await revokeAllAdminRoles(user1Id, adminId, "Bulk revocation");
    assertEquals(revoked.length, 3);

    // Verify all are revoked
    const activeGrants = await listAdminRoleGrants(user1Id, false);
    assertEquals(activeGrants.length, 0);
  });

  await t.step("role grants: listAllActiveAdminRoleGrants returns all active grants", async () => {
    // Clear and create grants for multiple users
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user2Id, "org_structure_admin", adminId);

    const allGrants = await listAllActiveAdminRoleGrants();
    assertEquals(allGrants.length, 2);
  });

  await t.step("role grants: listByRole returns grants for specific role", async () => {
    // Clear and create grants
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user2Id, "user_admin", adminId);
    await grantAdminRole(user1Id, "org_structure_admin", adminId);

    const userAdminGrants = await listAdminRoleGrants(user1Id);
    const userAdminRoleGrants = userAdminGrants.filter((g) => g.roleKey === "user_admin");
    assertEquals(userAdminRoleGrants.length, 1);
  });

  await t.step("role grants: getUsersWithRole returns users with specific role", async () => {
    // Clear and create grants
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user2Id, "user_admin", adminId);
    await grantAdminRole(user1Id, "org_structure_admin", adminId);

    const userAdminUsers = await getUsersWithRole("user_admin");
    assertEquals(userAdminUsers.length, 2);
    assert(userAdminUsers.includes(user1Id));
    assert(userAdminUsers.includes(user2Id));
  });

  // ==========================================================================
  // Capability Checking Tests
  // ==========================================================================

  await t.step("capability checking: hasAdminPrivilege returns true for granted capability", async () => {
    // Clear and create grant
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);

    const hasPrivilege = await hasAdminPrivilege(user1Id, "UserRead");
    assert(hasPrivilege);
  });
}
