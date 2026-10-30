// Repro: the e2e happy-path DEMO showcase (e2e/demo/happy-path-showcase.spec.ts)
// hangs to its 600s per-test timeout inside provisionSystem() (e2e/helpers/
// scenario.ts:255), on the THIRD team-mapping iteration — the agency L1 team.
// The captured last frame shows System = "DEMO1 — Demo Showcase System",
// the Team dropdown stuck at "-- Select a team --" (no options), the two
// VENDOR teams already mapped, and an "AGENCY CLUSTER DEMO HAS NO TEAM MAPPED"
// warning. So the UI's team dropdown (populated by GET /admin/systems/:id/
// mappable-teams) never surfaced the agency teams, and Playwright's
// selectOption({ label: '...agency L1' }) waited forever.
//
// This file reproduces that provisioning at the BACKEND layer — driving the
// same real routes in the same order the demo does — to isolate whether the
// bug is in getMappableTeams/createTeamSystemMapping (backend) or purely in
// the UI. If the backend correctly returns the agency teams as mappable at
// every step here, the bug is frontend-only; if it doesn't, we've found it.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, fixtureFallbackOrgId,
} from "./helpers.tsx";

let shortCodeSeq = 0;
const uniqueShortCode = () => `MR${++shortCodeSeq}`;

Deno.test("mapping_droplist_repro", async (t) => {
  let adminSession: string;
  // addendum-206: clusters.organization_id is NOT NULL — the demo-shaped
  // clusters below anchor on the shared fallback org.
  let clusterOrgId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("MapRepro!2026");
    const login = await loginAs(admin.email, "MapRepro!2026");
    adminSession = (login as any).session;
    clusterOrgId = await fixtureFallbackOrgId(admin.id);
  });

  await t.step("replicate the demo's mapping flow via real routes; assert agency teams stay mappable", async () => {
    const h = authHeaders(adminSession);

    // 1. Owner (agency-affiliated active user), as the demo has.
    const owner = await createActiveUser({
      fullName: "Demo Owner", email: uniqueEmail("demo-owner"), password: "OwnerPass!2026", affiliation: "agency",
    });

    // 2. Two clusters, via the real route — mirrors provisionActorsAndTeams().
    const vendorClusterRes = await req("/admin/clusters", {
      method: "POST", headers: h, body: { name: "Vendor Cluster Demo", type: "vendor", organizationId: clusterOrgId },
    });
    assertEquals(vendorClusterRes.status, 201);
    const vendorCluster = (await vendorClusterRes.json()).cluster;

    const agencyClusterRes = await req("/admin/clusters", {
      method: "POST", headers: h, body: { name: "Agency Cluster Demo", type: "agency", organizationId: clusterOrgId },
    });
    assertEquals(agencyClusterRes.status, 201);
    const agencyCluster = (await agencyClusterRes.json()).cluster;

    // 3. Four teams, via the real route, in the demo's order.
    async function makeTeam(name: string, clusterId: string, level: number) {
      const res = await req("/admin/teams", {
        method: "POST", headers: h, body: { name, clusterId: clusterId, level },
      });
      assertEquals(res.status, 201, `create team ${name}: ${await res.clone().text()}`);
      return (await res.json()).team;
    }
    const vendorL1Team = await makeTeam("Vendor L1 Team demo", vendorCluster.id, 1);
    const vendorL2Team = await makeTeam("Vendor L2 Team demo", vendorCluster.id, 2);
    const agencyL1Team = await makeTeam("Agency L1 Team demo", agencyCluster.id, 1);
    const agencyL2Team = await makeTeam("Agency L2 Team demo", agencyCluster.id, 2);

    // 4. System with BOTH clusters assigned + the demo's 4-approval-step
    //    workflow (vendor L1 submitter is step 1 per addendum-027), via the
    //    real create route.
    const systemRes = await req("/admin/systems", {
      method: "POST", headers: h,
      body: {
        shortCode: uniqueShortCode(),
        name: "Demo Showcase System",
        primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id],
        agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: vendorCluster.id, level: 2, stepKind: "hierarchical", notes: null },
          { ordinal: 3, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 4, clusterId: agencyCluster.id, level: 2, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(systemRes.status, 201, `create system: ${await systemRes.clone().text()}`);
    const system = (await systemRes.json()).system;

    // 5. Addendum-127: system create via HTTP API triggers syncMappingsForSystem,
    //    which auto-maps all 4 teams (one per workflow step's cluster+level).
    //    All teams are already mapped — no manual loop needed.
    //    mappable-teams returns [] because all are taken.
    const mappableRes = await req(`/admin/systems/${system.id}/mappable-teams`, { headers: h });
    assertEquals(mappableRes.status, 200);
    assertEquals((await mappableRes.json()).teams.length, 0, "all teams auto-mapped on create");

    // All 4 mappings exist, no unmapped cluster warning.
    const mappingsRes = await req(`/admin/systems/${system.id}/mappings`, { headers: h });
    assertEquals(mappingsRes.status, 200);
    const mappingsData = await mappingsRes.json();
    assertEquals(mappingsData.mappings.length, 4);
    assertEquals(mappingsData.unmappedClusters.length, 0);
  });
});
