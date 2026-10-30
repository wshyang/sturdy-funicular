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

export async function run03Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession, user1Id, user2Id } = context;
  await t.step("capability checking: hasAdminPrivilege returns false for ungranted capability", async () => {
    // Clear and create grant for user_admin (doesn't have SystemRead)
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);

    const hasPrivilege = await hasAdminPrivilege(user1Id, "SystemRead");
    assert(!hasPrivilege);
  });

  await t.step("capability checking: hasAdminPrivilege returns false for user with no grants", async () => {
    // Clear all grants
    await query(`DELETE FROM user_admin_role_grants`);

    const hasPrivilege = await hasAdminPrivilege(user1Id, "UserRead");
    assert(!hasPrivilege);
  });

  await t.step("capability checking: hasAdminPrivilege returns true for full_admin with any capability", async () => {
    // Clear and create full_admin grant
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "full_admin", adminId);

    // full_admin should have all capabilities
    for (const capability of ALL_CAPABILITIES) {
      const hasPrivilege = await hasAdminPrivilege(user1Id, capability);
      assert(hasPrivilege, `full_admin should have capability: ${capability}`);
    }
  });

  await t.step("capability checking: hasAdminPrivilege throws for invalid capability", async () => {
    await assertRejects(
      async () => await hasAdminPrivilege(user1Id, "InvalidCapability" as any),
      Error,
      "Unknown capability: InvalidCapability",
    );
  });

  await t.step("capability checking: requireAdminPrivilege succeeds for granted capability", async () => {
    // Clear and create grant
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);

    await requireAdminPrivilege(user1Id, "UserRead");
    // If we get here, the check passed
  });

  await t.step("capability checking: requireAdminPrivilege throws for ungranted capability", async () => {
    // Clear and create grant for user_admin (doesn't have SystemRead)
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);

    await assertRejects(
      async () => await requireAdminPrivilege(user1Id, "SystemRead"),
      AuthorizationError,
      "User lacks required admin capability: SystemRead",
    );
  });

  // ==========================================================================
  // Effective Capabilities Tests
  // ==========================================================================

  await t.step("effective capabilities: getEffectiveAdminCapabilities returns union of all role capabilities", async () => {
    // Clear and create multiple grants
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user1Id, "org_structure_admin", adminId);

    const capabilities = await getEffectiveAdminCapabilities(user1Id);

    // Should have capabilities from both roles
    assert(capabilities.has("UserRead")); // from user_admin
    assert(capabilities.has("ClusterRead")); // from org_structure_admin
    assert(capabilities.has("TeamRead")); // from org_structure_admin

    // Should not have capabilities from other roles
    assert(!capabilities.has("DataExport")); // from data_operator (not granted)
  });

  await t.step("effective capabilities: getEffectiveAdminCapabilities returns empty set for user with no grants", async () => {
    // Clear all grants
    await query(`DELETE FROM user_admin_role_grants`);

    const capabilities = await getEffectiveAdminCapabilities(user1Id);
    assertEquals(capabilities.size, 0);
  });

  // ==========================================================================
  // Admin User Tests
  // ==========================================================================

  await t.step("admin user: isAdminUser returns true for user with admin role", async () => {
    // Clear and create grant
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);

    const isAdmin = await isAdminUser(user1Id);
    assert(isAdmin);
  });

  await t.step("admin user: isAdminUser returns false for user with no admin roles", async () => {
    // Clear all grants
    await query(`DELETE FROM user_admin_role_grants`);

    const isAdmin = await isAdminUser(user1Id);
    assert(!isAdmin);
  });

  await t.step("admin user: isAdminUser returns false for user with only revoked grants", async () => {
    // Clear and create then revoke grant
    await query(`DELETE FROM user_admin_role_grants`);
    const grant = await grantAdminRole(user1Id, "user_admin", adminId);
    await revokeAdminRole(grant.id, adminId);

    const isAdmin = await isAdminUser(user1Id);
    assert(!isAdmin);
  });

  // ==========================================================================
  // Additive Model Tests
  // ==========================================================================

  await t.step("additive model: user with multiple roles has union of capabilities", async () => {
    // Clear and create grants for roles with overlapping and unique capabilities
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user1Id, "config_audit_admin", adminId);

    const capabilities = await getEffectiveAdminCapabilities(user1Id);

    // Should have capabilities from both roles
    assert(capabilities.has("UserRead")); // from user_admin
    assert(capabilities.has("UserInvite")); // from user_admin
    assert(capabilities.has("AuditLogRead")); // from config_audit_admin
    assert(capabilities.has("ConfigAppSettingsRead")); // from config_audit_admin
  });

  await t.step("additive model: granting additional role adds capabilities", async () => {
    // Clear and create initial grant
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(user1Id, "user_admin", adminId);

    let capabilities = await getEffectiveAdminCapabilities(user1Id);
    const initialCount = capabilities.size;
    assert(capabilities.has("UserRead"));
    assert(!capabilities.has("ClusterRead"));

    // Grant additional role
    await grantAdminRole(user1Id, "org_structure_admin", adminId);

    capabilities = await getEffectiveAdminCapabilities(user1Id);
    const newCount = capabilities.size;
    assert(newCount > initialCount);
    assert(capabilities.has("UserRead")); // Still has original
    assert(capabilities.has("ClusterRead")); // Now has new capability
  });

  await t.step("additive model: revoking role removes its capabilities", async () => {
    // Clear and create grants for two roles
    await query(`DELETE FROM user_admin_role_grants`);
    const grant1 = await grantAdminRole(user1Id, "user_admin", adminId);
    await grantAdminRole(user1Id, "org_structure_admin", adminId);

    let capabilities = await getEffectiveAdminCapabilities(user1Id);
    assert(capabilities.has("UserRead")); // from user_admin
    assert(capabilities.has("ClusterRead")); // from org_structure_admin

    // Revoke user_admin role
    await revokeAdminRole(grant1.id, adminId);

    capabilities = await getEffectiveAdminCapabilities(user1Id);
    assert(!capabilities.has("UserRead")); // Removed
    assert(capabilities.has("ClusterRead")); // Still has this one
  });

  // ── Capability hygiene (red-regiment ledger row 6) ──────────────────────
  // Deep-dive findings from docs/assessments/2026-08-04-capability-org-
  // scoping-deep-dive.md. Both steps are RED by design until the cleanup
  // lands (no gating — owner direction 2026-08-05).

  await t.step("capability hygiene: dead capability 'AdminCapabilitiesDebugView' is removed from the registry", async () => {
    // Finding: AdminCapabilitiesDebugView has ZERO enforcement call sites
    // anywhere in server/ — a dead capability carried by the union
    // (auth-admin-roles.tsx:93), the validation set (:119) and the
    // full_admin role (:242). Desired: gone from all three.
    assert(
      (ALL_CAPABILITIES as ReadonlySet<string>).has("AdminCapabilitiesDebugView") === false,
      "AdminCapabilitiesDebugView must be removed from ALL_CAPABILITIES (dead capability — red-regiment ledger row 6)",
    );
    assertEquals(isValidCapability("AdminCapabilitiesDebugView"), false);
    const fullAdmin = PRECONFIGURED_ROLES.get("full_admin");
    assert(fullAdmin !== undefined);
    assert(
      (fullAdmin.capabilities as ReadonlySet<string>).has("AdminCapabilitiesDebugView") === false,
      "full_admin must no longer grant AdminCapabilitiesDebugView (red-regiment ledger row 6)",
    );
  });

  await t.step("capability hygiene: 'org_structure_admin' display name no longer collides with the organisations concept", async () => {
    // Finding: the role is named "Organization Structure Administrator" but
    // it manages CLUSTERS & TEAMS — and the addendum-109 organisations
    // dimension now owns the word "Organization". Desired name: "Cluster &
    // Team Structure Administrator".
    const role = PRECONFIGURED_ROLES.get("org_structure_admin");
    assert(role !== undefined);
    assertEquals(role.name, "Cluster & Team Structure Administrator");
  });

  // ── Capability introspection routes (G1 — addendum-140 gap register) ────
  // The six introspection routes consumed by src/app/lib/api/admin.ts had ZERO
  // suite references before this cluster: /admin/capabilities, .../check,
  // .../check-multiple, .../all, /admin/roles/my-grants, /admin/is-admin.
  // Sessions: adminSession (grants re-asserted below — the additive-model
  // steps above wipe user_admin_role_grants) + a fresh GRANTLESS user.
}
