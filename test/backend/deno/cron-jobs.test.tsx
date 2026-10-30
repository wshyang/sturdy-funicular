// Coverage: the addendum-107 cron guarded executor + job-run observability.
// runJobWithGuards is driven BY HAND against the real database (no mocks) —
// the Deno.cron registration path (index.tsx) stays untested-by-design per
// addendum-019: this suite never imports index.tsx, so Deno.cron never fires
// here, exactly as intended.
//
//   1. unknown job name throws (advisory-key registry guard)
//   2. a guarded run executes the handler and finalizes a success job_run
//   3. a concurrent same-name run is 'skipped-in-flight', not queued
//   4. an externally held advisory lock yields 'skipped-locked' and NO
//      job_run — and the lock is reusable after external release (the
//      pre-107 pooled lock/unlock leak class, pinned against regression)
//   5. the REAL idempotency sweep runs through the guard against the real DB
//   6. the /health prompt path no-ops 'disabled' with the AWS integration off
//   7. GET /admin/job-runs is admin-only (anon 401, vendor 403) and reports
//      the runs this test produced
//   8. CRON_JOBS ⊆ JOB_ADVISORY_LOCK_KEYS (addendum-131: the addendum-121
//      due-sweep registered without a key — silently dead until 131; the
//      registry now lives in server/cron-jobs.tsx so this pin can exist)
import { assert, assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import { defineTest } from "./harness/harness.ts";
import { runJobWithGuards, JOB_ADVISORY_LOCK_KEYS } from "../../../server/cron.tsx";
import { promptTenantInboundSweepOnce } from "../../../server/aws/tenant-sweep.tsx";
import { sweepExpiredIdempotencyTokens } from "../../../server/idempotency.tsx";
import { query, connectDedicated } from "../../../server/pg.tsx";
import { mintIdempotencyToken, createActiveUser, loginAs, uniqueEmail } from "./helpers.tsx";
import { CRON_JOBS } from "../../../server/cron-jobs.tsx";
import { sweepExpiredIdentityChangeRequests } from "../../../server/identity-change.tsx";
import { identityChangeRequests, generateId, now } from "../../../server/db.tsx";

const JOB = "sweep-expired-idempotency-tokens";
const TENANT_JOB = "tenant-inbound-sweep";

async function jobRunCount(name: string): Promise<number> {
  const rows = await query<{ n: number }>(`SELECT count(*)::int AS n FROM job_runs WHERE job_name = $1`, [name]);
  return rows[0]?.n ?? 0;
}

async function lastJobRun(name: string): Promise<{ status: string | null; finished_at: string | null }> {
  const rows = await query<{ status: string | null; finished_at: string | null }>(
    `SELECT status, finished_at FROM job_runs WHERE job_name = $1 ORDER BY started_at DESC LIMIT 1`,
    [name],
  );
  assertExists(rows[0], `expected a job_runs row for ${name}`);
  return rows[0];
}

defineTest("cron guarded executor + job-run observability (addendum-107)", async ({ ctx, t }) => {
  await t.step("1 — an unknown job name throws (no advisory-lock key registered)", async () => {
    await assertRejects(() => runJobWithGuards("no-such-job", async () => {}), Error, "no advisory-lock key");
  });

  await t.step("8 — every registered cron job resolves an advisory-lock key (the 121 due-sweep gap, pinned)", () => {
    const missing = CRON_JOBS.map((j) => j.name).filter((name) => JOB_ADVISORY_LOCK_KEYS[name] === undefined);
    assertEquals(missing, [], 'every CRON_JOBS name must have a JOB_ADVISORY_LOCK_KEYS entry (unkeyed jobs die silently in the guarded executor)');
  });

  await t.step("2 — a guarded run executes the handler and finalizes a success job_run", async () => {
    let ran = 0;
    const before = await jobRunCount(JOB);
    const outcome = await runJobWithGuards(JOB, async () => {
      ran += 1;
    });
    assertEquals(outcome, "ran");
    assertEquals(ran, 1, "the stub handler actually executed");
    assertEquals(await jobRunCount(JOB), before + 1);
    const last = await lastJobRun(JOB);
    assertEquals(last.status, "success");
    assertExists(last.finished_at);
  });

  await t.step("3 — a concurrent same-name run is skipped-in-flight, not queued", async () => {
    let release!: () => void;
    const block = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The in-flight slot is taken synchronously inside runJobWithGuards
    // (before its first await), so by the time `second` runs the guard must
    // already see the first execution — no timing race.
    const first = runJobWithGuards(JOB, () => block);
    const second = await runJobWithGuards(JOB, async () => {});
    assertEquals(second, "skipped-in-flight");
    release();
    assertEquals(await first, "ran");
  });

  await t.step("4 — an externally held advisory lock skips with no job_run; release restores the job", async () => {
    // A second dedicated connection plays "the other replica": advisory locks
    // are session-scoped, so this is a faithful cross-process simulation.
    const external = await connectDedicated();
    const key = JOB_ADVISORY_LOCK_KEYS[JOB];
    try {
      await external.queryObject("SELECT pg_advisory_lock($1)", [key]);
      const before = await jobRunCount(JOB);
      assertEquals(await runJobWithGuards(JOB, async () => {}), "skipped-locked");
      assertEquals(await jobRunCount(JOB), before, "a locked-out attempt must not write a job_run");

      await external.queryObject("SELECT pg_advisory_unlock($1)", [key]);
      assertEquals(
        await runJobWithGuards(JOB, async () => {}),
        "ran",
        "the lock is free again once the OTHER session releases — and our own unlock left nothing held",
      );
    } finally {
      await external.queryObject("SELECT pg_advisory_unlock($1)", [key]).catch(() => {});
      external.release();
    }
  });

  await t.step("5 — the real idempotency sweep runs through the guard against the real DB", async () => {
    const expired = await mintIdempotencyToken(ctx.admin.id);
    const fresh = await mintIdempotencyToken(ctx.admin.id);
    // Backdate one token past the 1-hour post-expiry grace window (the sweep
    // deletes expires_at < now - grace; the live 2fa/login tokens minted for
    // the seeded ctx users are unexpired, so only this row is eligible).
    await query(`UPDATE idempotency_tokens SET expires_at = now() - interval '2 hours' WHERE token = $1`, [expired]);

    assertEquals(await runJobWithGuards(JOB, sweepExpiredIdempotencyTokens), "ran");

    const rows = await query<{ token: string }>(`SELECT token FROM idempotency_tokens WHERE token = ANY($1::uuid[])`, [[expired, fresh]]);
    const tokens = rows.map((r) => r.token);
    assert(!tokens.includes(expired), "the expired-beyond-grace token is swept");
    assert(tokens.includes(fresh), "the unexpired token survives");
    assertEquals((await lastJobRun(JOB)).status, "success");
  });

  await t.step("6 — the /health prompt path no-ops 'disabled' with the AWS integration off", async () => {
    const before = await jobRunCount(TENANT_JOB);
    assertEquals(await promptTenantInboundSweepOnce(), "disabled");
    assertEquals(await jobRunCount(TENANT_JOB), before, "no lock, no job_run while the integration is disabled");
  });

  await t.step("7 — GET /admin/job-runs is admin-only and reports the runs above", async () => {
    const res = await ctx.actors.admin.get("/admin/job-runs");
    assertEquals(res.status, 200);
    const jobs = (res.json?.jobs ?? []) as Array<{ name: string; status: string | null; runsLast24h: number }>;
    const job = jobs.find((j) => j.name === JOB);
    assertExists(job, "the admin payload includes the job this test ran");
    assertEquals(job.status, "success");
    assert(job.runsLast24h >= 1, "24h count aggregates this test's runs");

    assertEquals((await ctx.actors.vendor.get("/admin/job-runs")).status, 403, "non-admin user is rejected");
    assertEquals((await ctx.api.get("/admin/job-runs")).status, 401, "anonymous request is rejected at the session gate");
  });

  await t.step("9 — G5 direct-call: the identity-change sweep expires ONLY past-expiry pending rows", async () => {
    // The sweep (sweepExpiredIdentityChangeRequests) is registry-pinned via
    // CRON_JOBS but was never driven directly: seed one EXPIRED and one
    // FUTURE pending request for distinct users (each with their own live
    // session), then sweep. Two separate users avoids createSessionExclusive
    // deleting the first session when the second login fires.
    const user1 = await createActiveUser({ email: uniqueEmail("g5-sweep-a"), password: "G5SweepA!2026", affiliation: "agency" });
    const user2 = await createActiveUser({ email: uniqueEmail("g5-sweep-b"), password: "G5SweepB!2026", affiliation: "agency" });
    const login1 = await loginAs(user1.email, "G5SweepA!2026");
    if ("error" in login1) throw new Error(`loginAs failed: ${login1.error}`);
    const login2 = await loginAs(user2.email, "G5SweepB!2026");
    if ("error" in login2) throw new Error(`loginAs failed: ${login2.error}`);

    const makeBase = (user: typeof user1) => ({
      userId: user.id,
      provider: "entra_id",
      changeType: "local_to_entra_upgrade" as const,
      source: "password_login" as const,
      oldExternalIdentityId: null,
      oldExternalId: null,
      newExternalId: "oid-g5-sweep",
      externalUpn: null,
      email: user.email,
      status: "pending" as const,
      detectedAt: now(),
      completedAt: null,
      failedAt: null,
      failureReason: null,
    });
    const expired = await identityChangeRequests.create({
      ...makeBase(user1), id: generateId(), sessionId: login1.session,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const future = await identityChangeRequests.create({
      ...makeBase(user2), id: generateId(), sessionId: login2.session,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });

    await sweepExpiredIdentityChangeRequests();

    assertEquals((await identityChangeRequests.get(expired.id))?.status, "expired", "past-expiry pending row is swept");
    assertEquals((await identityChangeRequests.get(future.id))?.status, "pending", "in-window pending row is untouched");
  });
});
