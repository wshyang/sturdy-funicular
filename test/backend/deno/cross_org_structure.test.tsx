// Cross-org structure-plane contracts (addendum-137 §4 S-class — phase-2
// cut 2: clusters + teams + team members). Companion to cross_org.test.tsx
// (which pins the identity/config planes + semantics): THIS suite pins the
// derived-org structure planes:
//   * list filtering (ClusterRead/TeamRead: scoped admins see only clusters/
//     teams anchored to their granted orgs — addendum-206 (D2) retired the
//     org-less category entirely: every cluster is anchored NOT NULL, so
//     "hidden" now means "anchored to an org outside the grant");
//   * create payload scoping (ClusterCreate requires anchoring INTO granted
//     orgs; TeamCreate keys on the parent cluster's org);
//   * 404-disguise on out-of-scope update/delete/member-roster ids;
//   * org-move payload guard (ClusterUpdate moving INTO a foreign org 400s).
// The 403-vs-404 distinction from cross_org.test.tsx holds: capability
// absent everywhere → 403; held scoped but object out of scope → 404.
import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import {
  addOrgMembership,
  createActiveUser,
  createAsset,
  createOrganization,
  createSingleStepAgencySystem,
  loginAs,
  repointOwnerOrgEdge,
  uniqueEmail,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import type { User } from "../../../server/types.tsx";

const runSuffix = crypto.randomUUID().slice(0, 8);

async function grantScoped(userId: string, roleKey: string, organizationId: string, grantedBy: string): Promise<void> {
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
    password: "XStruct!2026",
    affiliation: "agency",
  });
  const login = await loginAs(user.email, "XStruct!2026");
  if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
  return { user, session: login.session };
}

defineTest(
  "cross-org structure contracts (phase-2 cut 2): clusters/teams scoped lists, keyed mutations, roster disguise",
  async ({ ctx, t }) => {
    let orgA = "";
    let orgB = "";
    let clusterA = "";
    let clusterB = "";
    let teamA = "";
    let scopedSession = "";

    await t.step("setup: orgs A/B + clusters in A/B + a team in A; scoped org_structure_admin in A", async () => {
      orgA = (await createOrganization({ name: `XS Org A ${runSuffix}`, shortCode: "XSA", createdBy: ctx.admin.id })).id;
      orgB = (await createOrganization({ name: `XS Org B ${runSuffix}`, shortCode: "XSB", createdBy: ctx.admin.id })).id;

      const mkCluster = async (name: string, orgId: string | null) => {
        const res = await ctx.actors.admin.post("/admin/clusters", {
          body: { name, type: "agency", organizationId: orgId },
        });
        assertEquals(res.status, 201);
        return res.json.cluster.id as string;
      };
      clusterA = await mkCluster(`XS Cluster A ${runSuffix}`, orgA);
      clusterB = await mkCluster(`XS Cluster B ${runSuffix}`, orgB);

      const teamRes = await ctx.actors.admin.post("/admin/teams", {
        body: { name: `XS Team A ${runSuffix}`, clusterId: clusterA, level: 1 },
      });
      assertEquals(teamRes.status, 201);
      teamA = teamRes.json.team.id as string;

      const admin = await agencyUserWithSession("XS Structure Admin");
      await addOrgMembership({ organizationId: orgA, userId: admin.user.id, addedBy: ctx.admin.id });
      await grantScoped(admin.user.id, "org_structure_admin", orgA, ctx.admin.id);
      scopedSession = admin.session;
    });

    await t.step("list filtering: /admin/clusters shows only Org-A clusters (org-less hidden); /admin/teams follows THROUGH", async () => {
      const cls = await ctx.actors.as(scopedSession).get("/admin/clusters");
      assertEquals(cls.status, 200);
      const clusterIds = (cls.json.clusters as { id: string }[]).map((c) => c.id);
      assert(clusterIds.includes(clusterA));
      assert(!clusterIds.includes(clusterB), "foreign cluster must not leak into the scoped list");

      const teamsRes = await ctx.actors.as(scopedSession).get("/admin/teams");
      assertEquals(teamsRes.status, 200);
      const teamIds = (teamsRes.json.teams as { id: string; organizationId: string | null }[]).map((tm) => tm.id);
      assert(teamIds.includes(teamA), "the Org-A team's row reaches the scoped list with its derived org");
    });

    await t.step("create payload scoping: cluster must anchor INTO the granted orgs (null and foreign both 400)", async () => {
      const nullAnchor = await ctx.actors.as(scopedSession).post("/admin/clusters", {
        body: { name: `XS No-Anchor ${runSuffix}`, type: "agency", organizationId: null },
      });
      assertEquals(nullAnchor.status, 400, "org-less creation is 400 for everyone — addendum-206 (D2): no NULL-org objects");

      const foreign = await ctx.actors.as(scopedSession).post("/admin/clusters", {
        body: { name: `XS Foreign ${runSuffix}`, type: "agency", organizationId: orgB },
      });
      assertEquals(foreign.status, 400);

      const own = await ctx.actors.as(scopedSession).post("/admin/clusters", {
        body: { name: `XS Own ${runSuffix}`, type: "agency", organizationId: orgA },
      });
      assertEquals(own.status, 201);
    });

    await t.step("keyed mutations: foreign cluster update/delete 404-disguise; own org-move INTO foreign 400", async () => {
      const updForeign = await ctx.actors.as(scopedSession).put(`/admin/clusters/${clusterB}`, {
        body: { name: `XS Renamed B ${runSuffix}` },
      });
      assertEquals(updForeign.status, 404);

      const delForeign = await ctx.actors.as(scopedSession).del(`/admin/clusters/${clusterB}`);
      assertEquals(delForeign.status, 404);

      const move = await ctx.actors.as(scopedSession).put(`/admin/clusters/${clusterA}`, {
        body: { organizationId: orgB },
      });
      assertEquals(move.status, 400, "moving a cluster INTO a foreign org is a caller fault, never silent");

      const rename = await ctx.actors.as(scopedSession).put(`/admin/clusters/${clusterA}`, {
        body: { name: `XS Cluster A2 ${runSuffix}` },
      });
      assertEquals(rename.status, 200, "in-scope rename succeeds");
    });

    await t.step("team create keys on the parent cluster's org; roster membership routes disguise the same way", async () => {
      const teamUnderB = await ctx.actors.as(scopedSession).post("/admin/teams", {
        body: { name: `XS Team Under B ${runSuffix}`, clusterId: clusterB, level: 1 },
      });
      assertEquals(teamUnderB.status, 400, "creating a team under a foreign cluster is out of scope");

      const teamUnderA = await ctx.actors.as(scopedSession).post("/admin/teams", {
        body: { name: `XS Team Under A ${runSuffix}`, clusterId: clusterA, level: 2 },
      });
      assertEquals(teamUnderA.status, 201);

      const memberId = (await createActiveUser({ email: uniqueEmail("xs-member"), password: "XMember!2026", affiliation: "agency" })).id;
      // A RANDOM/absent roster id and a foreign-organised roster id disguise
      // identically for the scoped admin: 404, never 403.
      const addToAbsent = await ctx.actors.as(scopedSession).post(`/teams/${crypto.randomUUID()}/members`, {
        body: { userId: memberId },
      });
      assertEquals(addToAbsent.status, 404);

      const addToA = await ctx.actors.as(scopedSession).post(`/teams/${teamA}/members`, {
        body: { userId: memberId },
      });
      assertEquals(addToA.status, 201, "in-scope roster management succeeds");

      const roster = await ctx.actors.as(scopedSession).get(`/teams/${teamA}/members`);
      assertEquals(roster.status, 200);
      assert((roster.json.members as { user?: { id: string }; userId?: string }[]).some((m) => (m.user?.id ?? m.userId) === memberId));
      assertExists(roster.json.members);
    });

    await t.step("D2 roster plane (addendum-206 §5.4): a scoped admin manages its ANCHORED VENDOR team's roster, foreign vendor roster disguises 404", async () => {
      // Org-anchored VENDOR cluster (the post-084 canonical shape — Certis in
      // the demo seed) lands in the scoped admin's org: member management of
      // anchored vendor teams rides canManageTeamMembers + scoped reach, with
      // no affiliation-keyed blocker.
      const vendorClusterRes = await ctx.actors.admin.post("/admin/clusters", {
        body: { name: `XS Vendor Anch ${runSuffix}`, type: "vendor", organizationId: orgA },
      });
      assertEquals(vendorClusterRes.status, 201);
      const vendorClusterA = vendorClusterRes.json.cluster.id as string;
      const vendorTeamRes = await ctx.actors.admin.post("/admin/teams", {
        body: { name: `XS Vendor Team A ${runSuffix}`, clusterId: vendorClusterA, level: 1 },
      });
      assertEquals(vendorTeamRes.status, 201);
      const vendorTeamA = vendorTeamRes.json.team.id as string;

      const vendorUser = await createActiveUser({ email: uniqueEmail("xs-vendor"), password: "XVendor!2026", affiliation: "vendor" });
      const addToAnchored = await ctx.actors.as(scopedSession).post(`/teams/${vendorTeamA}/members`, {
        body: { userId: vendorUser.id },
      });
      assertEquals(addToAnchored.status, 201, "scoped admin rosters its anchored vendor team — never affiliation-blocked");

      const anchoredRoster = await ctx.actors.as(scopedSession).get(`/teams/${vendorTeamA}/members`);
      assertEquals(anchoredRoster.status, 200);

      const vendorClusterB = await ctx.actors.admin.post("/admin/clusters", {
        body: { name: `XS Vendor Foreign ${runSuffix}`, type: "vendor", organizationId: orgB },
      });
      const vendorTeamBRes = await ctx.actors.admin.post("/admin/teams", {
        body: { name: `XS Vendor Team B ${runSuffix}`, clusterId: vendorClusterB.json.cluster.id as string, level: 1 },
      });
      const foreign = await ctx.actors.as(scopedSession).post(`/teams/${vendorTeamBRes.json.team.id}/members`, {
        body: { userId: vendorUser.id },
      });
      assertEquals(foreign.status, 404, "another org's anchored vendor roster disguises exactly like the absent id");
    });
  },
);

// Cut-3 suites pin (systems + assets planes) — appended as a second defineTest
// so cut-2's fixture stays untouched.

defineTest(
  "cross-org structure contracts (phase-2 cut 3, addendum-206): systems/assets keyed THROUGH the system's owner org edge",
  async ({ ctx, t }) => {
    let orgA = "";
    let orgB = "";
    let systemA = "";
    let assetA = "";
    let foreignSystemId = "";
    let scopedSession = "";

    await t.step("setup: systems in A/B via owner-edge re-pointing; scoped systems_assets_admin in A", async () => {
      orgA = (await createOrganization({ name: `X3 Org A ${runSuffix}`, shortCode: "X3A", createdBy: ctx.admin.id })).id;
      orgB = (await createOrganization({ name: `X3 Org B ${runSuffix}`, shortCode: "X3B", createdBy: ctx.admin.id })).id;

      const ownerA = await createActiveUser({ email: uniqueEmail("x3-owner-a"), password: "X3Owner!2026", affiliation: "agency" });
      const builtA = await createSingleStepAgencySystem(ctx.admin.id, ownerA);
      systemA = builtA.system.id;
      // addendum-206: a system's org is its owner EDGE — re-point the edge
      // (the cluster anchor stays where the fixture put it; for SYSTEM
      // scoping only the edge matters now).
      await repointOwnerOrgEdge(systemA, orgA, ctx.admin.id);

      const ownerB = await createActiveUser({ email: uniqueEmail("x3-owner-b"), password: "X3Owner!2026", affiliation: "agency" });
      const builtB = await createSingleStepAgencySystem(ctx.admin.id, ownerB);
      foreignSystemId = builtB.system.id;
      await repointOwnerOrgEdge(foreignSystemId, orgB, ctx.admin.id);

      assetA = (await createAsset(systemA, { hostname: `x3-host-a-${runSuffix}` })).id;

      const admin = await agencyUserWithSession("X3 Systems Admin");
      await addOrgMembership({ organizationId: orgA, userId: admin.user.id, addedBy: ctx.admin.id });
      await grantScoped(admin.user.id, "systems_assets_admin", orgA, ctx.admin.id);
      // Pre-existing fixture gap (red on the pre-206 baseline too, unrelated
      // to 206): systems_assets_admin carries no UserRead, so the scoped
      // users-list step below 403'd on the shared-org read plane. Grants
      // compose — hand the same scoped plane the user_admin role as well.
      await grantScoped(admin.user.id, "user_admin", orgA, ctx.admin.id);
      scopedSession = admin.session;
    });

    await t.step("SystemRead list filters to systems anchored in the granted org", async () => {
      const res = await ctx.actors.as(scopedSession).get("/admin/systems");
      assertEquals(res.status, 200);
      const ids = (res.json.systems as { id: string }[]).map((s) => s.id);
      assert(ids.includes(systemA));
      assert(!ids.includes(foreignSystemId), "the foreign system must not leak into the scoped list");
    });

    await t.step("keyed mutations: foreign system update/delete/asset-update 404-disguise; own-org operations succeed", async () => {
      const updForeign = await ctx.actors.as(scopedSession).put(`/admin/systems/${foreignSystemId}`, {
        body: { description: "tampered" },
      });
      assertEquals(updForeign.status, 404);

      const delForeign = await ctx.actors.as(scopedSession).del(`/admin/systems/${foreignSystemId}`);
      assertEquals(delForeign.status, 404);

      const foreignAssets = await ctx.actors.as(scopedSession).get(`/admin/systems/${foreignSystemId}/assets`);
      assertEquals(foreignAssets.status, 404);

      const own = await ctx.actors.as(scopedSession).put(`/admin/systems/${systemA}`, {
        body: { description: `X3 updated ${runSuffix}` },
      });
      assertEquals(own.status, 200);

      const ownAssets = await ctx.actors.as(scopedSession).get(`/admin/systems/${systemA}/assets`);
      assertEquals(ownAssets.status, 200);
      const assetUpdate = await ctx.actors.as(scopedSession).put(`/admin/systems/${systemA}/assets/${assetA}`, {
        body: { description: "in-scope asset note" },
      });
      assertEquals(assetUpdate.status, 200);
    });

    await t.step("asset key THROUGH: update/delete on a foreign assetId 404 even when the systemId path looks own (the asset wins)", async () => {
      // Path claims systemA but the asset belongs to the foreign system — the
      // resolvers go through the ASSET's real system, never the path.
      const { createAsset: mk } = await import("./helpers.tsx");
      const foreignAsset = await mk(foreignSystemId, { hostname: `x3-host-b-${runSuffix}` });
      const cross = await ctx.actors.as(scopedSession).put(`/admin/systems/${systemA}/assets/${foreignAsset.id}`, {
        body: { description: "cross-keyed tamper" },
      });
      assertEquals(cross.status, 404, "IDOR substitution: the asset's actual org decides, not the path");
      const del = await ctx.actors.as(scopedSession).del(`/admin/systems/${systemA}/assets/${foreignAsset.id}`);
      assertEquals(del.status, 404);
    });

    await t.step("users list: scoped UserRead sees only shared-org users; pending users never list", async () => {
      const res = await ctx.actors.as(scopedSession).get("/admin/users");
      assertEquals(res.status, 200);
      const rows = res.json.users as { id: string; status: string }[];
      assert(!rows.some((u) => u.status === "pending_approval"), "pending signups are global-plane for scoped lists");
      // Every listed user shares Org A (scoped admin's only org).
      const memberships = await query<{ organization_id: string }>(
        `SELECT organization_id FROM organization_memberships WHERE user_id = ANY($1) AND expires_after IS NULL`,
        [rows.map((u) => u.id)],
      );
      const orgSet = new Set(memberships.map((m) => m.organization_id));
      assert([...orgSet].every((o) => o === orgA), "every listed user is a co-member of the scoped org");
    });
  },
);
