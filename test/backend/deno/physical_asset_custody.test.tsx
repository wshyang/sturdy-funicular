// Addendum-144 backend RED contract. Written after frontend/e2e contracts and
// before any custody schema/routes. Failures must express absent behavior
// (404/missing read model), never broken imports or fixture setup.
import { assert, assertEquals, assertExists, assertMatch } from "jsr:@std/assert";
import {
  addMember, addServingMember, authHeaders, createActiveUser, createAdmin, createAsset,
  createWiredSystem, loginAs, req, reqFormData, uniqueEmail, wipeDatabase,
} from "./helpers.tsx";

const STAGES = ['prepare', 'initiate_handover', 'verify_return', 'return_to_inventory', 'investigate_exception'] as const;

Deno.test("physical asset custody: relational item flow, partial exception, one-to-many evidence, and authorization", async (t) => {
  let adminSession = '';
  let submitterSession = '';
  let vendorApproverSession = '';
  let agencySession = '';
  let ownerSession = '';
  let unrelatedAgencySession = '';
  let requestId = '';
  let systemId = '';
  let securePhoneAssetId = '';
  let laptopAssetId = '';
  let phoneCaseId = '';
  let laptopCaseId = '';
  let agencyTeamId = '';

  await t.step("setup: fixed custody teams are configured as normalized system stage rows", async () => {
    await wipeDatabase();
    const admin = await createAdmin("CustodyAdmin!2026");
    adminSession = ((await loginAs(admin.email, "CustodyAdmin!2026")) as any).session;
    const owner = await createActiveUser({ fullName: "Custody Owner", email: uniqueEmail("cust-owner"), password: "CustodyOwner!2026", affiliation: "agency" });
    const wired = await createWiredSystem(admin.id, owner);
    systemId = wired.system.id;
    agencyTeamId = wired.agencyL1.id;

    const submitter = await createActiveUser({ fullName: "Custody Requester", email: uniqueEmail("cust-requester"), password: "CustodyRequester!2026", affiliation: "vendor" });
    const vendorApprover = await createActiveUser({ fullName: "Custody Vendor Approver", email: uniqueEmail("cust-vendor"), password: "CustodyVendor!2026", affiliation: "vendor" });
    const agency = await createActiveUser({ fullName: "Custody Agency Engineer", email: uniqueEmail("cust-agency"), password: "CustodyAgency!2026", affiliation: "agency" });
    const unrelated = await createActiveUser({ fullName: "Foreign Agency Engineer", email: uniqueEmail("cust-foreign"), password: "CustodyForeign!2026", affiliation: "agency" });
    await addServingMember(wired.vendorL1, submitter, admin.id);
    await addServingMember(wired.vendorL2, vendorApprover, admin.id);
    await addMember(wired.agencyL1, agency, admin.id);

    submitterSession = ((await loginAs(submitter.email, "CustodyRequester!2026")) as any).session;
    vendorApproverSession = ((await loginAs(vendorApprover.email, "CustodyVendor!2026")) as any).session;
    agencySession = ((await loginAs(agency.email, "CustodyAgency!2026")) as any).session;
    ownerSession = ((await loginAs(owner.email, "CustodyOwner!2026")) as any).session;
    unrelatedAgencySession = ((await loginAs(unrelated.email, "CustodyForeign!2026")) as any).session;

    const configs = STAGES.map((stage) => ({ stage, agencyTeamId, instructions: `${stage} instructions`, dueInHours: 24 }));
    const configRes = await req(`/admin/systems/${systemId}`, { method: "PUT", headers: authHeaders(adminSession), body: { custodyStageConfigs: configs } });
    assertEquals(configRes.status, 200);
    const listRes = await req('/admin/systems', { headers: authHeaders(adminSession) });
    const row = (await listRes.json()).systems.find((candidate: { id: string }) => candidate.id === systemId);
    assertEquals(row.custodyStageConfigs.map((config: Record<string, unknown>) => ({ stage: config.stage, agencyTeamId: config.agencyTeamId, instructions: config.instructions, dueInHours: config.dueInHours })), configs, "stage/team configuration must round-trip as relational rows");

    const phone = await createAsset(systemId, { hostname: "secure-phone", credentialName: "Secure phone", credentialType: "device", managementMode: "manual" });
    const laptop = await createAsset(systemId, { hostname: "custody-laptop", credentialName: "Emergency laptop", credentialType: "device", managementMode: "manual" });
    securePhoneAssetId = phone.id;
    laptopAssetId = laptop.id;
  });

  await t.step("approval creates one custody case per manual request item, directly linked to asset and request", async () => {
    const submit = await req('/requests', { method: 'POST', headers: authHeaders(submitterSession), body: {
      systemId, justification: 'Physical custody backend contract.', srNumber: 'SR-CUSTODY-1',
      activityStartAt: new Date(Date.now() + 3_600_000).toISOString(), activityEndAt: new Date(Date.now() + 86_400_000).toISOString(),
      credentialItems: [{ assetId: securePhoneAssetId }, { assetId: laptopAssetId }],
    } });
    assertEquals(submit.status, 201);
    requestId = (await submit.json()).request.id;
    for (const [session, path] of [[vendorApproverSession, 'step-decision'], [agencySession, 'step-decision']] as const) {
      const decision = await req(`/requests/${requestId}/${path}`, { method: 'POST', headers: authHeaders(session), body: { decision: 'approve' } });
      assertEquals(decision.status, 200);
    }
    const ownerDecision = await req(`/requests/${requestId}/owner-decision`, { method: 'POST', headers: authHeaders(ownerSession), body: { decision: 'approve' } });
    assertEquals(ownerDecision.status, 200);

    const detail = await req(`/requests/${requestId}`, { headers: authHeaders(agencySession) });
    assertEquals(detail.status, 200);
    const custody = (await detail.json()).assetCustody;
    assertExists(custody, "manual assets must instantiate the fixed custody read model");
    assertEquals(custody.cases.length, 2);
    const phone = custody.cases.find((item: { assetId: string }) => item.assetId === securePhoneAssetId);
    const laptop = custody.cases.find((item: { assetId: string }) => item.assetId === laptopAssetId);
    assertExists(phone); assertExists(laptop);
    phoneCaseId = phone.id; laptopCaseId = laptop.id;
    assertEquals(phone.state, 'awaiting_preparation');
    assert(phone.availableActions.includes('prepare_and_handover'), "same-team safe pair is combined for the agency actor");
  });

  await t.step("wrong-session and same-role-wrong-team substitutions cannot act on custody cases (OWASP A01)", async () => {
    for (const session of [submitterSession, unrelatedAgencySession]) {
      const res = await req(`/requests/${requestId}/asset-custody/actions`, { method: 'POST', headers: authHeaders(session), body: {
        action: 'prepare_and_handover', custodyCaseIds: [laptopCaseId],
      } });
      assertEquals(res.status, 403);
    }
  });

  await t.step("safe same-team compound action writes both transitions atomically", async () => {
    const res = await req(`/requests/${requestId}/asset-custody/actions`, { method: 'POST', headers: authHeaders(agencySession), body: {
      action: 'prepare_and_handover', custodyCaseIds: [laptopCaseId],
    } });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.cases[0].state, 'handover_pending');
    assertEquals(body.events.map((event: { eventType: string }) => event.eventType), ['preparation_confirmed', 'handover_initiated']);
  });

  await t.step("missing phone creates a structured exception with TWO independent attachment rows", async () => {
    const form = new FormData();
    form.append('custodyCaseId', phoneCaseId);
    form.append('exceptionType', 'missing');
    form.append('description', 'Secure phone was not present in Cabinet C2.');
    form.append('expectedLocation', 'Cabinet C2');
    form.append('checkedExpectedLocation', 'true');
    form.append('checkedRegister', 'true');
    form.append('contactedLastCustodian', 'false');
    form.append('checkedNearbyLocations', 'false');
    form.append('attachments', new File(['Cabinet C2 checked'], 'cabinet.txt', { type: 'text/plain' }));
    form.append('attachments', new File(['Inventory register checked'], 'register.txt', { type: 'text/plain' }));
    const res = await reqFormData(`/requests/${requestId}/asset-custody/exceptions`, agencySession, form);
    assertEquals(res.status, 201);
    const body = await res.json();
    assertEquals(body.exception.exceptionType, 'missing');
    assertEquals(body.exception.evidenceFiles.length, 2, "attachments are one-to-many rows, not a JSON array column");
    assert(body.exception.evidenceFiles[0].id !== body.exception.evidenceFiles[1].id);
    assertEquals(body.case.state, 'exception_open');
  });

  await t.step("unaffected laptop remains in handover while only the phone is paused", async () => {
    const detail = await req(`/requests/${requestId}`, { headers: authHeaders(agencySession) });
    const custody = (await detail.json()).assetCustody;
    assertEquals(custody.status, 'attention_required');
    assertEquals(custody.exceptionCount, 1);
    assertEquals(custody.cases.find((item: { id: string }) => item.id === phoneCaseId).state, 'exception_open');
    assertEquals(custody.cases.find((item: { id: string }) => item.id === laptopCaseId).state, 'handover_pending');
  });

  await t.step("upload validation rejects spoofed, executable, empty, and >10 MiB files (OWASP A05/A08/A10)", async () => {
    for (const file of [
      new File(['MZ executable'], 'photo.png', { type: 'image/png' }),
      new File(['x'], 'script.exe', { type: 'application/x-msdownload' }),
      new File([], 'empty.txt', { type: 'text/plain' }),
      new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.png', { type: 'image/png' }),
    ]) {
      const form = new FormData();
      form.append('custodyCaseId', laptopCaseId); form.append('exceptionType', 'damaged'); form.append('description', 'validation arm');
      form.append('attachments', file);
      const res = await reqFormData(`/requests/${requestId}/asset-custody/exceptions`, agencySession, form);
      assertEquals(res.status, 400);
      assertMatch((await res.json()).error, /attachment|file|media|empty|10 MB/i);
    }
  });

  await t.step("bounds and malformed action inputs fail closed without partial transition (OWASP A05/A10)", async () => {
    for (const body of [
      { action: 'invented', custodyCaseIds: [laptopCaseId] },
      { action: 'confirm_receipt', custodyCaseIds: [] },
      { action: 'confirm_receipt', custodyCaseIds: [laptopCaseId, 'not-a-uuid'] },
    ]) {
      const res = await req(`/requests/${requestId}/asset-custody/actions`, { method: 'POST', headers: authHeaders(agencySession), body });
      assertEquals(res.status, 400);
    }
    const detail = await req(`/requests/${requestId}`, { headers: authHeaders(agencySession) });
    assertEquals((await detail.json()).assetCustody.cases.find((item: { id: string }) => item.id === laptopCaseId).state, 'handover_pending');
  });
});

Deno.test("physical custody controls the main request issue and close lifecycle", async (t) => {
  let requestId = '';
  let custodyCaseId = '';
  let submitterSession = '';
  let agencySession = '';

  await t.step("setup and owner approval leave the custody-only request approved", async () => {
    await wipeDatabase();
    const admin = await createAdmin("CustodyLifecycleAdmin!2026");
    const adminSession = ((await loginAs(admin.email, "CustodyLifecycleAdmin!2026")) as any).session;
    const owner = await createActiveUser({ fullName: "Lifecycle Owner", email: uniqueEmail("cust-life-owner"), password: "LifecycleOwner!2026", affiliation: "agency" });
    const wired = await createWiredSystem(admin.id, owner);
    const submitter = await createActiveUser({ fullName: "Lifecycle Requester", email: uniqueEmail("cust-life-requester"), password: "LifecycleRequester!2026", affiliation: "vendor" });
    const vendorApprover = await createActiveUser({ fullName: "Lifecycle Vendor Approver", email: uniqueEmail("cust-life-vendor"), password: "LifecycleVendor!2026", affiliation: "vendor" });
    const agency = await createActiveUser({ fullName: "Lifecycle Agency", email: uniqueEmail("cust-life-agency"), password: "LifecycleAgency!2026", affiliation: "agency" });
    await addServingMember(wired.vendorL1, submitter, admin.id);
    await addServingMember(wired.vendorL2, vendorApprover, admin.id);
    await addMember(wired.agencyL1, agency, admin.id);
    submitterSession = ((await loginAs(submitter.email, "LifecycleRequester!2026")) as any).session;
    const vendorSession = ((await loginAs(vendorApprover.email, "LifecycleVendor!2026")) as any).session;
    agencySession = ((await loginAs(agency.email, "LifecycleAgency!2026")) as any).session;
    const ownerSession = ((await loginAs(owner.email, "LifecycleOwner!2026")) as any).session;
    const configs = STAGES.map((stage) => ({ stage, agencyTeamId: wired.agencyL1.id, instructions: `${stage} lifecycle`, dueInHours: 24 }));
    assertEquals((await req(`/admin/systems/${wired.system.id}`, { method: "PUT", headers: authHeaders(adminSession), body: { custodyStageConfigs: configs } })).status, 200);
    const asset = await createAsset(wired.system.id, { hostname: "lifecycle-device", credentialName: "Lifecycle device", credentialType: "device", managementMode: "manual" });
    const submit = await req('/requests', { method: 'POST', headers: authHeaders(submitterSession), body: {
      systemId: wired.system.id, justification: 'Custody lifecycle contract.', srNumber: 'SR-CUSTODY-LIFECYCLE',
      activityStartAt: new Date(Date.now() + 3_600_000).toISOString(), activityEndAt: new Date(Date.now() + 86_400_000).toISOString(),
      credentialItems: [{ assetId: asset.id }],
    } });
    requestId = (await submit.json()).request.id;
    assertEquals((await req(`/requests/${requestId}/step-decision`, { method: 'POST', headers: authHeaders(vendorSession), body: { decision: 'approve' } })).status, 200);
    assertEquals((await req(`/requests/${requestId}/step-decision`, { method: 'POST', headers: authHeaders(agencySession), body: { decision: 'approve' } })).status, 200);
    assertEquals((await req(`/requests/${requestId}/owner-decision`, { method: 'POST', headers: authHeaders(ownerSession), body: { decision: 'approve' } })).status, 200);
    const detail = await req(`/requests/${requestId}`, { headers: authHeaders(agencySession) }).then((response) => response.json());
    assertEquals(detail.request.status, 'approved');
    custodyCaseId = detail.assetCustody.cases[0].id;
  });

  await t.step("direct issue is rejected while custody is the persisted fulfillment route", async () => {
    const issue = await req(`/requests/${requestId}/issue-credential`, { method: 'POST', headers: authHeaders(agencySession) });
    assertEquals(issue.status, 409);
    assertMatch((await issue.json()).error, /physical custody/i);
    const detail = await req(`/requests/${requestId}`, { headers: authHeaders(submitterSession) }).then((response) => response.json());
    assertEquals(detail.request.status, 'approved');
  });

  await t.step("final requester receipt automatically marks custody-only request issued", async () => {
    assertEquals((await req(`/requests/${requestId}/asset-custody/actions`, { method: 'POST', headers: authHeaders(agencySession), body: { action: 'prepare_and_handover', custodyCaseIds: [custodyCaseId] } })).status, 200);
    assertEquals((await req(`/requests/${requestId}/asset-custody/actions`, { method: 'POST', headers: authHeaders(submitterSession), body: { action: 'confirm_receipt', custodyCaseIds: [custodyCaseId] } })).status, 200);
    const detail = await req(`/requests/${requestId}`, { headers: authHeaders(submitterSession) }).then((response) => response.json());
    assertEquals(detail.request.status, 'credential_issued');
    assertEquals(detail.assetCustody.cases[0].state, 'in_requester_custody');
  });

  await t.step("main request may close while physical return custody remains unresolved", async () => {
    const close = await req(`/requests/${requestId}/close`, { method: 'POST', headers: authHeaders(submitterSession), body: { closingNotes: 'Access use complete; physical return follows.' } });
    assertEquals(close.status, 200);
    const detail = await req(`/requests/${requestId}`, { headers: authHeaders(submitterSession) }).then((response) => response.json());
    assertEquals(detail.request.status, 'closed');
    assertEquals(detail.assetCustody.status, 'in_progress');
    assertEquals(detail.assetCustody.cases[0].state, 'in_requester_custody');
  });
});
