// Coverage: GET/POST/PUT/DELETE /admin/systems[/:id], GET /my-systems,
// GET /admin/systems/:id/mappings, POST/DELETE /admin/systems/:id/owners[/:ownerId],
// POST/DELETE /admin/mappings/team-system[/:id], POST/DELETE /admin/mappings/owner-pa[/:id].
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
  createCluster, createTeam, addMember, createWiredSystem, ensureDefaultOrganization, createAsset,
} from "../helpers.tsx";
import { query } from "../../../../server/pg.tsx";
import { systemOwners, clusters, teams, systems } from "../../../../server/db.tsx";

let shortCodeSeq = 0;
function uniqueShortCode(): string {
  shortCodeSeq += 1;
  return `AS${shortCodeSeq}`;
}

import type { SuiteContext } from "./00-context.ts";

export async function run02Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;
  await t.step("delete: positive — system with no open requests succeeds", async () => {
    // The negative "system with open requests blocked" case is covered at
    // the requests-layer in requests.test.tsx (submits a request, then
    // attempts delete against that same system).
    const owner = await createActiveUser({ fullName: "DelOwner", email: uniqueEmail("delowner"), password: "DelPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req(`/admin/systems/${system.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
  });

  await t.step("delete: negative — system not found", async () => {
    const res = await req(`/admin/systems/00000000-0000-0000-0000-000000000999`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 404);
  });

  await t.step("mappings: positive — lists team-system mappings enriched with team objects", async () => {
    const owner = await createActiveUser({ fullName: "MapOwner", email: uniqueEmail("mapowner"), password: "MapPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const res = await req(`/admin/systems/${system.id}/mappings`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.mappings.find((m: any) => m.team.id === vendorL1.id));
  });

  await t.step("mappings: positive — unmapped_clusters flags a declared cluster with zero mapped teams", async () => {
    // createWiredSystem maps every team it creates, so add a second vendor
    // cluster to the system that never gets a mapping (via update, since
    // create requires a fully-workflow-valid set up front).
    const owner = await createActiveUser({ fullName: "UnmapOwner", email: uniqueEmail("unmapowner"), password: "UnmapPass!2026", affiliation: "agency" });
    const { system, vendorCluster } = await createWiredSystem(adminId, owner);
    const secondVendorCluster = await createCluster("vendor", adminId);
    const updateRes = await req(`/admin/systems/${system.id}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: { vendorClusterIds: [vendorCluster.id, secondVendorCluster.id] },
    });
    assertEquals(updateRes.status, 200);

    const res = await req(`/admin/systems/${system.id}/mappings`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.unmappedClusters.find((cl: any) => cl.id === secondVendorCluster.id));
    // The system's original, fully-mapped vendor cluster must NOT be flagged.
    assertEquals(data.unmappedClusters.some((cl: any) => cl.id === vendorCluster.id), false);
  });

  await t.step("mappable-teams: positive — lists only teams from the system's own clusters, minus already-mapped ones", async () => {
    const owner = await createActiveUser({ fullName: "MapableOwner", email: uniqueEmail("mapableowner"), password: "MapablePass!2026", affiliation: "agency" });
    const { system, agencyCluster, vendorL1 } = await createWiredSystem(adminId, owner);
    const eligibleAgencyTeam = await createTeam(agencyCluster, 3, adminId);

    const unrelatedCluster = await createCluster("vendor", adminId);
    const unrelatedTeam = await createTeam(unrelatedCluster, 1, adminId);

    const res = await req(`/admin/systems/${system.id}/mappable-teams`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.teams.find((t: any) => t.id === eligibleAgencyTeam.id));
    assertEquals(data.teams.some((t: any) => t.id === vendorL1.id), false); // already mapped by createWiredSystem
    assertEquals(data.teams.some((t: any) => t.id === unrelatedTeam.id), false); // unrelated cluster
  });

  await t.step("owners: positive — add backup owner", async () => {
    const owner = await createActiveUser({ fullName: "PrimOwner", email: uniqueEmail("primowner"), password: "PrimPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const backup = await createActiveUser({ fullName: "BackupOwner", email: uniqueEmail("backupowner"), password: "BackupPass!2026", affiliation: "agency" });
    const res = await req(`/admin/systems/${system.id}/owners`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: backup.id, kind: "backup" },
    });
    assertEquals(res.status, 201);
  });

  await t.step("owners: negative — invalid kind", async () => {
    const owner = await createActiveUser({ fullName: "O10", email: uniqueEmail("o10"), password: "O10Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const other = await createActiveUser({ fullName: "O11", email: uniqueEmail("o11"), password: "O11Pass!2026", affiliation: "agency" });
    const res = await req(`/admin/systems/${system.id}/owners`, {
      method: "POST", headers: authHeaders(adminSession), body: { userId: other.id, kind: "tertiary" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("owners: negative — remove primary owner with no backup blocked", async () => {
    const owner = await createActiveUser({ fullName: "SoleOwner", email: uniqueEmail("soleowner"), password: "SolePass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const primaryRow = await systemOwners.findBySystemAndKind(system.id, "primary");
    const res = await req(`/admin/systems/${system.id}/owners/${primaryRow!.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  // addendum-033-authorization-scoping-test-discipline.md: removeSystemOwner
  // defensively re-checks ownerRow.systemId === systemId even though the
  // whole route is admin-gated — good practice, but untested for the
  // mismatch branch until now.
  await t.step("owners: negative — owner record does not belong to this system", async () => {
    const ownerA = await createActiveUser({ fullName: "OwnerRecA", email: uniqueEmail("ownerreca"), password: "OwnerRecPass!2026", affiliation: "agency" });
    const { system: systemA } = await createWiredSystem(adminId, ownerA);
    const ownerB = await createActiveUser({ fullName: "OwnerRecB", email: uniqueEmail("ownerrecb"), password: "OwnerRecPass!2026", affiliation: "agency" });
    const { system: systemB } = await createWiredSystem(adminId, ownerB);
    const primaryRowB = await systemOwners.findBySystemAndKind(systemB.id, "primary");

    // Substitute systemA's id with systemB's real owner-record id.
    const res = await req(`/admin/systems/${systemA.id}/owners/${primaryRowB!.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 404);

    const stillThere = await systemOwners.get(primaryRowB!.id);
    assertExists(stillThere);
  });

  await t.step("owners: positive — remove backup owner", async () => {
    const owner = await createActiveUser({ fullName: "O12", email: uniqueEmail("o12"), password: "O12Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const backup = await createActiveUser({ fullName: "O13", email: uniqueEmail("o13"), password: "O13Pass!2026", affiliation: "agency" });
    await req(`/admin/systems/${system.id}/owners`, { method: "POST", headers: authHeaders(adminSession), body: { userId: backup.id, kind: "backup" } });
    const backupRow = await systemOwners.findBySystemAndKind(system.id, "backup");

    const res = await req(`/admin/systems/${system.id}/owners/${backupRow!.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
  });

  await t.step("team-system mapping: positive — map an agency team to a system", async () => {
    const owner = await createActiveUser({ fullName: "O14", email: uniqueEmail("o14"), password: "O14Pass!2026", affiliation: "agency" });
    const { system, agencyCluster } = await createWiredSystem(adminId, owner);
    const newAgencyTeam = await createTeam(agencyCluster, 3, adminId);
    const res = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(adminSession), body: { teamId: newAgencyTeam.id, systemId: system.id },
    });
    assertEquals(res.status, 201);
  });

  await t.step("team-system mapping: negative — team's cluster is not one of the system's assigned clusters", async () => {
    const owner = await createActiveUser({ fullName: "ClusterMismatchOwner", email: uniqueEmail("clustermismatch"), password: "MismatchPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const unrelatedCluster = await createCluster("vendor", adminId);
    const unrelatedTeam = await createTeam(unrelatedCluster, 2, adminId);
    const res = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(adminSession), body: { teamId: unrelatedTeam.id, systemId: system.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("team-system mapping: negative — duplicate mapping rejected", async () => {
    const owner = await createActiveUser({ fullName: "O15", email: uniqueEmail("o15"), password: "O15Pass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const res = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(adminSession), body: { teamId: vendorL1.id, systemId: system.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("team-system mapping: negative — PA team cannot be mapped to a system", async () => {
    const owner = await createActiveUser({ fullName: "O16", email: uniqueEmail("o16"), password: "O16Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const paCluster = await createCluster("pa", adminId);
    const paTeam = await createTeam(paCluster, 1, adminId);
    const res = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(adminSession), body: { teamId: paTeam.id, systemId: system.id },
    });
    assertEquals(res.status, 400);
  });

  // addendum-042-relationship-fk-validation-audit.md: teams.get()/systems.get()
  // still return invalidated rows, so createTeamSystemMapping must reject an
  // invalidated team/system explicitly, not just a nonexistent one.
  await t.step("team-system mapping: negative — invalidated team rejected", async () => {
    const owner = await createActiveUser({ fullName: "InvMapTeamOwner", email: uniqueEmail("invmapteamowner"), password: "InvMapTeamPass!2026", affiliation: "agency" });
    const { system, agencyCluster } = await createWiredSystem(adminId, owner);
    const newAgencyTeam = await createTeam(agencyCluster, 4, adminId);
    await teams.invalidate(newAgencyTeam.id);
    const res = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(adminSession), body: { teamId: newAgencyTeam.id, systemId: system.id },
    });
    assertEquals(res.status, 404);
  });

  await t.step("team-system mapping: negative — invalidated system rejected", async () => {
    const owner = await createActiveUser({ fullName: "InvMapSysOwner", email: uniqueEmail("invmapsysowner"), password: "InvMapSysPass!2026", affiliation: "agency" });
    const { system, agencyCluster } = await createWiredSystem(adminId, owner);
    const newAgencyTeam = await createTeam(agencyCluster, 4, adminId);
    await systems.invalidate(system.id);
    const res = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(adminSession), body: { teamId: newAgencyTeam.id, systemId: system.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("team-system mapping: positive — delete mapping", async () => {
    const owner = await createActiveUser({ fullName: "O17", email: uniqueEmail("o17"), password: "O17Pass!2026", affiliation: "agency" });
    const { system, agencyCluster } = await createWiredSystem(adminId, owner);
    const newTeam = await createTeam(agencyCluster, 3, adminId);
    const mapRes = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(adminSession), body: { teamId: newTeam.id, systemId: system.id },
    });
    const mapData = await mapRes.json();
    const res = await req(`/admin/mappings/team-system/${mapData.mapping.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
  });
}
