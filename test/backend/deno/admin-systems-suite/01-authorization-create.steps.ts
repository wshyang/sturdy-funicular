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

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;
  await t.step("list: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "V", email: uniqueEmail("v"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req("/admin/systems", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  // addendum-033-authorization-scoping-test-discipline.md: every route in
  // this file is admin-only, but until this pass only the GET/list route
  // above had a non-admin-403 regression test. One combined test covering
  // every remaining admin-only route in this file — create/update/delete
  // system, its mappings/mappable-teams reads, owners add/remove, and both
  // team-system and owner-PA mapping create/delete.
  await t.step("create/update/delete/mappings/owners/mapping-create-delete: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "SysMutNonAdmin", email: uniqueEmail("sysmutnonadmin"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const session = (login as any).session;

    const owner = await createActiveUser({ fullName: "NonAdminTargetOwner", email: uniqueEmail("nonadmintargetowner"), password: "TargetPass!2026", affiliation: "agency" });
    const { system, vendorCluster, agencyCluster, vendorL1 } = await createWiredSystem(adminId, owner);
    const backup = await createActiveUser({ fullName: "NonAdminTargetBackup", email: uniqueEmail("nonadmintargetbackup"), password: "BackupPass!2026", affiliation: "agency" });
    const primaryRow = await systemOwners.findBySystemAndKind(system.id, "primary");

    const createRes = await req("/admin/systems", {
      method: "POST", headers: authHeaders(session),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("ShouldNotCreate"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }],
      },
    });
    assertEquals(createRes.status, 403);

    const updateRes = await req(`/admin/systems/${system.id}`, { method: "PUT", headers: authHeaders(session), body: { name: "Hijacked" } });
    assertEquals(updateRes.status, 403);

    const mappingsRes = await req(`/admin/systems/${system.id}/mappings`, { headers: authHeaders(session) });
    assertEquals(mappingsRes.status, 403);

    const mappableRes = await req(`/admin/systems/${system.id}/mappable-teams`, { headers: authHeaders(session) });
    assertEquals(mappableRes.status, 403);

    const addOwnerRes = await req(`/admin/systems/${system.id}/owners`, {
      method: "POST", headers: authHeaders(session), body: { userId: backup.id, kind: "backup" },
    });
    assertEquals(addOwnerRes.status, 403);

    const removeOwnerRes = await req(`/admin/systems/${system.id}/owners/${primaryRow!.id}`, {
      method: "DELETE", headers: authHeaders(session),
    });
    assertEquals(removeOwnerRes.status, 403);

    const newAgencyTeam = await createTeam(agencyCluster, 3, adminId);
    const createMappingRes = await req("/admin/mappings/team-system", {
      method: "POST", headers: authHeaders(session), body: { teamId: newAgencyTeam.id, systemId: system.id },
    });
    assertEquals(createMappingRes.status, 403);

    const existingMappingsRes = await req(`/admin/systems/${system.id}/mappings`, { headers: authHeaders(adminSession) });
    const existingMappingsData = await existingMappingsRes.json();
    const existingMapping = existingMappingsData.mappings.find((m: any) => m.team.id === vendorL1.id);
    const deleteMappingRes = await req(`/admin/mappings/team-system/${existingMapping.id}`, {
      method: "DELETE", headers: authHeaders(session),
    });
    assertEquals(deleteMappingRes.status, 403);

    const paCluster = await createCluster("pa", adminId);
    const paTeam = await createTeam(paCluster, 1, adminId);
    const createOwnerPaRes = await req("/admin/mappings/owner-pa", {
      method: "POST", headers: authHeaders(session), body: { systemOwnerId: primaryRow.id, paTeamId: paTeam.id },
    });
    assertEquals(createOwnerPaRes.status, 403);

    // Confirm none of the rejected calls actually mutated anything.
    const listRes = await req("/admin/systems", { headers: authHeaders(adminSession) });
    const listData = await listRes.json();
    const stillThere = listData.systems.find((s: any) => s.id === system.id);
    assertExists(stillThere);
    assertEquals(stillThere.name, system.name);
    const reloadedMappingsRes = await req(`/admin/systems/${system.id}/mappings`, { headers: authHeaders(adminSession) });
    const reloadedMappingsData = await reloadedMappingsRes.json();
    assertExists(reloadedMappingsData.mappings.find((m: any) => m.team.id === vendorL1.id));
    assertEquals(reloadedMappingsData.mappings.some((m: any) => m.team.id === newAgencyTeam.id), false);
  });

  await t.step("list: positive — admin sees every created system", async () => {
    const owner = await createActiveUser({ fullName: "ListOwner", email: uniqueEmail("listowner"), password: "ListPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req("/admin/systems", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.systems.find((s: any) => s.id === system.id));
  });

  await t.step("list: positive — returns primary/backup owner ids for the edit form", async () => {
    const owner = await createActiveUser({ fullName: "OwnerPop", email: uniqueEmail("ownerpop"), password: "OwnerPop!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req("/admin/systems", { headers: authHeaders(adminSession) });
    const data = await res.json();
    const row = data.systems.find((s: any) => s.id === system.id);
    assertExists(row);
    assertEquals(row.primaryOwnerId, owner.id);
    // No backup owner configured on a freshly wired system.
    assertEquals(row.backupOwnerId, null);
  });

  // addendum-109 (rev 2026-08-05 — NO GATES): systems hang off the Default
  // organisation THROUGH their agency cluster (systems has NO org column —
  // derivation keeps the data honest). The setup attaches the cluster with
  // raw SQL; the assertion joins systems.agency_cluster_id →
  // clusters.organization_id. RED by design until the addendum-110+
  // implementation lands (raw setup SQL fails today — no organizations
  // table / organization_id column yet).
  await t.step("organisation dimension: system's organisation derives through its agency cluster", async () => {
    const org = await ensureDefaultOrganization(adminId);
    const owner = await createActiveUser({ fullName: "OrgDerivOwner", email: uniqueEmail("orgderiv"), password: "OrgDeriv!2026", affiliation: "agency" });
    const { system, agencyCluster } = await createWiredSystem(adminId, owner);
    await query(`UPDATE clusters SET organization_id = $1 WHERE id = $2`, [org.id, agencyCluster.id]);

    const rows = await query<{ organization_id: string }>(
      `SELECT c.organization_id AS organization_id
       FROM systems s JOIN clusters c ON c.id = s.agency_cluster_id
       WHERE s.id = $1`,
      [system.id],
    );
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.organization_id, org.id);
  });

  await t.step("create: negative — empty workflow_definition rejected (Constraint #12 requires >=1 step)", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "OwnerEmpty", email: uniqueEmail("ownerempty"), password: "OwnerPass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("System"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [],
      },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: positive — minimal valid system (single agency step) created, owner written to junction table", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "Owner1", email: uniqueEmail("owner1"), password: "OwnerPass!2026", affiliation: "agency" });

    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("System"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }],
      },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.system.vendorClusterIds, [vendorCluster.id]);

    const ownerRow = await systemOwners.findBySystemAndKind(data.system.id, "primary");
    assertExists(ownerRow);
    assertEquals(ownerRow!.userId, owner.id);
  });

  // V2 groundwork placeholder field — see
  // addendum-011-aws-assume-role-placeholder.md. Free-text note, no ARN-format
  // validation beyond the 500-char length guard shared with `description`.
  await t.step("create/update: positive — aws_role_arn_note persists and can be cleared via update", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "OwnerAws", email: uniqueEmail("ownerarn"), password: "OwnerPass!2026", affiliation: "agency" });

    const createRes = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("System"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }],
        awsRoleArnNote: "arn:aws:iam::123456789012:role/example",
      },
    });
    assertEquals(createRes.status, 201);
    const created = await createRes.json();
    assertEquals(created.system.awsRoleArnNote, "arn:aws:iam::123456789012:role/example");

    const updateRes = await req(`/admin/systems/${created.system.id}`, {
      method: "PUT", headers: authHeaders(adminSession),
      body: { awsRoleArnNote: "" },
    });
    assertEquals(updateRes.status, 200);
    const updated = await updateRes.json();
    assertEquals(updated.system.awsRoleArnNote, null);
  });

  await t.step("create: negative — aws_role_arn_note over 500 characters rejected", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "OwnerAwsLong", email: uniqueEmail("ownerarnlong"), password: "OwnerPass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("System"),
        primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }],
        awsRoleArnNote: "x".repeat(501),
      },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — missing required fields", async () => {
    const res = await req("/admin/systems", { method: "POST", headers: authHeaders(adminSession), body: { name: "X" } });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — no vendor clusters", async () => {
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O2", email: uniqueEmail("o2"), password: "O2Pass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id, vendorClusterIds: [], agencyClusterId: agencyCluster.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — agency_cluster_id references a vendor-type cluster", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const owner = await createActiveUser({ fullName: "O3", email: uniqueEmail("o3"), password: "O3Pass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: vendorCluster.id },
    });
    assertEquals(res.status, 400);
  });

  // addendum-042-relationship-fk-validation-audit.md: clusters.get() still
  // returns invalidated rows (audit/history views need them), so
  // validateClusterRefs must reject an invalidated cluster explicitly, not
  // just a nonexistent one — for both the vendor cluster set and the agency
  // cluster. Each body below supplies an otherwise-fully-valid
  // workflow_definition (a single submitter step on a still-active cluster)
  // so the ONLY thing that can produce a 400 is the invalidated-cluster
  // check itself, not an incidental workflow-shape rejection.
  await t.step("create: negative — invalidated vendor cluster rejected", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    await clusters.invalidate(vendorCluster.id);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "InvVendorOwner", email: uniqueEmail("invvendorowner"), password: "InvVendorPass!2026", affiliation: "agency" });
    const workflowDefinition = [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }];
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id, workflowDefinition },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — invalidated agency cluster rejected", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    await clusters.invalidate(agencyCluster.id);
    const owner = await createActiveUser({ fullName: "InvAgencyOwner", email: uniqueEmail("invagencyowner"), password: "InvAgencyPass!2026", affiliation: "agency" });
    const workflowDefinition = [{ ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null }];
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id, workflowDefinition },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: negative — adding an invalidated vendor cluster rejected", async () => {
    const owner = await createActiveUser({ fullName: "InvUpdOwner", email: uniqueEmail("invupdowner"), password: "InvUpdPass!2026", affiliation: "agency" });
    const { system, vendorCluster } = await createWiredSystem(adminId, owner);
    const otherVendorCluster = await createCluster("vendor", adminId);
    await clusters.invalidate(otherVendorCluster.id);
    // Keep the existing (already-workflow-referenced) vendorCluster in the
    // set and only ADD the invalidated one — workflow_definition itself is
    // untouched, so the only possible rejection is the cluster check.
    const res = await req(`/admin/systems/${system.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { vendorClusterIds: [vendorCluster.id, otherVendorCluster.id] },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — invalid short code format", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O4", email: uniqueEmail("o4"), password: "O4Pass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: "lower-case!", name: uniqueName("S"), primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — duplicate short code", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O5", email: uniqueEmail("o5"), password: "O5Pass!2026", affiliation: "agency" });
    const code = uniqueShortCode();
    const workflowDefinition = [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }];
    const first = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: code, name: uniqueName("S"), primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id, workflowDefinition },
    });
    assertEquals(first.status, 201);
    const second = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: code, name: uniqueName("S2"), primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id, workflowDefinition },
    });
    assertEquals(second.status, 400);
  });

  await t.step("create: negative — primary owner must be agency-affiliated", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const wrongOwner = await createActiveUser({ fullName: "WrongOwner", email: uniqueEmail("wrongowner"), password: "WrongPass!2026", affiliation: "vendor" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: { shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: wrongOwner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — backup owner same as primary", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O6", email: uniqueEmail("o6"), password: "O6Pass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id, backupOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
      },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — workflow step references unmapped cluster (map-first, Constraint #12)", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O7", email: uniqueEmail("o7"), password: "O7Pass!2026", affiliation: "agency" });
    const otherAgency = await createCluster("agency", adminId);
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [{ ordinal: 1, clusterId: otherAgency.id, level: 1, stepKind: "hierarchical", notes: null }],
      },
    });
    assertEquals(res.status, 400);
  });

  // AP-09 inverted: per addendum-027-submitter-as-workflow-step-one.md,
  // Constraint #17's old blanket "vendor L1 can never approve" rule was
  // fully dropped, replaced by the narrower self-approval guard below. A
  // vendor L1 team CAN now be an approval step, as long as it isn't THIS
  // system's own Step 1 (submitter) team.
  await t.step("create: positive — vendor L1 as a LATER approval step is now allowed (Constraint #17 relaxed by addendum-025)", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const otherVendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O8", email: uniqueEmail("o8"), password: "O8Pass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id, otherVendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          // A DIFFERENT vendor cluster's L1 team — not the submitter's own
          // team/level, so the self-approval guard doesn't apply.
          { ordinal: 2, clusterId: otherVendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(res.status, 201);
  });

  await t.step("create: negative — self-approval guard rejects the submitter's own team/level reappearing as a later step", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O8b", email: uniqueEmail("o8b"), password: "O8bPass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          // Same (cluster_id, level) as the submitter step — rejected.
          { ordinal: 2, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — missing submitter step (workflow can never be empty)", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O8c", email: uniqueEmail("o8c"), password: "O8cPass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [],
      },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: positive — agency cluster as Step 1 (submitter can be any cluster type, addendum-025)", async () => {
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O8d", email: uniqueEmail("o8d"), password: "O8dPass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: vendorCluster.id, level: 2, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(res.status, 201);
  });

  await t.step("create: positive — valid multi-step workflow with pre-mapped clusters", async () => {
    // Map-first pattern here works because on CREATE (systemId=null), checkWorkflow
    // treats the system's own vendor_cluster_ids/agency_cluster_id as implicitly mapped.
    const vendorCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "O9", email: uniqueEmail("o9"), password: "O9Pass!2026", affiliation: "agency" });
    const res = await req("/admin/systems", {
      method: "POST", headers: authHeaders(adminSession),
      body: {
        shortCode: uniqueShortCode(), name: uniqueName("S"), primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [
          { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
          { ordinal: 2, clusterId: vendorCluster.id, level: 2, stepKind: "hierarchical", notes: null },
          { ordinal: 3, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
        ],
      },
    });
    assertEquals(res.status, 201);
  });

  await t.step("update: positive — rename system", async () => {
    const owner = await createActiveUser({ fullName: "UpdOwner", email: uniqueEmail("updowner"), password: "UpdPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const newName = uniqueName("Renamed System");
    const res = await req(`/admin/systems/${system.id}`, { method: "PUT", headers: authHeaders(adminSession), body: { name: newName } });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.system.name, newName);
  });

  await t.step("update: negative — system not found", async () => {
    const res = await req(`/admin/systems/00000000-0000-0000-0000-000000000999`, { method: "PUT", headers: authHeaders(adminSession), body: { name: "X" } });
    assertEquals(res.status, 404);
  });

  await t.step("update: positive — reassign primary owner", async () => {
    const owner = await createActiveUser({ fullName: "OldOwner", email: uniqueEmail("oldowner"), password: "OldPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const newOwner = await createActiveUser({ fullName: "NewOwner", email: uniqueEmail("newowner"), password: "NewPass!2026", affiliation: "agency" });

    const res = await req(`/admin/systems/${system.id}`, { method: "PUT", headers: authHeaders(adminSession), body: { primaryOwnerId: newOwner.id } });
    assertEquals(res.status, 200);
    const primaryRow = await systemOwners.findBySystemAndKind(system.id, "primary");
    assertEquals(primaryRow!.userId, newOwner.id);
  });
}
