// Coverage: GET/POST/PUT/DELETE /admin/systems[/:id], GET /my-systems,
// GET /admin/systems/:id/mappings, POST/DELETE /admin/systems/:id/owners[/:ownerId],
// POST/DELETE /admin/mappings/team-system[/:id], POST/DELETE /admin/mappings/owner-pa[/:id].
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
  createCluster, createTeam, addMember, addServingMember, createWiredSystem, ensureDefaultOrganization, createAsset,
  addOrgMembership, fixtureFallbackOrgId,
} from "../helpers.tsx";
import { query } from "../../../../server/pg.tsx";
import { systemOwners, clusters, teams, systems } from "../../../../server/db.tsx";

let shortCodeSeq = 0;
function uniqueShortCode(): string {
  shortCodeSeq += 1;
  return `AT${shortCodeSeq}`;
}

import type { SuiteContext } from "./00-context.ts";

export async function run03Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;
  await t.step("owner-PA mapping: positive — assign PA team to owner", async () => {
    const owner = await createActiveUser({ fullName: "PAOwner", email: uniqueEmail("paowner"), password: "PAPass!2026", affiliation: "agency" });
    const { primaryOwner } = await createWiredSystem(adminId, owner);
    const paCluster = await createCluster("pa", adminId);
    const paTeam = await createTeam(paCluster, 1, adminId);
    const res = await req("/admin/mappings/owner-pa", {
      method: "POST", headers: authHeaders(adminSession), body: { systemOwnerId: primaryOwner.id, paTeamId: paTeam.id },
    });
    assertEquals(res.status, 201);
  });

  await t.step("owner-PA mapping: negative — owner already has a PA team", async () => {
    const owner = await createActiveUser({ fullName: "PAOwner2", email: uniqueEmail("paowner2"), password: "PA2Pass!2026", affiliation: "agency" });
    const { primaryOwner } = await createWiredSystem(adminId, owner);
    const paCluster = await createCluster("pa", adminId);
    const paTeamA = await createTeam(paCluster, 1, adminId);
    const paTeamB = await createTeam(paCluster, 2, adminId);
    await req("/admin/mappings/owner-pa", { method: "POST", headers: authHeaders(adminSession), body: { systemOwnerId: primaryOwner.id, paTeamId: paTeamA.id } });
    const res = await req("/admin/mappings/owner-pa", { method: "POST", headers: authHeaders(adminSession), body: { systemOwnerId: primaryOwner.id, paTeamId: paTeamB.id } });
    assertEquals(res.status, 400);
  });

  await t.step("owner-PA mapping: negative — non-PA team rejected", async () => {
    const owner = await createActiveUser({ fullName: "PAOwner3", email: uniqueEmail("paowner3"), password: "PA3Pass!2026", affiliation: "agency" });
    const { system, vendorL1, primaryOwner } = await createWiredSystem(adminId, owner);
    const res = await req("/admin/mappings/owner-pa", {
      method: "POST", headers: authHeaders(adminSession), body: { systemOwnerId: primaryOwner.id, paTeamId: vendorL1.id },
    });
    assertEquals(res.status, 400);
  });

  // addendum-042-relationship-fk-validation-audit.md: teams.get() still
  // returns invalidated rows, so createSystemOwnerPAMapping must reject an
  // invalidated PA team explicitly, not just a nonexistent one.
  await t.step("owner-PA mapping: negative — invalidated PA team rejected", async () => {
    const owner = await createActiveUser({ fullName: "PAOwner5", email: uniqueEmail("paowner5"), password: "PA5Pass!2026", affiliation: "agency" });
    const { primaryOwner } = await createWiredSystem(adminId, owner);
    const paCluster = await createCluster("pa", adminId);
    const paTeam = await createTeam(paCluster, 1, adminId);
    await teams.invalidate(paTeam.id);
    const res = await req("/admin/mappings/owner-pa", {
      method: "POST", headers: authHeaders(adminSession), body: { systemOwnerId: primaryOwner.id, paTeamId: paTeam.id },
    });
    assertEquals(res.status, 404);
  });

  await t.step("owner-PA mapping: positive — delete mapping", async () => {
    const owner = await createActiveUser({ fullName: "PAOwner4", email: uniqueEmail("paowner4"), password: "PA4Pass!2026", affiliation: "agency" });
    const { primaryOwner } = await createWiredSystem(adminId, owner);
    const paCluster = await createCluster("pa", adminId);
    const paTeam = await createTeam(paCluster, 1, adminId);
    const mapRes = await req("/admin/mappings/owner-pa", { method: "POST", headers: authHeaders(adminSession), body: { systemOwnerId: primaryOwner.id, paTeamId: paTeam.id } });
    const mapData = await mapRes.json();
    const res = await req(`/admin/mappings/owner-pa/${mapData.mapping.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
  });

  await t.step("my-systems: positive — vendor submitter sees only their mapped system", async () => {
    const owner = await createActiveUser({ fullName: "MySysOwner", email: uniqueEmail("mysysowner"), password: "MySysPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const vendorUser = await createActiveUser({ fullName: "MySysVendor", email: uniqueEmail("mysysvendor"), password: "MySysVPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, vendorUser, adminId);
    const login = await loginAs(vendorUser.email, "MySysVPass!2026");
    const res = await req("/my-systems", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.systems.find((s: any) => s.id === system.id));
  });

  await t.step("my-systems: negative — unauthenticated", async () => {
    const res = await req("/my-systems");
    // requireActiveUser(null) throws AuthorizationError, caught -> 403 (not 401).
    assertEquals(res.status, 403);
  });

  // ── Addendum-127 (red-regiment row 9): mappings auto-sync on workflow save ─
  // team_system_mappings is derivable state (workflow_definition ⋈ live teams
  // at (clusterId, level)); every workflow_definition write re-materializes
  // it. Fixtures above bypass routes (entity-level), so these steps drive the
  // API directly.

  await t.step("auto-sync: first workflow PUT auto-binds step teams; re-save is idempotent", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const vendorL1 = await createTeam(vendorCluster, 1, adminId);
    const agencyL1 = await createTeam(agencyCluster, 1, adminId);
    const owner = await createActiveUser({ fullName: "SyncOwner", email: uniqueEmail("syncowner"), password: "SyncPass!2026", affiliation: "agency" });

    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("System"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(res.status, 201);
    const systemId = (await res.json()).system.id;

    // Create auto-binds both step teams (addendum-127: create is exempt from
    // map-first; sync runs immediately on POST).
    let mappings = (await query<{ team_id: string }>(
      `SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND expires_after IS NULL ORDER BY team_id`, [systemId],
    )).map((r) => r.team_id).sort();
    assertEquals(mappings, [agencyL1.id, vendorL1.id].sort(), 'create auto-binds both step teams');

    // First PUT re-syncs the same definition — idempotent (unique-index guard).
    const upd = await req(`/admin/systems/${systemId}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: {
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(upd.status, 200);
    mappings = (await query<{ team_id: string }>(
      `SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND expires_after IS NULL ORDER BY team_id`, [systemId],
    )).map((r) => r.team_id).sort();
    assertEquals(mappings, [agencyL1.id, vendorL1.id].sort(), 'first PUT re-sync is idempotent');

    // Provenance: the sync's audit rows carry via: workflow_save_auto_sync.
    const audit = await query<{ action: string }>(
      `SELECT action FROM audit_log WHERE target_type = 'team_system_mapping' AND action LIKE 'team_system_mapping.%' AND details->>'via' = 'workflow_save_auto_sync'`, [],
    );
    assertEquals(audit.length >= 2, true, `sync audit provenance rows present, got ${audit.length}`);

    // Re-saving the SAME definition adds nothing (unique-index-backed idempotence).
    const upd2 = await req(`/admin/systems/${systemId}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: {
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(upd2.status, 200);
    mappings = (await query<{ team_id: string }>(
      `SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND expires_after IS NULL ORDER BY team_id`, [systemId],
    )).map((r) => r.team_id).sort();
    assertEquals(mappings, [agencyL1.id, vendorL1.id].sort(), 'no duplicate mappings on re-save');
  });

  await t.step("auto-sync: edit binds a new step's team and expires a removed step's mapping", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const vendorL1 = await createTeam(vendorCluster, 1, adminId);
    const vendorL2 = await createTeam(vendorCluster, 2, adminId);
    const agencyL1 = await createTeam(agencyCluster, 1, adminId);
    const owner = await createActiveUser({ fullName: "SyncOwner2", email: uniqueEmail("syncowner2"), password: "SyncPass!2026", affiliation: "agency" });

    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("System"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(res.status, 201);
    const systemId = (await res.json()).system.id;

    // First PUT: establish initial mappings (vendorL1 + agencyL1).
    const initial = await req(`/admin/systems/${systemId}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: {
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(initial.status, 200);

    // Edit: swap the agency step for a vendor-L2 step ⇒ agency mapping expires, vendor-L2 mapping appears.
    const upd = await req(`/admin/systems/${systemId}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: {
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: vendorCluster.id, level: 2, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(upd.status, 200);

    const active = (await query<{ team_id: string }>(
      `SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND expires_after IS NULL`, [systemId],
    )).map((r) => r.team_id).sort();
    assertEquals(active, [vendorL1.id, vendorL2.id].sort(), 'surplus mapping expired, new step team bound');
    const expired = await query<{ team_id: string }>(
      `SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND team_id = $2 AND expires_after IS NOT NULL`, [systemId, agencyL1.id],
    );
    assertEquals(expired.length, 1, 'removal is a soft invalidate (history kept)');
  });

  await t.step("auto-sync: in-flight guard retains a removed step's mapping while an open request needs it", async () => {
    const owner = await createActiveUser({ fullName: "SyncOwner3", email: uniqueEmail("syncowner3"), password: "SyncPass!2026", affiliation: "agency" });
    const { system, vendorL1, vendorL2, agencyL1 } = await createWiredSystem(adminId, owner);

    // Submit a request against the fixture system (steps are all non-terminal).
    const asset = await createAsset(system.id, { managementMode: 'manual' });
    const submitter = await createActiveUser({ fullName: "SyncSub", email: uniqueEmail("syncsub"), password: "SyncSubPass!2026", affiliation: "vendor" });
    await req(`/teams/${vendorL1.id}/members`, { method: "POST", headers: authHeaders(adminSession), body: { userId: submitter.id } });
    // addendum-206 §3.3: the vendor's service membership of the system's
    // linked org — the user-level on-ramp the D1 §4.2 gate reads (the wired
    // topology's owner edge points at the fixture fallback org).
    await addOrgMembership({ organizationId: await fixtureFallbackOrgId(adminId), userId: submitter.id, addedBy: adminId });
    const submitterSession = ((await loginAs(submitter.email, "SyncSubPass!2026")) as any).session;
    const submitted = await req("/requests", {
      method: "POST", headers: authHeaders(submitterSession),
      body: {
        systemId: system.id, justification: "In-flight guard coverage.", srNumber: "SR-9300",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id }],
      },
    });
    assertEquals(submitted.status, 201);

    // Now drop the tail agency step from the definition. The request still
    // occupies that (cluster, level) in a non-terminal state ⇒ RETAINED.
    const upd = await req(`/admin/systems/${system.id}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: {
        workflowDefinition: [
          { ordinal: 1, clusterId: system.vendorClusterIds[0], level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: system.vendorClusterIds[0], level: 2, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(upd.status, 200);

    const retained = await query<{ team_id: string }>(
      `SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND team_id = $2 AND expires_after IS NULL`, [system.id, agencyL1.id],
    );
    assertEquals(retained.length, 1, 'in-flight step keeps its mapping (guard) — the request chain cannot be stranded mid-flight');
  });

  await t.step("auto-sync: a step with no live team at (cluster, level) is tolerated, not created", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    await createTeam(vendorCluster, 1, adminId);
    const owner = await createActiveUser({ fullName: "SyncOwner4", email: uniqueEmail("syncowner4"), password: "SyncPass!2026", affiliation: "agency" });

    // Level 5 in the agency cluster has NO team — create passes (map-first
    // exempt), sync simply cannot bind it.
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("System"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: agencyCluster.id, level: 5, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(res.status, 201);
    const systemId = (await res.json()).system.id;

    // PUT triggers auto-sync; only the resolvable step (vendorL1) gets bound.
    const upd = await req(`/admin/systems/${systemId}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: {
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: agencyCluster.id, level: 5, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(upd.status, 200);
    const mappings = await query<{ team_id: string }>(
      `SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND expires_after IS NULL`, [systemId],
    );
    assertEquals(mappings.length, 1, 'only the resolvable step bound; the team-less step stays mapped-by-badge (no row invented)');
  });
}
