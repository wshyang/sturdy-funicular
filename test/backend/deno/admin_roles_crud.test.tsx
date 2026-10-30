// Coverage: custom admin roles (addendum-072-custom-admin-roles.md) — role
// CRUD endpoints (POST/PUT/DELETE /admin/roles), the user role-settlement
// endpoint (PUT /admin/users/:id/roles), the DB-backed capability resolution,
// and the protected-user guard.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
} from "./helpers.tsx";
import { users } from "../../../server/db.tsx";
import { query } from "../../../server/pg.tsx";
import { getEffectiveAdminCapabilities } from "../../../server/auth-admin-roles.tsx";

Deno.test("admin_roles_crud", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AdminRoles!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "AdminRoles!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
    adminSession = login.session;
  });

  await t.step("create: positive — POST /admin/roles creates a custom role with capabilities", async () => {
    const res = await req("/admin/roles", {
      method: "POST",
      headers: authHeaders(adminSession),
      body: { key: "helpdesk_admin", name: "Helpdesk Administrator", description: "View users and audit logs", capabilities: ["UserRead", "AuditLogRead"] },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.role.key, "helpdesk_admin");
    assertEquals(data.role.isSystemRole, false);
    assertEquals(data.role.capabilities, ["UserRead", "AuditLogRead"]);
  });

  await t.step("create: negative — reserved system key is rejected", async () => {
    const res = await req("/admin/roles", {
      method: "POST",
      headers: authHeaders(adminSession),
      body: { key: "full_admin", name: "Nope", description: "", capabilities: ["UserRead"] },
    });
    assertEquals(res.status, 400); // ValidationError → 400 via routeError
  });

  await t.step("create: negative — unknown capability is rejected", async () => {
    const res = await req("/admin/roles", {
      method: "POST",
      headers: authHeaders(adminSession),
      body: { key: "bad_role", name: "Bad Role", description: "", capabilities: ["NotARealCapability"] },
    });
    assertEquals(res.status, 400);
  });

  await t.step("list: custom role appears with DB-backed capabilities", async () => {
    const res = await req("/admin/roles", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const role = data.roles.find((r: any) => r.key === "helpdesk_admin");
    assertExists(role);
    assertEquals(role.capabilities, ["UserRead", "AuditLogRead"]);
    // System roles keep their seeded capabilities.
    const fullAdmin = data.roles.find((r: any) => r.key === "full_admin");
    assertExists(fullAdmin);
    assertEquals(fullAdmin.capabilities.includes("AdminRolesManage"), true);
  });

  await t.step("update: PUT /admin/roles/:key replaces capabilities", async () => {
    const res = await req("/admin/roles/helpdesk_admin", {
      method: "PUT",
      headers: authHeaders(adminSession),
      body: { description: "Now also sees sent notifications", capabilities: ["UserRead", "AuditLogRead", "AuditSentNotificationsRead"] },
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.role.capabilities.includes("AuditSentNotificationsRead"), true);
  });

  await t.step("user roles: PUT /admin/users/:id/roles grants + revokes, and capabilities resolve", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("Rolee"), email: uniqueEmail("rolee"), password: "RoleePass!2026", affiliation: "agency",
    });

    const grant = await req(`/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers: authHeaders(adminSession),
      body: { roleKeys: ["helpdesk_admin", "data_operator"] },
    });
    assertEquals(grant.status, 200);

    const getRes = await req(`/admin/users/${user.id}/roles`, { headers: authHeaders(adminSession) });
    const getData = await getRes.json();
    assertEquals(getData.roleKeys.sort(), ["data_operator", "helpdesk_admin"]);

    const caps = await getEffectiveAdminCapabilities(user.id);
    assertEquals(caps.has("UserRead"), true);
    assertEquals(caps.has("AuditSentNotificationsRead"), true);
    assertEquals(caps.has("DataExport"), true); // from data_operator
    assertEquals(caps.has("AdminRolesManage"), false);

    // Revoke one role.
    const revoke = await req(`/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers: authHeaders(adminSession),
      body: { roleKeys: ["helpdesk_admin"] },
    });
    assertEquals(revoke.status, 200);
    const after = await getEffectiveAdminCapabilities(user.id);
    assertEquals(after.has("DataExport"), false);
  });

  await t.step("user roles: negative — protected users are rejected", async () => {
    const protectedUser = await createActiveUser({
      fullName: "Protected Rolee", email: uniqueEmail("prole"), password: "RoleePass!2026", affiliation: "agency",
    });
    await users.update(protectedUser.id, { isProtected: true });
    const res = await req(`/admin/users/${protectedUser.id}/roles`, {
      method: "PUT",
      headers: authHeaders(adminSession),
      body: { roleKeys: ["helpdesk_admin"] },
    });
    assertEquals(res.status, 400);
  });

  await t.step("delete: negative — system role cannot be deleted", async () => {
    const res = await req("/admin/roles/user_admin", { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  let stillGrantedUserId = "";
  await t.step("delete: negative — still-granted role cannot be deleted", async () => {
    const user = await createActiveUser({
      fullName: uniqueName("StillGranted"), email: uniqueEmail("sg"), password: "RoleePass!2026", affiliation: "agency",
    });
    stillGrantedUserId = user.id;
    await req(`/admin/users/${user.id}/roles`, {
      method: "PUT",
      headers: authHeaders(adminSession),
      body: { roleKeys: ["helpdesk_admin"] },
    });
    const res = await req("/admin/roles/helpdesk_admin", { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  await t.step("delete: positive — ungranted custom role is deleted", async () => {
    // Earlier steps granted helpdesk_admin to more than one user (the role
    // settlement step and the still-granted step); deleteAdminRole rejects
    // while ANY active grant remains. Revoke all active helpdesk_admin grants
    // so the role is ungranted and DELETE can succeed.
    void stillGrantedUserId;
    await query(
      `UPDATE user_admin_role_grants SET revoked_at = now(), revoked_by = $1, revocation_reason = 'test cleanup'
        WHERE role_key = 'helpdesk_admin' AND revoked_at IS NULL`,
      [adminId],
    );
    const res = await req("/admin/roles/helpdesk_admin", { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const list = await (await req("/admin/roles", { headers: authHeaders(adminSession) })).json();
    assertEquals(list.roles.find((r: any) => r.key === "helpdesk_admin"), undefined);
  });

  await t.step("negative — non-admin cannot create roles", async () => {
    const vendor = await createActiveUser({
      fullName: "Vendor", email: uniqueEmail("v"), password: "VendorPass!2026", affiliation: "vendor",
    });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const session = "error" in login ? "" : login.session;
    const res = await req("/admin/roles", {
      method: "POST",
      headers: authHeaders(session),
      body: { key: "x", name: "X", description: "", capabilities: [] },
    });
    assertEquals(res.status, 403);
  });
});
