// Coverage: addendum-205-runtime-derives-team-visibility-live.md regression —
// runtime team-based visibility and step authorization derive
// workflow_definition ⋈ live teams ⋈ memberships DIRECTLY and never consult
// team_system_mappings. Proven by wiping every mapping row mid-scenario and
// showing submit/review/visibility all still work, plus the 2026-08-20 UAT
// bug itself (team created AFTER the workflow save binds immediately). See
// docs/test-bug-fixes.md #57.
import { assertEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createCluster, createTeam, addMember, addServingMember, createWiredSystem, createAsset, seedOwnerOrgEdge,
  createSystemWithOwnerOrgEdge,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { systems, systemOwners, teamSystemMappings, generateId, now } from "../../../server/db.tsx";
import type { System, WorkflowStep } from "../../../server/types.tsx";

let shortCodeSeq = 0;
function uniqueShortCode(): string {
  shortCodeSeq += 1;
  return `VD${shortCodeSeq}`;
}

async function mySystemIds(session: unknown): Promise<string[]> {
  const res = await req("/my-systems", { headers: authHeaders(session) });
  assertEquals(res.status, 200);
  const data = await res.json();
  return (data.systems as System[]).map((s) => s.id).sort();
}

async function validSubmission(systemId: string) {
  return {
    systemId,
    justification: "Derivation regression — incident access.",
    srNumber: "SR-2051",
    activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    credentialItems: [{ assetId: (await createAsset(systemId, { hostname: "host-205" })).id, hostnameDescription: "derivation host" }],
  };
}

Deno.test("addendum-205: runtime visibility/authorization derive live, never read team_system_mappings", async (t) => {
  let adminSession: unknown;
  let adminId = "";

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("DerivationAdminPass!2026");
    adminId = admin.id;
    adminSession = (await loginAs(admin.email, "DerivationAdminPass!2026") as any).session;
  });

  // ── Baseline: fixture builds mapping rows; visibility works ────────────
  let systemAId = "";
  let submitterSession: unknown;
  let vendorApproverSession: unknown;
  let vendorL1Id = "";
  await t.step("baseline: submitter and reviewer see the wired system", async () => {
    const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("vd-owner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1, vendorL2 } = await createWiredSystem(adminId, owner);
    systemAId = system.id;
    vendorL1Id = vendorL1.id;

    const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("vd-sub"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, adminId);
    const vendorApprover = await createActiveUser({ fullName: "VendorApprover", email: uniqueEmail("vd-appr"), password: "ApprPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL2, vendorApprover, adminId);

    submitterSession = (await loginAs(submitter.email, "SubmitPass!2026") as any).session;
    vendorApproverSession = (await loginAs(vendorApprover.email, "ApprPass!2026") as any).session;

    assertEquals(await mySystemIds(submitterSession), [systemAId]);
    assertEquals(await mySystemIds(vendorApproverSession), [systemAId]);
  });

  // ── The class-killer: wipe EVERY mapping row; runtime must not care ────
  let requestId = "";
  await t.step("class-killer: zero mapping rows — visibility, submit and step-decision still work", async () => {
    await query("DELETE FROM team_system_mappings");
    assertEquals(await teamSystemMappings.findBySystem(systemAId), []);

    // Visibility derives from the workflow, not rows.
    assertEquals(await mySystemIds(submitterSession), [systemAId]);
    assertEquals(await mySystemIds(vendorApproverSession), [systemAId]);

    // canSubmit derives too — the submission route accepts.
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(submitterSession), body: await validSubmission(systemAId),
    });
    assertEquals(submitRes.status, 201);
    requestId = (await submitRes.json()).request.id;

    // isStepReviewer resolves the pinned step's (cluster, level) → live team
    // → membership; the vendor L2 approver's decision on step 2 succeeds
    // with zero mapping rows in the entire database.
    const decisionRes = await req(`/requests/${requestId}/step-decision`, {
      method: "POST", headers: authHeaders(vendorApproverSession), body: { decision: "approve" },
    });
    assertEquals(decisionRes.status, 200);
  });

  // ── The 2026-08-20 UAT bug: team created AFTER the workflow save ───────
  await t.step("regression: a team created after its slot was saved binds immediately", async () => {
    const lateCluster = await createCluster("vendor", adminId);
    const agencyCluster = await createCluster("agency", adminId);
    const owner = await createActiveUser({ fullName: "OwnerB", email: uniqueEmail("vd-ownerb"), password: "OwnerPass!2026", affiliation: "agency" });

    // System B's Step 1 points at (lateCluster, 1) while NO team exists
    // there — saved straight via entities, exactly the drift auto-sync could
    // not heal (it only ever ran on workflow saves).
    const lateStep: WorkflowStep = { ordinal: 1, clusterId: lateCluster.id, level: 1, stepKind: "hierarchical", notes: null };
    const systemB: System = {
      id: generateId(),
      shortCode: uniqueShortCode(),
      name: "Late Team System",
      description: null,
      vendorClusterIds: [lateCluster.id],
      agencyClusterId: agencyCluster.id,
      workflowDefinition: [lateStep],
      awsRoleArnNote: null,
      expiresAfter: null,
      createdBy: adminId,
      createdAt: now(),
      updatedAt: now(),
    };
    await createSystemWithOwnerOrgEdge(systemB, agencyCluster, adminId);
    await systemOwners.create({
      id: generateId(), systemId: systemB.id, userId: owner.id, kind: "primary",
      expiresAfter: null, createdBy: adminId, createdAt: now(),
    });

    // Admin surface reports the step as unmapped (no live team) BEFORE the
    // team exists — the truthful, derived signal.
    const beforeRes = await req(`/admin/systems/${systemB.id}/mappings`, { headers: authHeaders(adminSession) });
    assertEquals(beforeRes.status, 200);
    const before = await beforeRes.json();
    assertEquals(before.unmappedSteps, [{ ordinal: 1, clusterId: lateCluster.id, level: 1 }]);

    // The team arrives LATE — the empty-droplist bug's exact precondition…
    const lateTeam = await createTeam(lateCluster, 1, adminId);
    const lateVendor = await createActiveUser({ fullName: "LateVendor", email: uniqueEmail("vd-late"), password: "LatePass!2026", affiliation: "vendor" });
    await addServingMember(lateTeam, lateVendor, adminId);

    // …and the team has ZERO mapping rows (nothing re-synced — pre-205 this
    // meant an empty droplist until a workflow re-save)…
    assertEquals(await teamSystemMappings.findByTeam(lateTeam.id), []);

    const lateSession = (await loginAs(lateVendor.email, "LatePass!2026") as any).session;

    // …yet the vendor sees the system immediately, and the badge clears.
    assertEquals(await mySystemIds(lateSession), [systemB.id]);
    const afterRes = await req(`/admin/systems/${systemB.id}/mappings`, { headers: authHeaders(adminSession) });
    const after = await afterRes.json();
    assertEquals(after.unmappedSteps, []);
  });

  // ── Negatives: derivation still respects team liveness and membership ──
  await t.step("negative: an expired team derives nothing; a non-member sees nothing", async () => {
    const outsider = await createActiveUser({ fullName: "Outsider", email: uniqueEmail("vd-out"), password: "OutPass!2026", affiliation: "vendor" });
    const outsiderSession = (await loginAs(outsider.email, "OutPass!2026") as any).session;
    assertEquals(await mySystemIds(outsiderSession), []);

    await query(`UPDATE teams SET expires_after = $1 WHERE id = $2`, [now(), vendorL1Id]);
    assertEquals(await mySystemIds(submitterSession), []);
  });
});
