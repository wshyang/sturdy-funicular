// Coverage: GET /audit/request/:id, GET /audit/logs.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { runWithAuditContext } from "../../../server/audit-context.tsx";
import { query } from "../../../server/pg.tsx";

Deno.test("audit", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AuditAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "AuditAdmin!2026");
    adminSession = (login as any).session;
  });

  await t.step("logs: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "AuditVendor", email: uniqueEmail("auditvendor"), password: "AuditVendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "AuditVendorPass!2026");
    const res = await req("/audit/logs", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  await t.step("logs: positive — admin sees entries enriched with actor_name/actor_email, most-recent-first", async () => {
    // Login itself produces a user.login_success audit row — use that.
    const res = await req("/audit/logs", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(Array.isArray(data.logs), true);
    assertEquals(data.logs.length > 0, true);
    assertExists(data.logs[0].actorName);
    // Most recent first: created_at should be non-increasing across the list.
    for (let i = 1; i < data.logs.length; i++) {
      const prev = new Date(data.logs[i - 1].createdAt).getTime();
      const cur = new Date(data.logs[i].createdAt).getTime();
      assertEquals(prev >= cur, true);
    }
  });

  await t.step("logs: trigger-computed changes are returned in the enriched shape", async () => {
    const owner = await createActiveUser({ fullName: "AuditReaderOwner", email: uniqueEmail("auditreaderowner"), password: "AuditReaderOwner!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const asset = await createAsset(system.id);
    await runWithAuditContext('test.reader_delta', adminId, { marker: 'reader' }, () =>
      query(`UPDATE assets SET expires_after = now() WHERE id = $1`, [asset.id]),
    );
    const res = await req("/audit/logs", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const hit = data.logs.find((l: any) => l.action === 'test.reader_delta');
    assertExists(hit, "trigger-written row must appear in /audit/logs");
    assertExists(hit.changes?.expiresAfter, "changes delta must be attached by the reader");
    assertEquals(hit.changes.expiresAfter.previous, null);
    assertExists(hit.changes.expiresAfter.after);
    assertEquals(hit.details?.marker, 'reader', "ffs.details payload must ride through to the response");
  });

  await t.step("request timeline: positive — submitter sees their own request's timeline", async () => {
    const owner = await createActiveUser({ fullName: "TLOwner", email: uniqueEmail("tlowner"), password: "TLOwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "TLSubmitter", email: uniqueEmail("tlsubmitter"), password: "TLSubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    const login = await loginAs(submitter.email, "TLSubmitPass!2026");
    const session = (login as any).session;

    const asset = await createAsset(system.id);
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(session),
      body: {
        systemId: system.id, justification: "Timeline test.", srNumber: "SR-TL1",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id }],
      },
    });
    const { request } = await submitRes.json();

    const res = await req(`/audit/request/${request.id}`, { headers: authHeaders(session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.timeline.find((e: any) => e.action === "request.submitted"));
  });

  await t.step("request timeline: negative — 404 for a request outside caller's visibility", async () => {
    const owner = await createActiveUser({ fullName: "TLOwner2", email: uniqueEmail("tlowner2"), password: "TLOwner2Pass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "TLSubmitter2", email: uniqueEmail("tlsubmitter2"), password: "TLSubmit2Pass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    const submitterLogin = await loginAs(submitter.email, "TLSubmit2Pass!2026");
    const asset2 = await createAsset(system.id);
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders((submitterLogin as any).session),
      body: {
        systemId: system.id, justification: "Timeline test 2.", srNumber: "SR-TL2",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset2.id }],
      },
    });
    const { request } = await submitRes.json();

    const outsider = await createActiveUser({ fullName: "TLOutsider", email: uniqueEmail("tloutsider"), password: "TLOutsiderPass!2026", affiliation: "vendor" });
    const outsiderLogin = await loginAs(outsider.email, "TLOutsiderPass!2026");
    const res = await req(`/audit/request/${request.id}`, { headers: authHeaders((outsiderLogin as any).session) });
    assertEquals(res.status, 404);
  });

  await t.step("request timeline: negative — request not found", async () => {
    const res = await req(`/audit/request/00000000-0000-0000-0000-000000000999`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 404);
  });

  await t.step("request timeline: negative — unauthenticated", async () => {
    const res = await req(`/audit/request/00000000-0000-0000-0000-000000000999`);
    assertEquals(res.status, 401);
  });

  await t.step("request timeline: positive (FK link) — event's access_log_id matches the request that produced it, enriched inline, visible to a non-admin submitter", async () => {
    const owner = await createActiveUser({ fullName: "TLOwner3", email: uniqueEmail("tlowner3"), password: "TLOwner3Pass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    const submitter = await createActiveUser({ fullName: "TLSubmitter3", email: uniqueEmail("tlsubmitter3"), password: "TLSubmit3Pass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    const login = await loginAs(submitter.email, "TLSubmit3Pass!2026");
    const session = (login as any).session;

    const asset3 = await createAsset(system.id);
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(session),
      body: {
        systemId: system.id, justification: "Timeline FK-link test.", srNumber: "SR-TL3",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset3.id }],
      },
    });
    const { request } = await submitRes.json();

    // Non-admin submitter fetches their own request's timeline — proves the
    // inline-enrichment approach doesn't require admin rights.
    const res = await req(`/audit/request/${request.id}`, { headers: authHeaders(session) });
    assertEquals(res.status, 200);
    const data = await res.json();
    const submittedEvent = data.timeline.find((e: any) => e.action === "request.submitted");
    assertExists(submittedEvent);
    assertExists(submittedEvent.accessLogId);
    assertExists(submittedEvent.accessLog);
    assertEquals(submittedEvent.accessLog.method, "POST");
    assertEquals(submittedEvent.accessLog.path, "/requests");
  });

  await t.step("request timeline: negative (FK link) — an audit row written outside any HTTP request has access_log_id null", async () => {
    // Simulates a SYSTEM-actor-generated event with no originating HTTP
    // request (e.g. bootstrap seeding) by calling createAuditLog() directly,
    // outside of accessLogContext.run(...) — accessLogContext.getStore()
    // returns undefined in that case, which createAuditLog() coalesces to null.
    const { createAuditLog } = await import("../../../server/utils.tsx");
    const { auditLogs } = await import("../../../server/db.tsx");
    const owner = await createActiveUser({ fullName: "TLOwner4", email: uniqueEmail("tlowner4"), password: "TLOwner4Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);

    await createAuditLog(adminId, "system.no_request_test", "system", system.id, null);
    const logs = await auditLogs.findByTarget("system", system.id);
    const written = logs.find((l: any) => l.action === "system.no_request_test");
    assertExists(written);
    assertEquals(written.accessLogId, null);
  });

  // ── Admin audit-log filtering (addendum-095 audit-log tab) ───────────────

  await t.step("logs: filter by exact action returns only that action", async () => {
    const res = await req(`/audit/logs?action=user.login_success`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.filtersApplied, true);
    assertEquals(Array.isArray(data.logs), true);
    for (const l of data.logs) {
      assertEquals(l.action, "user.login_success");
    }
  });

  await t.step("logs: filter by actor name substring", async () => {
    const res = await req(`/audit/logs?actor=${encodeURIComponent("AuditAdmin")}`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.filtersApplied, true);
    // The acting admin created login events; all returned rows' actor resolves
    // to the admin (substring match on full_name).
    for (const l of data.logs) {
      assertEquals(l.actorName.includes("AuditAdmin"), true, `actorName=${l.actorName}`);
    }
  });

  await t.step("logs: filter by target_type", async () => {
    const res = await req(`/audit/logs?targetType=system`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.filtersApplied, true);
    for (const l of data.logs) {
      assertEquals(l.targetType, "system");
    }
  });

  await t.step("logs: invalid date filter returns 400", async () => {
    const res = await req(`/audit/logs?from=not-a-date`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  await t.step("logs: from-after-to returns 400", async () => {
    const res = await req(`/audit/logs?from=2026-02-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });
});
