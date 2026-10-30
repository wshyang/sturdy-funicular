// POST /teams/:id/members — the roster-add validation arms behind §E's
// TeamMembersModal (add disabled until a prospect is picked; failed adds stay
// local; the roster CSV's flagged rows). admin_teams.test.tsx pins the
// positive add, the first-member auto-promotion (Constraint #15) and the
// cross-team 403, but none of these route-level 400/404 classes.
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, createActiveUser, loginAs, uniqueEmail, createCluster, createTeam, addMember,
} from "../helpers.tsx";
import type { SuiteContext } from "./00-context.ts";

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;

  await t.step("add member: negative — missing userId fails the schema gate 400", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const res = await req(`/teams/${team.id}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: {},
    });
    assertEquals(res.status, 400);
  });

  await t.step("add member: negative — unknown user id rejected 400", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const res = await req(`/teams/${team.id}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: crypto.randomUUID() },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "The specified user does not exist or is not active.");
  });

  await t.step("add member: negative — an agency user cannot join a vendor team", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const agencyUser = await createActiveUser({ fullName: "Agency", email: uniqueEmail("tp-agency"), password: "AgencyPass!2026", affiliation: "agency" });
    const res = await req(`/teams/${team.id}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: agencyUser.id },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "A user with affiliation agency cannot be added to a vendor team.");
  });

  await t.step("add member: negative — duplicate membership rejected 400", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const user = await createActiveUser({ fullName: "Dup", email: uniqueEmail("tp-dup"), password: "DupPass!2026", affiliation: "vendor" });
    const first = await req(`/teams/${team.id}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: user.id },
    });
    assertEquals(first.status, 201);
    const res = await req(`/teams/${team.id}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: user.id },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "This user is already a member of this team.");
  });

  await t.step("add member: negative — one team per user per cluster (Constraint #16) rejected 400", async () => {
    const cluster = await createCluster("vendor", adminId);
    const teamA = await createTeam(cluster, 1, adminId);
    const teamB = await createTeam(cluster, 2, adminId);
    const user = await createActiveUser({ fullName: "Clu", email: uniqueEmail("tp-clu"), password: "CluPass!2026", affiliation: "vendor" });
    const first = await req(`/teams/${teamA.id}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: user.id },
    });
    assertEquals(first.status, 201);
    const res = await req(`/teams/${teamB.id}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: user.id },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "This user already belongs to another team in this cluster.");
  });

  await t.step("add member: negative — an expired/unknown team 404s", async () => {
    const user = await createActiveUser({ fullName: "NoTeam", email: uniqueEmail("tp-noteam"), password: "NoTeamPass!2026", affiliation: "vendor" });
    const res = await req(`/teams/${crypto.randomUUID()}/members`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: user.id },
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Team not found.");
  });

  await t.step("add member: positive — a team's own team_admin (no global grant) manages the roster", async () => {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const teamAdmin = await createActiveUser({ fullName: "TAdmin", email: uniqueEmail("tp-tadmin"), password: "TAdminPass!2026", affiliation: "vendor" });
    await addMember(team, teamAdmin, adminId, "team_admin");
    const login = await loginAs(teamAdmin.email, "TAdminPass!2026");
    const recruit = await createActiveUser({ fullName: "Recruit", email: uniqueEmail("tp-recruit"), password: "RecruitPass!2026", affiliation: "vendor" });
    const res = await req(`/teams/${team.id}/members`, {
      method: "POST", headers: authHeaders((login as any).session), body: { userId: recruit.id },
    });
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.membership.teamRole, "member");
  });
}
