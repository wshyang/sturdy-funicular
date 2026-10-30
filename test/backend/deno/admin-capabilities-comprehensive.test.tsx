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
} from "../../../server/auth-admin-roles.tsx";
import {
  hasAdminPrivilege,
  requireAdminPrivilege,
} from "../../../server/auth.tsx";
import { AuthorizationError } from "../../../server/utils.tsx";
import { query } from "../../../server/pg.tsx";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
} from "./helpers.tsx";

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

import { run01Steps } from "./admin-capabilities-suite/01-capability-matrix-a.steps.ts";
import { run02Steps } from "./admin-capabilities-suite/02-capability-matrix-b.steps.ts";
import { run03Steps } from "./admin-capabilities-suite/03-additional-and-edge.steps.ts";

Deno.test("admin-capabilities-comprehensive", async (t) => {
  let adminId: string;
  let adminSession: string;
  let testUserId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("CapabilityTestAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "CapabilityTestAdmin!2026");
    adminSession = (login as any).session;

    // Create a test user
    const testUser = await createActiveUser({
      fullName: "Capability Test User",
      email: uniqueEmail("captestuser"),
      password: "CapabilityTestUser!2026",
      affiliation: "vendor",
    });
    testUserId = testUser.id;

    // Clear any existing grants
    await clearUserGrants(testUserId);
  });

  // ==========================================================================
  // INDIVIDUAL CAPABILITY TESTS
  // Each capability gets: BASELINE + POSITIVE + NEGATIVE tests
  // ==========================================================================

  // -- User Management Capabilities (7) --

  const context = { adminId, adminSession, testUserId };
  await run01Steps(t, context);
  await run02Steps(t, context);
  await run03Steps(t, context);
});
