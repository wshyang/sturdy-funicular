// Filter contracts for GET /admin/access-log (parseAccessLogFilters in
// server/routes/audit.tsx).
//
// access-log.test.tsx covers the logging middleware and the unfiltered read.
// It issues no filtered request at all, so the eight query parameters — and
// every one of their rejection branches — were unexercised.
//
// This matters beyond coverage: the access log is the raw record of who called
// what. A filter that silently ignores a bad value (rather than 400-ing) makes
// an investigator believe they are looking at a complete result set when they
// are not. Each negative below asserts the specific message, so a filter that
// stops parsing cannot pass by returning some other error.
//
// It also pins the two response flags the UI keys on: `filtersApplied` and
// `isLive` (live polling is only correct on an unfiltered view), plus
// `totalMatching`, which is null unless a filter was applied.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  authHeaders,
  createAdmin,
  loginAs,
  req,
  wipeDatabase,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";

const PW = "AccessLogFilters!2026";

Deno.test("GET /admin/access-log — filter parsing and response flags", async (t) => {
  await wipeDatabase();

  const admin = await createAdmin(PW);
  const login = await loginAs(admin.email, PW);
  assert("session" in login, `admin login failed: ${JSON.stringify(login)}`);
  const auth = authHeaders(login.session);

  // Generate a little real traffic so the filters have rows to match.
  await req("/auth/me", { headers: auth });
  await req("/admin/users", { headers: auth });
  await req("/audit/logs", { headers: auth });

  const get = (qs = "") => req(`/admin/access-log${qs}`, { headers: auth });
  const bodyOf = async (res: Response) => await res.json();
  const errorOf = async (res: Response) => String((await res.json()).error ?? "");

  // ── unfiltered ───────────────────────────────────────────────────────────

  await t.step("positive: unfiltered read is 'live' and reports no totalMatching", async () => {
    const res = await get();
    assertEquals(res.status, 200);
    const body = await bodyOf(res);
    assertEquals(body.filtersApplied, false);
    assertEquals(body.isLive, true, "an unfiltered view is the live-polling view");
    assertEquals(body.totalMatching, null, "totalMatching is only computed for filtered reads");
    assert(Array.isArray(body.logs) && body.logs.length > 0, "expected some access-log rows");
    assert(typeof body.limit === "number" && body.limit > 0, "a default limit must be applied");
  });

  await t.step("positive: an empty-string filter is treated as absent, not as a filter", async () => {
    const body = await bodyOf(await get("?method="));
    assertEquals(body.filtersApplied, false);
    assertEquals(body.isLive, true);
  });

  await t.step("the in-flight request excludes itself from its own results", async () => {
    // Otherwise the caller would always see a row with a null status_code for
    // the very request being served.
    const body = await bodyOf(await get());
    const nullStatus = (body.logs as Array<{ statusCode: number | null }>)
      .filter((r) => r.statusCode === null);
    assertEquals(nullStatus.length, 0, "no in-flight row should be returned");
  });

  // ── method ───────────────────────────────────────────────────────────────

  await t.step("positive: method filter, single and comma-separated, case-insensitive", async () => {
    const single = await bodyOf(await get("?method=GET"));
    assertEquals(single.filtersApplied, true);
    assertEquals(single.isLive, false, "a filtered view is not the live view");
    assert(typeof single.totalMatching === "number", "totalMatching is computed when filtering");
    assert(
      (single.logs as Array<{ method: string }>).every((r) => r.method === "GET"),
      "every row must match the requested method",
    );

    const lower = await bodyOf(await get("?method=get"));
    assertEquals(lower.filtersApplied, true, "method is upper-cased before matching");
    assert((lower.logs as unknown[]).length > 0, "lower-case 'get' must still match GET rows");

    const multi = await bodyOf(await get("?method=GET,POST"));
    assert(
      (multi.logs as Array<{ method: string }>).every((r) => ["GET", "POST"].includes(r.method)),
      "comma-separated methods must all be honoured",
    );
  });

  await t.step("NEGATIVE: an unknown HTTP method is rejected by name", async () => {
    const res = await get("?method=FETCH");
    assertEquals(res.status, 400);
    assertEquals(await errorOf(res), "Invalid HTTP method: FETCH");
    // One bad entry in a list poisons the whole filter — better than silently
    // dropping it and returning a partial set.
    assertEquals((await get("?method=GET,FETCH")).status, 400);
  });

  // ── status ───────────────────────────────────────────────────────────────

  await t.step("positive: status accepts an exact code and a class", async () => {
    const exact = await bodyOf(await get("?status=200"));
    assertEquals(exact.filtersApplied, true);
    assert(
      (exact.logs as Array<{ statusCode: number }>).every((r) => r.statusCode === 200),
      "exact status must match precisely",
    );

    const klass = await bodyOf(await get("?status=2xx"));
    assertEquals(klass.filtersApplied, true);
    assert(
      (klass.logs as Array<{ statusCode: number }>).every((r) => r.statusCode >= 200 && r.statusCode < 300),
      "2xx must match the whole class",
    );
    // Case-insensitive: the parser upper-cases before testing the class form.
    assertEquals((await get("?status=2XX")).status, 200);
  });

  await t.step("NEGATIVE: bad status class and bad status code are distinguished", async () => {
    const badClass = await get("?status=9xx");
    assertEquals(badClass.status, 400);
    assertEquals(await errorOf(badClass), "Invalid status class: 9xx",
      "the message echoes the value as the caller sent it, not the upper-cased form");

    const badCode = await get("?status=abc");
    assertEquals(badCode.status, 400);
    assertEquals(await errorOf(badCode), "Invalid status code: abc");
  });

  // ── path_contains / actor / ip length caps ───────────────────────────────

  await t.step("positive: path_contains narrows to matching paths", async () => {
    const body = await bodyOf(await get("?path_contains=/auth/me"));
    assertEquals(body.filtersApplied, true);
    assert(
      (body.logs as Array<{ path: string }>).every((r) => r.path.includes("/auth/me")),
      "every row must contain the substring",
    );
  });

  await t.step("NEGATIVE: over-long path_contains, actor and ip are refused", async () => {
    const longPath = await get(`?path_contains=${"x".repeat(201)}`);
    assertEquals(longPath.status, 400);
    assertEquals(await errorOf(longPath), "Path contains filter exceeds maximum length of 200 characters");

    const longActor = await get(`?actor=${"x".repeat(201)}`);
    assertEquals(longActor.status, 400);
    assertEquals(await errorOf(longActor), "Actor filter exceeds maximum length of 200 characters");

    const longIp = await get(`?ip=${"1".repeat(51)}`);
    assertEquals(longIp.status, 400);
    assertEquals(await errorOf(longIp), "IP filter exceeds maximum length of 50 characters");
  });

  await t.step("boundary: exactly at each cap is accepted", async () => {
    assertEquals((await get(`?path_contains=${"x".repeat(200)}`)).status, 200);
    assertEquals((await get(`?actor=${"x".repeat(200)}`)).status, 200);
    assertEquals((await get(`?ip=${"1".repeat(50)}`)).status, 200);
  });

  await t.step("positive: actor and ip filters apply without error", async () => {
    assertEquals((await bodyOf(await get("?actor=nobody-matches"))).filtersApplied, true);
    const empty = await bodyOf(await get("?actor=nobody-matches"));
    assertEquals(empty.returnedCount, 0, "a non-matching actor yields an empty, not a full, set");
    assertEquals(empty.totalMatching, 0);
    assertEquals((await get("?ip=10.0.0")).status, 200);
  });

  // ── date range ───────────────────────────────────────────────────────────

  await t.step("positive: from/to bound the window", async () => {
    const body = await bodyOf(await get("?from=2020-01-01T00:00:00.000Z&to=2999-01-01T00:00:00.000Z"));
    assertEquals(body.filtersApplied, true);
    assert((body.logs as unknown[]).length > 0, "a wide window should still match rows");

    const past = await bodyOf(await get("?to=2020-01-01T00:00:00.000Z"));
    assertEquals(past.returnedCount, 0, "nothing predates the fixture traffic");
  });

  await t.step("NEGATIVE: unparseable dates are reported per-field", async () => {
    const badFrom = await get("?from=not-a-date");
    assertEquals(badFrom.status, 400);
    assertEquals(await errorOf(badFrom), "Invalid 'from' date: not-a-date");

    const badTo = await get("?to=31/02/2026");
    assertEquals(badTo.status, 400);
    assertEquals(await errorOf(badTo), "Invalid 'to' date: 31/02/2026");
  });

  await t.step("NEGATIVE: an inverted window is refused", async () => {
    const res = await get("?from=2026-06-01T00:00:00.000Z&to=2026-01-01T00:00:00.000Z");
    assertEquals(res.status, 400);
    assertEquals(await errorOf(res), "'from' date cannot be after 'to' date");
  });

  // ── limit ────────────────────────────────────────────────────────────────

  await t.step("positive: limit caps the returned rows but not totalMatching", async () => {
    const body = await bodyOf(await get("?method=GET&limit=1"));
    assertEquals(body.limit, 1);
    assertEquals(body.returnedCount, 1);
    assert(
      body.totalMatching >= body.returnedCount,
      "totalMatching counts every match, ignoring the limit",
    );
  });

  await t.step("NEGATIVE: zero, negative and non-numeric limits are refused", async () => {
    for (const bad of ["0", "-5", "abc"]) {
      const res = await get(`?limit=${bad}`);
      assertEquals(res.status, 400, `limit=${bad}`);
      assertEquals(await errorOf(res), "Limit must be a positive integer");
    }
  });

  await t.step("limit DOES count as a filter, which switches the view out of live mode", async () => {
    // Observed behaviour, pinned deliberately. parseAccessLogFilters sets
    // filtersApplied for `limit` just as it does for a real predicate, so
    // asking for fewer rows also flips isLive to false and makes the route
    // run the countFiltered query. Arguably a page size is not a filter --
    // but this is what the endpoint does today, and the UI's live-polling
    // decision depends on it, so it is worth a failing test if it changes.
    const body = await bodyOf(await get("?limit=2"));
    assertEquals(body.filtersApplied, true);
    assertEquals(body.isLive, false);
    assertEquals(body.limit, 2);
    assert(typeof body.totalMatching === "number", "a totalMatching count is computed");
  });

  await t.step("an oversized limit is clamped to the configured cap, not rejected", async () => {
    const body = await bodyOf(await get("?limit=999999"));
    assertEquals(body.limit < 999999, true, "the request cap must clamp the value");
  });

  // ── combination + authorization ──────────────────────────────────────────

  await t.step("positive: several filters combine", async () => {
    const body = await bodyOf(await get("?method=GET&status=2xx&path_contains=/auth"));
    assertEquals(body.filtersApplied, true);
    for (const row of body.logs as Array<{ method: string; statusCode: number; path: string }>) {
      assertEquals(row.method, "GET");
      assert(row.statusCode >= 200 && row.statusCode < 300);
      assert(row.path.includes("/auth"));
    }
  });

  await t.step("negative: an unauthenticated read is refused", async () => {
    const res = await req("/admin/access-log");
    assert(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  await t.step("the access_log table itself recorded these filtered reads", async () => {
    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM access_log WHERE path = $1`,
      ["/admin/access-log"],
    );
    assert(Number(rows[0]!.n) > 0, "the endpoint's own calls are logged like any other");
  });
});
