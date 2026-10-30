// Coverage: GET/POST/PUT/DELETE /admin/teams[/:id], GET /teams/:id/members,
// GET /teams/:id/eligible-members, POST /teams/:id/members,
// DELETE /teams/:teamId/members/:membershipId,
// PUT /teams/:teamId/members/:membershipId/role, GET /me/managed-teams.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
  createCluster, createTeam, addMember, latestSentNotification, sentNotificationEmailSnapshots, ensureDefaultOrganization,
  createOrganization, addOrgMembership, createWiredSystem, uniqueShortCode, seedOwnerOrgEdge,
  createSystemWithOwnerOrgEdge,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { clusters, systems, teams, generateId, now } from "../../../server/db.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";
import type { System } from "../../../server/types.tsx";

Deno.test("admin_teams", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("TeamAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "TeamAdmin!2026");
    adminSession = (login as any).session;
  });

  await t.step("list: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "V", email: uniqueEmail("v"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req("/admin/teams", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  // addendum-033-authorization-scoping-test-discipline.md: create/update/
  // delete are all admin-only but, until this pass, only the GET/list route
  // above had a non-admin-403 regression test.
  await t.step("create/update/delete: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "TeamMutNonAdmin", email: uniqueEmail("teammutnonadmin"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const session = (login as any).session;
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);

    const createRes = await req("/admin/teams", {
      method: "POST", headers: authHeaders(session), body: { name: uniqueName("ShouldNotCreate"), clusterId: cluster.id, level: 2 },
    });
    assertEquals(createRes.status, 403);

    const updateRes = await req(`/admin/teams/${team.id}`, { method: "PUT", headers: authHeaders(session), body: { name: "Hijacked" } });
    assertEquals(updateRes.status, 403);

    const deleteRes = await req(`/admin/teams/${team.id}`, { method: "DELETE", headers: authHeaders(session) });
    assertEquals(deleteRes.status, 403);

    const listRes = await req("/admin/teams", { headers: authHeaders(adminSession) });
    const listData = await listRes.json();
    const stillThere = listData.teams.find((t: any) => t.id === team.id);
    assertExists(stillThere);
    assertEquals(stillThere.name, team.name);
  });

  await t.step("create: positive — team created, enriched list shows derived type + cluster_name", async () => {
    const cluster = await createCluster("vendor", adminId);
    const res = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession),
      body: { name: uniqueName("Team"), clusterId: cluster.id, level: 1, description: "d" },
    });
    assertEquals(res.status, 201);
    const data = await res.json();

    const listRes = await req("/admin/teams", { headers: authHeaders(adminSession) });
    const listData = await listRes.json();
    const found = listData.teams.find((t: any) => t.id === data.team.id);
    assertExists(found);
    assertEquals(found.type, "vendor");
    assertEquals(found.clusterName, cluster.name);
  });

  // addendum-109 (rev 2026-08-05 — NO GATES): teams hang off the Default
  // organisation THROUGH their cluster (no teams column, by design). The
  // enriched-row derivation joins cluster → organisation exactly like the
  // existing `type`/`clusterName` enrichments. RED by design until the
  // addendum-110+ implementation lands (raw setup SQL fails today — no
  // organizations table / organization_id column yet).
  await t.step("organisation dimension: team rows derive organisationId via their cluster", async () => {
    const org = await ensureDefaultOrganization(adminId);
    // Team orgs still derive THROUGH the cluster (addendum-206 moved only
    // SYSTEM orgs to the junction); anchor via the helper's org argument.
    const cluster = await createCluster("agency", adminId, undefined, org.id);
    const res = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession),
      body: { name: uniqueName("Org Team"), clusterId: cluster.id, level: 1 },
    });
    assertEquals(res.status, 201);
    const data = await res.json();

    const listRes = await req("/admin/teams", { headers: authHeaders(adminSession) });
    const found = (await listRes.json()).teams.find((tm: { id: string }) => tm.id === data.team.id);
    assertExists(found);
    assertEquals(found.organizationId, org.id);
  });

  await t.step("create: negative — missing fields", async () => {
    const res = await req("/admin/teams", { method: "POST", headers: authHeaders(adminSession), body: { name: "X" } });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — nonexistent cluster", async () => {
    const res = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession),
      body: { name: uniqueName("T"), clusterId: "00000000-0000-0000-0000-000000000999", level: 1 },
    });
    assertEquals(res.status, 400);
  });

  // addendum-042-relationship-fk-validation-audit.md: clusters.get() still
  // returns invalidated rows (audit/history views need them), so createTeam
  // must reject an invalidated cluster explicitly, not just a nonexistent one.
  await t.step("create: negative — invalidated cluster rejected", async () => {
    const cluster = await createCluster("vendor", adminId);
    await clusters.invalidate(cluster.id);
    const res = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession),
      body: { name: uniqueName("T"), clusterId: cluster.id, level: 1 },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — level out of range", async () => {
    const cluster = await createCluster("vendor", adminId);
    const res = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession),
      body: { name: uniqueName("T"), clusterId: cluster.id, level: 9 },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — level uniqueness within cluster (Constraint #14)", async () => {
    const cluster = await createCluster("vendor", adminId);
    await createTeam(cluster, 1, adminId);
    const res = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession),
      body: { name: uniqueName("T"), clusterId: cluster.id, level: 1 },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — duplicate name within cluster", async () => {
    const cluster = await createCluster("vendor", adminId);
    const name = uniqueName("SameName");
    const first = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession), body: { name, clusterId: cluster.id, level: 1 },
    });
    assertEquals(first.status, 201);
    const second = await req("/admin/teams", {
      method: "POST", headers: authHeaders(adminSession), body: { name, clusterId: cluster.id, level: 2 },
    });
    assertEquals(second.status, 400);
  });

  await t.step("update: positive — rename; cluster_id/level immutable (not accepted as fields)", async () => {
    const cluster = await createCluster("agency", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const newName = uniqueName("Renamed");
    const res = await req(`/admin/teams/${team.id}`, { method: "PUT", headers: authHeaders(adminSession), body: { name: newName } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.team.name, newName);
    assertEquals(data.team.clusterId, cluster.id);
    assertEquals(data.team.level, 1);
  });

  await t.step("update: negative — team not found", async () => {
    const res = await req(`/admin/teams/00000000-0000-0000-0000-000000000999`, { method: "PUT", headers: authHeaders(adminSession), body: { name: "X" } });
    assertEquals(res.status, 404);
  });

  await t.step("delete: positive — cascades memberships and mappings", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const member = await createActiveUser({ fullName: "M", email: uniqueEmail("m"), password: "MemberPass!2026", affiliation: "vendor" });
    await addMember(team, member, adminId);

    const res = await req(`/admin/teams/${team.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);

    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    // Team itself is gone, so requireTeamMemberManager's team.get lookup inside
    // getTeamMembers will 404 before checking membership.
    assertEquals(membersRes.status, 404);
  });

  await t.step("delete: negative — team not found", async () => {
    const res = await req(`/admin/teams/00000000-0000-0000-0000-000000000999`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 404);
  });

  await t.step("eligible-members: positive — excludes admins, incompatible affiliations, and users already in team/cluster", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const vendorUser = await createActiveUser({ fullName: "Eligible Vendor", email: uniqueEmail("elig"), password: "EligPass!2026", affiliation: "vendor" });
    const agencyUser = await createActiveUser({ fullName: "Wrong Affiliation", email: uniqueEmail("wrongaff"), password: "WrongPass!2026", affiliation: "agency" });

    const res = await req(`/teams/${team.id}/eligible-members`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.users.find((u: any) => u.id === vendorUser.id));
    assertEquals(data.users.find((u: any) => u.id === agencyUser.id), undefined);
  });

  await t.step("add member: positive — first member auto-promoted to team_admin (Constraint #15)", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const first = await createActiveUser({ fullName: "First", email: uniqueEmail("first"), password: "FirstPass!2026", affiliation: "vendor" });

    const res = await req(`/teams/${team.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: first.id } });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.membership.teamRole, "team_admin");

    // Email notification (addendum-044) #23 — the new member.
    const addedEmail = await latestSentNotification("team_membership.added");
    assertExists(addedEmail);
    assertEquals(sentNotificationEmailSnapshots(addedEmail), [first.email]);
  });

  await t.step("add member: positive — second member defaults to plain member", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const first = await createActiveUser({ fullName: "First2", email: uniqueEmail("first2"), password: "FirstPass!2026", affiliation: "vendor" });
    const second = await createActiveUser({ fullName: "Second2", email: uniqueEmail("second2"), password: "SecondPass!2026", affiliation: "vendor" });
    await req(`/teams/${team.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: first.id } });

    const res = await req(`/teams/${team.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: second.id } });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.membership.teamRole, "member");
  });

  await t.step("add member: negative — affiliation/team-type mismatch", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const agencyUser = await createActiveUser({ fullName: "Mismatch", email: uniqueEmail("mismatch"), password: "MismatchPass!2026", affiliation: "agency" });
    const res = await req(`/teams/${team.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: agencyUser.id } });
    assertEquals(res.status, 400);
  });

  await t.step("add member: negative — duplicate membership", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const user = await createActiveUser({ fullName: "Dup", email: uniqueEmail("dup"), password: "DupPass!2026", affiliation: "vendor" });
    await req(`/teams/${team.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: user.id } });
    const res = await req(`/teams/${team.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: user.id } });
    assertEquals(res.status, 400);
  });

  await t.step("add member: negative — one team per user per cluster (Constraint #16)", async () => {
    const cluster = await createCluster("vendor", adminId);
    const teamA = await createTeam(cluster, 1, adminId);
    const teamB = await createTeam(cluster, 2, adminId);
    const user = await createActiveUser({ fullName: "OneCluster", email: uniqueEmail("onecl"), password: "OneClPass!2026", affiliation: "vendor" });
    await req(`/teams/${teamA.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: user.id } });
    const res = await req(`/teams/${teamB.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: user.id } });
    assertEquals(res.status, 400);
  });

  await t.step("get members: positive — enriched with user + team_role, no password_hash", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const user = await createActiveUser({ fullName: "Listed", email: uniqueEmail("listed"), password: "ListedPass!2026", affiliation: "vendor" });
    await addMember(team, user, adminId, "member");

    const res = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const found = data.members.find((m: any) => m.user.id === user.id);
    assertExists(found);
    assertEquals(found.user.passwordHash, undefined);
    assertEquals(found.user.passwordSalt, undefined);
    assertEquals(found.teamRole, "member");
  });

  await t.step("remove member: negative — self-removal blocked for non-admin team admin", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const teamAdminUser = await createActiveUser({ fullName: "TA", email: uniqueEmail("ta"), password: "TaPass!2026", affiliation: "vendor" });
    await addMember(team, teamAdminUser, adminId, "team_admin");
    const login = await loginAs(teamAdminUser.email, "TaPass!2026");
    const session = (login as any).session;

    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(session) });
    const membersData = await membersRes.json();
    const membershipId = membersData.members.find((m: any) => m.user.id === teamAdminUser.id).membershipId;

    const res = await req(`/teams/${team.id}/members/${membershipId}`, { method: "DELETE", headers: authHeaders(session) });
    assertEquals(res.status, 400);
  });

  await t.step("remove member: positive — global admin can remove any member", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const user = await createActiveUser({ fullName: "Removable", email: uniqueEmail("removable"), password: "RemovablePass!2026", affiliation: "vendor" });
    await addMember(team, user, adminId, "member");
    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    const membershipId = membersData.members.find((m: any) => m.user.id === user.id).membershipId;

    const res = await req(`/teams/${team.id}/members/${membershipId}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);

    // Email notification (addendum-044) #24 — the removed member.
    const removedEmail = await latestSentNotification("team_membership.removed");
    assertExists(removedEmail);
    assertEquals(sentNotificationEmailSnapshots(removedEmail), [user.email]);
  });

  await t.step("remove member: negative — team admin cannot manage a team they don't administer", async () => {
    const cluster = await createCluster("vendor", adminId);
    const teamA = await createTeam(cluster, 1, adminId);
    const cluster2 = await createCluster("vendor", adminId);
    const teamB = await createTeam(cluster2, 1, adminId);
    const outsider = await createActiveUser({ fullName: "Outsider", email: uniqueEmail("outsider"), password: "OutsiderPass!2026", affiliation: "vendor" });
    await addMember(teamA, outsider, adminId, "team_admin");
    const login = await loginAs(outsider.email, "OutsiderPass!2026");
    const session = (login as any).session;

    const victim = await createActiveUser({ fullName: "Victim", email: uniqueEmail("victim"), password: "VictimPass!2026", affiliation: "vendor" });
    await addMember(teamB, victim, adminId, "member");
    const membersRes = await req(`/teams/${teamB.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    const membershipId = membersData.members.find((m: any) => m.user.id === victim.id).membershipId;

    const res = await req(`/teams/${teamB.id}/members/${membershipId}`, { method: "DELETE", headers: authHeaders(session) });
    assertEquals(res.status, 403);
  });

  // addendum-033-authorization-scoping-test-discipline.md: getTeamMembers,
  // getEligibleTeamMembers, addTeamMember, and setTeamMemberRole all share
  // the exact same requireTeamMemberManager/canManageTeamMembers gate as
  // removeTeamMember above, but only removeTeamMember had a direct
  // cross-team-substitution test proving it. Same fixture shape (a real
  // team_admin of Team A, substituting Team B's id) applied to each sibling
  // route in turn.
  await t.step("get members: negative — team admin cannot list a team they don't administer", async () => {
    const cluster = await createCluster("vendor", adminId);
    const teamA = await createTeam(cluster, 1, adminId);
    const cluster2 = await createCluster("vendor", adminId);
    const teamB = await createTeam(cluster2, 1, adminId);
    const outsider = await createActiveUser({ fullName: "GetMembersOutsider", email: uniqueEmail("getmembersoutsider"), password: "OutsiderPass!2026", affiliation: "vendor" });
    await addMember(teamA, outsider, adminId, "team_admin");
    const login = await loginAs(outsider.email, "OutsiderPass!2026");
    const session = (login as any).session;

    const victim = await createActiveUser({ fullName: "GetMembersVictim", email: uniqueEmail("getmembersvictim"), password: "VictimPass!2026", affiliation: "vendor" });
    await addMember(teamB, victim, adminId, "member");

    const res = await req(`/teams/${teamB.id}/members`, { headers: authHeaders(session) });
    assertEquals(res.status, 403);
  });

  await t.step("get eligible-members: negative — team admin cannot query a team they don't administer", async () => {
    const cluster = await createCluster("vendor", adminId);
    const teamA = await createTeam(cluster, 1, adminId);
    const cluster2 = await createCluster("vendor", adminId);
    const teamB = await createTeam(cluster2, 1, adminId);
    const outsider = await createActiveUser({ fullName: "EligibleOutsider", email: uniqueEmail("eligibleoutsider"), password: "OutsiderPass!2026", affiliation: "vendor" });
    await addMember(teamA, outsider, adminId, "team_admin");
    const login = await loginAs(outsider.email, "OutsiderPass!2026");
    const session = (login as any).session;

    const res = await req(`/teams/${teamB.id}/eligible-members`, { headers: authHeaders(session) });
    assertEquals(res.status, 403);
  });

  await t.step("add member: negative — team admin cannot add a member to a team they don't administer", async () => {
    const cluster = await createCluster("vendor", adminId);
    const teamA = await createTeam(cluster, 1, adminId);
    const cluster2 = await createCluster("vendor", adminId);
    const teamB = await createTeam(cluster2, 1, adminId);
    const outsider = await createActiveUser({ fullName: "AddOutsider", email: uniqueEmail("addoutsider"), password: "OutsiderPass!2026", affiliation: "vendor" });
    await addMember(teamA, outsider, adminId, "team_admin");
    const login = await loginAs(outsider.email, "OutsiderPass!2026");
    const session = (login as any).session;

    const candidate = await createActiveUser({ fullName: "AddCandidate", email: uniqueEmail("addcandidate"), password: "CandidatePass!2026", affiliation: "vendor" });

    const res = await req(`/teams/${teamB.id}/members`, {
      method: "POST", headers: authHeaders(session), body: { userId: candidate.id, teamRole: "member" },
    });
    assertEquals(res.status, 403);

    const membersRes = await req(`/teams/${teamB.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    assertEquals(membersData.members.some((m: any) => m.user.id === candidate.id), false);
  });

  await t.step("role change: negative — team admin cannot change a role on a team they don't administer", async () => {
    const cluster = await createCluster("vendor", adminId);
    const teamA = await createTeam(cluster, 1, adminId);
    const cluster2 = await createCluster("vendor", adminId);
    const teamB = await createTeam(cluster2, 1, adminId);
    const outsider = await createActiveUser({ fullName: "RoleOutsider", email: uniqueEmail("roleoutsider"), password: "OutsiderPass!2026", affiliation: "vendor" });
    await addMember(teamA, outsider, adminId, "team_admin");
    const login = await loginAs(outsider.email, "OutsiderPass!2026");
    const session = (login as any).session;

    const victim = await createActiveUser({ fullName: "RoleVictim", email: uniqueEmail("rolevictim"), password: "VictimPass!2026", affiliation: "vendor" });
    await addMember(teamB, victim, adminId, "member");
    const membersRes = await req(`/teams/${teamB.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    const membershipId = membersData.members.find((m: any) => m.user.id === victim.id).membershipId;

    const res = await req(`/teams/${teamB.id}/members/${membershipId}/role`, {
      method: "PUT", headers: authHeaders(session), body: { teamRole: "team_admin" },
    });
    assertEquals(res.status, 403);
  });

  await t.step("role change: negative — cannot demote sole team_admin", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const sole = await createActiveUser({ fullName: "Sole", email: uniqueEmail("sole"), password: "SolePass!2026", affiliation: "vendor" });
    await addMember(team, sole, adminId, "team_admin");
    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    const membershipId = membersData.members.find((m: any) => m.user.id === sole.id).membershipId;

    const res = await req(`/teams/${team.id}/members/${membershipId}/role`, {
      method: "PUT", headers: authHeaders(adminSession), body: { teamRole: "member" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("role change: positive — promote a member to team_admin", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const first = await createActiveUser({ fullName: "F", email: uniqueEmail("f"), password: "FPass!2026", affiliation: "vendor" });
    const second = await createActiveUser({ fullName: "S", email: uniqueEmail("s"), password: "SPass!2026", affiliation: "vendor" });
    await addMember(team, first, adminId, "team_admin");
    await addMember(team, second, adminId, "member");
    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    const membershipId = membersData.members.find((m: any) => m.user.id === second.id).membershipId;

    const res = await req(`/teams/${team.id}/members/${membershipId}/role`, {
      method: "PUT", headers: authHeaders(adminSession), body: { teamRole: "team_admin" },
    });
    assertEquals(res.status, 200);
  });

  await t.step("role change: negative — invalid role value", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const user = await createActiveUser({ fullName: "Inv", email: uniqueEmail("inv"), password: "InvPass!2026", affiliation: "vendor" });
    await addMember(team, user, adminId, "member");
    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    const membersData = await membersRes.json();
    const membershipId = membersData.members.find((m: any) => m.user.id === user.id).membershipId;

    const res = await req(`/teams/${team.id}/members/${membershipId}/role`, {
      method: "PUT", headers: authHeaders(adminSession), body: { teamRole: "superadmin" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("managed-teams: positive — global admin sees all teams", async () => {
    const res = await req("/me/managed-teams", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(Array.isArray(data.teams), true);
  });

  await t.step("managed-teams: positive — team admin sees only their administered teams", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const teamAdminUser = await createActiveUser({ fullName: "MgdTA", email: uniqueEmail("mgdta"), password: "MgdPass!2026", affiliation: "vendor" });
    await addMember(team, teamAdminUser, adminId, "team_admin");
    const login = await loginAs(teamAdminUser.email, "MgdPass!2026");
    const res = await req("/me/managed-teams", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.teams.length, 1);
    assertEquals(data.teams[0].id, team.id);
  });

  await t.step("managed-teams: negative — unauthenticated", async () => {
    const res = await req("/me/managed-teams");
    assertEquals(res.status, 401);
  });
});

// Addendum-204 F3: DELETE /admin/teams/:id invalidated memberships and
// team_system_mappings with no reference guard. A team occupies its
// (cluster, level) uniquely (Constraint #14 — findByClusterAndLevel), so
// deleting THE team at a step a live system's workflow routes through
// orphans that step (findByClusterAndLevel -> null at request-decision
// time — the addendum-127 decision #3 / addendum-137 matrix lockout door),
// across org boundaries too. The route now counts live referencing systems
// and blocks — scoped and global callers alike — unless the caller passes
// an explicit { force: true } acknowledgement.
Deno.test("admin_teams delete workflow-reference guard (addendum-204 F3)", async (t) => {
  let adminId = "";
  let adminSession = "";

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("F3Admin!2026");
    adminId = admin.id;
    adminSession = (await loginAs(admin.email, "F3Admin!2026") as any).session;
  });

  await t.step("blocked while referenced (count in the message), then force acknowledges the cascade", async () => {
    const owner = await createActiveUser({
      fullName: "F3 Owner", email: uniqueEmail("f3owner"), password: "F3Owner!2026", affiliation: "agency",
    });
    const { vendorCluster, vendorL1 } = await createWiredSystem(adminId, owner);

    const blocked = await req(`/admin/teams/${vendorL1.id}`, {
      method: "DELETE", headers: authHeaders(adminSession),
    });
    assertEquals(blocked.status, 400, "a bodyless DELETE carries no force acknowledgement");
    const body = await blocked.json();
    assertEquals(body.error.includes("1 live system workflow"), true, "the referencing-system count must be in the message");
    assertExists(await teams.findByClusterAndLevel(vendorCluster.id, 1), "the team must survive the blocked delete");

    const forced = await req(`/admin/teams/${vendorL1.id}`, {
      method: "DELETE", headers: authHeaders(adminSession), body: { force: true },
    });
    assertEquals(forced.status, 200);
    assertEquals(await teams.findByClusterAndLevel(vendorCluster.id, 1), null, "force runs the delete");
  });

  await t.step("the count tracks every live referencing system", async () => {
    const owner = await createActiveUser({
      fullName: "F3 Owner Two", email: uniqueEmail("f3owner2"), password: "F3Owner!2026", affiliation: "agency",
    });
    const { vendorCluster, agencyCluster, vendorL1 } = await createWiredSystem(adminId, owner);
    const second: System = {
      id: generateId(),
      shortCode: uniqueShortCode(),
      name: uniqueName("F3 Second System"),
      description: null,
      vendorClusterIds: [vendorCluster.id],
      agencyClusterId: agencyCluster.id,
      workflowDefinition: [
        { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
      ],
      awsRoleArnNote: null,
      expiresAfter: null,
      createdBy: adminId,
      createdAt: now(),
      updatedAt: now(),
    };
    await createSystemWithOwnerOrgEdge(second, agencyCluster, adminId);

    const res = await req(`/admin/teams/${vendorL1.id}`, {
      method: "DELETE", headers: authHeaders(adminSession),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error.includes("2 live system workflow"), true, "both systems route through (vendorCluster, 1)");
  });

  await t.step("an unreferenced team still deletes clean (regression envelope)", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 4, adminId);
    const res = await req(`/admin/teams/${team.id}`, {
      method: "DELETE", headers: authHeaders(adminSession),
    });
    assertEquals(res.status, 200);
  });

  await t.step("a scoped TeamDelete holder is blocked identically — the guard is scope-indifferent", async () => {
    const orgA = await createOrganization({ name: "F3 Org A", shortCode: "F3A", createdBy: adminId });
    const scopedAdmin = await createActiveUser({
      fullName: "F3 Scoped", email: uniqueEmail("f3scoped"), password: "F3Scoped!2026", affiliation: "agency",
    });
    await addOrgMembership({ organizationId: orgA.id, userId: scopedAdmin.id, addedBy: adminId });
    await grantAdminRole(scopedAdmin.id, "org_structure_admin", adminId, "addendum-204 F3 fixture", orgA.id);
    const scopedSession = (await loginAs(scopedAdmin.email, "F3Scoped!2026") as any).session;
    assertExists(scopedSession);

    const owner = await createActiveUser({
      fullName: "F3 Owner Scoped", email: uniqueEmail("f3ownerscoped"), password: "F3Owner!2026", affiliation: "agency",
    });
    const { vendorCluster, vendorL1 } = await createWiredSystem(adminId, owner);
    // Anchor the team's cluster into org A — the scoped holder's TeamDelete
    // now legitimately reaches the team, while the referencing system stays
    // OUT OF SCOPE (its owner edge lives in the fixture fallback org, which
    // org A never grants): exactly the cross-org cascade the guard exists for.
    await query(`UPDATE clusters SET organization_id = $1 WHERE id = $2`, [orgA.id, vendorCluster.id]);

    const res = await req(`/admin/teams/${vendorL1.id}`, {
      method: "DELETE", headers: authHeaders(scopedSession),
    });
    assertEquals(res.status, 400, "scope grants reach, not exemption from the reference guard");
    const body = await res.json();
    assertEquals(body.error.includes("1 live system workflow"), true);
    assertExists(await teams.findByClusterAndLevel(vendorCluster.id, 1));
  });
});
