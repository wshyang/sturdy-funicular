// End-to-end outbox tests for email direct-links (plan_link_mapping.md /
// addendum-059). Complements direct-links.test.tsx (which tests resolution):
// here we drive each request lifecycle action through the REAL HTTP routes and
// assert that the sent_notifications outbox row for the triggered notification has a
// FULLY RENDERED direct link in its body_html — i.e. a real
// <a href="…?dl=<key>">, NOT the literal {{directLink}} handlebars token.
//
// This proves the whole chain end-to-end: notify site mints a scoped key →
// passes request_direct_link → the seeded template's {{directLink}} helper
// renders it → the rendered HTML is what lands in the outbox.
import { assertEquals, assert, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, reactivateEmailTemplates, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystem, createAsset, addMember, addServingMember, latestSentNotification,
} from "./helpers.tsx";

// Assert the outbox row for `triggerKey` exists and carries a rendered link.
async function assertOutboxHasDirectLink(triggerKey: string) {
  const row = await latestSentNotification(triggerKey);
  assertExists(row, `no sent_notifications row for ${triggerKey}`);
  const html: string = row.renderedBodyHtml;
  // The helper rendered an anchor with a ?dl= key…
  assert(/<a href="[^"]*\?dl=[0-9A-Za-z]{12}"/.test(html), `${triggerKey}: no rendered ?dl= anchor in bodyHtml:\n${html}`);
  // …and NO unrendered handlebars token leaked through.
  assert(!html.includes("{{directLink"), `${triggerKey}: unrendered {{directLink}} token present`);
  assert(!html.includes("{{request_direct_link"), `${triggerKey}: unrendered {{request_direct_link}} token present`);
  return row;
}

async function validSubmission(systemId: string) {
  const asset = await createAsset(systemId, { hostname: "host-01" });
  return {
    systemId: systemId,
    justification: "Investigate a production incident requiring elevated access.",
    srNumber: "SR-1001",
    activityStartAt: new Date(Date.now() + 3_600_000).toISOString(),
    activityEndAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    credentialItems: [{ assetId: asset.id, hostnameDescription: "test host" }],
  };
}

async function scenario(adminId: string) {
  const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("owner"), password: "OwnerPass!2026", affiliation: "agency" });
  const { system, vendorL1, vendorL2, agencyL1 } = await createWiredSystem(adminId, owner);
  const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("submitter"), password: "SubmitPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL1, submitter, adminId);
  const vendorApprover = await createActiveUser({ fullName: "VendorAppr", email: uniqueEmail("vappr"), password: "VendorPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL2, vendorApprover, adminId);
  const agencyApprover = await createActiveUser({ fullName: "AgencyAppr", email: uniqueEmail("aappr"), password: "AgencyPass!2026", affiliation: "agency" });
  await addMember(agencyL1, agencyApprover, adminId);

  return {
    system, owner, submitter,
    submitterSession: ((await loginAs(submitter.email, "SubmitPass!2026")) as any).session,
    vendorSession: ((await loginAs(vendorApprover.email, "VendorPass!2026")) as any).session,
    agencySession: ((await loginAs(agencyApprover.email, "AgencyPass!2026")) as any).session,
    ownerSession: ((await loginAs(owner.email, "OwnerPass!2026")) as any).session,
  };
}

async function submit(s: any): Promise<string> {
  const res = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
  assertEquals(res.status, 201);
  return (await res.json()).request.id;
}

// Drive a request all the way to the owner terminal (both approval steps done).
async function toOwnerTerminal(s: any): Promise<string> {
  const id = await submit(s);
  await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorSession), body: { decision: "approve" } });
  await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.agencySession), body: { decision: "approve" } });
  return id;
}

Deno.test("direct-links-email outbox", async (t) => {
  let adminId = "";
  let adminSession = "";

  await t.step("setup", async () => {
    await wipeDatabase();
    // email_templates survives wipeDatabase (seeded config); reactivate any row
    // an earlier file left inactive so the request.submitted template renders.
    await reactivateEmailTemplates();
    const admin = await createAdmin("DLEmailAdmin!2026");
    adminId = admin.id;
    adminSession = ((await loginAs(admin.email, "DLEmailAdmin!2026")) as any).session;
  });

  await t.step("submit → request.submitted + request.submitted_confirmation carry the link", async () => {
    const s = await scenario(adminId);
    await submit(s);
    await assertOutboxHasDirectLink("request.submitted");
    await assertOutboxHasDirectLink("request.submitted_confirmation");
  });

  await t.step("step approve (advance to next reviewer) → request.step_approved_next_reviewer", async () => {
    const s = await scenario(adminId);
    const id = await submit(s);
    const res = await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorSession), body: { decision: "approve" } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.step_approved_next_reviewer");
  });

  await t.step("step approve (final step → owner) → request.step_approved_owner", async () => {
    const s = await scenario(adminId);
    const id = await submit(s);
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorSession), body: { decision: "approve" } });
    const res = await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.agencySession), body: { decision: "approve" } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.step_approved_owner");
  });

  await t.step("step return → request.step_returned", async () => {
    const s = await scenario(adminId);
    const id = await submit(s);
    const res = await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorSession), body: { decision: "return", notes: "Please add more detail." } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.step_returned");
  });

  await t.step("step reject → request.step_rejected", async () => {
    const s = await scenario(adminId);
    const id = await submit(s);
    const res = await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorSession), body: { decision: "reject", notes: "Not justified." } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.step_rejected");
  });

  await t.step("resubmit → request.resubmitted_step2", async () => {
    const s = await scenario(adminId);
    const id = await submit(s);
    await req(`/requests/${id}/step-decision`, { method: "POST", headers: authHeaders(s.vendorSession), body: { decision: "return", notes: "Fix it." } });
    const res = await req(`/requests/${id}/resubmit`, { method: "PUT", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.resubmitted_step2");
  });

  await t.step("owner approve → owner_approved_agency_l1 + owner_approved_submitter", async () => {
    const s = await scenario(adminId);
    const id = await toOwnerTerminal(s);
    const res = await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.owner_approved_agency_l1");
    await assertOutboxHasDirectLink("request.owner_approved_submitter");
  });

  await t.step("owner return → request.owner_returned", async () => {
    const s = await scenario(adminId);
    const id = await toOwnerTerminal(s);
    const res = await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "return", notes: "Need more context." } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.owner_returned");
  });

  await t.step("owner reject → request.owner_rejected", async () => {
    const s = await scenario(adminId);
    const id = await toOwnerTerminal(s);
    const res = await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "reject", notes: "Denied." } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.owner_rejected");
  });

  await t.step("issue credential → request.credential_issued", async () => {
    const s = await scenario(adminId);
    const id = await toOwnerTerminal(s);
    await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
    const res = await req(`/requests/${id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencySession), body: {} });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.credential_issued");
  });

  await t.step("close → request.closed_submitter + request.closed_system_owner", async () => {
    const s = await scenario(adminId);
    const id = await toOwnerTerminal(s);
    await req(`/requests/${id}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
    await req(`/requests/${id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencySession), body: {} });
    const res = await req(`/requests/${id}/close`, { method: "POST", headers: authHeaders(s.agencySession), body: { closingNotes: "Done." } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.closed_submitter");
    await assertOutboxHasDirectLink("request.closed_system_owner");
  });

  await t.step("admin reset → request.admin_reset", async () => {
    const s = await scenario(adminId);
    const id = await toOwnerTerminal(s);
    const res = await req(`/requests/${id}/admin-reset`, { method: "POST", headers: authHeaders(adminSession), body: { notes: "Reset for re-review." } });
    assertEquals(res.status, 200);
    await assertOutboxHasDirectLink("request.admin_reset");
  });
});
