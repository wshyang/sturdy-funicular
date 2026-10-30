// addendum-206 §5.1/§5.5 — the system-org-edges admin plane.
// Pins (status + byte-exact message, house doctrine):
//   create:  explicit owner/participant edges land; scoped SystemCreate with
//            any org override -> 400 "Organisation selection is outside your
//            granted organisations." (derived-edge scoped create stays 201);
//   read:    scoped SystemRead in the OWNER org -> 200; out-of-scope -> 404
//            "System not found.";
//   writes:  scoped (non-global) SystemUpdate -> 403
//            "User lacks required admin capability: SystemUpdate";
//   owner:   same-org -> 400 "This organisation is already the system's
//            owner."; unknown org -> 400 "Organisation not found."; D6 -> 400
//            "Remove all delegates before transferring this system's
//            organisation."; happy path flips the edge, absorbs the target's
//            participant edge, audits system_org_edge.owner_transferred;
//   participants: dup owner/dup edge 400s, unknown org 400, unknown edge 404
//            "Organisation is not a participant of this system.", orphan
//            removal -> 400 "Removing this organisation would leave delegates
//            without a serving organisation; remove those delegates first.",
//            audits participant_added/removed;
//   org delete (§5.5): live edges -> 400 "Cannot delete organisation linked
//            to systems. Transfer or remove the system organisation links
//            first."; edge-free org deletes clean.
import { assertEquals, assert } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import {
  req, authHeaders, createActiveUser, loginAs, uniqueEmail, uniqueShortCode, uniqueName,
  createCluster, createWiredSystem, createOrganization, addOrgMembership, fixtureFallbackOrgId,
} from "./helpers.tsx";
import { systemDelegates } from "../../../server/db.tsx";
import { query } from "../../../server/pg.tsx";
import type { User } from "../../../server/types.tsx";

// Scoped grant fixture (cross_org precedent: raw INSERT into
// user_admin_role_grants).
async function grantScopedAdminRole(userId: string, roleKey: string, organizationId: string, grantedBy: string): Promise<void> {
  await query(
    `INSERT INTO user_admin_role_grants (user_id, role_key, granted_by, organization_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, roleKey, grantedBy, organizationId],
  );
}

async function agencyUserWithSession(label: string): Promise<{ user: User; session: string }> {
  const user = await createActiveUser({
    fullName: label,
    email: uniqueEmail(label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    password: "OrgEdges!2026",
    affiliation: "agency",
  });
  const login = await loginAs(user.email, "OrgEdges!2026");
  if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
  return { user, session: login.session };
}

async function latestAuditDetail(action: string): Promise<Record<string, unknown> | null> {
  const rows = await query<{ details: Record<string, unknown> }>(
    `SELECT details FROM audit_log WHERE action = $1 ORDER BY created_at DESC LIMIT 1`, [action],
  );
  return rows[0]?.details ?? null;
}

defineTest(
  "system org edges (addendum-206 §5): admin plane + org delete guard",
  async ({ ctx, t }) => {
    const adminId = ctx.admin.id;
    const adminLogin = await loginAs(ctx.admin.email, "HarnessAdmin!2026");
    if ("error" in adminLogin) throw new Error(`admin login failed: ${adminLogin.error}`);
    const adminSession = adminLogin.session;

    const owner = await createActiveUser({
      fullName: "Edge Owner", email: uniqueEmail("edge-owner"), password: "OrgeOwner!2026", affiliation: "agency",
    });
    const ownerLogin = await loginAs(owner.email, "OrgeOwner!2026");
    if ("error" in ownerLogin) throw new Error(`owner login failed: ${ownerLogin.error}`);
    const ownerSession = ownerLogin.session;

    let orgA = "";
    let orgB = "";
    let orgC = "";
    let orgCName = "";

    await t.step("setup: three orgs (A keeps a scoped admin; B and C ride the create payload)", async () => {
      orgA = (await createOrganization({ name: uniqueName("Edges Org A"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgB = (await createOrganization({ name: uniqueName("Edges Org B"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgCName = uniqueName("Edges Org C");
      orgC = (await createOrganization({ name: orgCName, shortCode: uniqueShortCode(), createdBy: adminId })).id;
      assert(orgA !== orgB && orgB !== orgC, "three distinct orgs");
    });

    let createdSystemId = "";

    await t.step("create: a global admin's explicit owner + participant edges land", async () => {
      const vendorCluster = await createCluster("vendor", adminId);
      const agencyCluster = await createCluster("agency", adminId);
      const res = await req("/admin/systems", {
        method: "POST", headers: authHeaders(adminSession),
        body: {
          shortCode: uniqueShortCode(), name: uniqueName("Edge Sys"),
          primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
          workflowDefinition: [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }],
          ownerOrganizationId: orgB,
          participantOrganizationIds: [orgC, orgC], // dup collapses
        },
      });
      assertEquals(res.status, 201);
      const created = await res.json();
      createdSystemId = created.system.id;

      const read = await req(`/admin/systems/${createdSystemId}/org-edges`, { headers: authHeaders(adminSession) });
      assertEquals(read.status, 200);
      const { edges } = await read.json();
      assertEquals(edges.length, 2, "exactly owner + participant");
      const ownerEdge = edges.find((e: { role: string }) => e.role === "owner");
      const participantEdge = edges.find((e: { role: string }) => e.role === "participant");
      assertEquals(ownerEdge.organizationId, orgB, "explicit owner org won over the cluster default");
      assertEquals(participantEdge.organizationId, orgC);
      assertEquals(typeof ownerEdge.organizationName, "string", "resolved names ride the read");
      assertEquals(participantEdge.organizationName, orgCName, "read resolves the org name");
    });

    await t.step("create: participant == requested owner rejected 400", async () => {
      const vendorCluster = await createCluster("vendor", adminId);
      const agencyCluster = await createCluster("agency", adminId);
      const res = await req("/admin/systems", {
        method: "POST", headers: authHeaders(adminSession),
        body: {
          shortCode: uniqueShortCode(), name: uniqueName("Edge Sys Dup"),
          primaryOwnerId: owner.id, vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
          workflowDefinition: [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }],
          ownerOrganizationId: orgB,
          participantOrganizationIds: [orgB],
        },
      });
      assertEquals(res.status, 400);
      assertEquals((await res.json()).error, "This organisation is already the system's owner.");
    });

    await t.step("create: a scoped SystemCreate holder cannot pass org overrides (400), derived-edge create stays 201", async () => {
      const scoped = await agencyUserWithSession("Edges Scoped Create");
      await grantScopedAdminRole(scoped.user.id, "systems_assets_admin", orgA, adminId);

      const vendorCluster = await createCluster("vendor", adminId, undefined, orgA);
      const agencyCluster = await createCluster("agency", adminId, undefined, orgA);
      const baseBody = {
        shortCode: uniqueShortCode(), name: uniqueName("Edge Scoped"),
        primaryOwnerId: owner.id,
        vendorClusterIds: [vendorCluster.id], agencyClusterId: agencyCluster.id,
        workflowDefinition: [{ ordinal: 1, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null }],
      };

      const denied = await req("/admin/systems", {
        method: "POST", headers: authHeaders(scoped.session),
        body: { ...baseBody, ownerOrganizationId: orgA },
      });
      assertEquals(denied.status, 400);
      assertEquals((await denied.json()).error, "Organisation selection is outside your granted organisations.");

      const allowed = await req("/admin/systems", {
        method: "POST", headers: authHeaders(scoped.session),
        body: { ...baseBody, shortCode: uniqueShortCode(), name: uniqueName("Edge Scoped Allow") },
      });
      assertEquals(allowed.status, 201, "no org fields = the derived owner edge in scope");
      const { system } = await allowed.json();
      const read = await req(`/admin/systems/${system.id}/org-edges`, { headers: authHeaders(adminSession) });
      const { edges } = await read.json();
      assertEquals(edges.length, 1);
      assertEquals(edges[0].role, "owner");
      assertEquals(edges[0].organizationId, orgA, "owner edge derived from the agency cluster's org");
    });

    await t.step("read: a scoped SystemRead holder of the OWNER org sees the edges; out-of-scope 404s", async () => {
      const inScope = await agencyUserWithSession("Edges In Scope");
      await grantScopedAdminRole(inScope.user.id, "systems_assets_admin", orgB, adminId);
      const ok = await req(`/admin/systems/${createdSystemId}/org-edges`, { headers: authHeaders(inScope.session) });
      assertEquals(ok.status, 200);

      const outScope = await agencyUserWithSession("Edges Out Scope");
      await grantScopedAdminRole(outScope.user.id, "systems_assets_admin", orgA, adminId);
      const hidden = await req(`/admin/systems/${createdSystemId}/org-edges`, { headers: authHeaders(outScope.session) });
      assertEquals(hidden.status, 404);
      assertEquals((await hidden.json()).error, "System not found.");
    });

    await t.step("transfer: same-org 400 / unknown org 400 / unknown system 404 / scoped write 403", async () => {
      const same = await req(`/admin/systems/${createdSystemId}/org-edges/owner`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgB },
      });
      assertEquals(same.status, 400);
      assertEquals((await same.json()).error, "This organisation is already the system's owner.");

      const unknownOrg = await req(`/admin/systems/${createdSystemId}/org-edges/owner`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: crypto.randomUUID() },
      });
      assertEquals(unknownOrg.status, 400);
      assertEquals((await unknownOrg.json()).error, "Organisation not found.");

      const unknownSystem = await req(`/admin/systems/${crypto.randomUUID()}/org-edges/owner`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgA },
      });
      assertEquals(unknownSystem.status, 404);
      assertEquals((await unknownSystem.json()).error, "System not found.");

      const scoped = await agencyUserWithSession("Edges Scoped Write");
      await grantScopedAdminRole(scoped.user.id, "systems_assets_admin", orgB, adminId);
      const forbidden = await req(`/admin/systems/${createdSystemId}/org-edges/owner`, {
        method: "POST", headers: authHeaders(scoped.session), body: { organizationId: orgA },
      });
      assertEquals(forbidden.status, 403);
      assertEquals((await forbidden.json()).error, "User lacks required admin capability: SystemUpdate");
    });

    await t.step("transfer: D6 hard-blocks while a delegate lives; pinned message; transfer+absorb lands after removal, audited", async () => {
      const { system } = await createWiredSystem(adminId, owner);
      const fallbackOrg = await fixtureFallbackOrgId(adminId);
      const candidate = (await agencyUserWithSession("Edges Delegate A")).user;
      await addOrgMembership({ organizationId: fallbackOrg, userId: candidate.id, addedBy: adminId });
      const added = await req(`/owner/systems/${system.id}/delegates`, {
        method: "POST", headers: authHeaders(ownerSession), body: { delegateUserId: candidate.id },
      });
      assertEquals(added.status, 201);

      const blocked = await req(`/admin/systems/${system.id}/org-edges/owner`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgB },
      });
      assertEquals(blocked.status, 400);
      assertEquals((await blocked.json()).error, "Remove all delegates before transferring this system's organisation.");

      const row = await systemDelegates.findBySystemAndUser(system.id, candidate.id);
      assert(row, "delegate row exists");
      const removed = await req(`/owner/systems/${system.id}/delegates/${row!.id}`, {
        method: "DELETE", headers: authHeaders(ownerSession),
      });
      assertEquals(removed.status, 200);

      // orgC rides as a participant first — transferring ownership TO it must
      // absorb that edge (an org is never owner and participant at once).
      const part = await req(`/admin/systems/${system.id}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgC },
      });
      assertEquals(part.status, 201);

      const transferred = await req(`/admin/systems/${system.id}/org-edges/owner`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgC },
      });
      assertEquals(transferred.status, 200);
      const { edges } = await transferred.json();
      assertEquals(edges.length, 1, "old owner expired, participant absorbed");
      assertEquals(edges[0].role, "owner");
      assertEquals(edges[0].organizationId, orgC);

      const detail = await latestAuditDetail("system_org_edge.owner_transferred");
      assert(detail, "transfer audited");
      assertEquals(detail!.systemId, system.id);
      assertEquals(detail!.toOrganizationId, orgC);
      assertEquals(detail!.fromOrganizationId, fallbackOrg);
    });

    await t.step("participants: add guards 400, unknown 404s, happy add audited", async () => {
      const { system } = await createWiredSystem(adminId, owner);
      const fallbackOrg = await fixtureFallbackOrgId(adminId);

      const dupOwner = await req(`/admin/systems/${system.id}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: fallbackOrg },
      });
      assertEquals(dupOwner.status, 400);
      assertEquals((await dupOwner.json()).error, "This organisation is already the system's owner.");

      const unknownOrg = await req(`/admin/systems/${system.id}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: crypto.randomUUID() },
      });
      assertEquals(unknownOrg.status, 400);
      assertEquals((await unknownOrg.json()).error, "Organisation not found.");

      const added = await req(`/admin/systems/${system.id}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgA },
      });
      assertEquals(added.status, 201);
      const addedDetail = await latestAuditDetail("system_org_edge.participant_added");
      assert(addedDetail, "participant add audited");
      assertEquals(addedDetail!.systemId, system.id);
      assertEquals(addedDetail!.organizationId, orgA);

      const dupEdge = await req(`/admin/systems/${system.id}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgA },
      });
      assertEquals(dupEdge.status, 400);
      assertEquals((await dupEdge.json()).error, "This organisation is already linked to this system.");

      const unknownSystem = await req(`/admin/systems/${crypto.randomUUID()}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgA },
      });
      assertEquals(unknownSystem.status, 404);
    });

    await t.step("participants: remove guards — missing edge 404, orphan-delegate 400 (pinned), non-orphan 200 audited", async () => {
      const { system } = await createWiredSystem(adminId, owner);
      const fallbackOrg = await fixtureFallbackOrgId(adminId);

      const missing = await req(`/admin/systems/${system.id}/org-edges/participants/${orgC}`, {
        method: "DELETE", headers: authHeaders(adminSession),
      });
      assertEquals(missing.status, 404);
      assertEquals((await missing.json()).error, "Organisation is not a participant of this system.");

      const added = await req(`/admin/systems/${system.id}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgC },
      });
      assertEquals(added.status, 201);

      // Delegate serving ONLY the participant org — removal must not strand.
      const candidate = (await agencyUserWithSession("Edges Delegate B")).user;
      await addOrgMembership({ organizationId: orgC, userId: candidate.id, addedBy: adminId });
      const delegated = await req(`/owner/systems/${system.id}/delegates`, {
        method: "POST", headers: authHeaders(ownerSession), body: { delegateUserId: candidate.id },
      });
      assertEquals(delegated.status, 201);

      const orphan = await req(`/admin/systems/${system.id}/org-edges/participants/${orgC}`, {
        method: "DELETE", headers: authHeaders(adminSession),
      });
      assertEquals(orphan.status, 400);
      assertEquals((await orphan.json()).error,
        "Removing this organisation would leave delegates without a serving organisation; remove those delegates first.");

      // A live membership in a REMAINING linked org frees the removal.
      await addOrgMembership({ organizationId: fallbackOrg, userId: candidate.id, addedBy: adminId });
      const freed = await req(`/admin/systems/${system.id}/org-edges/participants/${orgC}`, {
        method: "DELETE", headers: authHeaders(adminSession),
      });
      assertEquals(freed.status, 200);
      const removedDetail = await latestAuditDetail("system_org_edge.participant_removed");
      assert(removedDetail, "participant removal audited");
      assertEquals(removedDetail!.systemId, system.id);
      assertEquals(removedDetail!.organizationId, orgC);
    });

    await t.step("org delete guard (§5.5): live edges block with the pinned message; edge-free org deletes clean", async () => {
      const { system } = await createWiredSystem(adminId, owner);
      // A pristine org — nothing attached but the edge under test (earlier
      // arms correctly block on members/clusters first).
      const orgD = (await createOrganization({ name: uniqueName("Edges Org D"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      const added = await req(`/admin/systems/${system.id}/org-edges/participants`, {
        method: "POST", headers: authHeaders(adminSession), body: { organizationId: orgD },
      });
      assertEquals(added.status, 201);

      const blocked = await req(`/admin/organizations/${orgD}`, { method: "DELETE", headers: authHeaders(adminSession) });
      assertEquals(blocked.status, 400);
      assertEquals((await blocked.json()).error,
        "Cannot delete organisation linked to systems. Transfer or remove the system organisation links first.");

      const freed = await req(`/admin/systems/${system.id}/org-edges/participants/${orgD}`, {
        method: "DELETE", headers: authHeaders(adminSession),
      });
      assertEquals(freed.status, 200);

      const clean = await req(`/admin/organizations/${orgD}`, { method: "DELETE", headers: authHeaders(adminSession) });
      assertEquals(clean.status, 200);
      assertEquals((await clean.json()).message, "Organisation deleted successfully.");
    });
  },
);
