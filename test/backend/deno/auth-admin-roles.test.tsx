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
import * as adminRoleModule from "../../../server/auth-admin-roles.tsx";
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

import { run01Steps } from "./auth-admin-roles-suite/01-catalogue.steps.ts";
import { run02Steps } from "./auth-admin-roles-suite/02-grants.steps.ts";
import { run03Steps } from "./auth-admin-roles-suite/03-effective-capabilities.steps.ts";
import { run04Steps } from "./auth-admin-roles-suite/04-introspection-routes.steps.ts";

Deno.test("auth-admin-roles", async (t) => {
  let adminId: string;
  let adminSession: string;
  let user1Id: string;
  let user2Id: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AdminRoleTest!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "AdminRoleTest!2026");
    adminSession = (login as any).session;

    // Create test users
    const user1 = await createActiveUser({
      fullName: "Admin Role User 1",
      email: uniqueEmail("adminroleuser1"),
      password: "User1!2026",
      affiliation: "vendor",
    });
    user1Id = user1.id;
    const user2 = await createActiveUser({
      fullName: "Admin Role User 2",
      email: uniqueEmail("adminroleuser2"),
      password: "User2!2026",
      affiliation: "vendor",
    });
    user2Id = user2.id;

    // Seed admin roles
    await seedAdminRoles();
  });

  // ==========================================================================
  // Canonical authorization API
  // ==========================================================================

  const context = { adminId, adminSession, user1Id, user2Id, grantsFreeSession: "" };
  await run01Steps(t, context);
  await run02Steps(t, context);
  await run03Steps(t, context);
  await run04Steps(t, context);
});
