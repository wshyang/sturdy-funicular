// Coverage: POST /requests/:id/asset-custody/exceptions — the multipart
// route-validation arms behind §F's custody problem-report modal that
// physical_asset_custody.test.tsx leaves unpinned (it owns the positive
// exception flow, the spoofed/executable/empty/oversized upload arms and the
// action-route bounds arms): unknown-request 404, report-validity 400s
// (bogus type, empty/over-long description, non-UUID case id) and the
// 20-file attachment cap. Every arm fires at the route boundary before
// custody-case resolution, so a plain submitted request is enough.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { run01Steps } from "./custody-exception-guards-suite/01-exception-validation.steps.ts";
import type { SuiteContext } from "./custody-exception-guards-suite/00-context.ts";

Deno.test("custody_exception_guards", async (t) => {
  const context = {} as SuiteContext;

  await t.step("setup: wired system + one submitted request from its vendor L1 submitter", async () => {
    await wipeDatabase();
    const admin = await createAdmin("CustGuardAdmin!2026");
    context.adminId = admin.id;
    context.adminSession = ((await loginAs(admin.email, "CustGuardAdmin!2026")) as any).session;

    const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("cg-owner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1 } = await createWiredSystem(admin.id, owner);
    const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("cg-sub"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, admin.id);
    context.submitterSession = ((await loginAs(submitter.email, "SubmitPass!2026")) as any).session;

    const asset = await createAsset(system.id, { hostname: "cg-vault-01" });
    const submitRes = await req("/requests", {
      method: "POST",
      headers: authHeaders(context.submitterSession),
      body: {
        systemId: system.id,
        justification: "Custody exception-validation coverage request.",
        srNumber: "SR-CG-001",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id, hostnameDescription: "custody-guards host" }],
      },
    });
    assertEquals(submitRes.status, 201);
    const submitted = await submitRes.json();
    assertExists(submitted.request?.id);
    context.requestId = submitted.request.id;
  });

  await run01Steps(t, context);
});
