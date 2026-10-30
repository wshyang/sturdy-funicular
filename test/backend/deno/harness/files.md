# test/backend/deno/harness/ directory files

The backend test harness (addendum-081) — the backend's counterpart to the
Playwright e2e harness (test/frontend/playwright/helpers/harness.ts). It is
pure orchestration + artifacts: the tests still hit the real Hono app + real
Postgres, never mock db.tsx.

- `harness.ts` — `defineTest(name, fn({ctx, t}), opts)` — the single entry
  point: seeded world, guaranteed teardown, automatic failure artifacts.
  Re-exports everything for one-import ergonomics. Addendum-109: opts gains
  `ignore?: boolean` (object-form Deno.test passthrough) — kept as a general
  utility; the red regiment itself is UNGATED per owner direction
  2026-08-05 (contract tests run live and fail by design).
- `context.ts` — `TestContext` (`ctx.api` recording client — with bounded
  response bodies since addendum-106 —, `ctx.actors` named sessions,
  `ctx.world`, `ctx.assert`, `ctx.time`, `ctx.markStep`, `ctx.artifacts`
  filed under the real test name).
- `fixtures.ts` — `WorldBuilder` (`ctx.world`): keyed, idempotent world steps
  (admin/user/cluster/team/member/singleStepSystem). Rev 2026-08-05: the
  addendum-109 rev-1 `organization` / `defaultOrganization` / `orgMembership`
  steps are reverted out (byte-identical to pre-dimension); org contract
  tests drive the raw-SQL helpers in helpers.tsx directly instead.
- `state.ts` — `Assertions` (`ctx.assert`): rowCount / sessionValid / auditHas
  / notificationsFor over allowlisted tables.
- `time.ts` — `TimeControl` (`ctx.time`): freeze/advance/reset the app clock
  via server/db.tsx's `setTestNow` seam + runSweep for cron sweeps.
- `artifacts.ts` — failure artifacts: request log + DB-state snapshot +
  failure.md under test_output/backend/artifacts/<test>/. Addendum-103: the
  snapshot allowlist covers every public table (drift-guarded) and cells of
  columns declared in config/audit_sensitive_columns.yaml are redacted to
  '[hidden]' before anything is written. Addendum-106: recorded requests
  carry bounded response bodies (boundResponseBody) and 'step' marker
  entries; failure.md names the last step marker.
- `seed.ts` — `resetTestDb()` one-shot reset (global-setup analog).
- `harness.test.tsx` — the harness's own self-test (incl. the addendum-103
  drift-guard + redaction steps).
- `files.md` — this inventory.
