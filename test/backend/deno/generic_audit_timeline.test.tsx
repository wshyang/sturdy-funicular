// Coverage: GET /audit/timeline/:targetType/:targetId — see
// addendum-041-uuidv7-and-object-lifecycle-traceability.md. Generalizes
// GET /audit/request/:id (still request-scoped, unchanged) to other object
// classes (currently: system, asset), following the same non-existence-
// disclosure convention (404, not 403) as every owner/delegate route.
// The final block pins the addendum-203 audit finding: the admin bypass
// counted ORG-SCOPED grants as global, leaking every timeline cross-org.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, createAsset, createOrganization, addOrgMembership, repointOwnerOrgEdge,
} from "./helpers.tsx";
import { systemDelegates, generateId, now } from "../../../server/db.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";
import { query } from "../../../server/pg.tsx";
import type { User } from "../../../server/types.tsx";

Deno.test("generic audit timeline", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("GenTimelineAdmin!2026");
    adminId = admin.id;
  });

  await t.step("system: positive — primary owner sees their system's timeline", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner", email: uniqueEmail("gtowner"), password: "GTOwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "GTOwnerPass!2026");

    const res = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.timeline);
  });

  await t.step("system: positive — a delegate sees the system's timeline", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner2", email: uniqueEmail("gtowner2"), password: "GTOwner2Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const delegate = await createActiveUser({ fullName: "GTDelegate", email: uniqueEmail("gtdelegate"), password: "GTDelegatePass!2026", affiliation: "vendor" });
    await systemDelegates.create({
      id: generateId(), systemId: system.id, ownerId: owner.id, delegateUserId: delegate.id, createdAt: now(),
    });
    const login = await loginAs(delegate.email, "GTDelegatePass!2026");

    const res = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
  });

  await t.step("system: negative (session-scoping substitution) — a real, active, logged-in user with NO relationship to this system is 404'd, not 403", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner3", email: uniqueEmail("gtowner3"), password: "GTOwner3Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const outsider = await createActiveUser({ fullName: "GTOutsider", email: uniqueEmail("gtoutsider"), password: "GTOutsiderPass!2026", affiliation: "vendor" });
    const login = await loginAs(outsider.email, "GTOutsiderPass!2026");

    const res = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 404);
  });

  await t.step("system: positive — a global admin (not the owner) sees any system's timeline", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner4", email: uniqueEmail("gtowner4"), password: "GTOwner4Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const secondAdmin = await createAdmin("GTSecondAdmin!2026");
    const adminLogin = await loginAs(secondAdmin.email, "GTSecondAdmin!2026");

    const res = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders((adminLogin as any).session) });
    assertEquals(res.status, 200);
  });

  await t.step("system: negative — unauthenticated", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner5", email: uniqueEmail("gtowner5"), password: "GTOwner5Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);

    const res = await req(`/audit/timeline/system/${system.id}`);
    assertEquals(res.status, 401);
  });

  await t.step("system: negative — unknown system id is 404 (no existence disclosure)", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner6", email: uniqueEmail("gtowner6"), password: "GTOwner6Pass!2026", affiliation: "agency" });
    await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "GTOwner6Pass!2026");

    const res = await req(`/audit/timeline/system/00000000-0000-0000-0000-000000000999`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 404);
  });

  await t.step("asset: positive — primary owner sees an asset's timeline via the parent system's ownership", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner7", email: uniqueEmail("gtowner7"), password: "GTOwner7Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const asset = await createAsset(system.id);
    const login = await loginAs(owner.email, "GTOwner7Pass!2026");

    const res = await req(`/audit/timeline/asset/${asset.id}`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
  });

  await t.step("asset: negative (session-scoping substitution) — an owner of a DIFFERENT system's asset is 404'd", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner8", email: uniqueEmail("gtowner8"), password: "GTOwner8Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const asset = await createAsset(system.id);

    const otherOwner = await createActiveUser({ fullName: "GTOwner9", email: uniqueEmail("gtowner9"), password: "GTOwner9Pass!2026", affiliation: "agency" });
    await createWiredSystem(adminId, otherOwner);
    const login = await loginAs(otherOwner.email, "GTOwner9Pass!2026");

    const res = await req(`/audit/timeline/asset/${asset.id}`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 404);
  });

  await t.step("negative — an unsupported target_type (e.g. breakglass_request, deliberately request-scoped only) is rejected for a non-admin", async () => {
    const owner = await createActiveUser({ fullName: "GTOwner10", email: uniqueEmail("gtowner10"), password: "GTOwner10Pass!2026", affiliation: "agency" });
    await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "GTOwner10Pass!2026");

    const res = await req(`/audit/timeline/breakglass_request/00000000-0000-0000-0000-000000000999`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 404);
  });

  await t.step("negative — an unsupported target_type is rejected for an admin too, with a 400 (not silently 200 with an empty list)", async () => {
    const admin2 = await createAdmin("GTAdmin2Pass!2026");
    const login = await loginAs(admin2.email, "GTAdmin2Pass!2026");

    const res = await req(`/audit/timeline/breakglass_request/00000000-0000-0000-0000-000000000999`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 400);
  });
});

Deno.test("generic audit timeline — org-scoped audit reads (addendum-203): the isAdmin bypass must mean GLOBAL, scoped readers only see their orgs", async (t) => {
  let admin: { id: string; email: string };
  let orgA = "";
  let orgB = "";
  let scopedAuditSession = "";

  await t.step("setup: orgs A/B + a config_audit_admin scoped to Org A only", async () => {
    await wipeDatabase();
    admin = await createAdmin("GTScopeAdmin!2026");
    orgA = (await createOrganization({ name: "GT Org A", shortCode: "GA", createdBy: admin.id })).id;
    orgB = (await createOrganization({ name: "GT Org B", shortCode: "GB", createdBy: admin.id })).id;

    const scoped = await createActiveUser({ fullName: "GT Scoped Audit", email: uniqueEmail("gt-scoped-audit"), password: "GTScopedAudit!2026", affiliation: "agency" });
    await addOrgMembership({ organizationId: orgA, userId: scoped.id, addedBy: admin.id });
    await grantAdminRole(scoped.id, "config_audit_admin", admin.id, "addendum-203 fixture", orgA);
    const login = await loginAs(scoped.email, "GTScopedAudit!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);
    scopedAuditSession = login.session;
  });

  // Anchor a wired system into an org — under addendum-206 the system's org
  // is its owner EDGE (createWiredSystem seeds one into the shared fixture
  // fallback org), so re-owning means re-pointing the edge.
  async function wireSystemInOrg(owner: User, orgId: string) {
    const built = await createWiredSystem(admin.id, owner);
    await repointOwnerOrgEdge(built.system.id, orgId, admin.id);
    return built;
  }

  await t.step("RED: a scoped audit reader is 404'd on a system in ANOTHER org — the bypass must not cover scoped grants", async () => {
    const owner = await createActiveUser({ fullName: "GTSysOwnerB", email: uniqueEmail("gtsysownerb"), password: "GTSysOwnerB!2026", affiliation: "agency" });
    const { system } = await wireSystemInOrg(owner, orgB);
    const res = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders(scopedAuditSession) });
    assertEquals(res.status, 404, "scoped grants must never read cross-org timelines — 404-disguise, same as absent");
  });

  await t.step("scoped audit reader sees a system inside their org (not the owner) — the phase-3 scoped-read path, rows attribution-filtered", async () => {
    const owner = await createActiveUser({ fullName: "GTSysOwnerA", email: uniqueEmail("gtsysownera"), password: "GTSysOwnerA!2026", affiliation: "agency" });
    const { system } = await wireSystemInOrg(owner, orgA);
    const res = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders(scopedAuditSession) });
    assertEquals(res.status, 200, "locked per addendum-137 phase 3: audit rows of an in-scope target are scoped-readable");
    const data = await res.json();
    assertExists(data.timeline);
    for (const row of data.timeline as { organizationId: string | null }[]) {
      assertEquals(row.organizationId, orgA, "a scoped reader must never receive rows attributed outside their orgs");
    }
  });

  await t.step("RED: a scoped admin WITHOUT AuditLogRead (user_admin@A) is 404'd even for a system in their org", async () => {
    const plain = await createActiveUser({ fullName: "GT Scoped UA", email: uniqueEmail("gt-scoped-ua"), password: "GTScopedUa!2026", affiliation: "agency" });
    await addOrgMembership({ organizationId: orgA, userId: plain.id, addedBy: admin.id });
    await grantAdminRole(plain.id, "user_admin", admin.id, "addendum-203 fixture", orgA);
    const login = await loginAs(plain.email, "GTScopedUa!2026");
    if ("error" in login) throw new Error(`loginAs failed: ${login.error}`);

    const owner = await createActiveUser({ fullName: "GTSysOwnerC", email: uniqueEmail("gtsysownerc"), password: "GTSysOwnerC!2026", affiliation: "agency" });
    const { system } = await wireSystemInOrg(owner, orgA);
    const res = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders(login.session) });
    assertEquals(res.status, 404, "audit reach rides the AuditLogRead capability — a scoped grant of a role lacking it confers no timeline access");
  });

  await t.step("user-target timelines: shared-org target visible, foreign-org target 404", async () => {
    const inScope = await createActiveUser({ fullName: "GT InScope User", email: uniqueEmail("gt-inscope"), password: "GTInScope!2026", affiliation: "agency" });
    await addOrgMembership({ organizationId: orgA, userId: inScope.id, addedBy: admin.id });
    const own = await req(`/audit/timeline/user/${inScope.id}`, { headers: authHeaders(scopedAuditSession) });
    assertEquals(own.status, 200, "UserRead-keyed visibility: users sharing an org are in scope");

    const foreign = await createActiveUser({ fullName: "GT Foreign User", email: uniqueEmail("gt-foreign"), password: "GTForeign!2026", affiliation: "agency" });
    await addOrgMembership({ organizationId: orgB, userId: foreign.id, addedBy: admin.id });
    const out = await req(`/audit/timeline/user/${foreign.id}`, { headers: authHeaders(scopedAuditSession) });
    assertEquals(out.status, 404, "a user wholly outside the reader's orgs is existence-disguised (identity-subset convention)");

    // Zero-membership (global-plane) targets stay unreachable for scoped readers.
    const globalPlane = await createActiveUser({ fullName: "GT GlobalPlane User", email: uniqueEmail("gt-globalplane"), password: "GTGlobalPlane!2026", affiliation: "agency" });
    const zero = await req(`/audit/timeline/user/${globalPlane.id}`, { headers: authHeaders(scopedAuditSession) });
    assertEquals(zero.status, 404, "zero-membership users are global-plane — the scoped plane never extends into it");
  });

  await t.step("RED: request-scoped target types stay request-scoped for scoped admins (404, not the global-admin 400)", async () => {
    const res = await req(`/audit/timeline/breakglass_request/00000000-0000-0000-0000-000000000999`, { headers: authHeaders(scopedAuditSession) });
    assertEquals(res.status, 404, "breakglass_request timelines belong to GET /audit/request/:id — scoped audit-read must not unlock the generic path");
  });

  await t.step("global admins and non-admin owner/delegate visibility are unchanged (regression envelope)", async () => {
    const owner = await createActiveUser({ fullName: "GTSysOwnerD", email: uniqueEmail("gtsysownerd"), password: "GTSysOwnerD!2026", affiliation: "agency" });
    const { system } = await wireSystemInOrg(owner, orgB);
    const globalLogin = await loginAs(admin.email, "GTScopeAdmin!2026");
    if ("error" in globalLogin) throw new Error(`loginAs failed: ${globalLogin.error}`);
    const asGlobal = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders(globalLogin.session) });
    assertEquals(asGlobal.status, 200, "global (null-org) grants keep the pre-203 bypass");

    const ownerLogin = await loginAs(owner.email, "GTSysOwnerD!2026");
    if ("error" in ownerLogin) throw new Error(`loginAs failed: ${ownerLogin.error}`);
    const asOwner = await req(`/audit/timeline/system/${system.id}`, { headers: authHeaders(ownerLogin.session) });
    assertEquals(asOwner.status, 200, "the non-admin owner/delegate visibility rules are untouched");
  });
});
