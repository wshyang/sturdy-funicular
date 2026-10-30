// Concurrency / race-condition coverage (GAP A from the test-coverage audit,
// 2026-07-29). idempotency.test.tsx proves the SAME client retrying with the
// same token is de-duplicated, but nothing proved the FDS "first to act wins"
// invariant — two DIFFERENT authorized actors hitting the same mutation at the
// same instant. FDS (#feat-approval-at-step): "Approver at step N picks up but
// another approver at same team races them: First to act wins."
//
// A probe against the live app + Postgres confirmed the observed behaviour
// before these assertions were written: two same-team approvers racing one
// step yield exactly {200, 403} (never {200,200}), the ordinal advances once,
// and exactly one step_approved audit row is written. The serialization comes
// from the per-request transaction (server/pg.tsx runInTransaction) plus the
// step's own status/reviewer precondition re-check — the loser reads a step
// that is no longer pending / no longer theirs to act on and is rejected.
//
// Because the OS scheduler decides which of the two racing requests commits
// first, assertions are written direction-agnostically: "exactly one 2xx and
// exactly one 4xx", never "r1 wins". Every race drives the REAL app; no mocks.
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";

// Partitions two racing responses into success (2xx) / failure (>=400) counts.
function tally(statuses: number[]): { ok: number; failed: number } {
  return {
    ok: statuses.filter((s) => s >= 200 && s < 300).length,
    failed: statuses.filter((s) => s >= 400).length,
  };
}

// A wired system with TWO members on the vendor-L2 approval team (both
// authorized on step 2) and the agency + owner actors needed to reach the
// approved / credential_issued states where issue/close races live.
async function raceScenario(adminId: string) {
  const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("cxowner"), password: "Race!2026aa", affiliation: "agency" });
  const { system, vendorL1, vendorL2, agencyL1 } = await createWiredSystem(adminId, owner);

  const submitter = await createActiveUser({ fullName: "Sub", email: uniqueEmail("cxsub"), password: "Race!2026aa", affiliation: "vendor" });
  await addServingMember(vendorL1, submitter, adminId);

  const vApprover1 = await createActiveUser({ fullName: "VA1", email: uniqueEmail("cxva1"), password: "Race!2026aa", affiliation: "vendor" });
  await addServingMember(vendorL2, vApprover1, adminId);
  const vApprover2 = await createActiveUser({ fullName: "VA2", email: uniqueEmail("cxva2"), password: "Race!2026aa", affiliation: "vendor" });
  await addServingMember(vendorL2, vApprover2, adminId);

  // Two agency reviewers on the same agency team — both may issue-credential /
  // close once the request is far enough along.
  const aApprover1 = await createActiveUser({ fullName: "AA1", email: uniqueEmail("cxaa1"), password: "Race!2026aa", affiliation: "agency" });
  await addMember(agencyL1, aApprover1, adminId);
  const aApprover2 = await createActiveUser({ fullName: "AA2", email: uniqueEmail("cxaa2"), password: "Race!2026aa", affiliation: "agency" });
  await addMember(agencyL1, aApprover2, adminId);

  const sessions = {
    submitter: (await loginAs(submitter.email, "Race!2026aa") as any).session,
    v1: (await loginAs(vApprover1.email, "Race!2026aa") as any).session,
    v2: (await loginAs(vApprover2.email, "Race!2026aa") as any).session,
    a1: (await loginAs(aApprover1.email, "Race!2026aa") as any).session,
    a2: (await loginAs(aApprover2.email, "Race!2026aa") as any).session,
    owner: (await loginAs(owner.email, "Race!2026aa") as any).session,
  };
  return { system, sessions };
}

async function submit(system: { id: string }, submitterSession: string): Promise<string> {
  const asset = await createAsset(system.id, { hostname: `cx-host-${Math.random().toString(36).slice(2, 8)}` });
  const res = await req("/requests", {
    method: "POST", headers: authHeaders(submitterSession),
    body: {
      systemId: system.id, justification: "concurrency race scenario", srNumber: "SR-CX",
      activityStartAt: new Date(Date.now() + 3600_000).toISOString(),
      activityEndAt: new Date(Date.now() + 7200_000).toISOString(),
      credentialItems: [{ assetId: asset.id, hostnameDescription: "h" }],
    },
  });
  const { request } = await res.json();
  return request.id;
}

Deno.test("concurrency", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("CxAdmin!2026");
    adminId = admin.id;
    await loginAs(admin.email, "CxAdmin!2026");
  });

  await t.step("two same-team approvers race one step → first-to-act wins, one 4xx, ordinal advances once", async () => {
    const { system, sessions } = await raceScenario(adminId);
    const id = await submit(system, sessions.submitter);

    const [r1, r2] = await Promise.all([
      req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.v1), body: { decision: "approve", notes: "v1" } }),
      req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.v2), body: { decision: "approve", notes: "v2" } }),
    ]);

    const t2 = tally([r1.status, r2.status]);
    assertEquals(t2.ok, 1, "exactly one approver should win the step");
    assertEquals(t2.failed, 1, "the loser must be rejected, not silently succeed");

    // Ordinal advanced exactly once (2 → 3), step 2 approved exactly once.
    const finalReq = await query<{ current_step_ordinal: number; status: string }>(
      `SELECT current_step_ordinal, status FROM breakglass_requests WHERE id = $1`, [id],
    );
    assertEquals(finalReq[0].current_step_ordinal, 3);
    assertEquals(finalReq[0].status, "under_review");

    const approveAudits = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE action IN ('request.step_approved','request.step_override_approved')
       AND (details->>'requestId') = $1 AND (details->>'stepOrdinal') = '2'`, [id],
    );
    assertEquals(approveAudits[0].n, 1, "exactly one step_approved audit row for step 2");
  });

  await t.step("two owner sessions race the terminal decision → one wins, one 4xx", async () => {
    const { system, sessions } = await raceScenario(adminId);
    const id = await submit(system, sessions.submitter);
    // Drive to the owner terminal.
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.v1), body: { decision: "approve" } });
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.a1), body: { decision: "approve" } });

    // Same owner session used twice, fired simultaneously (a double-click).
    const [r1, r2] = await Promise.all([
      req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(sessions.owner), body: { decision: "approve", notes: "o1" } }),
      req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(sessions.owner), body: { decision: "approve", notes: "o2" } }),
    ]);

    const tallyOwner = tally([r1.status, r2.status]);
    assertEquals(tallyOwner.ok, 1, "exactly one owner decision should commit");
    assertEquals(tallyOwner.failed, 1, "the duplicate owner decision must be rejected");

    const finalReq = await query<{ status: string }>(`SELECT status FROM breakglass_requests WHERE id = $1`, [id]);
    assertEquals(finalReq[0].status, "approved");
  });

  await t.step("two agency reviewers race issue-credential → one issues, one 4xx", async () => {
    const { system, sessions } = await raceScenario(adminId);
    const id = await submit(system, sessions.submitter);
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.v1), body: { decision: "approve" } });
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.a1), body: { decision: "approve" } });
    await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(sessions.owner), body: { decision: "approve" } });

    const [r1, r2] = await Promise.all([
      req(`/requests/${id}/issue-credential`, { method: "POST", headers: authHeaders(sessions.a1) }),
      req(`/requests/${id}/issue-credential`, { method: "POST", headers: authHeaders(sessions.a2) }),
    ]);

    const tallyIssue = tally([r1.status, r2.status]);
    assertEquals(tallyIssue.ok, 1, "credential issued exactly once");
    assertEquals(tallyIssue.failed, 1, "the second issue-credential must be rejected");

    const finalReq = await query<{ status: string }>(`SELECT status FROM breakglass_requests WHERE id = $1`, [id]);
    assertEquals(finalReq[0].status, "credential_issued");
  });

  await t.step("two agency reviewers race close → one closes, one 4xx", async () => {
    const { system, sessions } = await raceScenario(adminId);
    const id = await submit(system, sessions.submitter);
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.v1), body: { decision: "approve" } });
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(sessions.a1), body: { decision: "approve" } });
    await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(sessions.owner), body: { decision: "approve" } });
    await req(`/requests/${id}/issue-credential`, { method: "POST", headers: authHeaders(sessions.a1) });

    const [r1, r2] = await Promise.all([
      req(`/requests/${id}/close`, { method: "POST", headers: authHeaders(sessions.a1), body: { closingNotes: "c1" } }),
      req(`/requests/${id}/close`, { method: "POST", headers: authHeaders(sessions.a2), body: { closingNotes: "c2" } }),
    ]);

    const tallyClose = tally([r1.status, r2.status]);
    assertEquals(tallyClose.ok, 1, "request closed exactly once");
    assertEquals(tallyClose.failed, 1, "the second close must be rejected");

    const finalReq = await query<{ status: string }>(`SELECT status FROM breakglass_requests WHERE id = $1`, [id]);
    assertEquals(finalReq[0].status, "closed");
  });
});
