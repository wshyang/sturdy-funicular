# test/frontend/playwright/ directory files

- `global-setup.ts` — Global setup for Playwright tests
- `demo-showcase-global-setup.ts` — Demo-showcase global setup: wipes the database AND re-applies the demo seed (standard wipe-only setup would destroy the backend's startup-applied `003_seed_demo_live.sql`), so showcase tests start from a clean known-good DEMO state
- `regression/` — Regression test suites
- `demo/` — Demo test suites (the two recorded HD videos; unified harness + 750ms pacing + viewport-centering as of addendum-194)
- `demo-showcase/` — DEMO-seed showcase pair: Amanda’s scoped-admin provenance story and Greg’s global-admin/cross-org pending-queue story.
- `helpers/` — Playwright test helpers
- `harness/` — The unified Playwright harness (addendum-194): `test.ts` extends `helpers/harness.ts` (observability/failure bundles/timeouts) with paced, centered, captioned actions; `pacing.ts` holds `DEFAULT_DEMO_DELAY_MS = 750` and `centerInViewport`; `captions.ts` is the single caption-overlay implementation
- `stories/` — Reserved for story-oriented demo tests using the new harness
- `admin-capabilities/` — Self-contained capability suite (own config/global-setup, raw `@playwright/test` imports; deliberately exempt from the shared-harness contract until separately migrated)
- addendum-196 note — `helpers/ui.ts pendingDashboardAction` now opens the row kebab (`{scope}__actions-menu-button`) transparently when the action is not a direct row button (addendum-192 moved Approve/Return/Close/Edit/Issue behind a Radix dropdown that portals out of the <tr>); View stays direct. Specs keep calling ONE helper.
