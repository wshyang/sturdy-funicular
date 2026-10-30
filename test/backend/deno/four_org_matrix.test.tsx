// Four-organisation access MATRIX — exhaustive (user × object × endpoint)
// enumeration. Companion to four_org_access.test.tsx (the curated narrative);
// this file iterates EVERY cell of the access-control cross-product instead of
// hand-picking representative cases.
//
// Dimensions:
//   users    = 15 (global admin + 14 cast)   ×
//   systems  = 5 (S_A, S_A2, S_B, S_C, S_D)   ×
//   endpoints = 4 system-keyed reads + 1 org-keyed read + 1 submit +
//               2 system-keyed mutations + 1 request-read + 1 my-systems.
//
// Predicates (derived from server/auth.tsx + auth-admin-roles.tsx):
//   scoped read / mutation scope:  global → 200/201 · scoped-in → 200/201 ·
//                                  scoped-out → 404-disguise · no-grant → 403.
//   submit (D1):  submitter-team member AND (vendor serves that system's org).
//   request read: submitter / reviewer / any-admin → 200, else 404 — and the
//                 OWNER is blocked pre-owner (Constraint #11).
//   /my-systems:  visibleSystemIds — VISIBLE_ALL for ANY admin grant
//                 (incl. scoped — the pinned observation, addendum-207 §3.3).
//
// Enumeration: addendum-207 §3.3 (docs/specs/addenda/).
import { assertEquals } from "jsr:@std/assert";
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
  loginAs,
  repointOwnerOrgEdge,
  req,
  uniqueEmail,
  uniqueName,
  uniqueShortCode,
} from "./helpers.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";
import type { Team, User } from "../../../server/types.tsx";

const PASSWORD = "FourOrg!2026";

type SessionUser = { user: User; session: string };
type UserRow = { key: string; session: string; kind: "global" | "scoped" | "none"; orgs: string[] };
type SystemRow = { key: string; id: string; org: string; primaryOwnerId: string };

async function agencyUser(label: string): Promise<SessionUser> {
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

async function vendorUser(label: string): Promise<SessionUser> {
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

// Scope predicate shared by every org-keyed admin surface.
function scopedStatus(kind: "global" | "scoped" | "none", orgs: string[], targetOrg: string): number {
  if (kind === "global") return 200;
  if (kind === "scoped") return orgs.includes(targetOrg) ? 200 : 404;
  return 403;
}

defineTest(
  "four-org access matrix: exhaustive user × system × endpoint enumeration",
  async ({ ctx, t }) => {
    const adminId = ctx.admin.id;
    const adminLogin = await loginAs(ctx.admin.email, "HarnessAdmin!2026");
    if ("error" in adminLogin) throw new Error(`admin login failed: ${adminLogin.error}`);
    const adminSession = adminLogin.session;

    // ── Setup (same topology as the narrative suite, minus the oscar-backup
    //    convenience row — this file needs deterministic ownership) ─────────
    let orgA = "", orgB = "", orgC = "", orgD = "";
    let alice!: SessionUser, bob!: SessionUser, carol!: SessionUser, dave!: SessionUser;
    let erin!: SessionUser, frank!: SessionUser, grace!: SessionUser, ivan!: SessionUser;
    let judy!: SessionUser, mason!: SessionUser, nora!: SessionUser, oscar!: SessionUser;
    let paAmember!: SessionUser, paBmember!: SessionUser;
    let sA!: Awaited<ReturnType<typeof createWiredSystem>>;
    let sA2!: Awaited<ReturnType<typeof createWiredSystem>>;
    let sB!: Awaited<ReturnType<typeof createWiredSystem>>;
    let sC!: Awaited<ReturnType<typeof createWiredSystem>>;
    let sD!: Awaited<ReturnType<typeof createWiredSystem>>;
    let paATeam!: Team, paBTeam!: Team, paCTeam!: Team;
    // Request ids seeded by the submit matrix, consumed by the request-read
    // matrix (hoisted so the two steps stay independently readable).
    let requestIds: Record<string, string> = {};

    const wire = async (owner: User, orgId: string) => {
      const built = await createWiredSystem(adminId, owner);
      await repointOwnerOrgEdge(built.system.id, orgId, adminId);
      return built;
    };
    const submission = async (systemId: string) => {
      const asset = await createAsset(systemId, { hostname: `m4-${systemId.slice(0, 6)}` });
      return {
        systemId,
        justification: "Four-org matrix request.",
        srNumber: "SR-M4-1",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id, hostnameDescription: "m4 host" }],
      };
    };

    await t.step("setup: four orgs + 14 cast users + five org-anchored systems", async () => {
      orgA = (await createOrganization({ name: uniqueName("M4 Org A"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgB = (await createOrganization({ name: uniqueName("M4 Org B"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgC = (await createOrganization({ name: uniqueName("M4 Org C"), shortCode: uniqueShortCode(), createdBy: adminId })).id;
      orgD = (await createOrganization({ name: uniqueName("M4 Org D"), shortCode: uniqueShortCode(), createdBy: adminId })).id;

      alice = await agencyUser("m4 alice");
      bob = await agencyUser("m4 bob");
      carol = await agencyUser("m4 carol");
      dave = await vendorUser("m4 dave");
      erin = await vendorUser("m4 erin");
      frank = await agencyUser("m4 frank");
      grace = await agencyUser("m4 grace");
      ivan = await agencyUser("m4 ivan");
      judy = await agencyUser("m4 judy");
      mason = await vendorUser("m4 mason");
      nora = await vendorUser("m4 nora");
      oscar = await agencyUser("m4 oscar");
      paAmember = await agencyUser("m4 pa-a-member");
      paBmember = await agencyUser("m4 pa-b-member");

      sA = await wire(alice.user, orgA);   // alice owns S_A  (A)
      sA2 = await wire(bob.user, orgA);    // bob owns S_A2   (A)
      sB = await wire(bob.user, orgB);     // bob owns S_B    (B)
      sC = await wire(ivan.user, orgC);    // ivan owns S_C   (C)
      sD = await wire(judy.user, orgD);    // judy owns S_D   (D)

      const join = (orgId: string, userId: string) => addOrgMembership({ organizationId: orgId, userId, addedBy: adminId });
      await join(orgA, alice.user.id);
      await join(orgA, bob.user.id); await join(orgB, bob.user.id);
      await join(orgB, carol.user.id); await join(orgC, carol.user.id);
      await join(orgC, dave.user.id);
      await join(orgD, erin.user.id); await join(orgA, erin.user.id);
      await join(orgD, frank.user.id);
      await join(orgA, grace.user.id); await join(orgC, grace.user.id);
      await join(orgC, ivan.user.id);
      await join(orgD, judy.user.id);
      await join(orgB, mason.user.id);
      await join(orgB, nora.user.id);
      await join(orgB, oscar.user.id);
      await join(orgA, paAmember.user.id);
      await join(orgB, paBmember.user.id);

      const grant = (userId: string, orgId: string) => Promise.all([
        grantAdminRole(userId, "org_structure_admin", adminId, "four-org matrix", orgId),
        grantAdminRole(userId, "systems_assets_admin", adminId, "four-org matrix", orgId),
      ]);
      await grant(alice.user.id, orgA);
      await grant(carol.user.id, orgB);
      await grant(grace.user.id, orgA);
      await grant(grace.user.id, orgC);

      // Submitter slots (dave is a team member of BOTH S_A and S_C but serves
      // only C — the S_A arm is the pure D1 rejection).
      await addMember(sC.vendorL1, dave.user, adminId);
      await addMember(sA.vendorL1, dave.user, adminId);
      await addMember(sD.vendorL1, erin.user, adminId);
      await addMember(sB.vendorL1, mason.user, adminId);
      // Reviewer slots (S_B only).
      await addMember(sB.vendorL2, nora.user, adminId);
      await addMember(sB.agencyL1, oscar.user, adminId);

      paATeam = await createTeam(await createCluster("pa", adminId, "M4 PA-A Cluster", orgA), 1, adminId, "M4 PA-A Team");
      paBTeam = await createTeam(await createCluster("pa", adminId, "M4 PA-B Cluster", orgB), 1, adminId, "M4 PA-B Team");
      paCTeam = await createTeam(await createCluster("pa", adminId, "M4 PA-C Cluster", orgC), 1, adminId, "M4 PA-C Team");
      await addMember(paATeam, paAmember.user, adminId);
      await addMember(paBTeam, paBmember.user, adminId);
    });

    // ── Data tables ────────────────────────────────────────────────────────
    const systems: SystemRow[] = [
      { key: "S_A", id: sA.system.id, org: orgA, primaryOwnerId: sA.primaryOwner.id },
      { key: "S_A2", id: sA2.system.id, org: orgA, primaryOwnerId: sA2.primaryOwner.id },
      { key: "S_B", id: sB.system.id, org: orgB, primaryOwnerId: sB.primaryOwner.id },
      { key: "S_C", id: sC.system.id, org: orgC, primaryOwnerId: sC.primaryOwner.id },
      { key: "S_D", id: sD.system.id, org: orgD, primaryOwnerId: sD.primaryOwner.id },
    ];
    const users: UserRow[] = [
      { key: "admin", session: adminSession, kind: "global", orgs: [] },
      { key: "alice", session: alice.session, kind: "scoped", orgs: [orgA] },
      { key: "carol", session: carol.session, kind: "scoped", orgs: [orgB] },
      { key: "grace", session: grace.session, kind: "scoped", orgs: [orgA, orgC] },
      { key: "bob", session: bob.session, kind: "none", orgs: [] },
      { key: "dave", session: dave.session, kind: "none", orgs: [] },
      { key: "erin", session: erin.session, kind: "none", orgs: [] },
      { key: "frank", session: frank.session, kind: "none", orgs: [] },
      { key: "ivan", session: ivan.session, kind: "none", orgs: [] },
      { key: "judy", session: judy.session, kind: "none", orgs: [] },
      { key: "mason", session: mason.session, kind: "none", orgs: [] },
      { key: "nora", session: nora.session, kind: "none", orgs: [] },
      { key: "oscar", session: oscar.session, kind: "none", orgs: [] },
      { key: "paAmember", session: paAmember.session, kind: "none", orgs: [] },
      { key: "paBmember", session: paBmember.session, kind: "none", orgs: [] },
    ];

    // ── Matrix 1 — system-keyed scoped admin reads ─────────────────────────
    // 4 endpoints × 15 users × 5 systems = 300 cells.
    await t.step("matrix: system-keyed admin reads (mappings / mappable-teams / assets / org-edges)", async () => {
      const endpoints = [
        (id: string) => `/admin/systems/${id}/mappings`,
        (id: string) => `/admin/systems/${id}/mappable-teams`,
        (id: string) => `/admin/systems/${id}/assets`,
        (id: string) => `/admin/systems/${id}/org-edges`,
      ];
      for (const path of endpoints) {
        for (const u of users) {
          for (const s of systems) {
            const res = await req(path(s.id), { headers: authHeaders(u.session) });
            assertEquals(
              res.status,
              scopedStatus(u.kind, u.orgs, s.org),
              `${u.key} × ${s.key} × ${path(":id")}`,
            );
          }
        }
      }
    });

    // ── Matrix 2 — org-keyed read ──────────────────────────────────────────
    // 1 endpoint × 15 users × 4 orgs = 60 cells.
    await t.step("matrix: org members read", async () => {
      for (const u of users) {
        for (const org of [orgA, orgB, orgC, orgD]) {
          const res = await req(`/admin/organizations/${org}/members`, { headers: authHeaders(u.session) });
          assertEquals(res.status, scopedStatus(u.kind, u.orgs, org), `${u.key} × members(${org})`);
        }
      }
    });

    // ── Matrix 3 — /my-systems (per user) ──────────────────────────────────
    await t.step("matrix: /my-systems per user (only GLOBAL admins get VISIBLE_ALL)", async () => {
      const ALL_KEYS = systems.map((s) => s.key).sort();
      const expectedKeys: Record<string, string[]> = {
        // Only the global admin gets VISIBLE_ALL. alice/carol/grace hold
        // org-SCOPED grants: previously that wrongly widened them to every
        // system (addendum-207 §3.3, now fixed in addendum-211), so they are
        // back to their runtime footprint — alice owns S_A; carol and grace
        // own/review nothing, so their runtime plane is empty even though
        // their scoped ADMIN plane is not.
        admin: ALL_KEYS,
        alice: ["S_A"],
        carol: [],
        grace: [],
        bob: ["S_A2", "S_B"],
        ivan: ["S_C"],
        judy: ["S_D"],
        dave: ["S_C"],
        mason: ["S_B"],
        erin: ["S_D"],
        frank: [],
        nora: ["S_B"],
        oscar: ["S_B"],
        paAmember: [],
        paBmember: [],
      };
      const idByKey = new Map(systems.map((s) => [s.key, s.id]));
      for (const u of users) {
        const res = await req("/my-systems", { headers: authHeaders(u.session) });
        assertEquals(res.status, 200, `${u.key} × /my-systems`);
        const got = (await res.json()).systems.map((s: { id: string }) => s.id).sort();
        const want = (expectedKeys[u.key] ?? []).map((k) => idByKey.get(k)!).sort();
        assertEquals(got, want, `${u.key} × /my-systems systems`);
      }
    });

    // ── Matrix 4 — submit (every user × every system) ──────────────────────
    // 15 users × 5 systems = 75 cells; the three 201 cells also seed the
    // request-read matrix below.
    await t.step("matrix: submit (D1 gate + submitter-team membership)", async () => {
      const submitOk: Record<string, string> = { dave: "S_C", mason: "S_B", erin: "S_D" };
      for (const u of users) {
        for (const s of systems) {
          const expected = submitOk[u.key] === s.key ? 201 : 403;
          const res = await req("/requests", {
            method: "POST", headers: authHeaders(u.session), body: await submission(s.id),
          });
          assertEquals(res.status, expected, `${u.key} × ${s.key} × POST /requests`);
          if (res.status === 201) requestIds[s.key] = (await res.json()).request.id;
        }
      }
    });

    // ── Matrix 5 — request read (every user × the three submittable systems)
    // 15 users × 3 systems = 45 cells. Owners are blocked pre-owner.
    await t.step("matrix: request detail read (submitter/reviewer/admin 200 · owner+stranger 404)", async () => {
      const submitter: Record<string, string> = { S_B: "mason", S_C: "dave", S_D: "erin" };
      const reviewers: Record<string, string[]> = { S_B: ["nora", "oscar"], S_C: [], S_D: [] };
      // Only a GLOBAL admin reads every request. Scoped admins (alice/carol/
      // grace) used to be lumped in here because getCapabilitySnapshot handed
      // them VISIBLE_ALL — addendum-207 §3.3, fixed in addendum-211. They now
      // fall through to the same submitter/reviewer test as anyone else, and
      // none of them holds either role on these requests, so they get the 404
      // disguise.
      for (const u of users) {
        for (const sk of ["S_B", "S_C", "S_D"]) {
          const allowed = u.kind === "global" || submitter[sk] === u.key || reviewers[sk].includes(u.key);
          const res = await req(`/requests/${requestIds[sk]}`, { headers: authHeaders(u.session) });
          assertEquals(res.status, allowed ? 200 : 404, `${u.key} × ${sk} × GET /requests/:id`);
        }
      }
    });

    // ── Matrix 6 — mutation NEGATIVE arms (every user × every system) ──────
    // POST /admin/systems/:id/owners + POST /admin/mappings/owner-pa.
    // The scope predicate is identical to reads: no-grant → 403, scoped
    // out-of-scope → 404-disguise (state-free — the check precedes any write).
    // In-scope/global positive arms are asserted in Matrix 7.
    await t.step("matrix: mutation negative arms (owners + owner-pa)", async () => {
      for (const u of users) {
        for (const s of systems) {
          const isGlobal = u.kind === "global";
          const inScope = u.kind === "scoped" && u.orgs.includes(s.org);
          if (isGlobal || inScope) continue; // positive arm in the next step
          const expected = u.kind === "scoped" ? 404 : 403;

          const ownersRes = await req(`/admin/systems/${s.id}/owners`, {
            method: "POST", headers: authHeaders(u.session),
            body: { userId: frank.user.id, kind: "backup" },
          });
          assertEquals(ownersRes.status, expected, `${u.key} × ${s.key} × POST owners`);

          const paRes = await req("/admin/mappings/owner-pa", {
            method: "POST", headers: authHeaders(u.session),
            body: { systemOwnerId: s.primaryOwnerId, paTeamId: paBTeam.id },
          });
          assertEquals(paRes.status, expected, `${u.key} × ${s.key} × POST owner-pa`);
        }
      }
    });

    // ── Matrix 7 — mutation POSITIVE arms (bounded fresh targets) ──────────
    // One in-scope success per scoped admin + one global success per endpoint.
    await t.step("matrix: mutation positive arms (owners 201 · owner-pa 201)", async () => {
      const candidate = await agencyUser("m4 owner-candidate");
      const ownerCells: Array<[SessionUser, Awaited<ReturnType<typeof createWiredSystem>>]> = [
        [alice, sA], [carol, sB], [grace, sC],
      ];
      for (const [u, s] of ownerCells) {
        const res = await req(`/admin/systems/${s.system.id}/owners`, {
          method: "POST", headers: authHeaders(u.session),
          body: { userId: candidate.user.id, kind: "backup" },
        });
        assertEquals(res.status, 201, `${u.key} × ${s.system.id} × POST owners (in-scope)`);
      }
      const adminOwners = await req(`/admin/systems/${sD.system.id}/owners`, {
        method: "POST", headers: authHeaders(adminSession),
        body: { userId: candidate.user.id, kind: "backup" },
      });
      assertEquals(adminOwners.status, 201, "global admin adds owner");

      const paCells: Array<[SessionUser, string, Team]> = [
        [alice, sA.primaryOwner.id, paATeam],
        [carol, sB.primaryOwner.id, paBTeam],
        [grace, sC.primaryOwner.id, paCTeam],
      ];
      for (const [u, ownerRowId, team] of paCells) {
        const res = await req("/admin/mappings/owner-pa", {
          method: "POST", headers: authHeaders(u.session),
          body: { systemOwnerId: ownerRowId, paTeamId: team.id },
        });
        assertEquals(res.status, 201, `${u.key} × owner(${ownerRowId}) × POST owner-pa (in-scope)`);
      }
      const adminPa = await req("/admin/mappings/owner-pa", {
        method: "POST", headers: authHeaders(adminSession),
        body: { systemOwnerId: sD.primaryOwner.id, paTeamId: paBTeam.id },
      });
      assertEquals(adminPa.status, 201, "global admin maps owner-pa");
    });
  },
);
