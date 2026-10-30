// Coverage: the idempotency-token enforcement middleware (app.tsx) applied
// to mutating routes. See docs/specs/addenda/addendum-008-idempotency-tokens.md
// for the full design. Uses POST /admin/clusters as a representative mutating
// route rather than re-testing every route — the middleware is global, so
// its behavior doesn't vary by which route it guards.
//
// See also addendum-014-idempotency-transactions-and-cleanup.md for the real
// transaction support tested below: token consumption and the downstream
// handler's own business writes now share ONE Postgres transaction
// (runInTransaction, server/pg.tsx, via AsyncLocalStorage), so a genuine
// mid-handler failure rolls back both.
import { assertEquals, assertExists } from "jsr:@std/assert";
import { req, authHeaders, wipeDatabase, createAdmin, loginAs, mintIdempotencyToken, uniqueName, fixtureFallbackOrgId } from "./helpers.tsx";
import { runInTransaction, query } from "../../../server/pg.tsx";
import { idempotencyTokens, generateId, now } from "../../../server/db.tsx";
import { sweepExpiredIdempotencyTokens } from "../../../server/idempotency.tsx";

Deno.test("idempotency", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("negative — missing X-Idempotency-Token header on a mutating route", async () => {
    const admin = await createAdmin("IdemPass!2026");
    const { session } = (await loginAs(admin.email, "IdemPass!2026")) as any;

    // req()'s auto-attach only fires when the caller hasn't set the header
    // itself — pass an explicit empty headers-without-token set by omitting
    // it AND forcing the auto-attach off is not directly possible via req(),
    // so call app.request via req() but strip the header the helper would
    // otherwise add by setting it to an empty string (falsy check in the
    // route's own header lookup treats '' the same as absent).
    const res = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": "" },
      body: { name: uniqueName("cluster"), type: "vendor", organizationId: await fixtureFallbackOrgId(admin.id) },
    });
    assertEquals(res.status, 409);
    const data = await res.json();
    assertExists(data.error);
  });

  await t.step("negative — invalid (never-issued) token", async () => {
    const admin = await createAdmin("IdemPass2!2026");
    const { session } = (await loginAs(admin.email, "IdemPass2!2026")) as any;

    const res = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": crypto.randomUUID() },
      body: { name: uniqueName("cluster"), type: "vendor", organizationId: await fixtureFallbackOrgId(admin.id) },
    });
    assertEquals(res.status, 409);
  });

  await t.step("negative — already-used token rejected on a second request", async () => {
    const admin = await createAdmin("IdemPass3!2026");
    const { session } = (await loginAs(admin.email, "IdemPass3!2026")) as any;
    const token = await mintIdempotencyToken(admin.id);

    const first = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": token },
      body: { name: uniqueName("cluster"), type: "vendor", organizationId: await fixtureFallbackOrgId(admin.id) },
    });
    assertEquals(first.status, 201);

    // Same token, second request — must be rejected even though the first
    // request succeeded (this is the actual double-submission guard).
    const second = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": token },
      body: { name: uniqueName("cluster"), type: "vendor", organizationId: await fixtureFallbackOrgId(admin.id) },
    });
    assertEquals(second.status, 409);
  });

  await t.step("negative — a token minted for a different user is rejected", async () => {
    const admin1 = await createAdmin("IdemPass4!2026");
    const admin2 = await createAdmin("IdemPass5!2026");
    const { session } = (await loginAs(admin1.email, "IdemPass4!2026")) as any;
    const tokenForOtherUser = await mintIdempotencyToken(admin2.id);

    const res = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": tokenForOtherUser },
      body: { name: uniqueName("cluster"), type: "vendor", organizationId: await fixtureFallbackOrgId(admin1.id) },
    });
    assertEquals(res.status, 409);
  });

  await t.step("positive — valid token succeeds and the response rotates in a fresh token", async () => {
    const admin = await createAdmin("IdemPass6!2026");
    const { session } = (await loginAs(admin.email, "IdemPass6!2026")) as any;
    const token = await mintIdempotencyToken(admin.id);

    const res = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": token },
      body: { name: uniqueName("cluster"), type: "vendor", organizationId: await fixtureFallbackOrgId(admin.id) },
    });
    assertEquals(res.status, 201);
    const rotated = res.headers.get("X-Idempotency-Token");
    assertExists(rotated);
    assertEquals(rotated === token, false);

    // The rotated token is itself valid and usable on a follow-up request.
    const followUp = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": rotated! },
      body: { name: uniqueName("cluster"), type: "vendor", organizationId: await fixtureFallbackOrgId(admin.id) },
    });
    assertEquals(followUp.status, 201);
  });

  await t.step("positive — a token still rotates in the response even on a failed (validation-error) request", async () => {
    const admin = await createAdmin("IdemPass7!2026");
    const { session } = (await loginAs(admin.email, "IdemPass7!2026")) as any;
    const token = await mintIdempotencyToken(admin.id);

    // Missing required "name" field — a 400 from the route's own validation,
    // not the idempotency middleware.
    const res = await req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": token },
      body: { type: "vendor" },
    });
    assertEquals(res.status, 400);
    const rotated = res.headers.get("X-Idempotency-Token");
    assertExists(rotated);
  });

  await t.step("positive — GET/OPTIONS requests are never gated by idempotency", async () => {
    const admin = await createAdmin("IdemPass8!2026");
    const { session } = (await loginAs(admin.email, "IdemPass8!2026")) as any;

    // No X-Idempotency-Token header at all — a GET must never 409.
    const res = await req("/admin/clusters", { headers: authHeaders(session) });
    assertEquals(res.status, 200);
  });

  await t.step("positive — unauthenticated mutating requests are not blocked by idempotency (route's own 401/403 applies)", async () => {
    const res = await req("/admin/clusters", {
      method: "POST",
      body: { name: uniqueName("cluster"), type: "vendor" },
    });
    // No session at all — the route's own auth check should produce the
    // failure, not a 409 from idempotency enforcement.
    assertEquals(res.status, 403);
  });

  await t.step("positive — auth/signup, auth/login, auth/logout are excluded from enforcement", async () => {
    const email = `idem-excl-${crypto.randomUUID()}@test.local`;
    const signupRes = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "Idem Exclusion", email, password: "ValidPass!2026" },
    });
    assertEquals(signupRes.status, 201);
  });

  // ── Real transaction support (addendum-014-idempotency-transactions-and-cleanup.md) ──

  await t.step("transaction: positive — runInTransaction rolls back a write on a thrown error", async () => {
    const admin = await createAdmin("TxnPass1!2026");
    const probeName = uniqueName("txn-probe-cluster");

    let threw = false;
    try {
      await runInTransaction(async () => {
        const { clusters } = await import("../../../server/db.tsx");
        await clusters.create({
          id: generateId(), name: probeName, type: "vendor", description: null,
          organizationId: await fixtureFallbackOrgId(admin.id),
          createdBy: admin.id, createdAt: now(), updatedAt: now(),
        });
        // Confirm the write is visible WITHIN the still-open transaction...
        const rows = await query(`SELECT * FROM clusters WHERE name = $1`, [probeName]);
        assertEquals(rows.length, 1);
        throw new Error("deliberate failure to force rollback");
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);

    // ...but gone entirely once the transaction has rolled back and released.
    const after = await query(`SELECT * FROM clusters WHERE name = $1`, [probeName]);
    assertEquals(after.length, 0);
  });

  await t.step("transaction: positive — runInTransaction commits a write on success", async () => {
    const admin = await createAdmin("TxnPass2!2026");
    const probeName = uniqueName("txn-commit-cluster");

    await runInTransaction(async () => {
      const { clusters } = await import("../../../server/db.tsx");
      await clusters.create({
        id: generateId(), name: probeName, type: "vendor", description: null,
        organizationId: await fixtureFallbackOrgId(admin.id),
        createdBy: admin.id, createdAt: now(), updatedAt: now(),
      });
    });

    const after = await query(`SELECT * FROM clusters WHERE name = $1`, [probeName]);
    assertEquals(after.length, 1);
  });

  await t.step("transaction: positive — concurrent requests with the SAME idempotency token: exactly one succeeds, the other 409s (real concurrent load, not sequential reuse)", async () => {
    const admin = await createAdmin("TxnPass3!2026");
    const { session } = (await loginAs(admin.email, "TxnPass3!2026")) as any;
    const token = await mintIdempotencyToken(admin.id);
    const clusterOrgId = await fixtureFallbackOrgId(admin.id);

    const fire = () => req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": token },
      body: { name: uniqueName("concurrent-cluster"), type: "vendor", organizationId: clusterOrgId },
    });

    const [a, b] = await Promise.all([fire(), fire()]);
    const statuses = [a.status, b.status].sort();
    // The atomic `UPDATE ... WHERE used_at IS NULL` (idempotencyTokens.consume,
    // server/db.tsx) guarantees this under real concurrent load, not just
    // sequential re-use — the second racer never observes the token as
    // still-unused, even though both requests started before either finished.
    assertEquals(statuses, [201, 409]);
  });

  await t.step("transaction: positive — a genuine mid-handler DB failure rolls back the write AND leaves the token un-consumed (not spent-with-no-effect)", async () => {
    const admin = await createAdmin("TxnPass4!2026");
    const { session } = (await loginAs(admin.email, "TxnPass4!2026")) as any;
    const clashName = uniqueName("race-cluster");
    const clashOrgId = await fixtureFallbackOrgId(admin.id);
    const tokenWinner = await mintIdempotencyToken(admin.id);
    const tokenLoser = await mintIdempotencyToken(admin.id);

    // Two concurrent creates of the SAME (name, type) pair. createCluster's
    // own check-then-insert (routes-admin-clusters.tsx) can't see the other
    // request's uncommitted row, so both pass the app-level uniqueness
    // check — the second INSERT only fails at the database's unique index
    // (clusters_name_type_uniq) once the first transaction commits. This is
    // an uncaught error from the route's perspective, caught by its generic
    // catch block, and surfaces as a 500 — exactly the case the middleware's
    // rollback-on-5xx logic exists for.
    const fire = (token: string) => req("/admin/clusters", {
      method: "POST",
      headers: { ...authHeaders(session), "X-Idempotency-Token": token },
      body: { name: clashName, type: "vendor", organizationId: clashOrgId },
    });
    const [r1, r2] = await Promise.all([fire(tokenWinner), fire(tokenLoser)]);

    const statuses = [r1.status, r2.status];
    const winnerRes = statuses[0] === 201 ? r1 : r2;
    const loserRes = statuses[0] === 201 ? r2 : r1;
    assertEquals(winnerRes.status, 201);
    assertEquals(loserRes.status, 500);

    // Exactly one cluster with this name+type exists — the loser's write was
    // rolled back, not left as a duplicate or partial row.
    const matching = await query(`SELECT * FROM clusters WHERE name = $1 AND type = 'vendor'`, [clashName]);
    assertEquals(matching.length, 1);

    // The loser's idempotency token was consumed WITHIN the same transaction
    // that got rolled back — it must be un-consumed afterward (still usable
    // on retry), not silently spent for a write that never actually landed.
    const loserToken = statuses[0] === 201 ? tokenLoser : tokenWinner;
    const tokenRow = await idempotencyTokens.findByToken(loserToken);
    assertExists(tokenRow);
    assertEquals(tokenRow!.usedAt, null);
  });

  // ── Hourly cron sweep (addendum-019-cron-mechanism.md) ──
  // sweepExpiredIdempotencyTokens() is the plain, directly-testable function
  // the cron job (registered in index.tsx, never imported by this suite)
  // calls hourly. Tested here with no HTTP/cron involved, against real
  // Postgres, per this repo's no-mocking test discipline.

  await t.step("sweep: deletes tokens expired over an hour ago, leaves grace-period and unexpired tokens alone", async () => {
    const admin = await createAdmin("SweepPass1!2026");

    const expiredLongAgo = crypto.randomUUID();
    const expiredWithinGrace = crypto.randomUUID();
    const notYetExpired = crypto.randomUUID();

    await idempotencyTokens.create({
      id: generateId(), userId: admin.id, token: expiredLongAgo, createdAt: now(),
      usedAt: null, expiresAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    await idempotencyTokens.create({
      id: generateId(), userId: admin.id, token: expiredWithinGrace, createdAt: now(),
      usedAt: null, expiresAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });
    await idempotencyTokens.create({
      id: generateId(), userId: admin.id, token: notYetExpired, createdAt: now(),
      usedAt: null, expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    });

    await sweepExpiredIdempotencyTokens();

    assertEquals(await idempotencyTokens.findByToken(expiredLongAgo), null);
    assertExists(await idempotencyTokens.findByToken(expiredWithinGrace));
    assertExists(await idempotencyTokens.findByToken(notYetExpired));
  });

  await t.step("sweep: no-op when only unexpired tokens exist", async () => {
    const admin = await createAdmin("SweepPass2!2026");
    const token = crypto.randomUUID();
    await idempotencyTokens.create({
      id: generateId(), userId: admin.id, token, createdAt: now(),
      usedAt: null, expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    });

    await sweepExpiredIdempotencyTokens();

    assertExists(await idempotencyTokens.findByToken(token));
  });
});
