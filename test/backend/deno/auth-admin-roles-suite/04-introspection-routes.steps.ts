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

export async function run04Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession, user1Id, user2Id } = context;
  await t.step("introspection setup: restore admin full_admin; mint a grantless non-admin session", async () => {
    await query(`DELETE FROM user_admin_role_grants`);
    await grantAdminRole(adminId, "full_admin", adminId, "introspection cluster setup");
    const plain = await createActiveUser({
      fullName: "Grantless User",
      email: uniqueEmail("grantless"),
      password: "Grantless!2026",
      affiliation: "agency",
    });
    const login = await loginAs(plain.email, "Grantless!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
    context.grantsFreeSession = login.session;
    assert(!(await isAdminUser(plain.id)), "fresh user must be grant-free");
  });

  await t.step("GET /admin/capabilities: positive shape — full set + count for full_admin", async () => {
    const res = await req("/admin/capabilities", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body.capabilities));
    assertEquals(body.count, ALL_CAPABILITIES.size);
    assertEquals(new Set(body.capabilities).size, ALL_CAPABILITIES.size);
    assert(body.capabilities.includes("UserRead"));
    assert(body.capabilities.includes("AdminRolesManage"));
  });

  await t.step("GET /admin/capabilities: non-admin 403, unauthenticated 401", async () => {
    const plain = await req("/admin/capabilities", { headers: authHeaders(context.grantsFreeSession) });
    assertEquals(plain.status, 403);
    const anon = await req("/admin/capabilities");
    assertEquals(anon.status, 401);
  });

  await t.step("GET /admin/capabilities/check: positive verdict; missing/unknown capability 400", async () => {
    const yes = await req("/admin/capabilities/check?capability=UserRead", { headers: authHeaders(adminSession) });
    assertEquals(yes.status, 200);
    assertEquals(await yes.json(), { capability: "UserRead", hasCapability: true });

    const no = await req("/admin/capabilities/check?capability=UserRead", { headers: authHeaders(context.grantsFreeSession) });
    assertEquals(no.status, 403); // introspection is admin-scoped, not self-serve

    const missing = await req("/admin/capabilities/check", { headers: authHeaders(adminSession) });
    assertEquals(missing.status, 400);
    const unknown = await req("/admin/capabilities/check?capability=NotARealCapability", { headers: authHeaders(adminSession) });
    assertEquals(unknown.status, 400);

    const anon = await req("/admin/capabilities/check?capability=UserRead");
    assertEquals(anon.status, 401, "unauthenticated must be 401 (was a null-deref 500 before addendum-141)");
  });

  await t.step("POST /admin/capabilities/check-multiple: positive per-cap verdicts; bad bodies 400; 401/403 negatives", async () => {
    const ok = await req("/admin/capabilities/check-multiple", {
      method: "POST",
      headers: authHeaders(adminSession),
      body: { capabilities: ["UserRead", "SystemDelete"] },
    });
    assertEquals(ok.status, 200);
    const okBody = await ok.json();
    assertEquals(okBody.results, [
      { capability: "UserRead", hasCapability: true },
      { capability: "SystemDelete", hasCapability: true },
    ]);

    const nonArray = await req("/admin/capabilities/check-multiple", {
      method: "POST", headers: authHeaders(adminSession), body: { capabilities: "UserRead" },
    });
    assertEquals(nonArray.status, 400);
    const unknownCap = await req("/admin/capabilities/check-multiple", {
      method: "POST", headers: authHeaders(adminSession), body: { capabilities: ["UserRead", "NotARealCapability"] },
    });
    assertEquals(unknownCap.status, 400);

    const plain = await req("/admin/capabilities/check-multiple", {
      method: "POST", headers: authHeaders(context.grantsFreeSession), body: { capabilities: ["UserRead"] },
    });
    assertEquals(plain.status, 403);
    const anon = await req("/admin/capabilities/check-multiple", { method: "POST", body: { capabilities: ["UserRead"] } });
    assertEquals(anon.status, 401);
  });

  await t.step("GET /admin/capabilities/all: mirrors the registry verbatim; 401/403 negatives", async () => {
    const res = await req("/admin/capabilities/all", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.count, ALL_CAPABILITIES.size);
    assertEquals(new Set(body.capabilities), new Set(ALL_CAPABILITIES));

    const plain = await req("/admin/capabilities/all", { headers: authHeaders(context.grantsFreeSession) });
    assertEquals(plain.status, 403);
    const anon = await req("/admin/capabilities/all");
    assertEquals(anon.status, 401);
  });

  await t.step("GET /admin/roles/my-grants: enriched roleName/roleDescription; 401/403 negatives", async () => {
    const res = await req("/admin/roles/my-grants", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(Array.isArray(body.grants));
    const fullAdminGrant = body.grants.find((g: { roleKey: string }) => g.roleKey === "full_admin");
    assert(fullAdminGrant, "admin's full_admin grant must be present");
    assertEquals(fullAdminGrant.roleName, "Full Administrator");
    assertEquals(fullAdminGrant.roleDescription, "Full access to all admin capabilities and role management");

    const plain = await req("/admin/roles/my-grants", { headers: authHeaders(context.grantsFreeSession) });
    assertEquals(plain.status, 403);
    const anon = await req("/admin/roles/my-grants");
    assertEquals(anon.status, 401);
  });

  await t.step("GET /admin/is-admin: admin true; grantless false; UNAUTHENTICATED is 200-false (any-caller route)", async () => {
    const adminRes = await req("/admin/is-admin", { headers: authHeaders(adminSession) });
    assertEquals(adminRes.status, 200);
    assertEquals(await adminRes.json(), { isAdmin: true });

    const plainRes = await req("/admin/is-admin", { headers: authHeaders(context.grantsFreeSession) });
    assertEquals(plainRes.status, 200);
    assertEquals(await plainRes.json(), { isAdmin: false });

    // The frontend calls this pre-login to decide chrome — anonymous callers
    // get the false verdict, NOT a 401 (handler contract pinned verbatim).
    const anon = await req("/admin/is-admin");
    assertEquals(anon.status, 200);
    assertEquals(await anon.json(), { isAdmin: false });
  });
}
