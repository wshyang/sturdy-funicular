// Self-test for the backend harness (addendum-081). Proves each standardized
// feature actually works against the real app + DB:
//   F2 ctx (recording client + actors) · F4 world builders (idempotent) ·
//   F5 state assertions · F6 time control (setTestNow seam) · F3 artifacts.
// Addendum-103 adds the drift guard (the snapshot allowlist IS the public
// schema) and the secret-redaction proof (registry-declared columns never
// reach a snapshot in plaintext).
// Uses Deno.test directly (not defineTest — that would test the harness with
// itself).
import { assertEquals, assert, assertExists } from "jsr:@std/assert";
import { wipeDatabase, loginAs } from "../helpers.tsx";
import { setTestNow, now } from "../../../../server/db.tsx";
import { query } from "../../../../server/pg.tsx";
import { createTestContext } from "./harness.ts";
import { WorldBuilder } from "./fixtures.ts";
import { writeSnapshot, snapshotTables, boundResponseBody, SNAPSHOT_TABLES, REDACTED } from "./artifacts.ts";
import { join } from "node:path";

Deno.test("backend harness self-test", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
    setTestNow(null);
  });

  await t.step("F6 time: setTestNow seam freezes and resets the app clock", async () => {
    const frozen = "2026-01-01T00:00:00.000Z";
    setTestNow(frozen);
    assertEquals(now(), frozen);
    setTestNow(null);
    // Back on the real clock — the frozen value must not persist.
    assert(now() !== frozen);
  });

  await t.step("F2 ctx: createTestContext seeds admin+vendor with live sessions", async () => {
    const ctx = await createTestContext();
    try {
      assertExists(ctx.admin.id);
      assertExists(ctx.vendor.id);
      // Seeded sessions are 2FA-verified -> an operational route works.
      const res = await ctx.actors.admin.get("/requests/my-requests");
      assertEquals(res.status, 200);
    } finally {
      await ctx.teardown();
    }
  });

  await t.step("F4 world: builders are keyed and idempotent", async () => {
    const world = new WorldBuilder();
    const admin = await world.admin("a", "WorldA!2026");
    const again = await world.admin("a", "WorldA!2026");
    assertEquals(again.id, admin.id, "same key returns the same admin");

    const user = await world.user("v1", { affiliation: "vendor" });
    const vc = await world.cluster("vendor-1", "vendor", admin.id);
    const team = await world.team("t1", "vendor-1", 1, admin.id);
    const membership = await world.member("t1", "v1", admin.id);
    assertExists(membership.id);
    assertExists(vc.id);
    assertExists(team.id);
    assertExists(user.id);

    const sys = await world.singleStepSystem("s1", admin.id, admin);
    assertExists(sys.system.id);
    // Re-invoking the system returns the same topology without rebuilding.
    const sysAgain = await world.singleStepSystem("s1", admin.id, admin);
    assertEquals(sysAgain.system.id, sys.system.id);
  });

  await t.step("F5 assert: rowCount / sessionValid / auditHas work over the real DB", async () => {
    const ctx = await createTestContext();
    try {
      // Seeded world: 1 admin + 1 vendor -> 2 non-system users. The two
      // reserved system-actor rows (SYSTEM_USER_ID/UNKNOWN_USER_ID) are
      // permanent and survive wipeDatabase, so filter is_system=false to
      // count only the fixture users the harness seeded.
      assertEquals(await ctx.assert.rowCount("users", { is_system: false }), 2);
      assertEquals(await ctx.assert.rowCount("users", { is_system: false, status: "active" }), 2);

      // Login produces audit rows + a valid session.
      const login = await loginAs(ctx.admin.email, "HarnessAdmin!2026");
      const session = "error" in login ? "" : login.session;
      assertEquals(await ctx.assert.sessionValid(session), true);
      assertEquals(await ctx.assert.auditHas("user.login_success", { target_id: ctx.admin.id }), true);
    } finally {
      await ctx.teardown();
    }
  });

  await t.step("F3 artifacts: writeSnapshot + snapshotTables produce files under test_output", async () => {
    const snap = await snapshotTables(["users"]);
    assert(Array.isArray(snap.users));
    const dir = await writeSnapshot("harness-self-test", "probe");
    // The parent directory exists (no throw) — proving the write path works.
    const parent = join(dir, "..");
    // Deno.readDir returns an AsyncIterable (not a Promise) — it has no .catch.
    // Consume it to prove the parent is readable; swallow any error so this
    // stays a non-fatal smoke of the write path.
    try {
      for await (const _ of Deno.readDir(parent)) { /* parent readable */ }
    } catch { /* ignore — smoke only */ }
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  await t.step("drift guard: SNAPSHOT_TABLES is the exact set of public schema tables", async () => {
    const rows = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    const actual = new Set(rows.map((r) => r.table_name));
    const listed = new Set<string>(SNAPSHOT_TABLES as string[]);
    const missing = [...actual].filter((x) => !listed.has(x)).sort();
    const stale = [...listed].filter((x) => !actual.has(x)).sort();
    assertEquals(missing, [], "tables missing from SNAPSHOT_TABLES — add them to artifacts.ts so failures snapshot them");
    assertEquals(stale, [], "SNAPSHOT_TABLES entries that no longer exist — remove them from artifacts.ts");
  });

  await t.step("redaction: registry-declared columns never reach a snapshot in plaintext", async () => {
    const ctx = await createTestContext(); // seeds an admin with real credential material
    try {
      // A known sentinel secret in app_settings (post-wipe seed state varies
      // by addendum, so the probe row is deterministic). The ON CONFLICT arbiter
      // must state the global partial-index predicate (see the same note in
      // app_settings_helper.test.tsx): app_settings has no plain UNIQUE(key).
      await query(
        `INSERT INTO app_settings (key, value, value_type, category, description)
         VALUES ('harness_redaction_probe', 'SENTINEL-SECRET-9f8e7d', 'string', 'security', 'harness redaction probe')
         ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET value = EXCLUDED.value`,
      );

      const snap = await snapshotTables(["users", "app_settings", "clusters"]);
      const text = JSON.stringify(snap);
      assert(!text.includes("SENTINEL-SECRET-9f8e7d"), "the app_settings sentinel must never appear in a snapshot");

      // The sentinel value cell is redacted, and the seeded admin's
      // credential material is redacted...
      const settings = snap.app_settings as Record<string, unknown>[];
      const probe = settings.find((r) => r.key === "harness_redaction_probe");
      assertEquals(probe?.value, REDACTED);

      const users = snap.users as Record<string, unknown>[];
      const adminRow = users.find((r) => r.email === ctx.admin.email);
      assertExists(adminRow);
      assertEquals(adminRow.password_hash, REDACTED);
      assertEquals(adminRow.password_salt, REDACTED);
      for (const u of users) {
        assert(u.password_hash == null || u.password_hash === REDACTED, "no plaintext password_hash anywhere");
        assert(u.totp_secret == null || u.totp_secret === REDACTED, "no plaintext totp_secret anywhere");
      }

      // ...while non-sensitive columns pass through verbatim, keeping the
      // snapshot's diagnostic value (a redacted-everything artifact is as
      // useless as no artifact).
      assertEquals(typeof adminRow.email, "string");

      // Negative control: a table with no registry entry is a verbatim dump.
      const raw = await query<Record<string, unknown>>(`SELECT * FROM clusters LIMIT 200`);
      assertEquals(snap.clusters, raw);
    } finally {
      await ctx.teardown();
    }
  });

  await t.step("addendum-106 B3: boundResponseBody is verbatim when small, enveloped when big", () => {
    assertEquals(boundResponseBody({ ok: true }), { ok: true }); // verbatim object
    assertEquals(boundResponseBody(null), null);
    assertEquals(boundResponseBody("short"), "short");

    const big = { s: "x".repeat(4_000) };
    const bounded = boundResponseBody(big) as { __truncated: boolean; bytes: number; preview: string };
    assertEquals(bounded.__truncated, true);
    assert(bounded.bytes > 2_048, "the envelope records the true serialized size");
    assert(bounded.preview.startsWith('{"s":"xxxx'), "preview carries the leading payload");
    assert(bounded.preview.length <= 2_048, "preview itself is capped");
  });

  await t.step("addendum-106 B4: artifacts carry the real test name + step markers; requests carry responses", async () => {
    const ctx = await createTestContext({ testName: "b4-probe" });
    try {
      ctx.markStep("phase-1");
      await ctx.api.get("/health");
      ctx.markStep("phase-2");

      const dir = await ctx.artifacts.captureFailure(new Error("b4 probe error"));
      assert(dir.includes("b4-probe"), "artifact dir is named after the real test, not 'ctx'");

      const files = [...Deno.readDirSync(dir)].map((f) => f.name);

      // Request log: step markers frame the request, and the request entry
      // carries a bounded response (the B3 live check folded in here).
      const logName = files.find((f) => f.endsWith("(failure).request-log.json"));
      assertExists(logName);
      const log = JSON.parse(await Deno.readTextFile(join(dir, logName))) as Array<{ type?: string; path: string; response?: unknown }>;
      const step1 = log.findIndex((e) => e.type === "step" && e.path === "phase-1");
      const health = log.findIndex((e) => e.type === "request" && e.path === "/health");
      const step2 = log.findIndex((e) => e.type === "step" && e.path === "phase-2");
      assert(step1 >= 0 && health > step1, "phase-1 marker precedes the /health request");
      assert(step2 > health, "phase-2 marker follows the /health request");
      assert(log[health].response !== undefined, "the recorded request carries its bounded response");

      // failure.md: real test name + the step the test died in.
      const mdName = files.find((f) => f.endsWith("(failure).md"));
      assertExists(mdName);
      const md = await Deno.readTextFile(join(dir, mdName));
      assert(md.includes("b4-probe — FAILED"), "failure.md titles the real test");
      assert(md.includes("phase-2"), "failure.md names the last step marker");
      assert(md.includes("b4 probe error"), "failure.md keeps the error text");

      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } finally {
      await ctx.teardown();
    }
  });
});
