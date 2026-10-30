// Coverage: GET /admin/users/pending, GET /admin/users,
// POST /admin/users/:id/approve, POST /admin/users/:id/reject,
// POST /admin/users/:id/tombstone, POST /admin/users/:id/untombstone,
// PUT /admin/users/:id/affiliation.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createCluster, createTeam, addMember, addServingMember, createWiredSystem, createAsset, latestSentNotification, sentNotificationEmailSnapshots,
  createOrganization, addOrgMembership,
} from "./helpers.tsx";
import { users } from "../../../server/db.tsx";
import { grantAdminRole, listAdminRoleGrants, createAdminRole } from "../../../server/auth-admin-roles.tsx";

async function signupPending(email: string) {
  const res = await req("/auth/signup", {
    method: "POST",
    body: { fullName: "Pending Person", email, password: "ValidPass!2026" },
  });
  const data = await res.json();
  return data.userId as string;
}

Deno.test("admin_users", async (t) => {
  let adminSession: string;
  let mainAdminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AdminPass!2026");
    mainAdminId = admin.id;
    const login = await loginAs(admin.email, "AdminPass!2026");
    adminSession = (login as any).session;
  });

  await t.step("pending/all: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({
      fullName: "Vendor Joe", email: uniqueEmail("v"), password: "VendorPass!2026", affiliation: "vendor",
    });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const session = (login as any).session;

    const pendingRes = await req("/admin/users/pending", { headers: authHeaders(session) });
    assertEquals(pendingRes.status, 403);
    const allRes = await req("/admin/users", { headers: authHeaders(session) });
    assertEquals(allRes.status, 403);
  });

  await t.step("pending/all: negative — unauthenticated", async () => {
    assertEquals((await req("/admin/users/pending")).status, 403);
    assertEquals((await req("/admin/users")).status, 403);
  });

  // addendum-033-authorization-scoping-test-discipline.md: every mutation
  // route in this file is admin-only, but until this pass only the two GET
  // routes above had a non-admin-403 regression test — a future change that
  // accidentally weakened/removed requireAdmin() on any of these five would
  // have gone undetected. One combined test, since the negative case is
  // identical in shape (403, before any id/body validation runs) for all five.
  await t.step("approve/reject/tombstone/untombstone/affiliation: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({
      fullName: "NonAdminMutator", email: uniqueEmail("nonadminmut"), password: "VendorPass!2026", affiliation: "vendor",
    });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const session = (login as any).session;

    const targetEmail = uniqueEmail("mutvictim");
    const targetId = await signupPending(targetEmail);

    const approveRes = await req(`/admin/users/${targetId}/approve`, {
      method: "POST", headers: authHeaders(session), body: { affiliation: "vendor" },
    });
    assertEquals(approveRes.status, 403);

    const rejectRes = await req(`/admin/users/${targetId}/reject`, { method: "POST", headers: authHeaders(session), body: {} });
    assertEquals(rejectRes.status, 403);

    const tombstoneRes = await req(`/admin/users/${targetId}/tombstone`, { method: "POST", headers: authHeaders(session) });
    assertEquals(tombstoneRes.status, 403);

    const untombstoneRes = await req(`/admin/users/${targetId}/untombstone`, {
      method: "POST", headers: authHeaders(session), body: { affiliation: "vendor" },
    });
    assertEquals(untombstoneRes.status, 403);

    const affiliationRes = await req(`/admin/users/${targetId}/affiliation`, {
      method: "PUT", headers: authHeaders(session), body: { affiliation: "agency" },
    });
    assertEquals(affiliationRes.status, 403);

    // Confirm none of the rejected calls actually mutated the target.
    const reloaded = await users.get(targetId);
    assertEquals(reloaded!.status, "pending_approval");
  });

  await t.step("pending: positive — lists only pending_approval users, no password_hash", async () => {
    const email = uniqueEmail("pend");
    await signupPending(email);
    const res = await req("/admin/users/pending", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const found = data.users.find((u: any) => u.email === email);
    assertExists(found);
    assertEquals(found.passwordHash, undefined);
    assertEquals(found.passwordSalt, undefined);
    assertEquals(found.status, "pending_approval");
  });

  await t.step("all: positive — lists every user regardless of status", async () => {
    const res = await req("/admin/users", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(Array.isArray(data.users), true);
    assertEquals(data.users.length > 0, true);
  });

  // Protected users (migrations/035_add_is_protected_users.sql — the default
  // admin + demo superadmin, surfaced as users.is_protected) must not be
  // deactivatable or re-affiliatable via the admin routes, and the DB trigger
  // backs it up with a clean 400 from the route layer (not a 500).
  await t.step("tombstone/affiliation: negative — protected users are immutable", async () => {
    const target = await createActiveUser({
      fullName: "Protected Person", email: uniqueEmail("protected"), password: "ValidPass!2026", affiliation: "agency",
    });
    // Flag it like the default admin would be flagged (bootstrap.tsx /
    // migration 035 backfill). Flipping false→true is legal (only clearing
    // the flag is blocked).
    await users.update(target.id, { isProtected: true });

    const tombstoneRes = await req(`/admin/users/${target.id}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(tombstoneRes.status, 400);

    const affiliationRes = await req(`/admin/users/${target.id}/affiliation`, {
      method: "PUT", headers: authHeaders(adminSession), body: { affiliation: "vendor" },
    });
    assertEquals(affiliationRes.status, 400);

    // The account is untouched.
    const after = await users.get(target.id);
    assertEquals(after?.status, "active");
    assertEquals(after?.affiliation, "agency");
  });

  await t.step("approve: negative — missing affiliation", async () => {
    const email = uniqueEmail("appr1");
    const userId = await signupPending(email);
    const res = await req(`/admin/users/${userId}/approve`, { method: "POST", headers: authHeaders(adminSession), body: {} });
    assertEquals(res.status, 400);
  });

  await t.step("approve: negative — invalid affiliation value", async () => {
    const email = uniqueEmail("appr2");
    const userId = await signupPending(email);
    const res = await req(`/admin/users/${userId}/approve`, {
      method: "POST", headers: authHeaders(adminSession), body: { affiliation: "not-a-real-one" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("approve: negative — user not found", async () => {
    const res = await req(`/admin/users/00000000-0000-0000-0000-000000000999/approve`, {
      method: "POST", headers: authHeaders(adminSession), body: { affiliation: "vendor" },
    });
    assertEquals(res.status, 404);
  });

  await t.step("approve: positive — activates user with chosen affiliation, and login now works", async () => {
    const email = uniqueEmail("appr3");
    const userId = await signupPending(email);
    const res = await req(`/admin/users/${userId}/approve`, {
      method: "POST", headers: authHeaders(adminSession), body: { affiliation: "vendor" },
    });
    assertEquals(res.status, 200);

    const login = await loginAs(email, "ValidPass!2026");
    assertExists((login as any).session);

    // Email notification (addendum-044) #18 — the user.
    const approvedEmail = await latestSentNotification("user.approved");
    assertExists(approvedEmail);
    assertEquals(sentNotificationEmailSnapshots(approvedEmail), [email]);
  });

  await t.step("approve: negative — already-active user cannot be re-approved", async () => {
    const email = uniqueEmail("appr4");
    const userId = await signupPending(email);
    await req(`/admin/users/${userId}/approve`, { method: "POST", headers: authHeaders(adminSession), body: { affiliation: "vendor" } });
    const second = await req(`/admin/users/${userId}/approve`, {
      method: "POST", headers: authHeaders(adminSession), body: { affiliation: "vendor" },
    });
    assertEquals(second.status, 400);
  });

  await t.step("reject: positive — sets status rejected, terminal (login blocked, no enumeration)", async () => {
    const email = uniqueEmail("rej1");
    const userId = await signupPending(email);
    const res = await req(`/admin/users/${userId}/reject`, {
      method: "POST", headers: authHeaders(adminSession), body: { reason: "Not needed." },
    });
    assertEquals(res.status, 200);

    const login = await loginAs(email, "ValidPass!2026");
    assertEquals((login as any).status, 401);

    // Email notification (addendum-044) #19 — the user.
    const rejectedEmail = await latestSentNotification("user.rejected");
    assertExists(rejectedEmail);
    assertEquals(sentNotificationEmailSnapshots(rejectedEmail), [email]);
  });

  await t.step("reject: negative — non-pending user cannot be rejected", async () => {
    const email = uniqueEmail("rej2");
    const userId = await signupPending(email);
    await req(`/admin/users/${userId}/reject`, { method: "POST", headers: authHeaders(adminSession), body: {} });
    const second = await req(`/admin/users/${userId}/reject`, { method: "POST", headers: authHeaders(adminSession), body: {} });
    assertEquals(second.status, 400);
  });

  await t.step("tombstone: negative — cannot tombstone self", async () => {
    const res = await req(`/admin/users/${mainAdminId}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  // NOTE: tombstoneUser's "last active admin" guard (routes-admin-users.tsx)
  // excludes the target user then checks if any active admins remain. Since
  // self-tombstone is blocked earlier in the same handler, the acting admin
  // (currentUser) is always a distinct, active admin and always survives
  // that filter — so this guard is structurally unreachable via the HTTP
  // API as currently written (you can never reach it with zero remaining
  // admins, because the caller itself is always one). This is a real,
  // previously-undocumented finding, not a test gap: flagged here rather
  // than silently worked around. The test below documents actual behavior
  // (tombstoning a second admin succeeds) instead of asserting unreachable
  // 400 behavior.
  await t.step("tombstone: positive — tombstoning a non-acting admin succeeds (last-admin guard is unreachable via API — see comment)", async () => {
    const secondAdmin = await createAdmin("SecondAdmin!2026");
    const res = await req(`/admin/users/${secondAdmin.id}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const reloaded = await users.get(secondAdmin.id);
    assertEquals(reloaded!.status, "tombstoned");

    // Email notification (addendum-044) #20 — the user.
    const tombstonedEmail = await latestSentNotification("user.tombstoned");
    assertExists(tombstonedEmail);
    assertEquals(sentNotificationEmailSnapshots(tombstonedEmail), [secondAdmin.email]);
  });

  await t.step("tombstone: positive — cascades memberships and PA-safe, sets tombstoned status", async () => {
    const admin = await createAdmin("CascadeAdmin!2026");
    const vendor = await createActiveUser({
      fullName: "Cascade Vendor", email: uniqueEmail("casc"), password: "CascPass!2026", affiliation: "vendor",
    });
    const cluster = await createCluster("vendor", admin.id);
    const team = await createTeam(cluster, 1, admin.id);
    await addMember(team, vendor, admin.id);

    const res = await req(`/admin/users/${vendor.id}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);

    const reloaded = await users.get(vendor.id);
    assertEquals(reloaded!.status, "tombstoned");

    // Membership should have been auto-removed.
    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    assertEquals(membersData.members.find((m: any) => m.user.id === vendor.id), undefined);
  });

  await t.step("tombstone: positive — invalidates the tombstoned user's existing session on the very next request", async () => {
    const admin = await createAdmin("SessionAdmin!2026");
    const vendor = await createActiveUser({
      fullName: "Session Vendor", email: uniqueEmail("sess"), password: "SessPass!2026", affiliation: "vendor",
    });
    const login = await loginAs(vendor.email, "SessPass!2026");
    const vendorSession = (login as any).session;
    assertExists(vendorSession);

    // Sanity: the still-fresh session works before tombstoning.
    const before = await req("/requests/my-requests", { headers: authHeaders(vendorSession) });
    assertEquals(before.status, 200);

    const tombstoneRes = await req(`/admin/users/${vendor.id}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(tombstoneRes.status, 200);

    // Same session token, reused — getCurrentUser re-fetches the user row
    // fresh every request and returns null once status !== 'active', with no
    // separate session-store invalidation step required (server/auth.tsx).
    const after = await req("/requests/my-requests", { headers: authHeaders(vendorSession) });
    assertEquals(after.status, 403);
  });

  await t.step("tombstone: negative — sole primary owner with no backup blocked", async () => {
    const admin = await createAdmin("OwnerGuardAdmin!2026");
    const owner = await createActiveUser({
      fullName: "Sole Owner", email: uniqueEmail("owner"), password: "OwnerPass!2026", affiliation: "agency",
    });
    await createWiredSystem(admin.id, owner);

    const res = await req(`/admin/users/${owner.id}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  await t.step("untombstone: negative — user not tombstoned", async () => {
    const email = uniqueEmail("untomb1");
    const userId = await signupPending(email);
    const res = await req(`/admin/users/${userId}/untombstone`, {
      method: "POST", headers: authHeaders(adminSession), body: { affiliation: "vendor" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("untombstone: positive — reactivates with new affiliation", async () => {
    const admin = await createAdmin("UntombAdmin!2026");
    const vendor = await createActiveUser({
      fullName: "Untomb Vendor", email: uniqueEmail("untomb2"), password: "UntombPass!2026", affiliation: "vendor",
    });
    await req(`/admin/users/${vendor.id}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });

    const res = await req(`/admin/users/${vendor.id}/untombstone`, {
      method: "POST", headers: authHeaders(adminSession), body: { affiliation: "agency" },
    });
    assertEquals(res.status, 200);

    const login = await loginAs(vendor.email, "UntombPass!2026");
    assertExists((login as any).session);

    // Email notification (addendum-044) #22 — the user.
    const untombstonedEmail = await latestSentNotification("user.untombstoned");
    assertExists(untombstonedEmail);
    assertEquals(sentNotificationEmailSnapshots(untombstonedEmail), [vendor.email]);
  });

  await t.step("tombstone: positive — auto-cancels in-flight requests and notifies the submitter per cancelled request (addendum-044 #21)", async () => {
    const admin = await createAdmin("AutoCancelAdmin!2026");
    const owner = await createActiveUser({ fullName: "AutoCancelOwner", email: uniqueEmail("autocancelowner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(admin.id, owner);
    const submitter = await createActiveUser({ fullName: "AutoCancelSubmitter", email: uniqueEmail("autocancelsubmitter"), password: "SubmitterPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, admin.id);
    const submitterLogin = await loginAs(submitter.email, "SubmitterPass!2026");
    const asset = await createAsset(system.id, { hostname: "autocancel-host" });

    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders((submitterLogin as any).session),
      body: {
        systemId: system.id, justification: "Investigate a production incident requiring elevated access.", srNumber: "SR-AC1",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id }],
      },
    });
    assertEquals(submitRes.status, 201);
    const { request } = await submitRes.json();

    const tombstoneRes = await req(`/admin/users/${submitter.id}/tombstone`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(tombstoneRes.status, 200);

    const cancelledEmail = await latestSentNotification("user.tombstoned_auto_cancelled_request");
    assertExists(cancelledEmail);
    assertEquals(sentNotificationEmailSnapshots(cancelledEmail), [submitter.email]);
    assertEquals(cancelledEmail.relatedTargetId, request.id);
  });

  await t.step("affiliation: negative — invalid value rejected", async () => {
    const vendor = await createActiveUser({
      fullName: "Aff Vendor", email: uniqueEmail("aff1"), password: "AffPass!2026", affiliation: "vendor",
    });
    const res = await req(`/admin/users/${vendor.id}/affiliation`, {
      method: "PUT", headers: authHeaders(adminSession), body: { affiliation: "bogus" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("affiliation: positive — changes affiliation for active user", async () => {
    const vendor = await createActiveUser({
      fullName: "Aff Vendor 2", email: uniqueEmail("aff2"), password: "AffPass!2026", affiliation: "vendor",
    });
    const res = await req(`/admin/users/${vendor.id}/affiliation`, {
      method: "PUT", headers: authHeaders(adminSession), body: { affiliation: "agency" },
    });
    assertEquals(res.status, 200);
    const reloaded = await users.get(vendor.id);
    assertEquals(reloaded!.affiliation, "agency");
  });

  await t.step("submitter capability: positive — losing the Step 1 team membership is re-checked on the very next request with the same session (no re-login needed)", async () => {
    // Per addendum-027-submitter-as-workflow-step-one.md, getSubmitterSystemIds
    // (server/auth.tsx) no longer gates on affiliation at all — submission is
    // determined purely by whether the caller belongs to the team occupying
    // Step 1 of the system's workflow_definition. This test's original
    // premise (an affiliation CHANGE alone blocks submission) is stale post-
    // addendum-025; rewritten to prove the same "no re-login needed"
    // live-recheck property via the mechanism that actually gates
    // submission now: team membership.
    const vendor = await createActiveUser({
      fullName: "Aff Vendor 3", email: uniqueEmail("aff3"), password: "AffPass!2026", affiliation: "vendor",
    });
    const login = await loginAs(vendor.email, "AffPass!2026");
    const vendorSession = (login as any).session;
    assertExists(vendorSession);

    const admin = await createAdmin("AffAdmin!2026");
    const owner = await createActiveUser({
      fullName: "Aff Owner", email: uniqueEmail("affowner"), password: "AffOwnerPass!2026", affiliation: "agency",
    });
    const { system, vendorL1 } = await createWiredSystem(admin.id, owner);
    const membership = await addServingMember(vendorL1, vendor, admin.id);

    // Per addendum-039-asset-gated-submission.md, credential_items now
    // reference a real, active asset via asset_id rather than free text.
    const asset = await createAsset(system.id, { hostname: "host-01" });
    const submitBody = (sr: string) => ({
      systemId: system.id,
      justification: "Testing submitter capability re-check.",
      srNumber: sr,
      activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      credentialItems: [{ assetId: asset.id }],
    });

    // Before removal: Step 1 (submitter) team member can submit
    // (canSubmit -> getSubmitterSystemIds).
    const submitBefore = await req("/requests", {
      method: "POST", headers: authHeaders(vendorSession), body: submitBody("SR-1"),
    });
    assertEquals(submitBefore.status, 201);

    await req(`/teams/${vendorL1.id}/members/${membership.id}`, {
      method: "DELETE", headers: authHeaders(adminSession),
    });

    // Same session token, reused — getSubmitterSystemIds now finds no
    // matching team membership for this user, so canSubmit fails, with no
    // re-login or session invalidation involved.
    const submitAfter = await req("/requests", {
      method: "POST", headers: authHeaders(vendorSession), body: submitBody("SR-2"),
    });
    assertEquals(submitAfter.status, 403);
  });

  await t.step("affiliation: negative — primary owner cannot lose agency affiliation without reassignment", async () => {
    const admin = await createAdmin("ReassignAdmin!2026");
    const owner = await createActiveUser({
      fullName: "Reassign Owner", email: uniqueEmail("reassign"), password: "ReassignPass!2026", affiliation: "agency",
    });
    await createWiredSystem(admin.id, owner);

    const res = await req(`/admin/users/${owner.id}/affiliation`, {
      method: "PUT", headers: authHeaders(adminSession), body: { affiliation: "vendor" },
    });
    assertEquals(res.status, 400);
  });
});

// Addendum-204 F2: PUT /admin/users/:id/affiliation settles role grants via
// resolveDesiredRoleKeys -> setUserRoles — the same settlement invite/approve
// gained scoped-authority guards for in addendum-202, but reachable here by a
// SCOPED UserAffiliationChange holder: grantFullAdmin:true minted a GLOBAL
// full_admin (escalation), an explicit empty end-state stripped every grant
// (cross-scope revocation), and the agency->vendor invariant strip revoked
// grants the scoped caller cannot even see. The route now refuses ANY role
// field from a scoped caller, refuses to move a grant-holder off agency, and
// skips settlement entirely for scoped requests (the grant set is preserved).
Deno.test("admin_users scoped affiliation-change grant guards (addendum-204 F2)", async (t) => {
  let adminSession = "";
  let adminId = "";
  let scopedSession = "";
  let orgA = "";

  await t.step("setup: global admin, org A, and a user_admin scoped INTO org A", async () => {
    await wipeDatabase();
    const admin = await createAdmin("F2Admin!2026");
    adminId = admin.id;
    adminSession = (await loginAs(admin.email, "F2Admin!2026") as any).session;
    await createAdminRole(
      { key: "helpdesk_admin", name: "Helpdesk Administrator", description: "View users and audit logs", capabilities: ["UserRead", "AuditLogRead"] },
      adminId,
    );
    const org = await createOrganization({ name: "F2 Org A", shortCode: "F2A", createdBy: adminId });
    orgA = org.id;
    const scopedAdmin = await createActiveUser({
      fullName: "F2 Scoped", email: uniqueEmail("f2scoped"), password: "F2Scoped!2026", affiliation: "agency",
    });
    await addOrgMembership({ organizationId: orgA, userId: scopedAdmin.id, addedBy: adminId });
    await grantAdminRole(scopedAdmin.id, "user_admin", adminId, "addendum-204 F2 fixture", orgA);
    scopedSession = (await loginAs(scopedAdmin.email, "F2Scoped!2026") as any).session;
    assertExists(scopedSession);
  });

  async function makeOrgAMember(label: string, affiliation: "agency" | "vendor") {
    const u = await createActiveUser({
      fullName: label, email: uniqueEmail(label.toLowerCase().replaceAll(" ", "")), password: "F2Target!2026", affiliation,
    });
    await addOrgMembership({ organizationId: orgA, userId: u.id, addedBy: adminId });
    return u;
  }

  await t.step("scoped: grantFullAdmin on affiliation-change is refused 400 and mints nothing", async () => {
    const target = await makeOrgAMember("F2 Mint", "agency");
    const res = await req(`/admin/users/${target.id}/affiliation`, {
      method: "PUT", headers: authHeaders(scopedSession),
      body: { affiliation: "agency", grantFullAdmin: true },
    });
    assertEquals(res.status, 400, "a scoped caller may not request ANY role settlement — this was the full_admin mint");
    const body = await res.json();
    assertEquals(body.error.includes("global UserAffiliationChange grant"), true);
    assertEquals((await listAdminRoleGrants(target.id, false)).length, 0, "no grant may be minted");
    assertEquals((await users.get(target.id))!.affiliation, "agency", "affiliation must be untouched on the refused request");
  });

  await t.step("scoped: an explicit empty end-state is the same refused role-field presence", async () => {
    const target = await makeOrgAMember("F2 Strip", "agency");
    await grantAdminRole(target.id, "helpdesk_admin", adminId, "F2 target grant", orgA);
    assertEquals((await listAdminRoleGrants(target.id, false)).length, 1);
    const res = await req(`/admin/users/${target.id}/affiliation`, {
      method: "PUT", headers: authHeaders(scopedSession),
      body: { affiliation: "agency", grantFullAdmin: false, roleKeys: [] },
    });
    assertEquals(res.status, 400, "empty end-state role fields from a scoped caller = the silent strip door");
    assertEquals((await listAdminRoleGrants(target.id, false)).length, 1, "the grant must survive the refused request");
  });

  await t.step("scoped: moving a grant-holder off agency is refused (the invariant strip would be a cross-scope revocation)", async () => {
    const target = await makeOrgAMember("F2 Holder", "agency");
    await grantAdminRole(target.id, "helpdesk_admin", adminId, "F2 target grant", orgA);
    const res = await req(`/admin/users/${target.id}/affiliation`, {
      method: "PUT", headers: authHeaders(scopedSession),
      body: { affiliation: "vendor" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("global administrator must remove"), true);
    assertEquals((await users.get(target.id))!.affiliation, "agency");
    assertEquals((await listAdminRoleGrants(target.id, false)).length, 1);
  });

  await t.step("scoped: a role-field-free affiliation change succeeds and preserves the grant set", async () => {
    const target = await makeOrgAMember("F2 Plain", "vendor");
    const res = await req(`/admin/users/${target.id}/affiliation`, {
      method: "PUT", headers: authHeaders(scopedSession),
      body: { affiliation: "agency" },
    });
    assertEquals(res.status, 200);
    assertEquals((await users.get(target.id))!.affiliation, "agency");
    assertEquals((await listAdminRoleGrants(target.id, false)).length, 0, "the affiliation flip alone must mint nothing");
  });

  await t.step("global: replace-settlement unchanged — mint on agency, strip on vendor (regression envelope)", async () => {
    const target = await makeOrgAMember("F2 Global", "agency");
    const mint = await req(`/admin/users/${target.id}/affiliation`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: { affiliation: "agency", grantFullAdmin: true },
    });
    assertEquals(mint.status, 200);
    const grants = await listAdminRoleGrants(target.id, false);
    assertEquals(grants.some((g) => g.roleKey === "full_admin" && g.organizationId === null), true);
    const strip = await req(`/admin/users/${target.id}/affiliation`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: { affiliation: "vendor", grantFullAdmin: false, roleKeys: [] },
    });
    assertEquals(strip.status, 200);
    assertEquals((await listAdminRoleGrants(target.id, false)).length, 0);
  });
});
