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

export async function run01Steps(t: Deno.TestContext, context: SuiteContext): Promise<void> {
  const { adminId, adminSession } = context;
  await t.step("submit: negative — unauthenticated", async () => {
    const res = await req("/requests", { method: "POST", body: {} });
    assertEquals(res.status, 403);
  });

  await t.step("submit: negative — missing system_id", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission("" as any),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — missing/invalid content fields", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: { systemId: s.system.id, justification: "", srNumber: "SR-1", activityStartAt: "x", activityEndAt: "y", credentialItems: [] },
    });
    assertEquals(res.status, 400);
  });

  // ── Asset-gated submission (addendum-039-asset-gated-submission.md) ────

  await t.step("submit: negative — asset_id missing from a credential item", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { credentialItems: [{ hostnameDescription: "no asset_id" }] }),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — asset_id references a nonexistent asset", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { credentialItems: [{ assetId: "00000000-0000-0000-0000-000000000999" }] }),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — asset_id belongs to a different system", async () => {
    const s = await setupScenario(adminId);
    const otherOwner = await createActiveUser({ fullName: "OtherOwner", email: uniqueEmail("otherowner"), password: "OtherPass!2026", affiliation: "agency" });
    const { system: otherSystem } = await createWiredSystem(adminId, otherOwner);
    const foreignAsset = await createAsset(otherSystem.id);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { credentialItems: [{ assetId: foreignAsset.id }] }),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — asset_id references an invalidated asset", async () => {
    const s = await setupScenario(adminId);
    const invalidated = await createAsset(s.system.id, { expiresAfter: now() });
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { credentialItems: [{ assetId: invalidated.id }] }),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — the same asset_id selected more than once", async () => {
    const s = await setupScenario(adminId);
    const asset = await createAsset(s.system.id);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { credentialItems: [{ assetId: asset.id }, { assetId: asset.id }] }),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — activity end before start", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, {
        activityStartAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      }),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — no credential items", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { credentialItems: [] }),
    });
    assertEquals(res.status, 400);
  });

  await t.step("submit: negative — non-submitter (vendor L2 approver) forbidden", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.vendorApproverSession),
      body: await validSubmission(s.system.id),
    });
    assertEquals(res.status, 403);
  });

  await t.step("submit: positive — creates request with generated number, snapshot steps, credential items", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertExists(data.request.requestNumber);
    assertEquals(data.request.status, "submitted");
    // Ordinal 1 (the submitter step) is already decided at creation time —
    // current_step_ordinal starts at 2, the first APPROVAL step. See
    // addendum-027-submitter-as-workflow-step-one.md.
    assertEquals(data.request.currentStepOrdinal, 2);
    assertEquals(data.credentialItems.length, 1);

    // Email notifications (addendum-044) #1/#2 — reviewer team + submitter confirmation.
    const reviewerEmail = await latestSentNotification("request.submitted");
    assertExists(reviewerEmail);
    assertEquals(sentNotificationEmailSnapshots(reviewerEmail), [s.vendorApprover.email]);
    const confirmationEmail = await latestSentNotification("request.submitted_confirmation");
    assertExists(confirmationEmail);
    assertEquals(sentNotificationEmailSnapshots(confirmationEmail), [s.submitter.email]);
  });

  // V2 automated-credential-delivery groundwork — see
  // addendum-023-request-key-material-and-secret-delivery-contract.md.
  await t.step("submit: positive — generates request_key_material (public key + private_key_wrap_key, no private key persisted)", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    assertEquals(res.status, 201);
    const data = await res.json();

    const keyMaterial = await requestKeyMaterial.findByRequest(data.request.id);
    assertExists(keyMaterial);
    assertEquals(keyMaterial!.keyAlgorithm, "RSA-OAEP-2048-SHA256");

    const publicKeyBytes = Uint8Array.from(atob(keyMaterial!.publicKey), (c) => c.charCodeAt(0));
    assertEquals(publicKeyBytes[0], 0x30); // DER SPKI SEQUENCE tag — real key material, not a placeholder string

    const wrapKeyBytes = Uint8Array.from(atob(keyMaterial!.privateKeyWrapKey), (c) => c.charCodeAt(0));
    assertEquals(wrapKeyBytes.length, 32);
  });

  // V2 extension — see addendum-012-multi-credential-type-requests.md.
  // credential_type is now derived from the selected asset, not submitted
  // by the client — see addendum-039-asset-gated-submission.md.
  await t.step("submit: positive — credential_type is derived from the selected asset's own type", async () => {
    const s = await setupScenario(adminId);
    const asset = await createAsset(s.system.id, { hostname: "host-nodefault", credentialType: "password" });
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, {
        credentialItems: [{ assetId: asset.id }],
      }),
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.credentialItems[0].credentialType, "password");
  });

  await t.step("submit: positive — 'token' and 'device' asset types persist and round-trip through GET", async () => {
    const s = await setupScenario(adminId);
    const tokenAsset = await createAsset(s.system.id, { hostname: "issuer-system", credentialName: "tok-abc123", credentialType: "token" });
    const deviceAsset = await createAsset(s.system.id, { hostname: "rack-3-shelf-2", credentialName: "asset-tag-42", credentialType: "device" });
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, {
        credentialItems: [
          { assetId: tokenAsset.id },
          { assetId: deviceAsset.id },
        ],
      }),
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.credentialItems.length, 2);
    assertEquals(data.credentialItems[0].credentialType, "token");
    assertEquals(data.credentialItems[1].credentialType, "device");

    // Round-trips correctly through GET too, not just the create response —
    // live-joined against the asset (enrichCredentialItemsWithAssets), not
    // a frozen snapshot.
    const getRes = await req(`/requests/${data.request.id}`, { headers: authHeaders(s.submitterSession) });
    const getData = await getRes.json();
    assertEquals(getData.credentialItems.find((i: any) => i.credentialName === "tok-abc123").credentialType, "token");
  });

  await t.step("get: positive — submitter can view own request with full detail", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const res = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.request.id, request.id);
    // 3 steps total: the submitter step (ordinal 1, already 'submitted')
    // plus the 2 approval steps (vendor L2, agency L1) — see
    // addendum-027-submitter-as-workflow-step-one.md.
    assertEquals(data.approvalSteps.length, 3);
    assertEquals(data.approvalSteps.find((s: any) => s.stepOrdinal === 1).stepStatus, "submitted");
    assertEquals(data.submitter.id, s.submitter.id);
  });

  await t.step("get: negative — 404 (not 403) for a request outside caller's visibility (no existence disclosure)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const outsider = await createActiveUser({ fullName: "Outsider", email: uniqueEmail("reqoutsider"), password: "OutPass!2026", affiliation: "vendor" });
    const login = await loginAs(outsider.email, "OutPass!2026");
    const res = await req(`/requests/${request.id}`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 404);
  });

  await t.step("get: negative — nonexistent id", async () => {
    const s = await setupScenario(adminId);
    const res = await req(`/requests/00000000-0000-0000-0000-000000000999`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 404);
  });

  // ── GET-request visibility (addendum-013-step-scoped-request-visibility-fix.md,
  // narrowed by addendum-028-visibility-fix-and-emergency-override.md) ──────
  // setupScenario's workflow is vendor L2 (step 1) -> agency L1 (step 2) -> owner
  // terminal. Per addendum-028, direct GET (like search) is now SYSTEM-scoped
  // while pre-owner — any team mapped to the system as a reviewer can view the
  // request regardless of current step — while Constraint #11 (owner
  // pre-routing gate) is still fully enforced on this path.

  await t.step("get: positive — a later step's reviewer CAN see the request while an earlier step is still active (system-scoped view, addendum-028)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Request is at step 1 (vendor L2). Agency L1 is step 2 — under
    // addendum-028's system-scoped view rule they CAN already see it (this
    // is what lets them determine override-eligibility before their own
    // step is reached); they still cannot ACT on it (see step-decision
    // override tests below) until it's genuinely their turn or they invoke
    // the emergency override.
    const res = await req(`/requests/${request.id}`, { headers: authHeaders(s.agencyApproverSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.request.viewerIsCurrentStepReviewer, false);
    assertEquals(data.request.viewerCanOverride, true);
  });

  await t.step("get: negative — owner cannot bypass Constraint #11 via direct GET before the owner terminal", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const res = await req(`/requests/${request.id}`, { headers: authHeaders(s.ownerSession) });
    assertEquals(res.status, 404);
  });

  await t.step("get: positive — a reviewer is flagged as the CURRENT step's team exactly when their team's step becomes current", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });

    const res = await req(`/requests/${request.id}`, { headers: authHeaders(s.agencyApproverSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.request.viewerIsCurrentStepReviewer, true);
  });

  await t.step("get: positive — a reviewer RETAINS visibility after their own step has been decided and a later step is active (addendum-028, the reported bug)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Vendor L2 approves step 1 — the request moves to step 2 (agency L1).
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });

    // Vendor L2's own step already passed; per addendum-028, they can still
    // search out and view the request (they just can't act on it again) —
    // this is the exact bug the user demonstrated: approve, then lose the
    // ability to even find the request via Search.
    const res = await req(`/requests/${request.id}`, { headers: authHeaders(s.vendorApproverSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.request.viewerIsCurrentStepReviewer, false);
    // Vendor L2's own step (ordinal 2 in this scenario) is BEHIND the
    // current step (agency L1, ordinal 3) — not eligible to override
    // something that's already downstream of them.
    assertEquals(data.request.viewerCanOverride, false);
  });

  await t.step("get: positive — visibility reverts to the broad historical-role model once the request leaves preOwner", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
    await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });

    // Vendor L2's step is long past, but the request has exited preOwner
    // (status=approved) — deliberately unchanged broad visibility restored.
    const res = await req(`/requests/${request.id}`, { headers: authHeaders(s.vendorApproverSession) });
    assertEquals(res.status, 200);
  });

  await t.step("my-requests: negative — a later step's reviewer's list omits the request while an earlier step is still active", async () => {
    const s = await setupScenario(adminId);
    await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });

    const res = await req("/requests/my-requests", { headers: authHeaders(s.agencyApproverSession) });
    const data = await res.json();
    assertEquals(data.requests.length, 0);
  });

  await t.step("my-requests: positive — the request appears in a reviewer's list exactly when their step becomes current", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });

    const res = await req("/requests/my-requests", { headers: authHeaders(s.agencyApproverSession) });
    const data = await res.json();
    assertExists(data.requests.find((r: any) => r.id === request.id));
  });

  // addendum-096-step-scoped-queue-actionability.md: list rows carry an
  // explicit per-row actionability signal (viewerIsCurrentStepReviewer) —
  // the my-requests analogue of the detail view's existing flag — because
  // "row is in your list" no longer implies "row is at your current step"
  // for admin viewers (VISIBLE_ALL short-circuit).
  await t.step("my-requests: rows carry viewerIsCurrentStepReviewer — false for the submitter, true once the viewer's own step is current", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // The submitter sees their own row, but the current step belongs to the
    // vendor L2 team — not to them.
    let data = await (await req("/requests/my-requests", { headers: authHeaders(s.submitterSession) })).json();
    const submitterRow = data.requests.find((r: any) => r.id === request.id);
    assertExists(submitterRow);
    assertEquals(submitterRow.viewerIsCurrentStepReviewer, false);

    // Advance to the agency L1 step — now the agency approver IS flagged.
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    data = await (await req("/requests/my-requests", { headers: authHeaders(s.agencyApproverSession) })).json();
    const agencyRow = data.requests.find((r: any) => r.id === request.id);
    assertExists(agencyRow);
    assertEquals(agencyRow.viewerIsCurrentStepReviewer, true);
  });

  await t.step("my-requests: an admin+reviewer sees every row (VISIBLE_ALL by design) but is flagged only at their own current step", async () => {
    const s = await setupScenario(adminId);
    // The reported-demo combination (live seed 003): a genuine reviewer who
    // also holds an admin grant. Snapshot is recomputed per request, so the
    // pre-existing session picks the grant up without re-login.
    await grantAdminRole(s.agencyApprover.id, "full_admin", adminId, "Test setup: admin+reviewer combination");

    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    // Parked at vendor L2's step: present in the admin+reviewer's list
    // (surfacing bypassed by design) but flagged as NOT pending them.
    let data = await (await req("/requests/my-requests", { headers: authHeaders(s.agencyApproverSession) })).json();
    const offStepRow = data.requests.find((r: any) => r.id === request.id);
    assertExists(offStepRow, "admin grant keeps the whole-system view on the queue dashboard");
    assertEquals(offStepRow.viewerIsCurrentStepReviewer, false);

    // Advance to THEIR step — the same row is now flagged pending-them.
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    data = await (await req("/requests/my-requests", { headers: authHeaders(s.agencyApproverSession) })).json();
    const atStepRow = data.requests.find((r: any) => r.id === request.id);
    assertExists(atStepRow);
    assertEquals(atStepRow.viewerIsCurrentStepReviewer, true);
  });

  await t.step("step-decision: negative — wrong reviewer (agency approver acting on vendor step) forbidden", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" },
    });
    assertEquals(res.status, 403);
  });

  await t.step("step-decision: negative — reviewer removed from team mid-flight loses authority on the same session (no re-login, re-checked per request)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const memberships = await teamMemberships.findByUser(s.vendorApprover.id);
    const membership = memberships[0];
    assertExists(membership);

    await req(`/teams/${membership.teamId}/members/${membership.id}`, { method: "DELETE", headers: authHeaders(adminSession) });

    // Same session token, reused — isStepReviewer re-checks team membership
    // fresh on every request (server/auth.tsx:305-316); no session
    // invalidation or re-login involved.
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" },
    });
    assertEquals(res.status, 403);
  });

  await t.step("step-decision: negative — invalid decision value", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "maybe" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("step-decision: negative — return/reject without notes rejected", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "return" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("step-decision: positive — approve advances to next step", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve", notes: "ok" },
    });
    assertEquals(res.status, 200);

    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    // Advances from ordinal 2 (vendor L2, just approved) to ordinal 3
    // (agency L1) — see addendum-027-submitter-as-workflow-step-one.md.
    assertEquals(detail.request.currentStepOrdinal, 3);
    assertEquals(detail.request.status, "under_review");

    // Email notification (addendum-044) #4 — next reviewer team (agency L1).
    const nextReviewerEmail = await latestSentNotification("request.step_approved_next_reviewer");
    assertExists(nextReviewerEmail);
    assertEquals(sentNotificationEmailSnapshots(nextReviewerEmail), [s.agencyApprover.email]);
  });

  await t.step("step-decision: positive — final step approval routes to owner terminal (ordinal 0)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    const res = await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
    assertEquals(res.status, 200);

    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.currentStepOrdinal, 0);

    // Email notification (addendum-044) #5 — the owner.
    const ownerNotifyEmail = await latestSentNotification("request.step_approved_owner");
    assertExists(ownerNotifyEmail);
    assertEquals(sentNotificationEmailSnapshots(ownerNotifyEmail), [s.owner.email]);
  });

  await t.step("step-decision: positive — return resets to returned_to_vendor, increments return_count", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "return", notes: "Needs more detail." },
    });
    assertEquals(res.status, 200);

    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "returned_to_vendor");
    assertEquals(detail.request.returnCount, 1);

    // Email notification (addendum-044) #6 — submitter.
    const returnedEmail = await latestSentNotification("request.step_returned");
    assertExists(returnedEmail);
    assertEquals(sentNotificationEmailSnapshots(returnedEmail), [s.submitter.email]);
  });

  await t.step("step-decision: positive — reject is terminal", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "reject", notes: "Not approved." },
    });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "rejected");

    // Email notification (addendum-044) #7 — submitter.
    const rejectedEmail = await latestSentNotification("request.step_rejected");
    assertExists(rejectedEmail);
    assertEquals(sentNotificationEmailSnapshots(rejectedEmail), [s.submitter.email]);
  });

  await t.step("step-decision: negative — cannot act on a request with no pending step (rejected already terminal)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "reject", notes: "no" } });
    const res = await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
    assertEquals(res.status, 400);
  });

  await t.step("resubmit: negative — only original submitter can resubmit", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "return", notes: "fix" } });

    const res = await req(`/requests/${request.id}/resubmit`, {
      method: "PUT", headers: authHeaders(s.vendorApproverSession), body: await validSubmission(s.system.id),
    });
    assertEquals(res.status, 403);
  });

  await t.step("resubmit: negative — only returned_to_vendor requests can be resubmitted", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/resubmit`, {
      method: "PUT", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id),
    });
    assertEquals(res.status, 400);
  });

  // NOTE: the FDS states return_count is incremented once at return-time and
  // NOT incremented again at resubmit-time (a full return+resubmit cycle
  // should net return_count=1). The actual implementation
  // (routes-requests.tsx resubmitRequest) increments return_count a SECOND
  // time on resubmit (`returnCount: request.returnCount + 1` — but
  // stepDecision's 'return' branch already bumped it once), so a single
  // return+resubmit cycle nets return_count=2, not 1. This is a genuine,
  // previously-undocumented spec-vs-implementation divergence — see
  // docs/fidelity-assessment.md. Asserting actual behavior here (2), not the
  // FDS-prescribed behavior (1), since this test suite documents what the
  // code does, not what it should do; flag this as a fix candidate.
}
