# test/frontend/playwright/harness/ directory files

- `actorFlows.ts` — Actor flow helpers using the test harness (strict-fixed, addendum-194)
- `artifacts.ts` — Artifact capture helpers (screenshots, videos) — best-effort writes, `E2E_ARTIFACT_SCREENSHOT_DIR` override
- `captions.ts` — On-screen caption overlay for recorded videos (addendum-194; moved from demo/helpers, single implementation; survives full-page reloads via addInitScript + localStorage)
- `dbMode.ts` — Database mode helpers (PostgreSQL/SQLite)
- `pacing.ts` — Per-action pacing and delay helpers: `DEFAULT_DEMO_DELAY_MS = 750` (raised from 300/350 for human watchability), `centerInViewport` camera discipline (central-band no-op), deterministic `divideDemoWork` worker splits
- `test.ts` — Main Playwright test harness: THE unified `{ test, expect }` — extends `../helpers/harness` (observability, failure bundles, historical timeouts) with the `harness` fixture (paced/centered/captioned actions, artifacts, demo division, console-hygiene passthrough)