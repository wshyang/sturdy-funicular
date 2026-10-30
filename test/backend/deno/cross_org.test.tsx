// Cross-organisation isolation & org-scoped capability contracts — the
// addendum-137 test plan, staged per owner direction 2026-08-06
// ("implement tests that were previously gated": the phase-2/3 deferrals in
// test/org-dimension.ts + addendum-140's G6). Two deliberate classes:
//
//  CLASS A — RUNTIME GUARDRAILS (GREEN today; must stay green through phases
//  2–4). Addendum-137 §2 is the load-bearing guardrail: organisations are an
//  ADMIN-PLANE and AUDIT-PLANE partition, NEVER a runtime workflow boundary.
//  canSubmit/canReview/step-decision stay org-blind FOR AGENCY affiliation
//  (addendum-206 D1 gates VENDOR callers to systems whose linked orgs they
//  serve); requests get no org
//  column, forever. Any future phase that breaks a Class-A pin is a DESIGN
//  ERROR, not a test to relax.
//
//  CLASS B — PHASE-2 CONTRACTS (RED BY DESIGN until phases 2–3 land). Owner
//  direction 2026-08-05 is NO GATING (the addendum-109 org_dimension
//  precedent): contract steps run live on every backend pass and FAIL while
//  `user_admin_role_grants.organization_id` is absent — each carries the
//  phase reference in its failure. The owner's two gating examples
//  (2026-08-06) map to:
//    * "users from another organisation cannot access api calls outside of
//      their org"        → B3 (IDOR 404-disguise), B4 (list filtering),
//                          B5 (scoped payload), B6 (identity-subset), B7
//                          (multi-org granularity) — the ADMIN plane only,
//                          per the Class-A guardrail;
//    * "users who have org scoped capabilities cannot change global
//      parameters / settings" → B2 (global-only-capability rejection).
import { assert, assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import {
  addMember,
  addOrgMembership,
  addServingMember,
  createActiveUser,
  createAsset,
  createOrganization,
  createSingleStepAgencySystem,
  createWiredSystem,
  loginAs,
  repointOwnerOrgEdge,
  uniqueEmail,
} from "./helpers.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";
import { query } from "../../../server/pg.tsx";
import type { User } from "../../../server/types.tsx";

const runSuffix = crypto.randomUUID().slice(0, 8);

// Raw-SQL scoped-grant fixture (the addendum-109 precedent: compiles against
// the pre-phase-2 server; fails at RUNTIME until the schema lands). NULL
// organization_id = global grant; phase 2 adds the column + uniqueness rework
// (NULLS NOT DISTINCT / coalesce — addendum-137 rev-3 §schema).
async function grantScopedAdminRole(
  userId: string,
  roleKey: string,
  organizationId: string,
  grantedBy: string,
): Promise<void> {
  await query(
    `INSERT INTO user_admin_role_grants (user_id, role_key, granted_by, organization_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, roleKey, grantedBy, organizationId],
  );
}

// Every contract step opens with this gate so a pre-phase-2 run fails LOUDLY
// with the ledger reference instead of a raw SQL "column does not exist".
let scopedGrantsSupported = false;
function phase2Gate() {
  if (!scopedGrantsSupported) {
    throw new Error(
      "PHASE-2 CONTRACT RED BY DESIGN (addendum-137 rev-3 §schema): " +
        "user_admin_role_grants.organization_id is absent — the scoped-grant schema has not landed yet.",
    );
  }
}

async function agencyUserWithSession(label: string): Promise<{ user: User; session: string }> {
  const user = await createActiveUser({
    fullName: label,
    email: uniqueEmail(label.toLowerCase().replace(/[^a-z0-9]+/g, "-")),
    password: "CrossOrg!2026",
    affiliation: "agency",
  });
  const login = await loginAs(user.email, "CrossOrg!2026");
  if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
  return { user, session: login.session };
}

// ────────────────────────────────────────────────────────────────────────────
// CLASS A — runtime guardrails (GREEN regression locks)
// ────────────────────────────────────────────────────────────────────────────
defineTest(
  "cross-org guardrails (GREEN forever): org-blind runtime workflow + membership≠grant posture",
  async ({ ctx, t }) => {
    let orgAgencyId = "";
    let orgVendorId = "";
    let requestId = "";
    let agencyApproverSession = "";
    let submitterSession = "";
    let built: Awaited<ReturnType<typeof createSingleStepAgencySystem>>;

    await t.step("setup: two orgs; vendor submitter SERVES Org A (206 service membership), approver+owner in Org A", async () => {
      const orgA = await createOrganization({ name: `XOrg Agency ${runSuffix}`, shortCode: "XA", createdBy: ctx.admin.id });
      const orgV = await createOrganization({ name: `XOrg Vendor ${runSuffix}`, shortCode: "XV", createdBy: ctx.admin.id });
      orgAgencyId = orgA.id;
      orgVendorId = orgV.id;

      const owner = await createActiveUser({ email: uniqueEmail("xorg-owner"), password: "XOwner!2026", affiliation: "agency" });
      built = await createSingleStepAgencySystem(ctx.admin.id, owner);
      // addendum-206: the junction owner edge is the system's org truth —
      // point it at Org A (the agency org this demo system belongs to).
      await repointOwnerOrgEdge(built.system.id, orgA.id, ctx.admin.id);

      const submitter = await createActiveUser({ email: uniqueEmail("xorg-sub"), password: "XSub!2026", affiliation: "vendor" });
      await addMember(built.vendorL1, submitter, ctx.admin.id);
      const approver = await createActiveUser({ email: uniqueEmail("xorg-appr"), password: "XAppr!2026", affiliation: "agency" });
      await addMember(built.agencyL1, approver, ctx.admin.id);

      // The vendor's unrelated-org membership (Org V) proves stray memberships
      // grant nothing; the Org-A membership is the D1 SERVICE relationship
      // (addendum-206 §3.3) without which a vendor cannot even submit now.
      await addOrgMembership({ organizationId: orgVendorId, userId: submitter.id, addedBy: ctx.admin.id });
      await addOrgMembership({ organizationId: orgAgencyId, userId: submitter.id, addedBy: ctx.admin.id });
      await addOrgMembership({ organizationId: orgAgencyId, userId: approver.id, addedBy: ctx.admin.id });
      await addOrgMembership({ organizationId: orgAgencyId, userId: owner.id, addedBy: ctx.admin.id });

      const subLogin = await loginAs(submitter.email, "XSub!2026");
      if ("error" in subLogin) throw new Error(`loginAs failed: ${subLogin.error}`);
      submitterSession = subLogin.session;
      const apprLogin = await loginAs(approver.email, "XAppr!2026");
      if ("error" in apprLogin) throw new Error(`loginAs failed: ${apprLogin.error}`);
      agencyApproverSession = apprLogin.session;

      const asset = await createAsset(built.system.id, { hostname: "xorg-host-01" });
      const submit = await ctx.actors.as(submitterSession).post("/requests", {
        body: {
          systemId: built.system.id,
          justification: "Cross-org guardrail: vendor in Org V submits to an agency reviewer in Org A.",
          srNumber: "SR-XORG-1",
          activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          credentialItems: [{ assetId: asset.id, hostnameDescription: "xorg host" }],
        },
      });
      assertEquals(submit.status, 201, "a SERVED vendor submits — D1 gates by service membership, not by blanket org-blindness (addendum-206 §4.2 amends 137 §2 for vendor affiliation)");
      requestId = submit.json.request.id;
      assertExists(requestId);
    });

    await t.step("guardrail: the Org-A agency reviewer READS and APPROVES the Org-V vendor's request (cross-org participation)", async () => {
      const read = await ctx.actors.as(agencyApproverSession).get(`/requests/${requestId}`);
      assertEquals(read.status, 200, "agency readers keep 137 §2 cross-org participation — the 206 D1 gate is vendor-scoped");
      const decide = await ctx.actors.as(agencyApproverSession).post(`/requests/${requestId}/step-decision`, {
        body: { decision: "approve" },
      });
      assertEquals(decide.status, 200, "agency step-decision stays cross-org (137 §2); only vendor callers are service-gated (206 D1)");
    });

    await t.step("guardrail: requests expose NO organizationId — the table never grows an org column", async () => {
      const read = await ctx.actors.as(agencyApproverSession).get(`/requests/${requestId}`);
      assertEquals(read.status, 200);
      assertEquals(
        read.json.request.organizationId,
        undefined,
        "requests get no org column, forever (addendum-137 §2 — counterparty inclusion is query-time, never dual-write)",
      );
    });

    await t.step("posture: membership ≠ grant — a grantless Org-A MEMBER still cannot read the org's member list (403)", async () => {
      const member = await createActiveUser({ email: uniqueEmail("xorg-plainmember"), password: "XMember!2026", affiliation: "agency" });
      await addOrgMembership({ organizationId: orgAgencyId, userId: member.id, addedBy: ctx.admin.id });
      const mLogin = await loginAs(member.email, "XMember!2026");
      if ("error" in mLogin) throw new Error(`loginAs failed: ${mLogin.error}`);
      const res = await ctx.actors.as(mLogin.session).get(`/admin/organizations/${orgAgencyId}/members`);
      assertEquals(res.status, 403, "org membership alone confers zero admin-plane reach (true today AND post-phase-3 for grantless members)");
    });

    await t.step("posture: the GLOBAL (unscoped) admin reads members across ALL orgs — today and post-phase-3", async () => {
      const a = await ctx.actors.admin.get(`/admin/organizations/${orgAgencyId}/members`);
      const v = await ctx.actors.admin.get(`/admin/organizations/${orgVendorId}/members`);
      assertEquals(a.status, 200);
      assertEquals(v.status, 200);
    });

    // ── addendum-206 D1 vendor service gate (owner direction "Yes (gate)") ──
    // Vendor affiliation alone no longer suffices for submit/review: the
    // system must be linked (owner ∪ participant edges, live) to an org the
    // vendor holds a live membership of. The blanket 137 §2 org-blindness
    // now survives ONLY for agency affiliation (see the guardrails above).
    await t.step("D1: a SERVED vendor's snapshot drop-lists include the system", async () => {
      const snap = await ctx.actors.as(submitterSession).get("/me/capability-snapshot");
      assertEquals(snap.status, 200);
      assert(
        snap.json.snapshot.submitterSystemIds.includes(built.system.id),
        "the serving vendor keeps the system on their submitter droplist",
      );
    });

    await t.step("D1: an UNSERVED vendor team-member is droplist-filtered and submit-403s (pinned message)", async () => {
      const unserved = await createActiveUser({ email: uniqueEmail("xorg-unserved"), password: "XUnserved!2026", affiliation: "vendor" });
      // Roster WITHOUT a service membership (plain addMember), plus an
      // unrelated-org membership to pin that memberships of unlinked orgs
      // never leak visibility.
      await addMember(built.vendorL1, unserved, ctx.admin.id);
      await addOrgMembership({ organizationId: orgVendorId, userId: unserved.id, addedBy: ctx.admin.id });
      const login = await loginAs(unserved.email, "XUnserved!2026");
      if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
      const snap = await ctx.actors.as(login.session).get("/me/capability-snapshot");
      assertEquals(snap.status, 200);
      assertEquals(
        snap.json.snapshot.submitterSystemIds.includes(built.system.id),
        false,
        "unserved vendor loses the droplist entry even while occupying the step-1 team",
      );
      const unservedAsset = await createAsset(built.system.id, { hostname: "xorg-unserved-host" });
      const submit = await ctx.actors.as(login.session).post("/requests", {
        body: {
          systemId: built.system.id,
          justification: "Unserved vendor must be blocked at the mutation boundary too.",
          srNumber: "SR-XORG-D1",
          activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          credentialItems: [{ assetId: unservedAsset.id, hostnameDescription: "unserved host" }],
        },
      });
      assertEquals(submit.status, 403);
      assertEquals(submit.json.error, "You are not authorized to submit requests for this system.");
    });

    await t.step("D1: step-decision boundary — unserved vendor reviewer 403s, served vendor reviewer approves", async () => {
      // A second wired topology WITH a vendor approval tier (vendorL2 at
      // ordinal 2). Its owner edge rides the shared fixture fallback org, so
      // addServingMember's cluster-org membership IS the service membership.
      const owner2 = await createActiveUser({ email: uniqueEmail("xorg-owner2"), password: "XOwner2!2026", affiliation: "agency" });
      const wired = await createWiredSystem(ctx.admin.id, owner2);
      const sub2 = await createActiveUser({ email: uniqueEmail("xorg-sub2"), password: "XSub2!2026", affiliation: "vendor" });
      await addServingMember(wired.vendorL1, sub2, ctx.admin.id);
      const servedL2 = await createActiveUser({ email: uniqueEmail("xorg-l2served"), password: "XL2Served!2026", affiliation: "vendor" });
      await addServingMember(wired.vendorL2, servedL2, ctx.admin.id);
      const unservedL2 = await createActiveUser({ email: uniqueEmail("xorg-l2unserved"), password: "XL2Unserved!2026", affiliation: "vendor" });
      await addMember(wired.vendorL2, unservedL2, ctx.admin.id);

      const sub2Login = await loginAs(sub2.email, "XSub2!2026");
      if ("error" in sub2Login) throw new Error(`loginAs failed: ${sub2Login.error}`);
      const asset = await createAsset(wired.system.id, { hostname: "xorg-d1-host" });
      const submit = await ctx.actors.as(sub2Login.session).post("/requests", {
        body: {
          systemId: wired.system.id,
          justification: "Served vendor submits; the L2 review step goes to vendor L2.",
          srNumber: "SR-XORG-D1-2",
          activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          credentialItems: [{ assetId: asset.id, hostnameDescription: "d1 host" }],
        },
      });
      assertEquals(submit.status, 201);
      const reqId = submit.json.request.id;

      // Unserved vendor L2: droplist-filtered AND 403 at the boundary itself
      // (defense-in-depth re-check — userServesSystemOrgs). Step stays pending.
      const unservedLogin = await loginAs(unservedL2.email, "XL2Unserved!2026");
      if ("error" in unservedLogin) throw new Error(`loginAs failed: ${unservedLogin.error}`);
      const snap = await ctx.actors.as(unservedLogin.session).get("/me/capability-snapshot");
      assertEquals(snap.json.snapshot.reviewerSystemIds.includes(wired.system.id), false);
      const denied = await ctx.actors.as(unservedLogin.session).post(`/requests/${reqId}/step-decision`, {
        body: { decision: "approve" },
      });
      assertEquals(denied.status, 403);
      assertEquals(denied.json.error, "You are not authorized to act on the current approval step.");
      const stillPending = await ctx.actors.admin.get(`/requests/${reqId}`);
      assertEquals(stillPending.json.request.currentStepOrdinal, 2, "the gated decision must not move the chain");

      // Served vendor L2: same team, WITH the service membership — passes.
      const servedLogin = await loginAs(servedL2.email, "XL2Served!2026");
      if ("error" in servedLogin) throw new Error(`loginAs failed: ${servedLogin.error}`);
      const allowed = await ctx.actors.as(servedLogin.session).post(`/requests/${reqId}/step-decision`, {
        body: { decision: "approve" },
      });
      assertEquals(allowed.status, 200, "the D1 gate admits the served vendor reviewer");
    });
  },
);

// ────────────────────────────────────────────────────────────────────────────
// CLASS B — phase-2 contracts (RED BY DESIGN until phases 2–3 land)
// ────────────────────────────────────────────────────────────────────────────
defineTest(
  "cross-org phase-2 contracts (RED BY DESIGN — addendum-137): scoped grants, isolation, global-only rejection",
  async ({ ctx, t }) => {
    let orgA = "";
    let orgB = "";
    let orgC = "";

    // config_audit_admin scoped to Org A (owner example #2).
    let scopedConfigId = "";
    let scopedConfigSession = "";
    // org_structure_admin scoped to Org A (IDOR / filtering / audit classes).
    let scopedStructId = "";
    let scopedStructSession = "";
    // user_admin scoped to Org A, later also Org C (payload / identity / multi-org).
    let scopedUserAdminId = "";
    let scopedUserAdminSession = "";

    await t.step("setup: three orgs + three scoped-admins-to-be (agency users, sessions verified)", async () => {
      orgA = (await createOrganization({ name: `P2 Org A ${runSuffix}`, shortCode: "PA", createdBy: ctx.admin.id })).id;
      orgB = (await createOrganization({ name: `P2 Org B ${runSuffix}`, shortCode: "PB", createdBy: ctx.admin.id })).id;
      orgC = (await createOrganization({ name: `P2 Org C ${runSuffix}`, shortCode: "PC", createdBy: ctx.admin.id })).id;

      const cfg = await agencyUserWithSession("P2 Config Admin");
      scopedConfigId = cfg.user.id;
      scopedConfigSession = cfg.session;
      await addOrgMembership({ organizationId: orgA, userId: scopedConfigId, addedBy: ctx.admin.id });

      const st = await agencyUserWithSession("P2 Structure Admin");
      scopedStructId = st.user.id;
      scopedStructSession = st.session;
      await addOrgMembership({ organizationId: orgA, userId: scopedStructId, addedBy: ctx.admin.id });

      const ua = await agencyUserWithSession("P2 User Admin");
      scopedUserAdminId = ua.user.id;
      scopedUserAdminSession = ua.session;
      await addOrgMembership({ organizationId: orgA, userId: scopedUserAdminId, addedBy: ctx.admin.id });
    });

    await t.step("CONTRACT(phase-2) schema: organization_id scoped insert lands + duplicate live scoped grant rejected", async () => {
      try {
        await grantScopedAdminRole(scopedUserAdminId, "user_admin", orgA, ctx.admin.id);
        scopedGrantsSupported = true;
      } catch {
        scopedGrantsSupported = false; // the assert below names the ledger item
      }
      assert(
        scopedGrantsSupported,
        "PHASE-2 CONTRACT RED BY DESIGN (addendum-137 rev-3 §schema): user_admin_role_grants.organization_id (NULL = global) must exist",
      );
      // Scoped uniqueness: a second LIVE grant of the same (user, role, org)
      // triple is rejected (the partial unique index extended NULLS NOT DISTINCT).
      await assertRejects(() => grantScopedAdminRole(scopedUserAdminId, "user_admin", orgA, ctx.admin.id));
    });

    // ── Owner example #2: org-scoped capabilities cannot change global
    //    parameters / settings (the G14 global-only class) ─────────────────
    await t.step("CONTRACT(phase-2): org-scoped config_audit_admin does NOT satisfy the global-only ConfigAppSettingsWrite", async () => {
      phase2Gate();
      await grantScopedAdminRole(scopedConfigId, "config_audit_admin", orgA, ctx.admin.id);

      const check = await ctx.actors.as(scopedConfigSession).get("/admin/capabilities/check?capability=ConfigAppSettingsWrite");
      assertEquals(check.status, 200);
      assertEquals(
        check.json.hasCapability,
        false,
        "G-class capabilities are global-only (addendum-137 G14) — an org-scoped grant must never satisfy them",
      );

      const write = await ctx.actors.as(scopedConfigSession).put("/admin/app-settings/max_login_attempts", {
        body: { value: "7" },
      });
      assertEquals(write.status, 403, "org-scoped capability cannot mutate a GLOBAL parameter");
    });

    await t.step("CONTRACT(phase-2): a GLOBAL (organization_id NULL) grant of the same role coexists and DOES satisfy it", async () => {
      phase2Gate();
      // NULL scope = global. Under today's (user_id, role_key) partial unique
      // index this SECOND row collides with the scoped one — the phase-2
      // uniqueness rework (NULLS NOT DISTINCT / coalesce) must let scopes
      // coexist per (user, role, scope).
      await grantAdminRole(scopedConfigId, "config_audit_admin", ctx.admin.id, "phase-2 global coexistence pin");

      const check = await ctx.actors.as(scopedConfigSession).get("/admin/capabilities/check?capability=ConfigAppSettingsWrite");
      assertEquals(check.json.hasCapability, true, "a global grant satisfies a G-class capability");

      const write = await ctx.actors.as(scopedConfigSession).put("/admin/app-settings/max_login_attempts", {
        body: { value: "7" },
      });
      assertEquals(write.status, 200);
    });

    // ── Owner example #1: another org's API objects are unreachable ────────
    await t.step("CONTRACT(phase-2) IDOR: Org-A-scoped OrgUpdate/org admin touches Org A but gets 404-DISGUISE (never 403) on Org B", async () => {
      phase2Gate();
      await grantScopedAdminRole(scopedStructId, "org_structure_admin", orgA, ctx.admin.id);

      const own = await ctx.actors.as(scopedStructSession).get(`/admin/organizations/${orgA}/members`);
      assertEquals(own.status, 200, "scoped grant reaches its own org's admin-plane objects");

      const foreign = await ctx.actors.as(scopedStructSession).get(`/admin/organizations/${orgB}/members`);
      assertEquals(
        foreign.status,
        404,
        "org-governed foreign ids are 404-not-403 — no existence disclosure (addendum-137 rev-3 §API-shape)",
      );
    });

    await t.step("CONTRACT(phase-2): list routes FILTER to the scoped orgs — 200-with-everything is a leak", async () => {
      phase2Gate();
      const list = await ctx.actors.as(scopedStructSession).get("/admin/organizations");
      assertEquals(list.status, 200);
      const ids = (list.json.organizations as { id: string }[]).map((o) => o.id);
      assert(ids.includes(orgA), "scoped list must contain the granted org");
      assert(!ids.includes(orgB), "scoped list must NOT leak Org B");
      assert(!ids.includes(orgC), "scoped list must NOT leak Org C");
    });

    await t.step("CONTRACT(phase-2): scoped UserApprove payload must be ⊆ the admin's orgs (out-of-scope org id → 400)", async () => {
      phase2Gate();
      const signup = await ctx.api.post("/auth/signup", {
        body: { fullName: "P2 Pending", email: uniqueEmail("p2-pending"), password: "ValidPass!2026" },
      });
      assertExists(signup.json?.userId);
      const pendingId = signup.json.userId as string;

      const outOfScope = await ctx.actors.as(scopedUserAdminSession).post(`/admin/users/${pendingId}/approve`, {
        body: { affiliation: "agency", organizationIds: [orgB] },
      });
      assertEquals(outOfScope.status, 400, "scoped approval payload outside the admin's orgs is a caller fault (400, never silent)");

      const inScope = await ctx.actors.as(scopedUserAdminSession).post(`/admin/users/${pendingId}/approve`, {
        body: { affiliation: "agency", organizationIds: [orgA] },
      });
      assertEquals(inScope.status, 200, "scoped approval with payload ⊆ granted orgs succeeds");
    });

    await t.step("CONTRACT(phase-2) identity-subset: scoped UserTombstone reaches only users whose memberships ⊆ the admin's orgs", async () => {
      phase2Gate();
      const inA = await createActiveUser({ email: uniqueEmail("p2-intomb"), password: "P2In!2026", affiliation: "agency" });
      await addOrgMembership({ organizationId: orgA, userId: inA.id, addedBy: ctx.admin.id });
      const inB = await createActiveUser({ email: uniqueEmail("p2-exttomb"), password: "P2Out!2026", affiliation: "vendor" });
      await addOrgMembership({ organizationId: orgB, userId: inB.id, addedBy: ctx.admin.id });

      const foreign = await ctx.actors.as(scopedUserAdminSession).post(`/admin/users/${inB.id}/tombstone`, {});
      assertEquals(
        foreign.status,
        404,
        "a user wholly outside the acting admin's orgs is existence-disguised — otherwise scoped tombstone is trivial cross-org escalation (addendum-137 identity-subset rule)",
      );

      const own = await ctx.actors.as(scopedUserAdminSession).post(`/admin/users/${inA.id}/tombstone`, {});
      assertEquals(own.status, 200, "memberships ⊆ granted orgs ⇒ the scoped identity action is legitimate");
    });

    await t.step("CONTRACT(phase-2) multi-org granularity: a second scoped grant (Org C) extends reach to A and C, never B", async () => {
      phase2Gate();
      await grantScopedAdminRole(scopedUserAdminId, "user_admin", orgC, ctx.admin.id);

      const pending = await ctx.api.post("/auth/signup", {
        body: { fullName: "P2 Pending C", email: uniqueEmail("p2-pending-c"), password: "ValidPass!2026" },
      });
      const res = await ctx.actors.as(scopedUserAdminSession).post(`/admin/users/${pending.json.userId}/approve`, {
        body: { affiliation: "agency", organizationIds: [orgC] },
      });
      assertEquals(res.status, 200, "the Org-C scoped grant extends the approvable payload set");

      const stillOut = await ctx.actors.as(scopedUserAdminSession).get(`/admin/organizations/${orgB}/members`);
      assertEquals(stillOut.status, 403, "user_admin has no OrgRead at all — Org B stays unreachable regardless of scope count");
    });

    await t.step("CONTRACT(phase-2): /me/capability-snapshot gains organizations[] + scopedGrants[] carrying organizationId", async () => {
      phase2Gate();
      const res = await ctx.actors.as(scopedStructSession).get("/me/capability-snapshot");
      assertEquals(res.status, 200);
      const orgs = res.json.snapshot.organizations as { id: string }[] | undefined;
      assertExists(orgs, "snapshot.organizations must exist (addendum-137 rev-3 §API-shape)");
      assert(orgs.some((o) => o.id === orgA));
      const scopedGrants = res.json.snapshot.scopedGrants as { organizationId: string | null }[] | undefined;
      assertExists(scopedGrants, "snapshot.scopedGrants must exist (addendum-137 rev-3 §API-shape)");
      assert(scopedGrants.some((g) => g.organizationId === orgA), "the Org-A scoped grant must surface with its organizationId");
    });

    await t.step("CONTRACT(phase-2): scoped writes attribute audit rows to the TARGET org (single ownership, never dual-write)", async () => {
      phase2Gate();
      const rename = await ctx.actors.as(scopedStructSession).put(`/admin/organizations/${orgA}`, {
        body: { name: `P2 Org A ${runSuffix} (scoped rename)` },
      });
      assertEquals(rename.status, 200, "scoped OrgUpdate on the granted org succeeds");
      const rows = await query<{ organization_id: string | null }>(
        `SELECT organization_id FROM audit_log WHERE action = 'organization.updated' ORDER BY created_at DESC LIMIT 1`,
      );
      assertExists(rows[0]);
      assertEquals(
        rows[0].organization_id,
        orgA,
        "audit attribution: the row belongs to the target's org (addendum-137 rev-3 §schema) — counterparties see via query-time inclusion",
      );
    });
  },
);
