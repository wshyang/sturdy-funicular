// Coverage: POST /requests, PUT /requests/:id/resubmit, POST /requests/:id/step-decision,
// POST /requests/:id/owner-decision, POST /requests/:id/admin-reset,
// POST /requests/:id/issue-credential, POST /requests/:id/close, GET /requests/:id,
// GET /requests/my-requests, GET /requests/search, PUT /requests/:id/approver-edit.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, addMember, addServingMember, createCluster, createTeam, createAsset,
  createSingleStepAgencySystem, createFourStepSystem, latestSentNotification, sentNotificationEmailSnapshots,
} from "../helpers.tsx";
import { grantAdminRole } from "../../../../server/auth-admin-roles.tsx";
import { systemOwners, teamMemberships, requestKeyMaterial, assets, generateId, now } from "../../../../server/db.tsx";

// Sets up a fully wired system (vendor L1 submit -> vendor L2 approve -> agency L1
// approve -> owner terminal), with one active member at each tier, and returns
// everything a test needs to drive a request through the whole lifecycle.
async function setupScenario(adminId: string) {
  const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("scnowner"), password: "OwnerPass!2026", affiliation: "agency" });
  const { system, vendorL1, vendorL2, agencyL1 } = await createWiredSystem(adminId, owner);

  const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("submitter"), password: "SubmitPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL1, submitter, adminId);
  const vendorApprover = await createActiveUser({ fullName: "VendorApprover", email: uniqueEmail("vendorappr"), password: "VendorApprPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL2, vendorApprover, adminId);
  const agencyApprover = await createActiveUser({ fullName: "AgencyApprover", email: uniqueEmail("agencyappr"), password: "AgencyApprPass!2026", affiliation: "agency" });
  await addMember(agencyL1, agencyApprover, adminId);

  const submitterLogin = await loginAs(submitter.email, "SubmitPass!2026");
  const vendorApproverLogin = await loginAs(vendorApprover.email, "VendorApprPass!2026");
  const agencyApproverLogin = await loginAs(agencyApprover.email, "AgencyApprPass!2026");
  const ownerLogin = await loginAs(owner.email, "OwnerPass!2026");

  return {
    system, owner, submitter, vendorApprover, agencyApprover,
    submitterSession: (submitterLogin as any).session,
    vendorApproverSession: (vendorApproverLogin as any).session,
    agencyApproverSession: (agencyApproverLogin as any).session,
    ownerSession: (ownerLogin as any).session,
  };
}

// Per addendum-039-asset-gated-submission.md, credential_items now
// reference a real, active asset via asset_id rather than carrying
// free-text userid/hostname — this helper creates a fresh asset for the
// given system by default so every existing call site gets a valid
// submission without having to manage assets by hand. Pass
// credential_items in overrides to override the default entirely (e.g. to
// test invalid/duplicate/cross-system asset_id values).
async function validSubmission(systemId: string, overrides: Record<string, unknown> = {}) {
  const defaultCredentialItems = overrides.credentialItems ?? (systemId
    ? [{ assetId: (await createAsset(systemId, { hostname: "host-01" })).id, hostnameDescription: "test host" }]
    : []);
  return {
    systemId: systemId,
    justification: "Investigate a production incident requiring elevated access.",
    srNumber: "SR-1001",
    activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    ...overrides,
    credentialItems: defaultCredentialItems,
  };
}

import type { SuiteContext } from "./00-context.ts";

export async function run03Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;
  await t.step("my-requests: negative — unauthenticated", async () => {
    const res = await req("/requests/my-requests");
    assertEquals(res.status, 403);
  });

  await t.step("search: positive — matches by request_number substring", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const partial = request.requestNumber.slice(3, 10);

    const res = await req(`/requests/search?q=${encodeURIComponent(partial)}`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.requests.find((r: any) => r.id === request.id));
  });

  await t.step("search: positive — empty query returns empty list", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests/search?q=", { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.requests, []);
  });

  // ── Search visibility is system-scoped (addendum-028-visibility-fix-and-
  // emergency-override.md) — distinct from the dashboard-list rule, which
  // stays step-scoped (see the "my-requests" tests above/below). ──────────

  await t.step("search: bounds — non-empty queries must be 3-128 characters", async () => {
    const s = await setupScenario(adminId);
    for (const query of ["x", "x".repeat(129)]) {
      const res = await req(`/requests/search?q=${encodeURIComponent(query)}`, {
        headers: authHeaders(s.submitterSession),
      });
      assertEquals(res.status, 400);
    }
  });

  await t.step("search: positive — a reviewer whose own step has already passed CAN still find the request (the reported bug)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/search?q=${encodeURIComponent(request.requestNumber.slice(3, 10))}`, { headers: authHeaders(s.vendorApproverSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const found = data.requests.find((r: any) => r.id === request.id);
    assertExists(found);
    // addendum-096: findable (system-scoped) is not actionable — their own
    // step already passed, so the row is flagged as NOT pending them.
    assertEquals(found.viewerIsCurrentStepReviewer, false);
  });

  await t.step("search: positive — a later step's reviewer can already find the request before their own step is reached", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const res = await req(`/requests/search?q=${encodeURIComponent(request.requestNumber.slice(3, 10))}`, { headers: authHeaders(s.agencyApproverSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const found = data.requests.find((r: any) => r.id === request.id);
    assertExists(found);
    assertEquals(found.viewerCanOverride, true);
    assertEquals(found.viewerIsCurrentStepReviewer, false);
  });

  await t.step("search: positive — the current step's reviewer is flagged as pending-them on the same row (addendum-096)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Advance to the agency L1 step, then search as that step's reviewer.
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    const res = await req(`/requests/search?q=${encodeURIComponent(request.requestNumber.slice(3, 10))}`, { headers: authHeaders(s.agencyApproverSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const found = data.requests.find((r: any) => r.id === request.id);
    assertExists(found);
    assertEquals(found.viewerIsCurrentStepReviewer, true);
  });

  await t.step("search: negative — a user with no reviewer/submitter relationship to the system still can't find the request", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const outsider = await createActiveUser({ fullName: "SearchOutsider", email: uniqueEmail("searchoutsider"), password: "OutPass!2026", affiliation: "vendor" });
    const login = await loginAs(outsider.email, "OutPass!2026");
    const res = await req(`/requests/search?q=${encodeURIComponent(request.requestNumber.slice(3, 10))}`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.requests.find((r: any) => r.id === request.id), undefined);
  });

  // ── Emergency override (addendum-028-visibility-fix-and-emergency-override.md) ──

  await t.step("step-decision: negative — a downstream reviewer cannot decide an earlier step without override:true", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Request is at step 1 (vendor L2). Agency L1 (step 2) tries to decide
    // it without the override flag.
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" },
    });
    assertEquals(res.status, 403);
  });

  await t.step("step-decision: negative — an UPSTREAM (past-step) reviewer cannot override a later step even with override:true", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Vendor L2 approves step 1 — request moves to step 2 (agency L1).
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });

    // Vendor L2 tries to override step 2 (agency L1) — their own step
    // (ordinal 2) is BEHIND the current step (ordinal 3), not eligible.
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve", override: true },
    });
    assertEquals(res.status, 403);
  });

  await t.step("step-decision: positive — a downstream reviewer CAN override an earlier stuck step with override:true, flagged and audited distinctly", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Request stuck at step 1 (vendor L2). Agency L1 (step 2) is downstream
    // and invokes the override.
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve", notes: "Vendor L2 uncontactable, escalated.", override: true },
    });
    assertEquals(res.status, 200);

    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    const decidedStep = detail.approvalSteps.find((st: any) => st.stepOrdinal === 2);
    assertEquals(decidedStep.stepStatus, "approved");
    assertEquals(decidedStep.decidedViaOverride, true);
    assertEquals(decidedStep.decidedBy, s.agencyApprover.id);
    // Advanced to the next step (agency L1's own step, ordinal 3) as normal.
    assertEquals(detail.request.currentStepOrdinal, 3);
  });

  await t.step("step-decision: positive — override respects the same notes rules as a normal decision (optional for approve, required for reject)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Reject via override with no notes — same rule as a normal reject, still 400.
    const rejectNoNotes = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "reject", override: true },
    });
    assertEquals(rejectNoNotes.status, 400);

    // Approve via override with no notes — allowed, same as a normal approve.
    const approveNoNotes = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve", override: true },
    });
    assertEquals(approveNoNotes.status, 200);
  });

  await t.step("approver-edit: negative — only current step's reviewer can edit", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/approver-edit`, {
      method: "PUT", headers: authHeaders(s.agencyApproverSession), body: await validSubmission(s.system.id),
    });
    assertEquals(res.status, 403);
  });

  await t.step("approver-edit: positive — current reviewer edits content without advancing workflow", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const res = await req(`/requests/${request.id}/approver-edit`, {
      method: "PUT", headers: authHeaders(s.vendorApproverSession),
      body: await validSubmission(s.system.id, { justification: "Edited by approver for clarity." }),
    });
    assertEquals(res.status, 200);

    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.justification, "Edited by approver for clarity.");
    assertEquals(detail.request.currentStepOrdinal, 2);
    assertEquals(detail.request.status, "submitted");
  });

  // ── Topology variety (Appendix K1/K5, K3) ──────────────────────────────
  // setupScenario's fixed vendor L2 -> agency L1 shape is exercised
  // everywhere above; these two prove the lifecycle (submit -> approve
  // through every step in order -> owner terminal) also works for a
  // single-step agency-only workflow and a longer 4-step chain spanning
  // both vendor approval tiers and both agency approval tiers.

  await t.step("full lifecycle: positive — single-step agency-only workflow (K1/K5) reaches owner terminal in one hop", async () => {
    const owner = await createActiveUser({ fullName: "SingleStepOwner", email: uniqueEmail("singlestepowner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1, agencyL1 } = await createSingleStepAgencySystem(adminId, owner);

    const submitter = await createActiveUser({ fullName: "SingleStepSubmitter", email: uniqueEmail("singlestepsubmitter"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    const agencyApprover = await createActiveUser({ fullName: "SingleStepAgencyAppr", email: uniqueEmail("singlestepagencyappr"), password: "AgencyApprPass!2026", affiliation: "agency" });
    await addMember(agencyL1, agencyApprover, adminId);

    const submitterLogin = await loginAs(submitter.email, "SubmitPass!2026");
    const agencyApproverLogin = await loginAs(agencyApprover.email, "AgencyApprPass!2026");
    const ownerLogin = await loginAs(owner.email, "OwnerPass!2026");

    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders((submitterLogin as any).session), body: await validSubmission(system.id),
    });
    assertEquals(submitRes.status, 201);
    const { request } = await submitRes.json();
    // createSingleStepAgencySystem's workflow is [submitter(vendor L1),
    // agencyL1] — ordinal 1 (submitter) already decided, so
    // current_step_ordinal starts at 2, the one real approval step. See
    // addendum-027-submitter-as-workflow-step-one.md.
    assertEquals(request.currentStepOrdinal, 2);

    const decisionRes = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders((agencyApproverLogin as any).session), body: { decision: "approve" },
    });
    assertEquals(decisionRes.status, 200);

    const afterDecision = await req(`/requests/${request.id}`, { headers: authHeaders((submitterLogin as any).session) }).then(r => r.json());
    assertEquals(afterDecision.request.currentStepOrdinal, 0);
    assertEquals(afterDecision.request.status, "under_review");

    const ownerRes = await req(`/requests/${request.id}/owner-decision`, {
      method: "POST", headers: authHeaders((ownerLogin as any).session), body: { decision: "approve" },
    });
    assertEquals(ownerRes.status, 200);
    const final = await req(`/requests/${request.id}`, { headers: authHeaders((submitterLogin as any).session) }).then(r => r.json());
    assertEquals(final.request.status, "approved");
  });

  await t.step("full lifecycle: positive — 4-step chain (K3: vendor L2 -> vendor L3 -> agency L1 -> agency L2) advances ordinal at every hop before reaching owner terminal", async () => {
    const owner = await createActiveUser({ fullName: "FourStepOwner", email: uniqueEmail("fourstepowner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1, vendorL2, vendorL3, agencyL1, agencyL2 } = await createFourStepSystem(adminId, owner);

    const submitter = await createActiveUser({ fullName: "FourStepSubmitter", email: uniqueEmail("fourstepsubmitter"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    const vendorL2Approver = await createActiveUser({ fullName: "FourStepVendorL2", email: uniqueEmail("fourstepvendorl2"), password: "VendorL2Pass!2026", affiliation: "vendor" });
    await addServingMember(vendorL2, vendorL2Approver, adminId);
    const vendorL3Approver = await createActiveUser({ fullName: "FourStepVendorL3", email: uniqueEmail("fourstepvendorl3"), password: "VendorL3Pass!2026", affiliation: "vendor" });
    await addServingMember(vendorL3, vendorL3Approver, adminId);
    const agencyL1Approver = await createActiveUser({ fullName: "FourStepAgencyL1", email: uniqueEmail("fourstepagencyl1"), password: "AgencyL1Pass!2026", affiliation: "agency" });
    await addMember(agencyL1, agencyL1Approver, adminId);
    const agencyL2Approver = await createActiveUser({ fullName: "FourStepAgencyL2", email: uniqueEmail("fourstepagencyl2"), password: "AgencyL2Pass!2026", affiliation: "agency" });
    await addMember(agencyL2, agencyL2Approver, adminId);

    const submitterSession = (await loginAs(submitter.email, "SubmitPass!2026") as any).session;
    const vendorL2Session = (await loginAs(vendorL2Approver.email, "VendorL2Pass!2026") as any).session;
    const vendorL3Session = (await loginAs(vendorL3Approver.email, "VendorL3Pass!2026") as any).session;
    const agencyL1Session = (await loginAs(agencyL1Approver.email, "AgencyL1Pass!2026") as any).session;
    const agencyL2Session = (await loginAs(agencyL2Approver.email, "AgencyL2Pass!2026") as any).session;
    const ownerSession = (await loginAs(owner.email, "OwnerPass!2026") as any).session;

    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(submitterSession), body: await validSubmission(system.id) });
    assertEquals(submitRes.status, 201);
    const { request } = await submitRes.json();
    // createFourStepSystem's workflow is [submitter(vendorL1), vendorL2,
    // vendorL3, agencyL1, agencyL2] — ordinal 1 already decided, so
    // current_step_ordinal starts at 2. See
    // addendum-027-submitter-as-workflow-step-one.md.
    assertEquals(request.currentStepOrdinal, 2);

    const step1 = await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(vendorL2Session), body: { decision: "approve" } });
    assertEquals(step1.status, 200);
    let detail = await req(`/requests/${request.id}`, { headers: authHeaders(submitterSession) }).then(r => r.json());
    assertEquals(detail.request.currentStepOrdinal, 3);

    const step2 = await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(vendorL3Session), body: { decision: "approve" } });
    assertEquals(step2.status, 200);
    detail = await req(`/requests/${request.id}`, { headers: authHeaders(submitterSession) }).then(r => r.json());
    assertEquals(detail.request.currentStepOrdinal, 4);

    const step3 = await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(agencyL1Session), body: { decision: "approve" } });
    assertEquals(step3.status, 200);
    detail = await req(`/requests/${request.id}`, { headers: authHeaders(submitterSession) }).then(r => r.json());
    assertEquals(detail.request.currentStepOrdinal, 5);

    const step4 = await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(agencyL2Session), body: { decision: "approve" } });
    assertEquals(step4.status, 200);
    detail = await req(`/requests/${request.id}`, { headers: authHeaders(submitterSession) }).then(r => r.json());
    assertEquals(detail.request.currentStepOrdinal, 0);

    const ownerRes = await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(ownerSession), body: { decision: "approve" } });
    assertEquals(ownerRes.status, 200);
    detail = await req(`/requests/${request.id}`, { headers: authHeaders(submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "approved");
  });

  await t.step("delete system: negative — cannot delete a system with open requests", async () => {
    const s = await setupScenario(adminId);
    await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const res = await req(`/admin/systems/${s.system.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  // IDOR negative tests (§2 / addendum-033 authorization-scoping discipline):
  // Authenticated sessions that lack admin role must be rejected by admin-gated routes.

  await t.step("delete system: negative — non-admin session rejected (IDOR §2)", async () => {
    const s = await setupScenario(adminId);
    const res = await req(`/admin/systems/${s.system.id}`, { method: "DELETE", headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 403);
  });

  await t.step("delete team member: negative — non-admin session rejected (IDOR §2)", async () => {
    const s = await setupScenario(adminId);
    const extraUser = await createActiveUser({ fullName: "ExtraMember", email: uniqueEmail("extramember"), password: "ExtraPass!2026", affiliation: "agency" });
    const { vendorL1: _vl, vendorL2: _vl2, agencyL1, primaryOwner: _po } = await createWiredSystem(adminId, extraUser);
    const membership = await addMember(agencyL1, extraUser, adminId);
    const res = await req(`/teams/${agencyL1.id}/members/${membership.id}`, { method: "DELETE", headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 403);
  });

  await t.step("owner-pa mapping: negative — non-admin session rejected (IDOR §2)", async () => {
    const s = await setupScenario(adminId);
    const paCluster = await createCluster("pa-neg", adminId);
    const paTeam = await createTeam(paCluster, 1, adminId);
    const { vendorL1: _vl3, vendorL2: _vl4, agencyL1: _al, primaryOwner } = await createWiredSystem(adminId, s.owner);
    const res = await req("/admin/mappings/owner-pa", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: { systemOwnerId: primaryOwner.id, paTeamId: paTeam.id },
    });
    assertEquals(res.status, 403);
  });

  await t.step("audit timeline: negative — unauthenticated request rejected (§2 session gate)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    // No auth headers — session gate must reject.
    const res = await req(`/audit/request/${request.id}`);
    assertEquals(res.status, 401);
  });
}
