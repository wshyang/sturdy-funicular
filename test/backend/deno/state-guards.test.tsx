// Forbidden-transition / terminal-guard coverage (GAP B from the test-coverage
// audit, 2026-07-29). requests.test.tsx already proves the *base* forbidden
// transitions (issue on a freshly-submitted request → 400, close before issue
// → 400, step-decision on an already-rejected request → 400), but it never
// drives a request into a POST-APPROVAL terminal (approved / credential_issued
// / closed) and then fires each lifecycle verb at it. Those are the states a
// double-click or a stale UI is most likely to hit, and every route's status
// guard for them was previously unexercised.
//
// Guards are read straight from server/routes-requests.tsx, not guessed:
//   step-decision   status ∈ {submitted,under_review} && ordinal>0, else 400
//                   "This request has no approval step awaiting a decision."
//   owner-decision  status==under_review && ordinal==0, else 400
//                   "This request is not awaiting the owner's terminal decision."
//   issue-credential status==approved, else 400 "Request has not been approved yet."
//   close           status==credential_issued, else 400
//   approver-edit   status ∈ {submitted,under_review} && ordinal>0, else 400
//                   "Request can only be edited while it is at an approval step."
//
// Plus a DB-free unit block asserting the XState machine (getNextState) is
// inert — not throwing — on forbidden event+state pairs: XState v5 ignores an
// event a state has no handler for, so the guarding lives in the route layer
// above, and the machine must leave status UNCHANGED rather than transition.
import { assertEquals, assertStringIncludes } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { getNextState } from "../../../server/workflow-machine.tsx";

async function scenario(adminId: string) {
  const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("sgowner"), password: "OwnerPass!2026", affiliation: "agency" });
  const { system, vendorL1, vendorL2, agencyL1 } = await createWiredSystem(adminId, owner);

  const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("sgsub"), password: "SubmitPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL1, submitter, adminId);
  const vendorApprover = await createActiveUser({ fullName: "VendorApprover", email: uniqueEmail("sgvappr"), password: "VendorApprPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL2, vendorApprover, adminId);
  const agencyApprover = await createActiveUser({ fullName: "AgencyApprover", email: uniqueEmail("sgaappr"), password: "AgencyApprPass!2026", affiliation: "agency" });
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

async function submit(s: Awaited<ReturnType<typeof scenario>>): Promise<string> {
  const asset = await createAsset(s.system.id, { hostname: `sg-host-${Math.random().toString(36).slice(2, 8)}` });
  const res = await req("/requests", {
    method: "POST", headers: authHeaders(s.submitterSession),
    body: {
      systemId: s.system.id,
      justification: "Investigate a production incident requiring elevated access.",
      srNumber: "SR-1001",
      activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      credentialItems: [{ assetId: asset.id, hostnameDescription: "sg host" }],
    },
  });
  const { request } = await res.json();
  return request.id;
}

// Drives a fresh request to each named terminal status and returns its id.
async function driveTo(s: Awaited<ReturnType<typeof scenario>>, target: "approved" | "credential_issued" | "closed" | "rejected"): Promise<string> {
  const id = await submit(s);
  if (target === "rejected") {
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "reject", notes: "no" } });
    return id;
  }
  await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
  await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
  await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
  if (target === "approved") return id;
  await req(`/requests/${id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
  if (target === "credential_issued") return id;
  await req(`/requests/${id}/close`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { closingNotes: "Done." } });
  return id;
}

Deno.test("state-guards", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("SGAdmin!2026");
    adminId = admin.id;
    await loginAs(admin.email, "SGAdmin!2026");
  });

  // ── step-decision fired at fulfillment terminals ────────────────────────

  for (const target of ["approved", "credential_issued", "closed"] as const) {
    await t.step(`step-decision on ${target} → 400 (no approval step awaiting a decision)`, async () => {
      const s = await scenario(adminId);
      const id = await driveTo(s, target);
      const res = await req(`/requests/${id}/step-decision`, {
        method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" },
      });
      assertEquals(res.status, 400);
      const data = await res.json();
      assertStringIncludes(data.error, "no approval step awaiting a decision");
    });
  }

  // ── owner-decision fired at fulfillment terminals ───────────────────────

  for (const target of ["approved", "credential_issued", "closed", "rejected"] as const) {
    await t.step(`owner-decision on ${target} → 400 (not awaiting the owner's terminal decision)`, async () => {
      const s = await scenario(adminId);
      const id = await driveTo(s, target);
      const res = await req(`/requests/${id}/owner-decision`, {
        method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve", notes: "x" },
      });
      assertEquals(res.status, 400);
      const data = await res.json();
      assertStringIncludes(data.error, "not awaiting the owner's terminal decision");
    });
  }

  // ── issue-credential fired at non-approved terminals ──────────────────────

  for (const target of ["credential_issued", "closed", "rejected"] as const) {
    await t.step(`issue-credential on ${target} → 400 (not still 'approved')`, async () => {
      const s = await scenario(adminId);
      const id = await driveTo(s, target);
      const res = await req(`/requests/${id}/issue-credential`, {
        method: "POST", headers: authHeaders(s.agencyApproverSession),
      });
      assertEquals(res.status, 400);
      const data = await res.json();
      assertStringIncludes(data.error, "not been approved");
    });
  }

  // ── close fired at non-credential_issued terminals (incl. double-close) ───

  for (const target of ["approved", "rejected", "closed"] as const) {
    await t.step(`close on ${target} → 400 (credential not issued / already closed)`, async () => {
      const s = await scenario(adminId);
      const id = await driveTo(s, target);
      const res = await req(`/requests/${id}/close`, {
        method: "POST", headers: authHeaders(s.agencyApproverSession), body: { closingNotes: "again" },
      });
      assertEquals(res.status, 400);
    });
  }

  // ── approver-edit immutability after any terminal ─────────────────────────

  for (const target of ["approved", "credential_issued", "closed", "rejected"] as const) {
    await t.step(`approver-edit on ${target} → 400 (only editable while at an approval step)`, async () => {
      const s = await scenario(adminId);
      const id = await driveTo(s, target);
      const res = await req(`/requests/${id}/approver-edit`, {
        method: "PUT", headers: authHeaders(s.agencyApproverSession),
        body: { justification: "post-terminal edit attempt" },
      });
      assertEquals(res.status, 400);
      const data = await res.json();
      assertStringIncludes(data.error, "only be edited while it is at an approval step");
    });
  }

  // ── resubmit fired at non-returned terminals ──────────────────────────────

  for (const target of ["approved", "credential_issued", "closed", "rejected"] as const) {
    await t.step(`resubmit on ${target} → 400 (only a returned request can be resubmitted)`, async () => {
      const s = await scenario(adminId);
      const id = await driveTo(s, target);
      const res = await req(`/requests/${id}/resubmit`, {
        method: "PUT", headers: authHeaders(s.submitterSession),
        body: { justification: "resubmit attempt", srNumber: "SR-9", credentialItems: [] },
      });
      assertEquals(res.status, 400);
    });
  }
});

// ── DB-free: the XState machine is INERT (not throwing) on forbidden pairs ──
// XState v5 silently ignores an event a state has no transition for, so a
// forbidden verb must leave status UNCHANGED. This documents that the
// authoritative guarding lives in the route layer (asserted above), and pins
// the machine's no-op contract so a future "throw on unknown event" refactor
// can't slip through unnoticed.
Deno.test("state-guards: workflow-machine is inert on forbidden event+state pairs", async (t) => {
  const forbidden: Array<{ from: { status: any; currentStepOrdinal: number }; event: any }> = [
    { from: { status: "approved", currentStepOrdinal: 0 }, event: { type: "STEP_APPROVE", hasNextStep: false, nextOrdinal: 0 } },
    { from: { status: "approved", currentStepOrdinal: 0 }, event: { type: "OWNER_APPROVE" } },
    { from: { status: "approved", currentStepOrdinal: 0 }, event: { type: "CLOSE" } },
    { from: { status: "credential_issued", currentStepOrdinal: 0 }, event: { type: "ISSUE_CREDENTIAL" } },
    { from: { status: "credential_issued", currentStepOrdinal: 0 }, event: { type: "STEP_APPROVE", hasNextStep: false, nextOrdinal: 0 } },
    { from: { status: "closed", currentStepOrdinal: 0 }, event: { type: "CLOSE" } },
    { from: { status: "closed", currentStepOrdinal: 0 }, event: { type: "ISSUE_CREDENTIAL" } },
    { from: { status: "rejected", currentStepOrdinal: 2 }, event: { type: "STEP_APPROVE", hasNextStep: false, nextOrdinal: 0 } },
    { from: { status: "rejected", currentStepOrdinal: 2 }, event: { type: "ISSUE_CREDENTIAL" } },
  ];

  for (const { from, event } of forbidden) {
    await t.step(`${event.type} from ${from.status} leaves status unchanged`, () => {
      const next = getNextState(from, event);
      assertEquals(next.status, from.status);
    });
  }
});
