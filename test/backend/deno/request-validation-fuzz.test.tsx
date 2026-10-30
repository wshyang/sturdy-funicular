// Boundary-value analysis + adversarial-payload coverage for the request
// content fields (GAP D from the test-coverage audit, 2026-07-29). The
// existing requests.test.tsx proves the fields are *validated at all* (empty
// justification rejected, end-before-start rejected), but never pins the exact
// n / n+1 length boundary the FDS spells out, and never feeds a hostile string
// (SQL, script, emoji, RTL override, NUL byte) through the parameterised query
// layer to prove it round-trips as inert data rather than being executed,
// mangled, or spuriously rejected.
//
// Bounds are read straight from the server (server/utils.tsx validateStringField
// + server/routes-requests.tsx), not guessed:
//   justification   trim()'d, 1..2000  → over: "Justification must be 2000 characters or fewer."
//   sr_number       trim()'d, 1..100   → over: "SR number must be 100 characters or fewer."
//   decision notes  raw length ≤ 2000  → over: "Notes must be 2000 characters or fewer."
//   closing_notes   raw length ≤ 2000  → over: "Closing notes must be 2000 characters or fewer."
//   activity window  end must be strictly later than start (equal instant rejected)
//
// Every case drives the REAL Hono app + Postgres via req()/loginAs(), exactly
// like requests.test.tsx — no mocks, so a payload that would break the SQL
// layer surfaces here.
import { assertEquals, assertExists, assertStringIncludes } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";

// A submitter fully wired to a submittable system, plus the vendor/agency
// approvers + owner needed to drive a request to the states that expose the
// decision-notes and closing-notes fields.
async function fuzzScenario(adminId: string) {
  const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("fuzzowner"), password: "OwnerPass!2026", affiliation: "agency" });
  const { system, vendorL1, vendorL2, agencyL1 } = await createWiredSystem(adminId, owner);

  const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("fuzzsub"), password: "SubmitPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL1, submitter, adminId);
  const vendorApprover = await createActiveUser({ fullName: "VendorApprover", email: uniqueEmail("fuzzvappr"), password: "VendorApprPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL2, vendorApprover, adminId);
  const agencyApprover = await createActiveUser({ fullName: "AgencyApprover", email: uniqueEmail("fuzzaappr"), password: "AgencyApprPass!2026", affiliation: "agency" });
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

// Builds a valid submission body with a fresh asset, then applies overrides.
// credential_items is always regenerated last so a caller overriding, say,
// justification still gets a valid single-asset item.
async function submissionBody(systemId: string, overrides: Record<string, unknown> = {}) {
  const asset = await createAsset(systemId, { hostname: `fuzz-host-${Math.random().toString(36).slice(2, 8)}` });
  return {
    systemId: systemId,
    justification: "Investigate a production incident requiring elevated access.",
    srNumber: "SR-1001",
    activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    credentialItems: [{ assetId: asset.id, hostnameDescription: "fuzz host" }],
    ...overrides,
  };
}

// Drives a fresh request to status=approved (owner terminal cleared) so the
// issue-credential → close path (and closing_notes) is reachable.
async function submitAndApprove(s: Awaited<ReturnType<typeof fuzzScenario>>): Promise<string> {
  const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await submissionBody(s.system.id) });
  const { request } = await submitRes.json();
  await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
  await req(`/requests/${request.id}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
  await req(`/requests/${request.id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
  return request.id;
}

Deno.test("request-validation-fuzz", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("FuzzAdmin!2026");
    adminId = admin.id;
    await loginAs(admin.email, "FuzzAdmin!2026");
  });

  // ── justification: 1..2000 (trim()'d) ─────────────────────────────────────

  await t.step("justification: exactly 2000 chars accepted (upper boundary)", async () => {
    const s = await fuzzScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { justification: "x".repeat(2000) }),
    });
    assertEquals(res.status, 201);
  });

  await t.step("justification: 2001 chars rejected (n+1) with the exact bound message", async () => {
    const s = await fuzzScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { justification: "x".repeat(2001) }),
    });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertStringIncludes(data.error, "2000 characters or fewer");
  });

  await t.step("justification: exactly 1 char accepted (lower boundary, min-1)", async () => {
    const s = await fuzzScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { justification: "x" }),
    });
    assertEquals(res.status, 201);
  });

  await t.step("justification: whitespace-only is trimmed to empty and rejected as required", async () => {
    const s = await fuzzScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { justification: "   \t \n  " }),
    });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertStringIncludes(data.error, "required");
  });

  // ── srNumber: 1..100 (trim()'d) ──────────────────────────────────────────

  await t.step("srNumber: exactly 100 chars accepted (upper boundary)", async () => {
    const s = await fuzzScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { srNumber: "S".repeat(100) }),
    });
    assertEquals(res.status, 201);
  });

  await t.step("srNumber: 101 chars rejected (n+1) with the exact bound message", async () => {
    const s = await fuzzScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { srNumber: "S".repeat(101) }),
    });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertStringIncludes(data.error, "100 characters or fewer");
  });

  // ── activity window: end must be strictly later than start ────────────────

  await t.step("activity window: end == start (same instant) rejected", async () => {
    const s = await fuzzScenario(adminId);
    const sameInstant = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { activityStartAt: sameInstant, activityEndAt: sameInstant }),
    });
    assertEquals(res.status, 400);
  });

  // ── step-decision notes: raw length ≤ 2000 ────────────────────────────────

  await t.step("step-decision notes: exactly 2000 chars accepted on a return", async () => {
    const s = await fuzzScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await submissionBody(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession),
      body: { decision: "return", notes: "n".repeat(2000) },
    });
    assertEquals(res.status, 200);
  });

  await t.step("step-decision notes: 2001 chars rejected (n+1)", async () => {
    const s = await fuzzScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await submissionBody(s.system.id) });
    const { request } = await submitRes.json();
    const res = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(s.vendorApproverSession),
      body: { decision: "return", notes: "n".repeat(2001) },
    });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertStringIncludes(data.error, "2000 characters or fewer");
  });

  // ── closingNotes: raw length ≤ 2000 ──────────────────────────────────────

  await t.step("closingNotes: exactly 2000 chars accepted at close", async () => {
    const s = await fuzzScenario(adminId);
    const requestId = await submitAndApprove(s);
    await req(`/requests/${requestId}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
    const res = await req(`/requests/${requestId}/close`, {
      method: "POST", headers: authHeaders(s.agencyApproverSession),
      body: { closingNotes: "c".repeat(2000) },
    });
    assertEquals(res.status, 200);
  });

  await t.step("closingNotes: 2001 chars rejected (n+1)", async () => {
    const s = await fuzzScenario(adminId);
    const requestId = await submitAndApprove(s);
    await req(`/requests/${requestId}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
    const res = await req(`/requests/${requestId}/close`, {
      method: "POST", headers: authHeaders(s.agencyApproverSession),
      body: { closingNotes: "c".repeat(2001) },
    });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertStringIncludes(data.error, "2000 characters or fewer");
  });

  // ── Adversarial payloads: must round-trip as inert data ───────────────────
  // Each string is a classic injection/rendering hazard. Fed through the
  // parameterised query layer it must be STORED VERBATIM (not executed, not
  // HTML-mangled, not truncated) and read back byte-identical — proving the
  // storage layer treats it as data and the API neither over-escapes nor
  // spuriously rejects legitimate-if-ugly free text.
  const ADVERSARIAL: Array<{ label: string; payload: string }> = [
    { label: "SQL injection", payload: "'; DROP TABLE breakglass_requests; -- and 1=1" },
    { label: "XSS script tag", payload: "<script>alert(document.cookie)</script>" },
    { label: "emoji / multibyte", payload: "🚒🔥 need access 日本語 emergency ☎️" },
    { label: "RTL override", payload: "urgent‮tnemipxe‬ access" },
  ];

  for (const { label, payload } of ADVERSARIAL) {
    await t.step(`adversarial justification (${label}) is stored verbatim and read back identical`, async () => {
      const s = await fuzzScenario(adminId);
      const res = await req("/requests", {
        method: "POST", headers: authHeaders(s.submitterSession),
        body: await submissionBody(s.system.id, { justification: payload, srNumber: payload.slice(0, 100) }),
      });
      assertEquals(res.status, 201);
      const { request } = await res.json();

      const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then((r) => r.json());
      assertExists(detail.request);
      assertEquals(detail.request.justification, payload);
    });
  }

  // NUL byte is special: PostgreSQL text/varchar columns reject U+0000 outright
  // (it is not a valid character in a Postgres text value). The API must
  // therefore fail cleanly (non-2xx) rather than corrupt/crash or persist a
  // value silently truncated at the NUL — that last outcome is the one that
  // must never happen.
  await t.step("adversarial justification (NUL byte) does not succeed with a mangled value", async () => {
    const s = await fuzzScenario(adminId);
    const nulPayload = `before${String.fromCharCode(0)}after incident`;
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await submissionBody(s.system.id, { justification: nulPayload }),
    });
    if (res.status === 201) {
      const { request } = await res.json();
      const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then((r) => r.json());
      assertEquals(detail.request.justification, nulPayload);
    } else {
      assertEquals(res.status >= 400, true);
    }
  });
});
