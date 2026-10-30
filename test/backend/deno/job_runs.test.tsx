// Coverage: audit_log.jobRunId linkage for cron/system-originated writes
// — see addendum-041-uuidv7-and-object-lifecycle-traceability.md.
// reconcileAssetInventory (aws-asset-inventory.tsx) is the concrete writer
// exercised here; jobRunContext.run(...) simulates what cron.tsx's
// registerJob() wrapper does around every real cron tick, since
// Deno.cron itself can't be fast-forwarded in a test process (see
// cron.tsx's own "not unit-testable" note).
import { assertEquals, assertExists } from "jsr:@std/assert";
import { auditLogs, jobRuns, generateId } from "../../../server/db.tsx";
import { jobRunContext, beginJobRun, finalizeJobRun } from "../../../server/job-run-context.tsx";
import { reconcileAssetInventory } from "../../../server/aws/asset-inventory.tsx";
import { SYSTEM_USER_ID } from "../../../server/types.tsx";
import { req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, createWiredSystem, createOrganization, addOrgMembership, repointOwnerOrgEdge } from "./helpers.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";

Deno.test("job_runs causal linkage", async (t) => {
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("JobRunsAdmin!2026");
    adminId = admin.id;
  });

  await t.step("positive — an audit row written inside jobRunContext.run(...) gets a real job_run_id, with actor_id SYSTEM_USER_ID, and access_log_id stays null", async () => {
    const owner = await createActiveUser({ fullName: "JRAOwner", email: uniqueEmail("jraowner"), password: "JRAOwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);

    const jobRunId = await beginJobRun("test-sweep-asset-inventory");
    assertExists(jobRunId);

    await jobRunContext.run(jobRunId, async () => {
      await reconcileAssetInventory(system, {
        schemaVersion: "1.0",
        systemId: system.id,
        status: "success",
        assets: [],
        errorMessage: null,
        processedAt: new Date().toISOString(),
      });
    });
    await finalizeJobRun(jobRunId, { status: "success" });

    const logs = await auditLogs.findByTarget("system", system.id);
    const synced = logs.find((l) => l.action === "asset_inventory.synced");
    assertExists(synced);
    assertEquals(synced!.actorId, SYSTEM_USER_ID);
    assertExists(synced!.jobRunId);
    assertEquals(synced!.accessLogId, null);

    // The job_run_id resolves to a real job_runs row.
    const jobRun = await jobRuns.get(synced!.jobRunId!);
    assertExists(jobRun);
    assertEquals(jobRun!.jobName, "test-sweep-asset-inventory");
    assertEquals(jobRun!.status, "success");
    assertExists(jobRun!.finishedAt);
  });

  await t.step("positive — an HTTP-originated audit row in the SAME test run still gets access_log_id (not job_run_id), proving the two contexts don't leak into each other", async () => {
    const owner = await createActiveUser({ fullName: "JRAOwner2", email: uniqueEmail("jraowner2"), password: "JRAOwner2Pass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const login = await loginAs(owner.email, "JRAOwner2Pass!2026");

    // A real HTTP call that itself writes an audit_log row — e.g. adding a
    // delegate — outside any jobRunContext.run(...) call.
    // addendum-134, as amended by 206 §4.3: the delegate must be an agency
    // member of a LINKED org — re-point the owner edge (the junction, not the
    // cluster, is the org truth) and enlist the candidate there.
    const candidate = await createActiveUser({ fullName: "JRACandidate", email: uniqueEmail("jracandidate"), password: "JRACandidatePass!2026", affiliation: "agency" });
    const jraOrg = await createOrganization({ name: `JRAOrg-${system.id.slice(0, 8)}`, shortCode: `JR${system.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`, createdBy: adminId });
    await repointOwnerOrgEdge(system.id, jraOrg.id, adminId);
    await addOrgMembership({ organizationId: jraOrg.id, userId: candidate.id, addedBy: adminId });
    const res = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST", headers: authHeaders((login as any).session), body: { delegateUserId: candidate.id },
    });
    assertEquals(res.status, 201);
    const { delegate } = await res.json();

    const logs = await auditLogs.findByTarget("system_delegate", delegate.id);
    const added = logs.find((l) => l.action === "system_delegate.added");
    assertExists(added);
    assertExists(added!.accessLogId);
    assertEquals(added!.jobRunId, null);
  });

  await t.step("negative — a failed job's finalizeJobRun records status=error with the message", async () => {
    const jobRunId = await beginJobRun("test-always-fails");
    assertExists(jobRunId);
    await finalizeJobRun(jobRunId, { status: "error", errorMessage: "simulated failure" });

    const jobRun = await jobRuns.get(jobRunId!);
    assertExists(jobRun);
    assertEquals(jobRun!.status, "error");
    assertEquals(jobRun!.errorMessage, "simulated failure");
    assertExists(jobRun!.finishedAt);
  });
});

// Addendum-204 F4: GET /admin/job-runs was gated on bare requireAdmin —
// any grant, scoped included. The scheduler telemetry it returns (latest
// runs, error payloads that can name systems/tenants) is global-plane
// observability with no org keying, so the gate is now a GLOBAL admin
// grant (owner direction 2026-08-17: "limit job runs to global admins
// only"). Scoped admins and non-admins both get 403; unauthenticated 401.
Deno.test("GET /admin/job-runs is global-admin only (addendum-204 F4)", async (t) => {
  let globalSession = "";
  let scopedSession = "";
  let vendorSession = "";

  await t.step("setup: global admin, org-scoped user_admin, plain vendor", async () => {
    await wipeDatabase();
    const admin = await createAdmin("F4Admin!2026");
    globalSession = (await loginAs(admin.email, "F4Admin!2026") as any).session;
    const org = await createOrganization({ name: "F4 Org A", shortCode: "F4A", createdBy: admin.id });
    const scopedAdmin = await createActiveUser({
      fullName: "F4 Scoped", email: uniqueEmail("f4scoped"), password: "F4Scoped!2026", affiliation: "agency",
    });
    await addOrgMembership({ organizationId: org.id, userId: scopedAdmin.id, addedBy: admin.id });
    await grantAdminRole(scopedAdmin.id, "user_admin", admin.id, "addendum-204 F4 fixture", org.id);
    scopedSession = (await loginAs(scopedAdmin.email, "F4Scoped!2026") as any).session;
    const vendor = await createActiveUser({
      fullName: "F4 Vendor", email: uniqueEmail("f4vendor"), password: "F4Vendor!2026", affiliation: "vendor",
    });
    vendorSession = (await loginAs(vendor.email, "F4Vendor!2026") as any).session;
    assertExists(globalSession);
    assertExists(scopedSession);
    assertExists(vendorSession);
  });

  await t.step("negative — an org-scoped admin is 403 (bare requireAdmin used to pass them)", async () => {
    const res = await req("/admin/job-runs", { headers: authHeaders(scopedSession) });
    assertEquals(res.status, 403);
  });

  await t.step("negative — a non-admin is still 403", async () => {
    const res = await req("/admin/job-runs", { headers: authHeaders(vendorSession) });
    assertEquals(res.status, 403);
  });

  await t.step("positive — a global admin gets the jobs projection (regression envelope)", async () => {
    const res = await req("/admin/job-runs", { headers: authHeaders(globalSession) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(Array.isArray(body.jobs), true);
  });
});
