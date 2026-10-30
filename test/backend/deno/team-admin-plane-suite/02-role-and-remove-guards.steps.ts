// PUT /teams/:teamId/members/:membershipId/role and
// DELETE /teams/:teamId/members/:membershipId — the self-lock and identity
// arms behind §E's TeamMembersModal self-lock story: admin_teams.test.tsx pins
// the sole-admin demote guard (acted on by a GLOBAL admin), the cross-team
// 403 and the invalid-role 400, but not the non-global SELF-service locks nor
// the 404/idempotence classes.
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, createActiveUser, loginAs, uniqueEmail, createCluster, createTeam, addMember,
} from "../helpers.tsx";
import type { SuiteContext } from "./00-context.ts";

export async function run02Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;

  // Shared fixture: one team with TWO team admins — the self-lock arms need a
  // surviving admin, so this never collides with the sole-admin guard (which
  // admin_teams.test.tsx pins separately).
  async function twoAdminTeam() {
    const cluster = await createCluster("vendor", adminId);
    const team = await createTeam(cluster, 1, adminId);
    const adminA = await createActiveUser({ fullName: "A", email: uniqueEmail("tp-a"), password: "APass!2026", affiliation: "vendor" });
    const adminB = await createActiveUser({ fullName: "B", email: uniqueEmail("tp-b"), password: "BPass!2026", affiliation: "vendor" });
    await addMember(team, adminA, adminId, "team_admin");
    await addMember(team, adminB, adminId, "team_admin");
    const membersRes = await req(`/teams/${team.id}/members`, { headers: authHeaders(adminSession) });
    const members = (await membersRes.json()).members;
    const membershipOf = (userId: string) =>
      members.find((m: any) => m.user.id === userId).membershipId;
    return { team, adminA, adminB, membershipOf };
  }

  await t.step("role change: negative — a non-global team_admin cannot demote THEMSELVES (self-lock)", async () => {
    const { team, adminA, membershipOf } = await twoAdminTeam();
    const login = await loginAs(adminA.email, "APass!2026");
    const res = await req(`/teams/${team.id}/members/${membershipOf(adminA.id)}/role`, {
      method: "PUT", headers: authHeaders((login as any).session), body: { teamRole: "member" },
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "You cannot demote yourself. Ask another team admin or a global admin.");
  });

  await t.step("role change: positive — re-setting the current role is an idempotent no-op 200", async () => {
    const { team, adminB, membershipOf } = await twoAdminTeam();
    const res = await req(`/teams/${team.id}/members/${membershipOf(adminB.id)}/role`, {
      method: "PUT", headers: authHeaders(adminSession), body: { teamRole: "team_admin" },
    });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.membership.teamRole, "team_admin");
  });

  await t.step("role change: negative — an unknown membership id 404s", async () => {
    const { team } = await twoAdminTeam();
    const res = await req(`/teams/${team.id}/members/${crypto.randomUUID()}/role`, {
      method: "PUT", headers: authHeaders(adminSession), body: { teamRole: "member" },
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Membership not found.");
  });

  await t.step("remove member: negative — a non-global team_admin cannot remove THEMSELVES (self-lock)", async () => {
    const { team, adminA, membershipOf } = await twoAdminTeam();
    const login = await loginAs(adminA.email, "APass!2026");
    const res = await req(`/teams/${team.id}/members/${membershipOf(adminA.id)}`, {
      method: "DELETE", headers: authHeaders((login as any).session),
    });
    assertEquals(res.status, 400);
    const body = await res.json();
    assertEquals(body.error, "You cannot remove yourself from a team you administer. Ask another team admin or a global admin.");
  });

  await t.step("remove member: negative — an unknown membership id 404s", async () => {
    const { team } = await twoAdminTeam();
    const res = await req(`/teams/${team.id}/members/${crypto.randomUUID()}`, {
      method: "DELETE", headers: authHeaders(adminSession),
    });
    assertEquals(res.status, 404);
    const body = await res.json();
    assertEquals(body.error, "Membership not found.");
  });
}
