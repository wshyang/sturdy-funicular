// Backend contract for the dashboard pending-action CHIPS and the admin
// aggregate tab — the exact wire fields the addendum-196 Playwright suites
// (pending-action-chips.spec.ts, admin-pending-actions.spec.ts) assert on.
// Chips never invent labels: the row's pendingActions[] is serialized from
// deriveViewerPendingActions via annotateViewerPendingActions on
// GET /requests/my-requests; this suite pins that pipeline's shape end-to-end
// (status/step transitions included) so the e2e can trust the vocabulary.
//
// Matrix:
//   1. my-requests row for the CURRENT-step reviewer carries exactly one
//      action: pre_approval/review_step, server label "Review step 1", key
//      pre_approval:review_step:<id>:step:1, deeplink /dashboard/request/<id>.
//   2. the SAME row for the submitter carries an EMPTY pendingActions list
//      (visibility is not actionability — addendum-013/096).
//   3. after the reviewer approves, their derivation empties and the NEXT
//      step's team inherits "Review step 2" (step moves, chip follows).
//   4. owner-terminal: the owner's row carries pre_approval/owner_decision
//      ("Owner decision") — the ordinal-0 fork of the same derivation.
//   5. GET /admin/pending-actions debtor ledger mirrors the same labels and
//      hands each action to a NAMED user (org attribution out of scope here —
//      pending_actions_admin.test.tsx owns the scoping matrix).
//
// Runs on the OWNER's machine (deno suites are not executed in-sandbox).
import { assert, assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystemWithAgencyL2, addMember, addServingMember, createAsset,
} from "./helpers.tsx";

interface WireAction {
  key: string;
  workflowType: string;
  kind: string;
  stepRef: string | null;
  label: string;
  urgency: string;
  deeplink: string;
}

interface WireRow {
  id: string;
  requestNumber: string;
  status: string;
  currentStepOrdinal: number;
  pendingActions?: WireAction[];
}

async function myRequestsRow(session: string, requestId: string): Promise<WireRow | null> {
  const res = await req("/requests/my-requests", { headers: authHeaders(session) });
  assertEquals(res.status, 200);
  const body = await res.json();
  const rows = (body.requests ?? []) as WireRow[];
  return rows.find((row) => row.id === requestId) ?? null;
}

async function soleAction(session: string, requestId: string): Promise<WireAction> {
  const row = await myRequestsRow(session, requestId);
  assert(row, "viewer sees the row at this step");
  const actions = row!.pendingActions ?? [];
  assertEquals(actions.length, 1, "exactly one owed action on this row for this viewer");
  return actions[0]!;
}

Deno.test("dashboard chips + admin pending-actions wire contract (addendum-196)", async (t) => {
  let requestId = "";
  let adminSession = "";
  let submitterSession = "";
  let vendorL2ASession = "";
  let agencyL1ASession = "";
  let agencyL2Session = "";
  let ownerSession = "";
  let vendorL2AEmail = "";
  let agencyL1AEmail = "";

  await t.step("setup: wired system + one open request at vendor L2", async () => {
    await wipeDatabase();
    const admin = await createAdmin("ChipsAdmin!2026");
    const owner = await createActiveUser({ fullName: "Owner Chips", email: uniqueEmail("chipowner"), password: "OwnerPass!2026", affiliation: "agency" });
    const wired = await createWiredSystemWithAgencyL2(admin.id, owner);
    const submitter = await createActiveUser({ fullName: "Submitter Chips", email: uniqueEmail("chipsub"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(wired.vendorL1, submitter, admin.id);
    const l2a = await createActiveUser({ fullName: "VendorL2A Chips", email: uniqueEmail("chipvl2a"), password: "VendorL2Pass!2026", affiliation: "vendor" });
    await addServingMember(wired.vendorL2, l2a, admin.id);
    const al1a = await createActiveUser({ fullName: "AgencyL1A Chips", email: uniqueEmail("chipagl1a"), password: "AgencyL1Pass!2026", affiliation: "agency" });
    await addMember(wired.agencyL1, al1a, admin.id);
    const al2 = await createActiveUser({ fullName: "AgencyL2 Chips", email: uniqueEmail("chipagl2"), password: "AgencyL2Pass!2026", affiliation: "agency" });
    await addMember(wired.agencyL2, al2, admin.id);

    adminSession = ((await loginAs(admin.email, "ChipsAdmin!2026")) as any).session;
    submitterSession = ((await loginAs(submitter.email, "SubmitPass!2026")) as any).session;
    vendorL2ASession = ((await loginAs(l2a.email, "VendorL2Pass!2026")) as any).session;
    agencyL1ASession = ((await loginAs(al1a.email, "AgencyL1Pass!2026")) as any).session;
    agencyL2Session = ((await loginAs(al2.email, "AgencyL2Pass!2026")) as any).session;
    ownerSession = ((await loginAs(owner.email, "OwnerPass!2026")) as any).session;
    vendorL2AEmail = l2a.email;
    agencyL1AEmail = al1a.email;

    const asset = await createAsset(wired.system.id, { hostname: "chip-1", credentialName: "chip-cred" });
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(submitterSession),
      body: {
        systemId: wired.system.id, justification: "Chip wire contract.", srNumber: "SR-9300",
        activityStartAt: new Date(Date.now() + 3_600_000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
        credentialItems: [{ assetId: asset.id }],
      },
    });
    assertEquals(submitRes.status, 201);
    requestId = (await submitRes.json()).request.id;
  });

  await t.step("1) current-step reviewer's my-requests row carries the chip action verbatim", async () => {
    const action = await soleAction(vendorL2ASession, requestId);
    assertEquals(action.workflowType, "pre_approval");
    assertEquals(action.kind, "review_step");
    assertEquals(action.label, "Review step 1", "chip text is the server's cue, verbatim");
    assertEquals(action.stepRef, "step:1");
    assertEquals(action.urgency, "normal");
    assertEquals(
      action.key,
      `pre_approval:review_step:${requestId}:step:1`,
      "key = workflowType:kind:requestId:stepRef — the DOM chip's testid suffix source",
    );
    assertEquals(action.deeplink, `/dashboard/request/${requestId}`);
  });

  await t.step("2) the submitter sees the row but owes NOTHING", async () => {
    const row = await myRequestsRow(submitterSession, requestId);
    assert(row, "the submitter keeps visibility (audit-trail self-view, addendum-028)");
    assertEquals(row!.pendingActions ?? [], [], "visibility is not actionability — no chips for the bystander");
  });

  await t.step("3) approval empties the decider's derivation; the next step inherits its own cue", async () => {
    const approve = await req(`/requests/${requestId}/step-decision`, {
      method: "POST", headers: authHeaders(vendorL2ASession),
      body: { decision: "approve" },
    });
    assertEquals(approve.status, 200);

    const exReviewer = await myRequestsRow(vendorL2ASession, requestId);
    assertEquals(exReviewer, null, "row leaves the decider's queue entirely (step-scoped visibility)");

    const next = await soleAction(agencyL1ASession, requestId);
    assertEquals(next.label, "Review step 2");
    assertEquals(next.stepRef, "step:2");
  });

  await t.step("4) owner-terminal: the owner's row says 'Owner decision'", async () => {
    for (const [session, step] of [[agencyL1ASession, 2], [agencyL2Session, 3]] as const) {
      const approve = await req(`/requests/${requestId}/step-decision`, {
        method: "POST", headers: authHeaders(session), body: { decision: "approve" },
      });
      assertEquals(approve.status, 200, `step ${step} approves`);
    }
    const action = await soleAction(ownerSession, requestId);
    assertEquals(action.workflowType, "pre_approval");
    assertEquals(action.kind, "owner_decision");
    assertEquals(action.label, "Owner decision");
    assertEquals(action.stepRef, null, "ordinal-0 owner step is stepRef-free");
  });

  await t.step("5) admin aggregate ledger mirrors the same vocabulary at each stage", async () => {
    // The request sits at owner-terminal now: the OWNER is the debtor.
    const res = await req("/admin/pending-actions", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    const debtors = (body.debtors ?? []) as Array<{
      user: { id: string; email: string; fullName: string };
      pendingActions: WireAction[];
    }>;
    const ownerDebtor = debtors.find((d) => d.pendingActions.some((a) => a.key.includes(requestId)));
    assert(ownerDebtor, "the aggregate tab names the actor who owes this request's action");
    const ledger = ownerDebtor!.pendingActions.find((a) => a.key.includes(requestId))!;
    assertEquals(ledger.label, "Owner decision", "the admin ledger reuses the identical cue vocabulary");
    assertEquals(ledger.deeplink, `/dashboard/request/${requestId}`);
    // Nobody from an earlier step is still reported for this request.
    assertEquals(
      [vendorL2AEmail, agencyL1AEmail].includes(ownerDebtor!.user.email),
      false,
      "decided steps stop owing",
    );
  });
});
