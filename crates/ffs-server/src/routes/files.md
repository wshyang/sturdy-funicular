# crates/ffs-server/src/routes/ directory files

- `mod.rs` — Route-module exports.
- `setup.rs` — Test/setup schema and seed endpoints.
- `teams.rs` — Team-member plane: roster list/add/remove, role changes, eligible members, managed teams, and self/sole-admin guards.
- `assets.rs` — Non-admin submitter asset autocomplete (serving-team + org gate, prefix search, live rows only).
- `requests.rs` — Break-glass request lifecycle routes.
- `owner.rs` — Owner-plane request/review routes.
- `audit.rs` — Audit timeline routes.
- `stubs.rs` — Remaining placeholder routes pending later port waves.


## Stage 3B updates

- `owner.rs` — replaced the delegate-only stub with the full owner self-service plane: batched `GET /owner/systems` (constant-query enrichment + `x-query-count` header), `GET /owner/systems/:id/eligible-delegates` (primary-owner-only, linked-org active-agency pool), delegate add/remove validation + audit + notifications, and `GET /owner/statistics` (`by_system` / `by_hostname`, half-open range, COUNT DISTINCT request semantics).
- `requests.rs` — Stage 3B hardening: conditional request-state updates serialize first-to-act-wins races and write one step-approved audit row; submission enforces justification minimum + SR number; submitter cannot see `viewerCanOverride`; owner/issue/close transitions are state-preconditioned.

- `direct_links.rs` — GET /link/resolve/:key with 2FA, recipient scope and live request visibility re-check.
- `secret_material.rs` — GET /requests/:id/secret-material, submitter-only after approval, window and delivered-payload checks.
