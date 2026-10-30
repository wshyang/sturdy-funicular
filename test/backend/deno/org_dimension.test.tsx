// addendum-109 — Organisation dimension backend contract-suite (TEST-FIRST,
// RED BY DESIGN).
//
// This file is the executable half of addendum-109: it pins the routes,
// payloads, status codes and content assertions the org-dimension
// implementation (addendum-110+) must satisfy. Owner direction 2026-08-05:
// NO GATING — every test here runs live on each backend pass and FAILS NOW
// by design (no organisations tables/routes exist yet); each failure is the
// TDD contract the implementation will turn green.
//
// Scope of the current regiment (owner direction 2026-08-04): the
// organisation registry itself, and the single "Default" organisation
// carrying every fixture user / cluster / team (via cluster) / system (via
// agency cluster), including approval- and invite-time assignment. NO
// cross-organisation-access cases and NO global-access cases yet (deferred
// to phase 2/3, not staged).
//
// Fixture discipline: organisations are built with the raw-SQL helpers in
// helpers.tsx (createOrganization / ensureDefaultOrganization / …), which
// compile against the pre-org server; routes are driven through the real
// HTTP surface (ctx.actors / ctx.api), never mocked.
import { assert, assertEquals, assertExists } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import {
  createActiveUser,
  createSingleStepAgencySystem,
  ensureDefaultOrganization,
  addOrgMembership,
  removeOrgMembership,
  listOrgMemberIds,
  uniqueEmail,
} from "./helpers.tsx";
import type { OrganizationRow } from "./helpers.tsx";
import { DEFAULT_ORG_NAME } from "../../org-dimension.ts";

const runSuffix = crypto.randomUUID().slice(0, 8);

defineTest(
  "org-dimension: organization registry — CRUD + authz negatives",
  async ({ ctx, t }) => {
    const orgName = `Registry Org ${runSuffix}`;
    let orgId = "";

    await t.step("create + list: positive — POST then GET /admin/organizations", async () => {
      const res = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: orgName, shortCode: "RO" },
      });
      assertEquals(res.status, 201);
      assertExists(res.json?.organization?.id);
      assertEquals(res.json.organization.name, orgName);
      assert(!("kind" in res.json.organization), "addendum-206 (D3): organisations carry no kind any more");
      orgId = res.json.organization.id;

      const list = await ctx.actors.admin.get("/admin/organizations");
      assertEquals(list.status, 200);
      assert(list.json.organizations.some((o: { id: string }) => o.id === orgId));
    });

    await t.step("negative — duplicate live name rejected (400)", async () => {
      const res = await ctx.actors.admin.post("/admin/organizations", {
        // Valid code of its own (addendum-200: required) — the 400 must come
        // from the NAME collision, not the (now schema-required) code.
        body: { name: orgName, shortCode: "DN" },
      });
      assertEquals(res.status, 400);
    });

    // addendum-200 — the short code is a required, normalised, live-unique
    // single word (mirrors the systems regime).
    await t.step("short code regime: required, format-checked, uppercased, live-unique", async () => {
      const missing = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: `No Code ${runSuffix}` },
      });
      assertEquals(missing.status, 400);

      const badFormat = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: `Bad Code ${runSuffix}`, shortCode: "HAS SPACE" },
      });
      assertEquals(badFormat.status, 400);
      assertEquals(badFormat.json?.error, "Short code must be 1-10 uppercase alphanumeric characters.");

      const tooLong = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: `Long Code ${runSuffix}`, shortCode: "ABCDEFGHIJK" },
      });
      assertEquals(tooLong.status, 400);

      const lowered = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: `Lower Coded ${runSuffix}`, shortCode: "lc9" },
      });
      assertEquals(lowered.status, 201);
      assertEquals(lowered.json?.organization?.shortCode, "LC9");

      // Live-unique and case-insensitive in effect: re-using 'lc9' hits the
      // normalized form LC9.
      const dupCode = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: `Dup Code ${runSuffix}`, shortCode: "lc9" },
      });
      assertEquals(dupCode.status, 400);
      assertEquals(dupCode.json?.error, `An organisation with short code "LC9" already exists.`);

      // Re-code via PUT: normalized + cannot clear (null/empty → 400).
      const recode = await ctx.actors.admin.put(`/admin/organizations/${lowered.json!.organization.id}`, {
        body: { shortCode: "re9" },
      });
      assertEquals(recode.status, 200);
      assertEquals(recode.json?.organization?.shortCode, "RE9");
      const clearAttempt = await ctx.actors.admin.put(`/admin/organizations/${lowered.json!.organization.id}`, {
        body: { shortCode: null },
      });
      assertEquals(clearAttempt.status, 400);
    });

    await t.step("206 — the kind field is gone: stale kind keys are inert (201, never echoed)", async () => {
      const res = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: `Bad Kind ${runSuffix}`, kind: "division", shortCode: "BK" },
      });
      assertEquals(res.status, 201);
      assert(!("kind" in (res.json?.organization ?? {})), "addendum-206 (D3): kind column dropped — never written, never echoed");
    });

    await t.step("negative — vendor (non-admin) 403, unauthenticated 403", async () => {
      // Valid short codes (addendum-200): the zValidator runs before the
      // handler, so these bodies must parse or they'd 400 before authz.
      const asVendor = await ctx.actors.vendor.post("/admin/organizations", {
        body: { name: `Forbidden ${runSuffix}`, shortCode: "FB" },
      });
      assertEquals(asVendor.status, 403);
      const anon = await ctx.api.post("/admin/organizations", {
        body: { name: `Anon ${runSuffix}`, shortCode: "AN" },
      });
      assertEquals(anon.status, 403);
    });

    await t.step("update positive; delete BLOCKED while memberships reference it; then free delete", async () => {
      const renamed = `Registry Org ${runSuffix} (renamed)`;
      const put = await ctx.actors.admin.put(`/admin/organizations/${orgId}`, { body: { name: renamed } });
      assertEquals(put.status, 200);

      const member = await createActiveUser({
        email: uniqueEmail("org-reg-member"),
        password: "OrgMember!2026",
        affiliation: "agency",
      });
      await addOrgMembership({ organizationId: orgId, userId: member.id, addedBy: ctx.admin.id });
      const blocked = await ctx.actors.admin.del(`/admin/organizations/${orgId}`);
      assertEquals(blocked.status, 400);

      await removeOrgMembership(orgId, member.id);
      const freed = await ctx.actors.admin.del(`/admin/organizations/${orgId}`);
      assertEquals(freed.status, 200);

      const list = await ctx.actors.admin.get("/admin/organizations");
      assert(!list.json.organizations.some((o: { id: string }) => o.id === orgId));
    });
  },
);

defineTest(
  "org-dimension: Default-org assignment at approval + invite",
  async ({ ctx, t }) => {
    let defaultOrg: OrganizationRow;

    const signup = async (email: string): Promise<string> => {
      const res = await ctx.api.post("/auth/signup", {
        body: { fullName: "Org Pending Person", email, password: "ValidPass!2026" },
      });
      assertExists(res.json?.userId);
      return res.json.userId as string;
    };

    await t.step("setup — the single Default organisation exists", async () => {
      defaultOrg = await ensureDefaultOrganization(ctx.admin.id);
      assertEquals(defaultOrg.name, DEFAULT_ORG_NAME);
    });

    await t.step("approve: positive — vendor signup approved into Default (affiliation-agnostic in this regiment)", async () => {
      const userId = await signup(uniqueEmail("org-approve"));
      const res = await ctx.actors.admin.post(`/admin/users/${userId}/approve`, {
        body: { affiliation: "vendor", organizationIds: [defaultOrg.id] },
      });
      assertEquals(res.status, 200);
      assert((await listOrgMemberIds(defaultOrg.id)).includes(userId));
    });

    await t.step("approve: negative — unknown organisation id is 400 (no silent drop)", async () => {
      const userId = await signup(uniqueEmail("org-unknown"));
      const res = await ctx.actors.admin.post(`/admin/users/${userId}/approve`, {
        body: { affiliation: "agency", organizationIds: ["00000000-0000-0000-0000-000000000999"] },
      });
      assertEquals(res.status, 400);
    });

    await t.step("invite: parity — the auto-approving invite cannot bypass org assignment", async () => {
      const res = await ctx.actors.admin.post("/admin/users/invite", {
        body: {
          fullName: "Org Invited Person",
          email: uniqueEmail("org-invitee"),
          affiliation: "agency",
          notify: false,
          organizationIds: [defaultOrg.id],
        },
      });
      assertEquals(res.status, 201);
      assert((await listOrgMemberIds(defaultOrg.id)).includes(res.json.userId));
    });

    await t.step("zero-org approval stays allowed (owner decision: allowed + UI soft-warning)", async () => {
      const userId = await signup(uniqueEmail("org-zero"));
      const res = await ctx.actors.admin.post(`/admin/users/${userId}/approve`, {
        body: { affiliation: "agency" },
      });
      assertEquals(res.status, 200);
    });
  },
);

defineTest(
  "org-dimension: cluster organisation assignment + move guard",
  async ({ ctx, t }) => {
    let defaultOrg: OrganizationRow;
    await t.step("setup", async () => {
      defaultOrg = await ensureDefaultOrganization(ctx.admin.id);
    });

    const clusterName = `Org Cluster ${runSuffix}`;

    await t.step("create agency cluster with organizationId; list reflects it", async () => {
      const res = await ctx.actors.admin.post("/admin/clusters", {
        body: { name: clusterName, type: "agency", organizationId: defaultOrg.id },
      });
      assertEquals(res.status, 201);
      const list = await ctx.actors.admin.get("/admin/clusters");
      const row = list.json.clusters.find((c: { name: string }) => c.name === clusterName);
      assertExists(row);
      assertEquals(row.organizationId, defaultOrg.id);
    });

    await t.step("guard — changing a cluster's organisation is 400 while live systems reference it", async () => {
      const owner = await createActiveUser({
        email: uniqueEmail("org-guard-owner"),
        password: "OrgOwner!2026",
        affiliation: "agency",
      });
      const built = await createSingleStepAgencySystem(ctx.admin.id, owner);
      const move = await ctx.actors.admin.put(`/admin/clusters/${built.agencyCluster.id}`, {
        body: { organizationId: defaultOrg.id },
      });
      assertEquals(move.status, 400);
    });
  },
);

// G1 (addendum-140 gap register): the /:id/members management routes had zero
// suite references — only the raw-SQL fixture path (addOrgMembership et al.)
// was exercised. This cluster drives the real HTTP surface: positive
// add/list/remove with audit rows, the 404-disguise family, the 400 classes
// (duplicate, member-not-live — addendum-141 verdict extension), and the
// session-scoping negatives.
defineTest(
  "org-dimension: member management routes (G1) — CRUD, audit, disguise, negatives",
  async ({ ctx, t }) => {
    let orgId = "";
    let memberA = "";
    let memberB = "";
    let pendingId = "";

    await t.step("setup: org via the real route; two active users + one PENDING signup", async () => {
      const res = await ctx.actors.admin.post("/admin/organizations", {
        body: { name: `Members Org ${runSuffix}`, shortCode: "MO" },
      });
      assertEquals(res.status, 201);
      orgId = res.json.organization.id;

      const a = await createActiveUser({ email: uniqueEmail("org-mem-a"), password: "MemberA!2026", affiliation: "agency" });
      const b = await createActiveUser({ email: uniqueEmail("org-mem-b"), password: "MemberB!2026", affiliation: "vendor" });
      memberA = a.id;
      memberB = b.id;

      const signup = await ctx.api.post("/auth/signup", {
        body: { fullName: "Pending Member", email: uniqueEmail("org-mem-pending"), password: "ValidPass!2026" },
      });
      assertExists(signup.json?.userId);
      pendingId = signup.json.userId;
    });

    await t.step("positive: empty member list, then add → list shows identity-joined row + audit row", async () => {
      const empty = await ctx.actors.admin.get(`/admin/organizations/${orgId}/members`);
      assertEquals(empty.status, 200);
      assertEquals(empty.json.members, []);

      const add = await ctx.actors.admin.post(`/admin/organizations/${orgId}/members`, { body: { userId: memberA } });
      assertEquals(add.status, 201);
      assertEquals(add.json.membership.organizationId, orgId);
      assertEquals(add.json.membership.userId, memberA);

      const list = await ctx.actors.admin.get(`/admin/organizations/${orgId}/members`);
      assertEquals(list.status, 200);
      assertEquals(list.json.members.length, 1);
      assertEquals(list.json.members[0].userId, memberA);
      assertExists(list.json.members[0].email);
      assertExists(list.json.members[0].fullName);

      assert(
        await ctx.assert.auditHas("organization_member.added", { actor_id: ctx.admin.id }),
        "organization_member.added audit row must exist",
      );
    });

    await t.step("negative: duplicate live membership is 400, never 409", async () => {
      const dup = await ctx.actors.admin.post(`/admin/organizations/${orgId}/members`, { body: { userId: memberA } });
      assertEquals(dup.status, 400);
    });

    await t.step("negative: member-not-live — a pending_approval user cannot be added (400)", async () => {
      const res = await ctx.actors.admin.post(`/admin/organizations/${orgId}/members`, { body: { userId: pendingId } });
      assertEquals(res.status, 400, "addendum-141: only active users join organisations");
    });

    await t.step("positive: add second member, remove the first → 200; list reflects; removal audit row", async () => {
      const add = await ctx.actors.admin.post(`/admin/organizations/${orgId}/members`, { body: { userId: memberB } });
      assertEquals(add.status, 201);

      const del = await ctx.actors.admin.del(`/admin/organizations/${orgId}/members/${memberA}`);
      assertEquals(del.status, 200);

      const list = await ctx.actors.admin.get(`/admin/organizations/${orgId}/members`);
      assertEquals(list.json.members.length, 1);
      assertEquals(list.json.members[0].userId, memberB);

      assert(
        await ctx.assert.auditHas("organization_member.removed", { actor_id: ctx.admin.id }),
        "organization_member.removed audit row must exist",
      );
    });

    await t.step("negative: re-add after removal is allowed (soft-invalidation leaves no ghost)", async () => {
      const readd = await ctx.actors.admin.post(`/admin/organizations/${orgId}/members`, { body: { userId: memberA } });
      assertEquals(readd.status, 201);
      const list = await ctx.actors.admin.get(`/admin/organizations/${orgId}/members`);
      assertEquals(list.json.members.length, 2);
    });

    await t.step("404-disguise: unknown organisation id on all three member routes", async () => {
      const unknownOrg = "00000000-0000-0000-0000-000000000999";
      assertEquals((await ctx.actors.admin.get(`/admin/organizations/${unknownOrg}/members`)).status, 404);
      assertEquals((await ctx.actors.admin.post(`/admin/organizations/${unknownOrg}/members`, { body: { userId: memberA } })).status, 404);
      assertEquals((await ctx.actors.admin.del(`/admin/organizations/${unknownOrg}/members/${memberA}`)).status, 404);
    });

    await t.step("404-disguise: unknown user id on add; unknown membership on remove", async () => {
      const unknownUser = "00000000-0000-0000-0000-000000000999";
      assertEquals((await ctx.actors.admin.post(`/admin/organizations/${orgId}/members`, { body: { userId: unknownUser } })).status, 404);
      assertEquals((await ctx.actors.admin.del(`/admin/organizations/${orgId}/members/${unknownUser}`)).status, 404);
    });

    await t.step("session-scoping negatives: non-admin 403, unauthenticated 403 on all three", async () => {
      assertEquals((await ctx.actors.vendor.get(`/admin/organizations/${orgId}/members`)).status, 403);
      assertEquals((await ctx.actors.vendor.post(`/admin/organizations/${orgId}/members`, { body: { userId: memberB } })).status, 403);
      assertEquals((await ctx.actors.vendor.del(`/admin/organizations/${orgId}/members/${memberB}`)).status, 403);
      assertEquals((await ctx.api.get(`/admin/organizations/${orgId}/members`)).status, 403);
      assertEquals((await ctx.api.post(`/admin/organizations/${orgId}/members`, { body: { userId: memberB } })).status, 403);
      assertEquals((await ctx.api.del(`/admin/organizations/${orgId}/members/${memberB}`)).status, 403);
    });
  },
);
