// Coverage: POST /requests/:id/step-decision and POST /requests/:id/owner-decision
// — the route-boundary VALIDATION and per-decision AUTHORIZATION arms (invalid
// decision value, notes-required on return/reject, unknown request 404,
// wrong-step / non-reviewer / stranger 403s, downstream override lane,
// delegate terminal decision) that the §C/§D/§E frontend negative stories lean
// on. Complements requests.test.tsx (happy paths), state-guards.test.tsx
// (status guards) and concurrency.test.tsx (row-lock races) — none of which
// pin these 400/403 classes.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { run01Steps } from "./decision-validation-suite/01-step-decision-validation.steps.ts";
import { run02Steps } from "./decision-validation-suite/02-owner-decision-validation.steps.ts";
import type { SuiteContext } from "./decision-validation-suite/00-context.ts";

Deno.test("decision_validation", async (t) => {
  const context = {} as SuiteContext;

  await t.step("setup: wired system, four actors, one in-flight request at vendor L2", async () => {
    await wipeDatabase();
    const admin = await createAdmin("DecValAdmin!2026");
    context.adminId = admin.id;
    const adminLogin = await loginAs(admin.email, "DecValAdmin!2026");
    context.adminSession = (adminLogin as any).session;

    const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("dv-owner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1, vendorL2, agencyL1, agencyCluster } = await createWiredSystem(admin.id, owner);
    context.systemId = system.id;
    context.agencyClusterId = agencyCluster.id;
    const ownerLogin = await loginAs(owner.email, "OwnerPass!2026");
    context.ownerSession = (ownerLogin as any).session;

    // addendum-206 D1: vendor actors need the service membership of the
    // system's linked org (the wired topology's fallback org) — roster via
    // addServingMember; agency actors are gate-exempt (plain addMember).
    const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("dv-sub"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, admin.id);
    const vendorApprover = await createActiveUser({ fullName: "VendorApprover", email: uniqueEmail("dv-vappr"), password: "VendorApprPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL2, vendorApprover, admin.id);
    const agencyApprover = await createActiveUser({ fullName: "AgencyApprover", email: uniqueEmail("dv-aappr"), password: "AgencyApprPass!2026", affiliation: "agency" });
    await addMember(agencyL1, agencyApprover, admin.id);
    const stranger = await createActiveUser({ fullName: "Stranger", email: uniqueEmail("dv-stranger"), password: "StrangerPass!2026", affiliation: "vendor" });
    const delegate = await createActiveUser({ fullName: "Delegate", email: uniqueEmail("dv-delegate"), password: "DelegatePass!2026", affiliation: "agency" });
    context.delegateUserId = delegate.id;

    context.submitterSession = ((await loginAs(submitter.email, "SubmitPass!2026")) as any).session;
    context.vendorApproverSession = ((await loginAs(vendorApprover.email, "VendorApprPass!2026")) as any).session;
    context.agencyApproverSession = ((await loginAs(agencyApprover.email, "AgencyApprPass!2026")) as any).session;
    context.strangerSession = ((await loginAs(stranger.email, "StrangerPass!2026")) as any).session;
    context.delegateSession = ((await loginAs(delegate.email, "DelegatePass!2026")) as any).session;

    const asset = await createAsset(system.id, { hostname: "dv-vault-01" });
    const submitRes = await req("/requests", {
      method: "POST",
      headers: authHeaders(context.submitterSession),
      body: {
        systemId: system.id,
        justification: "Decision-validation coverage: production incident access.",
        srNumber: "SR-DV-001",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id, hostnameDescription: "decision-validation host" }],
      },
    });
    assertEquals(submitRes.status, 201);
    const submitted = await submitRes.json();
    assertExists(submitted.request?.id);
    context.requestId = submitted.request.id;
  });

  await run01Steps(t, context);
  await run02Steps(t, context);
});
