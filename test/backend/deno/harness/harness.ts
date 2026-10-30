// Backend harness entry point (addendum-081, F1) — the `test` analog.
//
// defineTest(name, fn, opts) wraps Deno.test and gives every test, for free:
//   * a seeded world (admin + vendor, both 2FA-verified sessions) via
//     createTestContext,
//   * a guaranteed teardown (time reset + DB wipe) so a thrown test can never
//     bleed state into the next file,
//   * automatic failure artifacts (request log + DB snapshot + failure.md)
//     written to test_output/backend/artifacts/<test>/.
//
// fn receives { ctx, t }: ctx is the TestContext (api/actors/world/assert/
// time/artifacts); t is the Deno.test context so subtests keep working.
//
// Porting an existing file: replace `Deno.test("x", async (t) => { ... })`
// with `defineTest("x", async ({ ctx, t }) => { ... })`, drop the manual
// wipeDatabase() setup, and swap `req(path, {headers: authHeaders(s)})` for
// `ctx.actors.as(s).get(path)` / `ctx.api.get(path)`.
import { createTestContext, type TestContext } from "./context.ts";

export interface HarnessOptions {
  // Seed the default admin+vendor world (default true).
  seed?: boolean;
  // Extra per-test setup run after the seeded world is ready.
  setup?: (ctx: TestContext) => Promise<void>;
  // Extra per-test teardown run before the default teardown.
  teardown?: (ctx: TestContext) => Promise<void>;
  // Register the test as ignored. General harness utility (kept): makes a
  // test visible in `deno test` output as "ignored" without running. NOTE:
  // the red regiment does NOT use this — owner direction 2026-08-05 is NO
  // GATING; contract tests for unbuilt behavior run live and fail by design.
  ignore?: boolean;
}

export function defineTest(
  name: string,
  fn: (h: { ctx: TestContext; t: Deno.TestContext }) => Promise<void>,
  opts: HarnessOptions = {},
): void {
  Deno.test({ name, ignore: opts.ignore ?? false, fn: async (t) => {
    // The test name flows into the artifact dirs (addendum-106, B4) so a
    // failure bundle identifies its test instead of the addendum-081 "ctx".
    const ctx = await createTestContext({ seed: opts.seed !== false, testName: name });
    try {
      if (opts.setup) await opts.setup(ctx);
      await fn({ ctx, t });
    } catch (error) {
      // Failure artifacts are best-effort — they must never mask the real
      // failure with a write error.
      await ctx.artifacts.captureFailure(error).catch(() => {});
      throw error;
    } finally {
      if (opts.teardown) await opts.teardown(ctx).catch(() => {});
      await ctx.teardown().catch(() => {});
    }
  } });
}

// One-import ergonomics: `import { defineTest, ... } from "./harness/harness.ts"`.
export { createTestContext } from "./context.ts";
export type { TestContext, ApiClient, RequestResult } from "./context.ts";
export { WorldBuilder } from "./fixtures.ts";
export { Assertions } from "./state.ts";
export { TimeControl } from "./time.ts";
export { writeSnapshot, writeFailureArtifacts, boundResponseBody, SNAPSHOT_TABLES, REDACTED } from "./artifacts.ts";
export type { RecordedRequest } from "./artifacts.ts";
