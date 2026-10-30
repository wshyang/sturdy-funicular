// Coverage: POST /requests, PUT /requests/:id/resubmit, POST /requests/:id/step-decision,
// POST /requests/:id/owner-decision, POST /requests/:id/admin-reset,
// POST /requests/:id/issue-credential, POST /requests/:id/close, GET /requests/:id,
// GET /requests/my-requests, GET /requests/search, PUT /requests/:id/approver-edit.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, addMember, addServingMember, createCluster, createTeam, createAsset,
  createSingleStepAgencySystem, createFourStepSystem, latestSentNotification, sentNotificationEmailSnapshots,
} from "./helpers.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";
import { systemOwners, teamMemberships, requestKeyMaterial, assets, generateId, now } from "../../../server/db.tsx";

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

import { run01Steps } from "./request-suite/01-submission-visibility-decisions.steps.ts";
import { run02Steps } from "./request-suite/02-owner-delivery-reset.steps.ts";
import { run03Steps } from "./request-suite/03-search-override-topology.steps.ts";

Deno.test("requests", async (t) => {
  let adminId: string;
  let adminSession: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("ReqAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "ReqAdmin!2026");
    adminSession = (login as any).session;
  });

  const context = { adminId, adminSession };
  await run01Steps(t, context);
  await run02Steps(t, context);
  await run03Steps(t, context);
});
