// Coverage: POST /teams/:id/members, PUT /teams/:teamId/members/:membershipId/role,
// DELETE /teams/:teamId/members/:membershipId — the roster-plane validation and
// self-lock arms behind §E's TeamMembersModal element stories (add gating,
// failed-add retention, non-global self-lock), complementing
// admin_teams.test.tsx (positive adds, Constraint #15 auto-promotion,
// cross-team 403, sole-admin guard, invalid-role 400, notification wiring).
import { wipeDatabase, createAdmin, loginAs } from "./helpers.tsx";
import { run01Steps } from "./team-admin-plane-suite/01-add-member-validation.steps.ts";
import { run02Steps } from "./team-admin-plane-suite/02-role-and-remove-guards.steps.ts";
import type { SuiteContext } from "./team-admin-plane-suite/00-context.ts";

Deno.test("team_admin_plane", async (t) => {
  const context = {} as SuiteContext;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("TeamPlaneAdmin!2026");
    context.adminId = admin.id;
    const login = await loginAs(admin.email, "TeamPlaneAdmin!2026");
    context.adminSession = (login as any).session;
  });

  await run01Steps(t, context);
  await run02Steps(t, context);
});
