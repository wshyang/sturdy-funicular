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
  const { system, vendorL1, vendorL2, agencyL1, primaryOwner } = await createWiredSystem(adminId, owner);

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
    system, owner, primaryOwner, submitter, vendorApprover, agencyApprover,
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

export async function run02Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;
  await t.step("resubmit: positive — resets to step 1, rebuilds snapshot (return_count increments twice per cycle — see comment, a documented FDS divergence)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const keyMaterialBefore = await requestKeyMaterial.findByRequest(request.id);
    assertExists(keyMaterialBefore);

    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "return", notes: "fix pls" } });

    const res = await req(`/requests/${request.id}/resubmit`, {
      method: "PUT", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { justification: "Updated justification with more detail." }),
    });
    assertEquals(res.status, 200);

    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "submitted");
    // Resubmission re-decides the submitter's own Step 1 fresh, so ordinal
    // resumes at 2 (the first approval step) — see
    // addendum-027-submitter-as-workflow-step-one.md.
    assertEquals(detail.request.currentStepOrdinal, 2);
    assertEquals(detail.request.returnCount, 2);
    assertEquals(detail.request.justification, "Updated justification with more detail.");

    // Resubmit does NOT regenerate key material — same row from initial submission.
    const keyMaterialAfter = await requestKeyMaterial.findByRequest(request.id);
    assertExists(keyMaterialAfter);
    assertEquals(keyMaterialAfter!.id, keyMaterialBefore!.id);
    assertEquals(keyMaterialAfter!.publicKey, keyMaterialBefore!.publicKey);

    // Email notification (addendum-044) #3 — step-2 reviewer team needs a fresh review.
    const resubmittedEmail = await latestSentNotification("request.resubmitted_step2");
    assertExists(resubmittedEmail);
    assertEquals(sentNotificationEmailSnapshots(resubmittedEmail), [s.vendorApprover.email]);
  });

  await t.step("owner-decision: negative — not yet at owner terminal", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
    assertEquals(res.status, 400);
  });

  await t.step("owner-decision: negative — non-owner/delegate forbidden", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    assertEquals(res.status, 403);
  });

  await t.step("owner-decision: positive — approve sets status approved", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve", notes: "Approved." } });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "approved");

    // Email notifications (addendum-044) #8/#10 — agency L1 (issue
    // credential) + submitter. #9 (PA team) has no PA mapping in this
    // scenario, covered separately below.
    const agencyL1Email = await latestSentNotification("request.owner_approved_agency_l1");
    assertExists(agencyL1Email);
    assertEquals(sentNotificationEmailSnapshots(agencyL1Email), [s.agencyApprover.email]);
    const approvedSubmitterEmail = await latestSentNotification("request.owner_approved_submitter");
    assertExists(approvedSubmitterEmail);
    assertEquals(sentNotificationEmailSnapshots(approvedSubmitterEmail), [s.submitter.email]);
  });

  await t.step("owner-decision: positive — backup owner approves (authorized identically to primary owner)", async () => {
    const s = await setupScenario(adminId);
    const backupOwner = await createActiveUser({ fullName: "BackupOwner", email: uniqueEmail("backupowner"), password: "BackupOwnerPass!2026", affiliation: "agency" });
    await systemOwners.create({
      id: generateId(), systemId: s.system.id, userId: backupOwner.id, kind: "backup", createdBy: adminId, createdAt: now(), expiresAfter: null,
    });
    const backupLogin = await loginAs(backupOwner.email, "BackupOwnerPass!2026");

    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/owner-decision`, {
      method: "POST", headers: authHeaders((backupLogin as any).session), body: { decision: "approve", notes: "Approved by backup owner." },
    });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "approved");
    assertEquals(detail.request.ownerDecisionBy, backupOwner.id);
  });

  await t.step("owner-decision: positive — backup owner rejects", async () => {
    const s = await setupScenario(adminId);
    const backupOwner = await createActiveUser({ fullName: "BackupOwnerReject", email: uniqueEmail("backupownerreject"), password: "BackupOwnerRejPass!2026", affiliation: "agency" });
    await systemOwners.create({
      id: generateId(), systemId: s.system.id, userId: backupOwner.id, kind: "backup", createdBy: adminId, createdAt: now(), expiresAfter: null,
    });
    const backupLogin = await loginAs(backupOwner.email, "BackupOwnerRejPass!2026");

    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/owner-decision`, {
      method: "POST", headers: authHeaders((backupLogin as any).session), body: { decision: "reject", notes: "Rejected by backup owner." },
    });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "rejected");
    assertEquals(detail.request.ownerDecisionBy, backupOwner.id);

    // Email notification (addendum-044) #12 — submitter.
    const ownerRejectedEmail = await latestSentNotification("request.owner_rejected");
    assertExists(ownerRejectedEmail);
    assertEquals(sentNotificationEmailSnapshots(ownerRejectedEmail), [s.submitter.email]);
  });

  await t.step("owner-decision: positive — return sends the submitter an email (addendum-044 #11)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/owner-decision`, {
      method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "return", notes: "Needs more detail before I can approve." },
    });
    assertEquals(res.status, 200);

    const ownerReturnedEmail = await latestSentNotification("request.owner_returned");
    assertExists(ownerReturnedEmail);
    assertEquals(sentNotificationEmailSnapshots(ownerReturnedEmail), [s.submitter.email]);
  });

  await t.step("owner-decision: positive — backup owner approves, PA notification still routes to the PRIMARY owner's PA team (Constraint #4)", async () => {
    const s = await setupScenario(adminId);
    const backupOwner = await createActiveUser({ fullName: "BackupOwnerPA", email: uniqueEmail("backupownerpa"), password: "BackupOwnerPAPass!2026", affiliation: "agency" });
    await systemOwners.create({
      id: generateId(), systemId: s.system.id, userId: backupOwner.id, kind: "backup", createdBy: adminId, createdAt: now(), expiresAfter: null,
    });
    const backupLogin = await loginAs(backupOwner.email, "BackupOwnerPAPass!2026");

    // Assign a PA team to the PRIMARY owner only — never to the backup owner.
    const paCluster = await createCluster("pa", adminId);
    const paTeam = await createTeam(paCluster, 1, adminId);
    const paMember = await createActiveUser({ fullName: "PAMember", email: uniqueEmail("pamember"), password: "PAMemberPass!2026", affiliation: "agency" });
    await addMember(paTeam, paMember, adminId);
    await req("/admin/mappings/owner-pa", {
      method: "POST", headers: authHeaders(adminSession), body: { systemOwnerId: s.primaryOwner.id, paTeamId: paTeam.id },
    });

    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });

    // The BACKUP owner, not the primary, makes the terminal decision.
    const res = await req(`/requests/${request.id}/owner-decision`, {
      method: "POST", headers: authHeaders((backupLogin as any).session), body: { decision: "approve", notes: "Approved by backup." },
    });
    assertEquals(res.status, 200);

    const timelineRes = await req(`/audit/request/${request.id}`, { headers: authHeaders(s.submitterSession) });
    const timeline = await timelineRes.json();
    const approvedEntry = timeline.timeline.find((e: any) => e.action === "request.owner_approved");
    assertExists(approvedEntry);
    assertEquals(approvedEntry.details.pa_team_notified, true);

    // Email notification (addendum-044) #9 — the PA team.
    const paTeamEmail = await latestSentNotification("request.owner_approved_pa_team");
    assertExists(paTeamEmail);
    assertEquals(sentNotificationEmailSnapshots(paTeamEmail), [paMember.email]);
  });

  await t.step("issue-credential: negative — request not yet approved", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
    assertEquals(res.status, 400);
  });

  await t.step("issue-credential: positive — agency reviewer marks issued", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "credential_issued");

    // Email notification (addendum-044) #14 — submitter.
    const issuedEmail = await latestSentNotification("request.credential_issued");
    assertExists(issuedEmail);
    assertEquals(sentNotificationEmailSnapshots(issuedEmail), [s.submitter.email]);
  });

  // addendum-033-authorization-scoping-test-discipline.md: canReview's
  // resource check exists (line-read confirmed) but had no dedicated
  // cross-relationship negative test — only the status-precondition negative
  // above. The submitter has a REAL relationship to this exact request (they
  // submitted it) but occupies the Step 1 submitter role, not a reviewer
  // role, so canReview(submitterId, systemId) must reject them — a stronger
  // test than an unrelated third party, since it proves the check is keyed
  // on the caller's specific relationship, not merely "has this user ever
  // touched this request."
  await t.step("issue-credential: negative — the submitter of this same request is not a reviewer, forbidden", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 403);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "approved");
  });

  await t.step("close: negative — credential not yet issued", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/close`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: {} });
    assertEquals(res.status, 400);
  });

  await t.step("close: positive — full lifecycle reaches closed", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });

    const res = await req(`/requests/${request.id}/close`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { closingNotes: "Done." } });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "closed");

    // Email notifications (addendum-044) #15/#16 — submitter + system owner.
    const closedSubmitterEmail = await latestSentNotification("request.closed_submitter");
    assertExists(closedSubmitterEmail);
    assertEquals(sentNotificationEmailSnapshots(closedSubmitterEmail), [s.submitter.email]);
    const closedOwnerEmail = await latestSentNotification("request.closed_system_owner");
    assertExists(closedOwnerEmail);
    assertEquals(sentNotificationEmailSnapshots(closedOwnerEmail), [s.owner.email]);
  });

  // The submitter can now self-close their own credential_issued request.
  // The requester is not a reviewer, but once they have retrieved the
  // credential they may close it themselves (the requester-self-close path,
  // formerly gated by the removed TEST_SECRET_AUTORELEASE_ENABLED flag, is
  // now unconditional) so the tenant is told the password is no longer
  // needed.
  await t.step("close: positive — the submitter of this same request can self-close once the credential is issued", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });

    const res = await req(`/requests/${request.id}/close`, { method: "POST", headers: authHeaders(s.submitterSession), body: {} });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "closed");
  });

  await t.step("admin-reset: negative — non-admin forbidden", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/admin-reset`, { method: "POST", headers: authHeaders(s.submitterSession), body: {} });
    assertEquals(res.status, 403);
  });

  await t.step("admin-reset: negative — closed requests cannot be reset", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
    await req(`/requests/${request.id}/close`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: {} });

    const res = await req(`/requests/${request.id}/admin-reset`, { method: "POST", headers: authHeaders(adminSession), body: {} });
    assertEquals(res.status, 400);
  });

  await t.step("admin-reset: positive — resets stuck request back to submitter, increments return_count", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}/admin-reset`, { method: "POST", headers: authHeaders(adminSession), body: { notes: "Stuck, resetting." } });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "returned_to_vendor");
    assertEquals(detail.request.returnCount, 1);
    // Step 1 (the submitter's own row) is deliberately left untouched by a
    // reset — resetting means "send the later approval steps back," not
    // "erase the submitter's original decision record." See
    // addendum-027-submitter-as-workflow-step-one.md.
    assertEquals(detail.approvalSteps.find((s: any) => s.stepOrdinal === 1).stepStatus, "submitted");
    // The vendor L2 approval step (ordinal 2), previously approved above,
    // IS reset to pending.
    assertEquals(detail.approvalSteps.find((s: any) => s.stepOrdinal === 2).stepStatus, "pending");

    // Email notification (addendum-044) #13 — submitter.
    const resetEmail = await latestSentNotification("request.admin_reset");
    assertExists(resetEmail);
    assertEquals(sentNotificationEmailSnapshots(resetEmail), [s.submitter.email]);
  });

  await t.step("my-requests: positive — submitter sees own request", async () => {
    const s = await setupScenario(adminId);
    await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const res = await req("/requests/my-requests", { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.requests.length > 0, true);
  });

  await t.step("my-requests: positive — owner pre-routing gate hides in-flight request until owner terminal (Constraint #11)", async () => {
    const s = await setupScenario(adminId);
    await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });

    const ownerRes = await req("/requests/my-requests", { headers: authHeaders(s.ownerSession) });
    const ownerData = await ownerRes.json();
    assertEquals(ownerData.requests.length, 0);
  });
}
