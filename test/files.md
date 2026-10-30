# test/ directory files

- `backend/` — Backend test suites
- `data/` — Test data and fixtures
- `frontend/` — Frontend test suites
- Fourth tier (by convention OUTSIDE /test): co-located pure-unit modules `server/domains/*.rules.test.ts` — addendum-123; run `deno task test:unit`.
- `org-dimension.ts` — Shared organisation-dimension constants (addendum-109, rev 2026-08-05): the single Default-org name ("Default" / short code "DEF") every fixture user, cluster, team and system hangs off. NO GATING — the first revision's `ORG_PHASE` phase-gate is retired (owner direction 2026-08-05: new-behavior tests run live and fail now by design; phases 2–3 remain deferred, not staged). Imported by the Deno, jsdom and Playwright suites alike

- [rust/](rust/files.md) — Rust-port assertion inventory, workboard, and staging plan.
