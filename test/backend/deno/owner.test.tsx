// Coverage: GET /owner/systems, GET /owner/systems/:id/eligible-delegates,
// POST /owner/systems/:id/delegates, DELETE /owner/systems/:id/delegates/:delegateId,
// GET /owner/statistics (addendum-020-owner-statistics-tab.md).
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, latestSentNotification, sentNotificationEmailSnapshots, createOrganization, addOrgMembership, uniqueShortCode,
  repointOwnerOrgEdge,
} from "./helpers.tsx";
import { users, systemOwners, systemDelegates, systemOrganizations, breakglassRequests, requestCredentialItems, generateId, now } from "../../../server/db.tsx";
import { resetQueryCount, getQueryCount } from "../../../server/pg.tsx";
import type { BreakglassRequest, System, RequestCredentialItem } from "../../../server/types.tsx";

// addendum-206 (amending 134): delegate eligibility is org-scoped to the
// system's LINKED organisations — the junction owner edge is the org truth
// (the pre-206 agency-cluster re-anchor no longer moves a system's org).
// This helper re-points the wired system's owner edge to a fresh
// organisation and makes the given users live members, so fixture
// candidates genuinely join the delegate pool.
async function anchorSystemOrg(system: System, memberIds: string[], addedBy: string): Promise<string> {
  const org = await createOrganization({ name: `Org-${system.id.replace(/-/g, '')}`, shortCode: uniqueShortCode(), createdBy: addedBy });
  await repointOwnerOrgEdge(system.id, org.id, addedBy);
  for (const userId of memberIds) {
    await addOrgMembership({ organizationId: org.id, userId, addedBy });
  }
  return org.id;
}

let statsRequestSeq = 0;

// Seeds a minimal but schema-valid breakglass_requests row at a caller-chosen
// created_at (the whole point — statistics filtering is date-driven, and
// db.tsx's create() passes explicit fields straight through, overriding the
// column's DEFAULT now()). Fields irrelevant to statistics (status,
// activity window, justification) get arbitrary valid placeholder values.
async function createRequestAt(opts: {
  systemId: string; vendorClusterId: string; submittedBy: string; createdAt: string;
}): Promise<BreakglassRequest> {
  statsRequestSeq += 1;
  const request: BreakglassRequest = {
    id: generateId(),
    requestNumber: `STATS-${Date.now()}-${statsRequestSeq}`,
    systemId: opts.systemId,
    submittedBy: opts.submittedBy,
    vendorClusterId: opts.vendorClusterId,
    justification: "Statistics fixture request.",
    srNumber: `SR-${statsRequestSeq}`,
    activityStartAt: opts.createdAt,
    activityEndAt: new Date(new Date(opts.createdAt).getTime() + 3600_000).toISOString(),
    status: "submitted",
    currentStepOrdinal: 1,
    ownerDecisionBy: null,
    ownerDecisionNotes: null,
    ownerDecisionAt: null,
    credentialIssuedAt: null,
    credentialIssuedBy: null,
    closingNotes: null,
    closedBy: null,
    closedAt: null,
    returnCount: 0,
    createdAt: opts.createdAt,
    updatedAt: opts.createdAt,
  };
  return breakglassRequests.create(request);
}

async function addCredentialItem(requestId: string, hostname: string): Promise<RequestCredentialItem> {
  const item: RequestCredentialItem = {
    id: generateId(),
    requestId: requestId,
    credentialType: "password",
    userid: "svc-account",
    hostname,
    hostnameDescription: null,
    createdAt: now(),
    updatedAt: now(),
  };
  return requestCredentialItems.create(item);
}

Deno.test("owner", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("OwnerRouteAdmin!2026");
    adminId = admin.id;
  });

  await t.step("owner/systems: positive — primary owner sees their system with role primary_owner", async () => {
    const owner = await createActiveUser({ fullName: "PrimaryOwner", email: uniqueEmail("primaryowner"), password: "PrimaryPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "PrimaryPass!2026");
    const res = await req("/owner/systems", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const found = data.systems.find((s: any) => s.id === system.id);
    assertExists(found);
    assertEquals(found.userRole, "primary_owner");
    assertEquals(found.primaryOwner.id, owner.id);
  });

  await t.step("owner/systems: positive — user with no ownership/delegation sees empty list", async () => {
    const nobody = await createActiveUser({ fullName: "Nobody", email: uniqueEmail("nobody"), password: "NobodyPass!2026", affiliation: "vendor" });
    const login = await loginAs(nobody.email, "NobodyPass!2026");
    const res = await req("/owner/systems", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.systems, []);
  });

  await t.step("owner/systems: negative — unauthenticated", async () => {
    const res = await req("/owner/systems");
    assertEquals(res.status, 403);
  });

  // addendum-095 owner-systems N+1 fix: the previous implementation issued
  // ~7+ queries per owned system (systems.get + multiple systemOwners lookups
  // + users.get for each owner and delegate), i.e. O(N·M) round-trips. This
  // step proves multi-system correctness: one owner owns two systems, with a
  // backup owner on one and delegates on both, and the enriched response is
  // complete and correct for every system.
  await t.step("owner/systems: multi-system correctness — backup owner + delegates enriched across two systems", async () => {
    const owner = await createActiveUser({ fullName: "MultiOwner", email: uniqueEmail("multiowner"), password: "MultiOwnerPass!2026", affiliation: "agency" });
    const { system: systemA } = await createWiredSystem(adminId, owner);
    const { system: systemB } = await createWiredSystem(adminId, owner);
    const backupA = await createActiveUser({ fullName: "MultiBackupA", email: uniqueEmail("multibackupa"), password: "MultiBackupAPass!2026", affiliation: "agency" });
    // addendum-134: delegates must be agency users with a live membership of
    // the system's organisation — fixtures wire exactly that (read path only;
    // the rows below are created directly to keep the query-shape pinned).
    const delegateA = await createActiveUser({ fullName: "MultiDelegateA", email: uniqueEmail("multidelegatea"), password: "MultiDelegateAPass!2026", affiliation: "agency" });
    const delegateB = await createActiveUser({ fullName: "MultiDelegateB", email: uniqueEmail("multidelegateb"), password: "MultiDelegateBPass!2026", affiliation: "agency" });
    await anchorSystemOrg(systemA, [delegateA.id], adminId);
    await anchorSystemOrg(systemB, [delegateB.id], adminId);

    // Backup owner on systemA (direct create — we're testing the READ path).
    await systemOwners.create({
      id: crypto.randomUUID(), systemId: systemA.id, userId: backupA.id, kind: "backup", createdBy: adminId, createdAt: now(),
    });
    // Delegates on both systems (direct create — same reason).
    await systemDelegates.create({
      id: crypto.randomUUID(), systemId: systemA.id, ownerId: owner.id, delegateUserId: delegateA.id, createdAt: now(),
    });
    await systemDelegates.create({
      id: crypto.randomUUID(), systemId: systemB.id, ownerId: owner.id, delegateUserId: delegateB.id, createdAt: now(),
    });

    const login = await loginAs(owner.email, "MultiOwnerPass!2026");
    const res = await req("/owner/systems", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.systems.length, 2);

    const sysA = data.systems.find((s: any) => s.id === systemA.id);
    const sysB = data.systems.find((s: any) => s.id === systemB.id);
    assertExists(sysA);
    assertExists(sysB);

    // systemA: primary owner (caller) + backup owner + delegate A.
    assertEquals(sysA.userRole, "primary_owner");
    assertEquals(sysA.primaryOwner.id, owner.id);
    assertEquals(sysA.backupOwner.id, backupA.id);
    assertEquals(sysA.delegates.length, 1);
    assertEquals(sysA.delegates[0].delegateUserId, delegateA.id);
    assertEquals(sysA.delegates[0].fullName, delegateA.fullName);
    assertEquals(sysA.delegates[0].email, delegateA.email);

    // systemB: primary owner (caller), no backup, delegate B.
    assertEquals(sysB.userRole, "primary_owner");
    assertEquals(sysB.primaryOwner.id, owner.id);
    assertEquals(sysB.backupOwner, null);
    assertEquals(sysB.delegates.length, 1);
    assertEquals(sysB.delegates[0].delegateUserId, delegateB.id);
    assertEquals(sysB.delegates[0].fullName, delegateB.fullName);
    assertEquals(sysB.delegates[0].email, delegateB.email);
  });

  // addendum-095 owner-systems N+1 fix: prove the fan-out does NOT scale with
  // the number of owned systems. The same owner calls GET /owner/systems with
  // 1 system and then with 3 systems; the marginal DB round-trips between the
  // two calls must stay small (the fixed path issues a constant handful of
  // batched queries regardless of N). The old per-system loop would add ~7+
  // queries per extra system (clearly > 10 for +2 systems).
  await t.step("owner/systems: query count does not scale with number of systems (N+1 regression)", async () => {
    const owner = await createActiveUser({ fullName: "QueryOwner", email: uniqueEmail("queryowner"), password: "QueryOwnerPass!2026", affiliation: "agency" });
    const { system: sys1 } = await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "QueryOwnerPass!2026");
    const headers = authHeaders((login as any).session);

    const call = async () => {
      resetQueryCount();
      const r = await req("/owner/systems", { headers });
      assertEquals(r.status, 200);
      return getQueryCount();
    };

    const count1 = await call();

    // Same owner gains two more systems + delegates (via the API to also
    // cover the delegate add path end-to-end).
    const { system: sys2 } = await createWiredSystem(adminId, owner);
    const { system: sys3 } = await createWiredSystem(adminId, owner);
    // addendum-134: delegates are agency users with a live membership of the
    // system's organisation (direct-create fixture, so wire it explicitly).
    const del2 = await createActiveUser({ fullName: "QueryDel2", email: uniqueEmail("querydel2"), password: "QueryDel2Pass!2026", affiliation: "agency" });
    const del3 = await createActiveUser({ fullName: "QueryDel3", email: uniqueEmail("querydel3"), password: "QueryDel3Pass!2026", affiliation: "agency" });
    await anchorSystemOrg(sys2, [del2.id], adminId);
    await anchorSystemOrg(sys3, [del3.id], adminId);
    await systemDelegates.create({ id: crypto.randomUUID(), systemId: sys2.id, ownerId: owner.id, delegateUserId: del2.id, createdAt: now() });
    await systemDelegates.create({ id: crypto.randomUUID(), systemId: sys3.id, ownerId: owner.id, delegateUserId: del3.id, createdAt: now() });

    const count3 = await call();

    // The three-system response must still be complete.
    const res3 = await req("/owner/systems", { headers });
    const data3 = await res3.json();
    assertEquals(data3.systems.length, 3);
    assertEquals(data3.systems.some((s: any) => s.id === sys1.id), true);
    assertEquals(data3.systems.some((s: any) => s.id === sys2.id), true);
    assertEquals(data3.systems.some((s: any) => s.id === sys3.id), true);

    // Marginal round-trips for +2 systems must be small (the batched path is
    // constant; the old N+1 loop would add ~14-21 queries).
    assert(
      count3 - count1 < 10,
      `expected near-constant query count across system count, got +${count3 - count1} queries for 2 extra systems (count1=${count1}, count3=${count3})`,
    );
  });

  await t.step("eligible-delegates: negative — 404 disguise for non-primary-owner caller", async () => {
    const owner = await createActiveUser({ fullName: "EligOwner", email: uniqueEmail("eligowner"), password: "EligPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const outsider = await createActiveUser({ fullName: "EligOutsider", email: uniqueEmail("eligoutsider"), password: "EligOutPass!2026", affiliation: "vendor" });
    const login = await loginAs(outsider.email, "EligOutPass!2026");
    const res = await req(`/owner/systems/${system.id}/eligible-delegates`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 404);
  });

  await t.step("eligible-delegates: positive — primary owner lists active agency org-members excluding existing owners/delegates", async () => {
    const owner = await createActiveUser({ fullName: "EligOwner2", email: uniqueEmail("eligowner2"), password: "Elig2Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    // addendum-134: the candidate must be an agency user with a live
    // membership of the system's organisation.
    const candidate = await createActiveUser({ fullName: "Candidate", email: uniqueEmail("candidate"), password: "CandidatePass!2026", affiliation: "agency" });
    await anchorSystemOrg(system, [candidate.id], adminId);
    const login = await loginAs(owner.email, "Elig2Pass!2026");
    const res = await req(`/owner/systems/${system.id}/eligible-delegates`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.users.find((u: any) => u.id === candidate.id));
    assertEquals(data.users.find((u: any) => u.id === owner.id), undefined);
  });

  // addendum-134: a VENDOR user is ineligible even when active AND a live
  // member of the system's organisation — the affiliation gate stands on its
  // own (a vendor org membership must never smuggle a vendor in).
  await t.step("eligible-delegates: negative — vendor org-members are excluded", async () => {
    const owner = await createActiveUser({ fullName: "EligVendorOwner", email: uniqueEmail("eligvendorowner"), password: "EligVendorPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const vendorMember = await createActiveUser({ fullName: "VendorMember", email: uniqueEmail("vendormember"), password: "VendorMemberPass!2026", affiliation: "vendor" });
    await anchorSystemOrg(system, [vendorMember.id], adminId);
    const login = await loginAs(owner.email, "EligVendorPass!2026");
    const res = await req(`/owner/systems/${system.id}/eligible-delegates`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.users.find((u: any) => u.id === vendorMember.id), undefined, "vendor org-member must be excluded");
  });

  // addendum-134: an AGENCY user is ineligible when their live membership is
  // in a DIFFERENT organisation than the system's own.
  await t.step("eligible-delegates: negative — agency members of a different organisation are excluded", async () => {
    const owner = await createActiveUser({ fullName: "EligCrossOwner", email: uniqueEmail("eligcrossowner"), password: "EligCrossPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    await anchorSystemOrg(system, [], adminId);
    const outlander = await createActiveUser({ fullName: "CrossOrgAgency", email: uniqueEmail("crossorgagency"), password: "CrossOrgPass!2026", affiliation: "agency" });
    // Live membership, but in an unrelated organisation.
    const otherOrg = await createOrganization({ name: `OtherOrg-${system.id.slice(0, 8)}`, shortCode: `OO${system.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`, createdBy: adminId });
    await addOrgMembership({ organizationId: otherOrg.id, userId: outlander.id, addedBy: adminId });
    const login = await loginAs(owner.email, "EligCrossPass!2026");
    const res = await req(`/owner/systems/${system.id}/eligible-delegates`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.users.find((u: any) => u.id === outlander.id), undefined, "cross-org agency member must be excluded");
  });

  // addendum-206 §4.3 union pool: a member of a PARTICIPANT org (linked via
  // system_organizations, not the owner edge) joins the delegate pool, and
  // the write gate accepts them — the read and the boundary share one rule.
  await t.step("eligible-delegates: positive — participant-org members join the pool AND the add gate (206 union)", async () => {
    const owner = await createActiveUser({ fullName: "UnionOwner", email: uniqueEmail("unionowner"), password: "UnionPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    await anchorSystemOrg(system, [], adminId); // owner edge → memberless fresh org
    const participantOrg = await createOrganization({ name: `ParticipantOrg-${system.id.slice(0, 8)}`, shortCode: uniqueShortCode(), createdBy: adminId });
    await systemOrganizations.addEdge({ systemId: system.id, organizationId: participantOrg.id, role: "participant", createdBy: adminId });
    const officer = await createActiveUser({ fullName: "ParticipantOfficer", email: uniqueEmail("participantofficer"), password: "ParticipantPass!2026", affiliation: "agency" });
    await addOrgMembership({ organizationId: participantOrg.id, userId: officer.id, addedBy: adminId });
    const login = await loginAs(owner.email, "UnionPass!2026");
    const res = await req(`/owner/systems/${system.id}/eligible-delegates`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.users.find((u: any) => u.id === officer.id), "participant-org officer must appear in the delegate pool");
    const add = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: officer.id },
    });
    assertEquals(add.status, 201, "the add gate honours the same union");
  });

  // D7 (addendum-206 §4.3): vendor affiliation bars delegation even when the
  // vendor holds a LIVE membership of a linked participant org — membership
  // must never smuggle a vendor in, on any edge role. Pinned message.
  await t.step("add delegate: negative — vendor member of a participant org still rejected (400, D7)", async () => {
    const owner = await createActiveUser({ fullName: "D7Owner", email: uniqueEmail("d7owner"), password: "D7Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    await anchorSystemOrg(system, [], adminId);
    const participantOrg = await createOrganization({ name: `D7Org-${system.id.slice(0, 8)}`, shortCode: uniqueShortCode(), createdBy: adminId });
    await systemOrganizations.addEdge({ systemId: system.id, organizationId: participantOrg.id, role: "participant", createdBy: adminId });
    const vendorMember = await createActiveUser({ fullName: "D7Vendor", email: uniqueEmail("d7vendor"), password: "D7VendorPass!2026", affiliation: "vendor" });
    await addOrgMembership({ organizationId: participantOrg.id, userId: vendorMember.id, addedBy: adminId });
    const login = await loginAs(owner.email, "D7Pass!2026");
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: vendorMember.id },
    });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertEquals(data.error, "Delegate must be an agency user with membership in the same organisation as the system.");
    const rows = await systemDelegates.findBySystemAndUser(system.id, vendorMember.id);
    assertEquals(rows, null);
  });

  // addendum-206 §4.3 (replacing 134's "unanchored cluster" pin — clusters
  // are never org-less now, D2 NOT NULL): the pool is union-scoped over the
  // system's LIVE linked orgs. A memberless linked org yields EMPTY (never
  // "any active agency user"), and a system whose only linked org is expired
  // has NO live edges left — equally empty, fail-closed in both shapes.
  await t.step("eligible-delegates: negative — memberless linked org yields an empty eligible list", async () => {
    const owner = await createActiveUser({ fullName: "EligUnanchoredOwner", email: uniqueEmail("eligunanchoredowner"), password: "EligUnanchoredPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    // Explicit memberless linked org (escapes the shared fallback org).
    await anchorSystemOrg(system, [], adminId);
    await createActiveUser({ fullName: "AnyAgency", email: uniqueEmail("anyagency"), password: "AnyAgencyPass!2026", affiliation: "agency" });
    const login = await loginAs(owner.email, "EligUnanchoredPass!2026");
    const res = await req(`/owner/systems/${system.id}/eligible-delegates`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.users, [], "linked orgs without members must expose no eligible delegates");
  });

  // addendum-095 Finding #5: eligible-delegates must EXCLUDE non-active users
  // (pending_approval/tombstoned/rejected) via the SQL-side status filter, not
  // an in-JS filter over a full users.list(). A tombstoned + a pending user
  // should never appear in the eligible list, while a fresh active candidate
  // still does. addendum-134: every fixture below is an agency org-member, so
  // status is the ONLY excluding factor (affiliation/membership cannot
  // confound the pin).
  await t.step("eligible-delegates: non-active users (tombstoned/pending) are excluded", async () => {
    const owner = await createActiveUser({ fullName: "EligActiveOwner", email: uniqueEmail("eligactiveowner"), password: "EligActivePass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);

    const activeCandidate = await createActiveUser({ fullName: "EligActiveCand", email: uniqueEmail("eligactivecand"), password: "EligActiveCandPass!2026", affiliation: "agency" });
    // A pending user (status pending_approval) via direct create.
    const pending = await users.create({
      id: crypto.randomUUID(), fullName: "EligPending", email: uniqueEmail("eligpending"),
      passwordHash: "x", passwordSalt: "", affiliation: "agency", status: "pending_approval",
      approvedBy: null, approvedAt: null, tombstonedBy: null, tombstonedAt: null,
      untombstonedBy: null, untombstonedAt: null, lastLoginAt: null,
      createdAt: now(), updatedAt: now(),
    });
    // A tombstoned user.
    const tombstoned = await users.create({
      id: crypto.randomUUID(), fullName: "EligTombstoned", email: uniqueEmail("eligtombstoned"),
      passwordHash: "x", passwordSalt: "", affiliation: "agency", status: "tombstoned",
      approvedBy: null, approvedAt: null, tombstonedBy: null, tombstonedAt: now(),
      untombstonedBy: null, untombstonedAt: null, lastLoginAt: null,
      createdAt: now(), updatedAt: now(),
    });
    await anchorSystemOrg(system, [activeCandidate.id, pending.id, tombstoned.id], adminId);

    const login = await loginAs(owner.email, "EligActivePass!2026");
    const res = await req(`/owner/systems/${system.id}/eligible-delegates`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.users.find((u: any) => u.id === activeCandidate.id), "active candidate should be eligible");
    assertEquals(data.users.find((u: any) => u.id === pending.id), undefined, "pending user must be excluded");
    assertEquals(data.users.find((u: any) => u.id === tombstoned.id), undefined, "tombstoned user must be excluded");
  });

  await t.step("add delegate: negative — cannot delegate to self", async () => {
    const owner = await createActiveUser({ fullName: "SelfOwner", email: uniqueEmail("selfowner"), password: "SelfPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "SelfPass!2026");
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: owner.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("add delegate: negative — non-primary-owner forbidden (404 disguise)", async () => {
    const owner = await createActiveUser({ fullName: "NonPrimOwner", email: uniqueEmail("nonprimowner"), password: "NonPrimPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const backup = await createActiveUser({ fullName: "BackupCaller", email: uniqueEmail("backupcaller"), password: "BackupCallerPass!2026", affiliation: "agency" });
    await systemOwners.create({
      id: crypto.randomUUID(), systemId: system.id, userId: backup.id, kind: "backup", createdBy: adminId, createdAt: new Date().toISOString(),
    });
    const backupLogin = await loginAs(backup.email, "BackupCallerPass!2026");
    const candidate = await createActiveUser({ fullName: "Cand2", email: uniqueEmail("cand2"), password: "Cand2Pass!2026", affiliation: "vendor" });

    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((backupLogin as any).session), body: { delegateUserId: candidate.id },
    });
    assertEquals(res.status, 404);
  });

  await t.step("add delegate: positive — primary owner adds a delegate", async () => {
    const owner = await createActiveUser({ fullName: "DelOwner", email: uniqueEmail("delowner"), password: "DelOwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    // addendum-134: the delegate must be an agency org-member.
    const delegate = await createActiveUser({ fullName: "Delegate", email: uniqueEmail("delegate"), password: "DelegatePass!2026", affiliation: "agency" });
    await anchorSystemOrg(system, [delegate.id], adminId);
    const login = await loginAs(owner.email, "DelOwnerPass!2026");

    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: delegate.id },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.delegate.delegateUserId, delegate.id);

    // Email notification (addendum-044) #25 — the delegate.
    const addedEmail = await latestSentNotification("system_delegate.added");
    assertExists(addedEmail);
    assertEquals(sentNotificationEmailSnapshots(addedEmail), [delegate.email]);
  });

  // addendum-134: vendor targets are hard-400 — the route must not accept a
  // user the eligible-delegates list would never have offered (UI filtering
  // alone is not the enforcement).
  await t.step("add delegate: negative — vendor target rejected (400)", async () => {
    const owner = await createActiveUser({ fullName: "VendorTargetOwner", email: uniqueEmail("vendortargetowner"), password: "VendorTargetPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const vendorTarget = await createActiveUser({ fullName: "VendorTarget", email: uniqueEmail("vendortarget"), password: "VendorTargetPass!2026", affiliation: "vendor" });
    // Membership present so affiliation alone is the rejecting gate.
    await anchorSystemOrg(system, [vendorTarget.id], adminId);
    const login = await loginAs(owner.email, "VendorTargetPass!2026");
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: vendorTarget.id },
    });
    assertEquals(res.status, 400);
    // No delegate row may have been created.
    const rows = await systemDelegates.findBySystemAndUser(system.id, vendorTarget.id);
    assertEquals(rows, null);
  });

  // addendum-134: an agency user whose live membership belongs to a
  // DIFFERENT organisation than the system's is hard-400.
  await t.step("add delegate: negative — agency target from a different organisation rejected (400)", async () => {
    const owner = await createActiveUser({ fullName: "CrossTargetOwner", email: uniqueEmail("crosstargetowner"), password: "CrossTargetPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    await anchorSystemOrg(system, [], adminId);
    const crossTarget = await createActiveUser({ fullName: "CrossTarget", email: uniqueEmail("crosstarget"), password: "CrossTargetPass!2026", affiliation: "agency" });
    const otherOrg = await createOrganization({ name: `OtherOrg-add-${system.id.slice(0, 8)}`, shortCode: `OA${system.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`, createdBy: adminId });
    await addOrgMembership({ organizationId: otherOrg.id, userId: crossTarget.id, addedBy: adminId });
    const login = await loginAs(owner.email, "CrossTargetPass!2026");
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: crossTarget.id },
    });
    assertEquals(res.status, 400);
    const rows = await systemDelegates.findBySystemAndUser(system.id, crossTarget.id);
    assertEquals(rows, null);
  });

  await t.step("add delegate: negative — cannot delegate to an existing owner", async () => {
    const owner = await createActiveUser({ fullName: "DupOwnerDel", email: uniqueEmail("dupownerdel"), password: "DupPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const backup = await createActiveUser({ fullName: "DupBackup", email: uniqueEmail("dupbackup"), password: "DupBackupPass!2026", affiliation: "agency" });
    await systemOwners.create({
      id: crypto.randomUUID(), systemId: system.id, userId: backup.id, kind: "backup", createdBy: adminId, createdAt: new Date().toISOString(),
    });
    const login = await loginAs(owner.email, "DupPass!2026");
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: backup.id },
    });
    assertEquals(res.status, 400);
  });

  await t.step("remove delegate: positive — primary owner removes a delegate", async () => {
    const owner = await createActiveUser({ fullName: "RemOwner", email: uniqueEmail("remowner"), password: "RemOwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    // addendum-134: agency org-member — the ADD below goes through the API.
    const delegate = await createActiveUser({ fullName: "RemDelegate", email: uniqueEmail("remdelegate"), password: "RemDelegatePass!2026", affiliation: "agency" });
    await anchorSystemOrg(system, [delegate.id], adminId);
    const login = await loginAs(owner.email, "RemOwnerPass!2026");
    const addRes = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: delegate.id },
    });
    const addData = await addRes.json();

    const res = await req(`/owner/systems/${system.id}/delegates/${addData.delegate.id}`, {
      method: "DELETE", headers: authHeaders((login as any).session),
    });
    assertEquals(res.status, 200);

    // Email notification (addendum-044) #26 — the delegate.
    const removedEmail = await latestSentNotification("system_delegate.removed");
    assertExists(removedEmail);
    assertEquals(sentNotificationEmailSnapshots(removedEmail), [delegate.email]);
  });

  await t.step("remove delegate: negative — delegate not found for this system", async () => {
    const owner = await createActiveUser({ fullName: "NotFoundOwner", email: uniqueEmail("notfoundowner"), password: "NotFoundPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "NotFoundPass!2026");
    const res = await req(`/owner/systems/${system.id}/delegates/00000000-0000-0000-0000-000000000999`, {
      method: "DELETE", headers: authHeaders((login as any).session),
    });
    assertEquals(res.status, 404);
  });

  // addendum-033-authorization-scoping-test-discipline.md: removeDelegate's
  // primary-owner check is identical in shape to addDelegate's/
  // eligible-delegates' (already tested above), but had no direct
  // cross-owner-substitution test of its own. A backup owner has a real
  // relationship to the system (unlike a totally unrelated user) but is
  // still not the primary owner, so this is the same non-transitivity rule
  // exercised from the strictest angle.
  await t.step("remove delegate: negative — non-primary-owner (backup owner) forbidden (404 disguise)", async () => {
    const owner = await createActiveUser({ fullName: "RemNonPrimOwner", email: uniqueEmail("remnonprimowner"), password: "RemNonPrimPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const backup = await createActiveUser({ fullName: "RemBackupCaller", email: uniqueEmail("rembackupcaller"), password: "RemBackupPass!2026", affiliation: "agency" });
    await systemOwners.create({
      id: crypto.randomUUID(), systemId: system.id, userId: backup.id, kind: "backup", createdBy: adminId, createdAt: new Date().toISOString(),
    });
    // addendum-134: agency org-member — the ADD below goes through the API.
    const delegate = await createActiveUser({ fullName: "RemTargetDelegate", email: uniqueEmail("remtargetdelegate"), password: "RemTargetPass!2026", affiliation: "agency" });
    await anchorSystemOrg(system, [delegate.id], adminId);
    const ownerLogin = await loginAs(owner.email, "RemNonPrimPass!2026");
    const addRes = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((ownerLogin as any).session), body: { delegateUserId: delegate.id },
    });
    const addData = await addRes.json();

    const backupLogin = await loginAs(backup.email, "RemBackupPass!2026");
    const res = await req(`/owner/systems/${system.id}/delegates/${addData.delegate.id}`, {
      method: "DELETE", headers: authHeaders((backupLogin as any).session),
    });
    assertEquals(res.status, 404);

    // Confirm the delegate row was NOT actually deleted by the unauthorized call.
    const stillThere = await systemDelegates.get(addData.delegate.id);
    assertExists(stillThere);
  });

  // ── GET /owner/statistics (addendum-020-owner-statistics-tab.md) ──────────

  await t.step("statistics: positive — by-system breakdown across two owned systems", async () => {
    const owner = await createActiveUser({ fullName: "StatsOwner", email: uniqueEmail("statsowner"), password: "StatsPass!2026", affiliation: "agency" });
    const { system: systemA, vendorCluster: vendorClusterA } = await createWiredSystem(adminId, owner);
    const { system: systemB, vendorCluster: vendorClusterB } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "StatsSubmitter", email: uniqueEmail("statssubmitter"), password: "SubPass!2026", affiliation: "vendor" });

    const from = new Date("2026-01-01T00:00:00.000Z");
    const to = new Date("2026-02-01T00:00:00.000Z");
    const inRange = new Date("2026-01-15T00:00:00.000Z").toISOString();

    for (let i = 0; i < 3; i++) {
      await createRequestAt({ systemId: systemA.id, vendorClusterId: vendorClusterA.id, submittedBy: submitter.id, createdAt: inRange });
    }
    for (let i = 0; i < 2; i++) {
      await createRequestAt({ systemId: systemB.id, vendorClusterId: vendorClusterB.id, submittedBy: submitter.id, createdAt: inRange });
    }

    const login = await loginAs(owner.email, "StatsPass!2026");
    const res = await req(`/owner/statistics?from=${from.toISOString()}&to=${to.toISOString()}`, {
      headers: authHeaders((login as any).session),
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.mode, "by_system");
    const bucketA = data.data.find((d: any) => d.id === systemA.id);
    const bucketB = data.data.find((d: any) => d.id === systemB.id);
    assertExists(bucketA);
    assertExists(bucketB);
    assertEquals(bucketA.count, 3);
    assertEquals(bucketB.count, 2);
  });

  await t.step("statistics: positive — by-hostname breakdown proves COUNT(DISTINCT r.id) semantics, not raw item-row counts", async () => {
    const owner = await createActiveUser({ fullName: "HostStatsOwner", email: uniqueEmail("hoststatsowner"), password: "HostStatsPass!2026", affiliation: "agency" });
    const { system, vendorCluster } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "HostSubmitter", email: uniqueEmail("hostsubmitter"), password: "HostSubPass!2026", affiliation: "vendor" });

    const inRange = new Date("2026-01-15T00:00:00.000Z").toISOString();

    // Request 1 touches both hostA and hostB.
    const req1 = await createRequestAt({ systemId: system.id, vendorClusterId: vendorCluster.id, submittedBy: submitter.id, createdAt: inRange });
    await addCredentialItem(req1.id, "hostA");
    await addCredentialItem(req1.id, "hostB");

    // Request 2 touches only hostA.
    const req2 = await createRequestAt({ systemId: system.id, vendorClusterId: vendorCluster.id, submittedBy: submitter.id, createdAt: inRange });
    await addCredentialItem(req2.id, "hostA");

    const login = await loginAs(owner.email, "HostStatsPass!2026");
    const res = await req(
      `/owner/statistics?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z&system_id=${system.id}`,
      { headers: authHeaders((login as any).session) },
    );
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.mode, "by_hostname");
    const hostA = data.data.find((d: any) => d.id === "hostA");
    const hostB = data.data.find((d: any) => d.id === "hostB");
    assertExists(hostA);
    assertExists(hostB);
    // hostA is touched by 2 DISTINCT requests (not 2 items + 1 item = 3 rows
    // if raw request_credential_items rows were counted instead).
    assertEquals(hostA.count, 2);
    assertEquals(hostB.count, 1);
  });

  await t.step("statistics: date-range boundary — a request outside [from, to) is excluded, then reappears once the range widens", async () => {
    const owner = await createActiveUser({ fullName: "BoundaryOwner", email: uniqueEmail("boundaryowner"), password: "BoundaryPass!2026", affiliation: "agency" });
    const { system, vendorCluster } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "BoundarySubmitter", email: uniqueEmail("boundarysubmitter"), password: "BoundarySubPass!2026", affiliation: "vendor" });

    const outsideRange = new Date("2026-03-01T00:00:00.000Z").toISOString();
    await createRequestAt({ systemId: system.id, vendorClusterId: vendorCluster.id, submittedBy: submitter.id, createdAt: outsideRange });

    const login = await loginAs(owner.email, "BoundaryPass!2026");

    const narrowRes = await req(
      `/owner/statistics?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`,
      { headers: authHeaders((login as any).session) },
    );
    const narrowData = await narrowRes.json();
    assertEquals(narrowData.data.find((d: any) => d.id === system.id), undefined);

    const wideRes = await req(
      `/owner/statistics?from=2026-01-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z`,
      { headers: authHeaders((login as any).session) },
    );
    const wideData = await wideRes.json();
    const bucket = wideData.data.find((d: any) => d.id === system.id);
    assertExists(bucket);
    assertEquals(bucket.count, 1);
  });

  await t.step("statistics: negative — system_id not owned/delegated by caller is disguised as 404", async () => {
    const ownerA = await createActiveUser({ fullName: "ScopeOwnerA", email: uniqueEmail("scopeownera"), password: "ScopeAPass!2026", affiliation: "agency" });
    const ownerB = await createActiveUser({ fullName: "ScopeOwnerB", email: uniqueEmail("scopeownerb"), password: "ScopeBPass!2026", affiliation: "agency" });
    await createWiredSystem(adminId, ownerA);
    const { system: systemB } = await createWiredSystem(adminId, ownerB);

    const loginA = await loginAs(ownerA.email, "ScopeAPass!2026");
    const res = await req(
      `/owner/statistics?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z&system_id=${systemB.id}`,
      { headers: authHeaders((loginA as any).session) },
    );
    assertEquals(res.status, 404);
  });

  await t.step("statistics: positive — caller with no ownership/delegation gets an empty by-system result, not an error", async () => {
    const nobody = await createActiveUser({ fullName: "StatsNobody", email: uniqueEmail("statsnobody"), password: "StatsNobodyPass!2026", affiliation: "vendor" });
    const login = await loginAs(nobody.email, "StatsNobodyPass!2026");
    const res = await req(
      `/owner/statistics?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`,
      { headers: authHeaders((login as any).session) },
    );
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.data, []);
  });

  await t.step("statistics: negative — missing from/to is a 400", async () => {
    const owner = await createActiveUser({ fullName: "ValOwner1", email: uniqueEmail("valowner1"), password: "ValPass1!2026", affiliation: "agency" });
    await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "ValPass1!2026");

    const res = await req(`/owner/statistics?from=2026-01-01T00:00:00.000Z`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 400);
  });

  await t.step("statistics: negative — to <= from is a 400", async () => {
    const owner = await createActiveUser({ fullName: "ValOwner2", email: uniqueEmail("valowner2"), password: "ValPass2!2026", affiliation: "agency" });
    await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "ValPass2!2026");

    const res = await req(
      `/owner/statistics?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`,
      { headers: authHeaders((login as any).session) },
    );
    assertEquals(res.status, 400);
  });

  await t.step("statistics: negative — unauthenticated", async () => {
    const res = await req(`/owner/statistics?from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z`);
    assertEquals(res.status, 403);
  });
});
