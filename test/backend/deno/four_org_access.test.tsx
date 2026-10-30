// Four-organisation access matrix — addendum-207 R6 companion.
//
// R6 re-keyed system_owner_pa_mappings.system_owner_id from users(id) to
// system_owners(id) so a single user who owns systems across MULTIPLE orgs can
// carry a different PA team per ownership row. That behaviour (plus the
// org-scoped admin model from addendum-137/206) was under-tested: the owner-PA
// route had no scoped-guard test and no test exercised a multi-org owner.
//
// This suite builds FOUR orgs and a cast whose memberships/assignments are
// deliberately crossed (multi-org owner, scoped-admin-≠-member, multi-org
// scoped admin, owner-who-is-also-admin, served vendor, stray-membership
// vendor, grantless member), then runs positive/negative object-access
// assertions against the admin plane (systems, mappings, owner-PA, owners,
// orgs, org members) and the runtime plane (/my-systems, submit, request
// detail, PA notification routing).
//
// Topology + permutation register: addendum-207 §3.3 (docs/specs/addenda/).
import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import {
  addMember,
  addOrgMembership,
  authHeaders,
  createActiveUser,
  createAsset,
  createCluster,
  createOrganization,
  createTeam,
  createWiredSystem,
  latestSentNotification,
  loginAs,
  repointOwnerOrgEdge,
  req,
  sentNotificationEmailSnapshots,
  uniqueEmail,
  uniqueName,
  uniqueShortCode,
} from "./helpers.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";
import { generateId, systemOwnerPAMappings, systemOwners } from "../../../server/db.tsx";
import type { Team, User } from "../../../server/types.tsx";

const PASSWORD = "FourOrg!2026";

async function agencyUser(label: string): Promise<{ user: User; session: string }> {
  const user = await createActiveUser({
    fullName: label,
    email: uniqueEmail(label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    password: PASSWORD,
    affiliation: "agency",
  });
  const login = await loginAs(user.email, PASSWORD);
  if ("error" in login) throw new Error(`login failed for ${label}: ${login.error}`);
  return { user, session: login.session };
}

async function vendorUser(label: string): Promise<{ user: User; session: string }> {
  const user = await createActiveUser({
    fullName: label,
    email: uniqueEmail(label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    password: PASSWORD,
    affiliation: "vendor",
  });
  const login = await loginAs(user.email, PASSWORD);
  if ("error" in login) throw new Error(`login failed for ${label}: ${login.error}`);
  return { user, session: login.session };
}

defineTest(
  "four-org access matrix (addendum-207 R6): multi-org ownership, owner-PA scoping, D1 vendor gate, scoped-admin object access",
  async ({ ctx, t }) => {
    const adminId = ctx.admin.id;
    const adminLogin = await loginAs(ctx.admin.email, "HarnessAdmin!2026");
    if ("error" in adminLogin) throw new Error(`admin login failed: ${adminLogin.error}`);
    const adminSession = adminLogin.session;

    // ── State hoisted across steps ─────────────────────────────────────────
    let orgA = "", orgB = "", orgC = "", orgD = "";
    let alice = {} as { user: User; session: string };
    let bob = {} as { user: User; session: string };
    let carol = {} as { user: User; session: string };
    let dave = {} as { user: User; session: string };
    let erin = {} as { user: User; session: string };
    let frank = {} as { user: User; session: string };
    let grace = {} as { user: User; session: string };
    let ivan = {} as { user: User; session: string };
    let judy = {} as { user: User; session: string };
    // Flow actors for the PA-notification isolation test (S_B, org B).
    let mason = {} as { user: User; session: string };
    let nora = {} as { user: User; session: string };
    let oscar = {} as { user: User; session: string };
    let paAmember = {} as { user: User; session: string };
    let paBmember = {} as { user: User; session: string };

    let sA: Awaited<ReturnType<typeof createWiredSystem>>;
    let sA2: Awaited<ReturnType<typeof createWiredSystem>>;
    let sB: Awaited<ReturnType<typeof createWiredSystem>>;
    let sC: Awaited<ReturnType<typeof createWiredSystem>>;
    let sD: Awaited<ReturnType<typeof createWiredSystem>>;

    let paATeam = {} as Team, paBTeam = {} as Team, paCTeam = {} as Team;
    let sBOscarBackupRowId = "";

    const wire = async (owner: User, orgId: string) => {
      const built = await createWiredSystem(adminId, owner);
      await repointOwnerOrgEdge(built.system.id, orgId, adminId);
      return built;
    };

    const submission = async (systemId: string) => {
      const asset = await createAsset(systemId, { hostname: `f4-${systemId.slice(0, 6)}` });
      return {
        systemId,
        justification: "Four-org access matrix request.",
        srNumber: "SR-F4-1",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id, hostnameDescription: "f4 host" }],
      };
    };

    await t.step("setup: four orgs + crossed cast + five org-anchored systems", async () => {
      orgA = (await createOrganization({ name: uniqueName("F4 Org A"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgB = (await createOrganization({ name: uniqueName("F4 Org B"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgC = (await createOrganization({ name: uniqueName("F4 Org C"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgD = (await createOrganization({ name: uniqueName("F4 Org D"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      assert(new Set([orgA, orgB, orgC, orgD]).size === 4, "four distinct orgs");

      alice = await agencyUser("f4 alice");
      bob = await agencyUser("f4 bob");
      carol = await agencyUser("f4 carol");
      dave = await vendorUser("f4 dave");
      erin = await vendorUser("f4 erin");
      frank = await agencyUser("f4 frank");
      grace = await agencyUser("f4 grace");
      ivan = await agencyUser("f4 ivan");
      judy = await agencyUser("f4 judy");
      mason = await vendorUser("f4 mason");
      nora = await vendorUser("f4 nora");
      oscar = await agencyUser("f4 oscar");
      paAmember = await agencyUser("f4 pa-a-member");
      paBmember = await agencyUser("f4 pa-b-member");

      // Systems (owner → org):
      sA = await wire(alice.user, orgA);            // alice owns S_A  (A)
      sA2 = await wire(bob.user, orgA);             // bob owns S_A2   (A)
      sB = await wire(bob.user, orgB);              // bob owns S_B    (B)
      sC = await wire(ivan.user, orgC);             // ivan owns S_C   (C)
      sD = await wire(judy.user, orgD);             // judy owns S_D   (D)

      // Extra ownership: oscar is BACKUP owner of S_B (org B) — a second
      // ownership row on S_B so scoped create/delete has a fresh target.
      const backupRow = {
        id: generateId(),
        systemId: sB.system.id,
        userId: oscar.user.id,
        kind: "backup" as const,
        createdBy: adminId,
        createdAt: new Date().toISOString(),
        expiresAfter: null,
      };
      await systemOwners.create(backupRow);
      sBOscarBackupRowId = backupRow.id;

      // Org memberships (service for vendors; crossed for everyone else).
      const join = (orgId: string, userId: string) => addOrgMembership({ organizationId: orgId, userId, addedBy: adminId });
      await join(orgA, alice.user.id);
      await join(orgA, bob.user.id); await join(orgB, bob.user.id);
      await join(orgB, carol.user.id); await join(orgC, carol.user.id);
      await join(orgC, dave.user.id);                    // dave SERVES C
      await join(orgD, erin.user.id); await join(orgA, erin.user.id); // serves D + stray A
      await join(orgD, frank.user.id);
      await join(orgA, grace.user.id); await join(orgC, grace.user.id);
      await join(orgC, ivan.user.id);
      await join(orgD, judy.user.id);
      await join(orgB, mason.user.id);                   // mason SERVES B
      await join(orgB, nora.user.id);                    // nora SERVES B
      await join(orgB, oscar.user.id);
      await join(orgA, paAmember.user.id);
      await join(orgB, paBmember.user.id);

      // Scoped admin grants (org_structure_admin for org surfaces +
      // systems_assets_admin for system/mapping/owner/owner-PA surfaces).
      const grant = (userId: string, orgId: string) => Promise.all([
        grantAdminRole(userId, "org_structure_admin", adminId, "four-org test", orgId),
        grantAdminRole(userId, "systems_assets_admin", adminId, "four-org test", orgId),
      ]);
      await grant(alice.user.id, orgA);
      await grant(carol.user.id, orgB);
      await grant(grace.user.id, orgA);
      await grant(grace.user.id, orgC);

      // Vendor team memberships (workflow submitter slots) — D1 gate input.
      // dave is a submitter-team member of BOTH S_A and S_C, but serves only C
      // — so the S_A submit 403 is a pure D1 service-gate rejection, not a
      // team-membership miss.
      await addMember(sC.vendorL1, dave.user, adminId);
      await addMember(sA.vendorL1, dave.user, adminId);
      await addMember(sD.vendorL1, erin.user, adminId);
      await addMember(sB.vendorL1, mason.user, adminId);
      await addMember(sB.vendorL2, nora.user, adminId);
      await addMember(sB.agencyL1, oscar.user, adminId);

      // PA teams (one per org).
      paATeam = await createTeam(await createCluster("pa", adminId, "F4 PA-A Cluster", orgA), 1, adminId, "F4 PA-A Team");
      paBTeam = await createTeam(await createCluster("pa", adminId, "F4 PA-B Cluster", orgB), 1, adminId, "F4 PA-B Team");
      paCTeam = await createTeam(await createCluster("pa", adminId, "F4 PA-C Cluster", orgC), 1, adminId, "F4 PA-C Team");
      await addMember(paATeam, paAmember.user, adminId);
      await addMember(paBTeam, paBmember.user, adminId);
    });

    // ── R6: multi-org owner ────────────────────────────────────────────────
    await t.step("R6: bob holds two live ownership rows across two orgs", async () => {
      const rows = await systemOwners.findByUser(bob.user.id);
      assertEquals(rows.length, 2, "bob owns S_A2 (A) and S_B (B)");
      const systemIds = rows.map((r) => r.systemId).sort();
      assertEquals(systemIds, [sA2.system.id, sB.system.id].sort());
    });

    await t.step("R6: two owner-PA mappings coexist — one per ownership row (global admin)", async () => {
      const mapA2 = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(adminSession),
        body: { systemOwnerId: sA2.primaryOwner.id, paTeamId: paATeam.id },
      });
      assertEquals(mapA2.status, 201, "S_A2 ownership → PA_A");

      const mapB = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(adminSession),
        body: { systemOwnerId: sB.primaryOwner.id, paTeamId: paBTeam.id },
      });
      assertEquals(mapB.status, 201, "S_B ownership → PA_B — a second mapping for the SAME user");

      const mapC = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(adminSession),
        body: { systemOwnerId: sC.primaryOwner.id, paTeamId: paCTeam.id },
      });
      assertEquals(mapC.status, 201, "S_C ownership → PA_C (used later for out-of-scope delete)");

      assertExists(await systemOwnerPAMappings.findBySystemOwner(sA2.primaryOwner.id), "S_A2 mapping live");
      assertExists(await systemOwnerPAMappings.findBySystemOwner(sB.primaryOwner.id), "S_B mapping live");
      assertExists(await systemOwnerPAMappings.findBySystemOwner(sC.primaryOwner.id), "S_C mapping live");
    });

    await t.step("runtime: multi-org owner sees both systems in /my-systems", async () => {
      const res = await req("/my-systems", { headers: authHeaders(bob.session) });
      assertEquals(res.status, 200);
      const ids = (await res.json()).systems.map((s: { id: string }) => s.id).sort();
      assertEquals(ids, [sA2.system.id, sB.system.id].sort());
    });

    await t.step("runtime: single-org owner sees only their own system", async () => {
      const aliceRes = await req("/my-systems", { headers: authHeaders(alice.session) });
      assertEquals(aliceRes.status, 200);
      assertEquals((await aliceRes.json()).systems.map((s: { id: string }) => s.id), [sA.system.id]);

      const ivanRes = await req("/my-systems", { headers: authHeaders(ivan.session) });
      assertEquals(ivanRes.status, 200);
      assertEquals((await ivanRes.json()).systems.map((s: { id: string }) => s.id), [sC.system.id]);
    });

    // ── Scoped admin: system plane ─────────────────────────────────────────
    await t.step("admin: scoped SystemRead filters the system list to granted orgs", async () => {
      const carolRes = await req("/admin/systems", { headers: authHeaders(carol.session) });
      assertEquals(carolRes.status, 200);
      assertEquals((await carolRes.json()).systems.map((s: { id: string }) => s.id), [sB.system.id], "carol (→B) sees only S_B");

      const graceRes = await req("/admin/systems", { headers: authHeaders(grace.session) });
      assertEquals(graceRes.status, 200);
      assertEquals(
        (await graceRes.json()).systems.map((s: { id: string }) => s.id).sort(),
        [sA.system.id, sA2.system.id, sC.system.id].sort(),
        "grace (→A+C) sees S_A, S_A2, S_C",
      );
    });

    await t.step("admin: grantless member gets 403 on the system list (membership ≠ grant)", async () => {
      const res = await req("/admin/systems", { headers: authHeaders(frank.session) });
      assertEquals(res.status, 403);
    });

    await t.step("admin: scoped SystemMappingRead — in-scope 200, out-of-scope 404-disguise", async () => {
      const inScope = await req(`/admin/systems/${sB.system.id}/mappings`, { headers: authHeaders(carol.session) });
      assertEquals(inScope.status, 200, "carol reads S_B (org B) mappings");

      const outScope = await req(`/admin/systems/${sC.system.id}/mappings`, { headers: authHeaders(carol.session) });
      assertEquals(outScope.status, 404, "carol cannot read S_C (org C) mappings");
      assertEquals((await outScope.json()).error, "System not found.", "existence disguise — no oracle");
    });

    // ── Scoped admin: owner-PA mapping (the R6 route) ──────────────────────
    await t.step("admin: scoped OwnerPAMappingManage keys on the ownership row's org", async () => {
      // carol (→B): fresh backup ownership on S_B is in scope.
      const createIn = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(carol.session),
        body: { systemOwnerId: sBOscarBackupRowId, paTeamId: paBTeam.id },
      });
      assertEquals(createIn.status, 201, "carol maps S_B's backup ownership (in scope)");
      const created = await createIn.json();

      // carol (→B): S_C's ownership is out of scope → 404-disguise, never 403.
      const createOut = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(carol.session),
        body: { systemOwnerId: sC.primaryOwner.id, paTeamId: paCTeam.id },
      });
      assertEquals(createOut.status, 404, "carol cannot map S_C's ownership (out of scope)");
      assertEquals((await createOut.json()).error, "System not found.", "existence disguise — no oracle");

      // grace (→A+C): S_A in scope, S_B out of scope.
      const graceIn = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(grace.session),
        body: { systemOwnerId: sA.primaryOwner.id, paTeamId: paATeam.id },
      });
      assertEquals(graceIn.status, 201, "grace maps S_A's ownership (in scope A)");
      const graceOut = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(grace.session),
        body: { systemOwnerId: sB.primaryOwner.id, paTeamId: paBTeam.id },
      });
      assertEquals(graceOut.status, 404, "grace cannot map S_B's ownership (out of scope)");

      // Delete: in-scope 200, out-of-scope 404.
      const deleteIn = await req(`/admin/mappings/owner-pa/${created.mapping.id}`, {
        method: "DELETE", headers: authHeaders(carol.session),
      });
      assertEquals(deleteIn.status, 200, "carol deletes the mapping she created (in scope)");

      const sCMapping = await systemOwnerPAMappings.findBySystemOwner(sC.primaryOwner.id);
      assertExists(sCMapping, "S_C mapping still live for the out-of-scope delete");
      const deleteOut = await req(`/admin/mappings/owner-pa/${sCMapping!.id}`, {
        method: "DELETE", headers: authHeaders(carol.session),
      });
      assertEquals(deleteOut.status, 404, "carol cannot delete S_C's mapping (out of scope)");
      assertEquals((await deleteOut.json()).error, "Mapping not found.", "existence disguise — no oracle");
    });

    // ── Scoped admin: owners plane ─────────────────────────────────────────
    await t.step("admin: scoped SystemOwnerManage — add owner in scope, 404 out of scope", async () => {
      // frank is an ACTIVE AGENCY user (owners must be agency-affiliated), not
      // an owner anywhere, so the in-scope add to S_B succeeds.
      const inScope = await req(`/admin/systems/${sB.system.id}/owners`, {
        method: "POST", headers: authHeaders(carol.session),
        body: { userId: frank.user.id, kind: "backup" },
      });
      assertEquals(inScope.status, 201, "carol adds a backup owner to S_B (in scope)");

      // Out-of-scope: the scope check fires before user validation, so the 404
      // disguise precedes any affiliation/duplicate check.
      const outScope = await req(`/admin/systems/${sC.system.id}/owners`, {
        method: "POST", headers: authHeaders(carol.session),
        body: { userId: frank.user.id, kind: "backup" },
      });
      assertEquals(outScope.status, 404, "carol cannot add an owner to S_C (out of scope)");
      assertEquals((await outScope.json()).error, "System not found.", "existence disguise — no oracle");
    });

    // ── Scoped admin: org plane ────────────────────────────────────────────
    await t.step("admin: scoped OrgRead filters the org list", async () => {
      const carolRes = await req("/admin/organizations", { headers: authHeaders(carol.session) });
      assertEquals(carolRes.status, 200);
      assertEquals((await carolRes.json()).organizations.map((o: { id: string }) => o.id), [orgB], "carol (→B) sees only B");

      const graceRes = await req("/admin/organizations", { headers: authHeaders(grace.session) });
      assertEquals(graceRes.status, 200);
      assertEquals(
        (await graceRes.json()).organizations.map((o: { id: string }) => o.id).sort(),
        [orgA, orgC].sort(),
        "grace (→A+C) sees A and C",
      );
    });

    await t.step("admin: scoped OrgRead on members — in-scope 200, out-of-scope 404, grantless 403", async () => {
      const inScope = await req(`/admin/organizations/${orgB}/members`, { headers: authHeaders(carol.session) });
      assertEquals(inScope.status, 200);
      const memberIds = (await inScope.json()).members.map((m: { userId: string }) => m.userId);
      assert(memberIds.includes(bob.user.id), "bob (member of B) listed");

      const outScope = await req(`/admin/organizations/${orgC}/members`, { headers: authHeaders(carol.session) });
      assertEquals(outScope.status, 404, "carol cannot read C's members");
      assertEquals((await outScope.json()).error, "Organisation not found.", "existence disguise — no oracle");

      const grantless = await req(`/admin/organizations/${orgD}/members`, { headers: authHeaders(frank.session) });
      assertEquals(grantless.status, 403, "frank is a MEMBER of D but has no OrgRead grant — membership ≠ grant");
    });

    // ── D1 vendor service gate ─────────────────────────────────────────────
    await t.step("D1: served vendor sees and submits only their served org's system", async () => {
      const daveSystems = await req("/my-systems", { headers: authHeaders(dave.session) });
      assertEquals(daveSystems.status, 200);
      assertEquals((await daveSystems.json()).systems.map((s: { id: string }) => s.id), [sC.system.id], "dave (serves C) sees only S_C");

      const submitC = await req("/requests", {
        method: "POST", headers: authHeaders(dave.session), body: await submission(sC.system.id),
      });
      assertEquals(submitC.status, 201, "dave submits to S_C (served)");

      const submitA = await req("/requests", {
        method: "POST", headers: authHeaders(dave.session), body: await submission(sA.system.id),
      });
      assertEquals(submitA.status, 403, "dave cannot submit to S_A (unserved)");
      assertEquals((await submitA.json()).error, "You are not authorized to submit requests for this system.");
    });

    await t.step("D1: a stray org membership grants a vendor nothing", async () => {
      const erinSystems = await req("/my-systems", { headers: authHeaders(erin.session) });
      assertEquals(erinSystems.status, 200);
      assertEquals(
        (await erinSystems.json()).systems.map((s: { id: string }) => s.id),
        [sD.system.id],
        "erin (serves D, stray member of A) sees only S_D — the stray A membership grants no extra systems",
      );

      // erin's A membership alone is not enough to submit to S_A: she is not on
      // S_A's vendor-L1 team (and carries no A admin grant either). Membership
      // ≠ team assignment, and membership ≠ admin grant.
      const submitA = await req("/requests", {
        method: "POST", headers: authHeaders(erin.session), body: await submission(sA.system.id),
      });
      assertEquals(submitA.status, 403, "erin cannot submit to S_A despite a stray A membership");

      const adminPlane = await req("/admin/systems", { headers: authHeaders(erin.session) });
      assertEquals(adminPlane.status, 403, "erin's memberships confer no admin-plane reach");
    });

    // ── Request visibility (runtime) ───────────────────────────────────────
    await t.step("runtime: request detail — submitter reads; owner is blocked pre-owner (Constraint #11); unrelated 404-disguise", async () => {
      const submitRes = await req("/requests", {
        method: "POST", headers: authHeaders(dave.session), body: await submission(sC.system.id),
      });
      assertEquals(submitRes.status, 201);
      const requestId = (await submitRes.json()).request.id;

      const submitterRead = await req(`/requests/${requestId}`, { headers: authHeaders(dave.session) });
      assertEquals(submitterRead.status, 200, "submitter reads their own request");

      // Constraint #11: owners never see a pre-owner request, even via direct
      // GET — the request is still 'submitted' (step phase), so the owner is
      // blocked with the same 404-disguise as a stranger.
      const ownerRead = await req(`/requests/${requestId}`, { headers: authHeaders(ivan.session) });
      assertEquals(ownerRead.status, 404, "the system's owner cannot read a pre-owner request (Constraint #11)");

      const unrelatedRead = await req(`/requests/${requestId}`, { headers: authHeaders(frank.session) });
      assertEquals(unrelatedRead.status, 404, "unrelated user cannot read the request");
      assertEquals((await unrelatedRead.json()).error, "Request not found.", "existence disguise — no oracle");
    });

    await t.step("SECURITY: a scoped admin canNOT read an out-of-scope request", async () => {
      const submitRes = await req("/requests", {
        method: "POST", headers: authHeaders(dave.session), body: await submission(sC.system.id),
      });
      const requestId = (await submitRes.json()).request.id;

      // Was pinned as accepted over-reach in addendum-207 §3.3 ("Open for
      // owner review"): getCapabilitySnapshot called isAdminUser(), which
      // counts org-SCOPED grants, so any scoped admin got
      // visibleSystemIds = VISIBLE_ALL — a system-wide read bypass on the
      // whole runtime plane. carol is scoped to org B only; this request is
      // owned by org C, so she must get the same 404 disguise as a stranger.
      // Fixed by switching the snapshot to hasGlobalAdminGrant (addendum-211).
      const carolRead = await req(`/requests/${requestId}`, { headers: authHeaders(carol.session) });
      assertEquals(carolRead.status, 404, "a B-scoped admin must not read a C-owned request");
      assertEquals((await carolRead.json()).error, "Request not found.", "existence disguise — no oracle");
    });

    // ── R6: PA notification routes per ownership (org partition) ───────────
    await t.step("R6: approving S_B notifies PA_B only — never PA_A", async () => {
      const submitRes = await req("/requests", {
        method: "POST", headers: authHeaders(mason.session), body: await submission(sB.system.id),
      });
      assertEquals(submitRes.status, 201, "mason (serves B) submits to S_B");
      const requestId = (await submitRes.json()).request.id;

      const step2 = await req(`/requests/${requestId}/step-decision`, {
        method: "POST", headers: authHeaders(nora.session), body: { decision: "approve" },
      });
      assertEquals(step2.status, 200, "vendor L2 approves");
      const step3 = await req(`/requests/${requestId}/step-decision`, {
        method: "POST", headers: authHeaders(oscar.session), body: { decision: "approve" },
      });
      assertEquals(step3.status, 200, "agency L1 approves");

      const ownerDecision = await req(`/requests/${requestId}/owner-decision`, {
        method: "POST", headers: authHeaders(bob.session), body: { decision: "approve" },
      });
      assertEquals(ownerDecision.status, 200, "bob (S_B primary owner) approves");

      const paEmail = await latestSentNotification("request.owner_approved_pa_team");
      assertExists(paEmail, "a PA-team notification fired");
      assertEquals(
        sentNotificationEmailSnapshots(paEmail),
        [paBmember.user.email],
        "S_B's approval notifies the org-B PA team member, not the org-A PA member",
      );
    });
  },
);
