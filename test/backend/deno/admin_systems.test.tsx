// Coverage: GET/POST/PUT/DELETE /admin/systems[/:id], GET /my-systems,
// GET /admin/systems/:id/mappings, POST/DELETE /admin/systems/:id/owners[/:ownerId],
// POST/DELETE /admin/mappings/team-system[/:id], POST/DELETE /admin/mappings/owner-pa[/:id].
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
  createCluster, createTeam, addMember, createWiredSystem, ensureDefaultOrganization, createAsset,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { systemOwners, clusters, teams, systems } from "../../../server/db.tsx";

let shortCodeSeq = 0;
function uniqueShortCode(): string {
  shortCodeSeq += 1;
  return `AS${shortCodeSeq}`;
}

import { run01Steps } from "./admin-systems-suite/01-authorization-create.steps.ts";
import { run02Steps } from "./admin-systems-suite/02-crud-mappings.steps.ts";
import { run03Steps } from "./admin-systems-suite/03-auto-sync.steps.ts";

Deno.test("admin_systems", async (t) => {
  let adminId: string;
  let adminSession: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("SysAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "SysAdmin!2026");
    adminSession = (login as any).session;
  });

  const context = { adminId, adminSession };
  await run01Steps(t, context);
  await run02Steps(t, context);
  await run03Steps(t, context);
});
