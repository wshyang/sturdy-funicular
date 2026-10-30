# Addendum 214 — Rust Backend Port: Staged Task Queue & Parity Plan

**Relates to:**
- `addendum-213-migrations-squash-first-deploy.md` (the clean `001_schema.sql` baseline this port shares unchanged)
- `addendum-026-sql-migrations-directory-overhaul.md` + `CLAUDE-standing-rules.md` (Option-B boot-gate schema discipline the Rust binary must honor)
- `addendum-065-entra-database-config-and-owasp-test-coverage.md` (OWASP Top-10 unit-test mandate the ported endpoints inherit)
- `addendum-211-live-owner-guard-orm-checks-and-link-target-enum.md` (ORM-level `live_owner_required` guard + link-target enum the port must reproduce)

**Tag:** `[CUSTOM]` — owner-directed backend-language port, not FDS-prescribed. Relates to the
`greenfield-port` skill's porting discipline (its template §20.1–§20.8) and to the repo's backend
test-discipline rules. No FDS functional section changes; every external wire contract is held
byte-identical.

**Status:** PLAN ONLY — no implementation this session. Author-date: 2026-10-27.

**Skills applied in planning:** `modularity:review`, `modularity:design`, `greenfield-port`.

---

## What was decided

Port the Deno 2.9.5 / Hono / Drizzle backend of the Firefighter Station (break-glass credential
approval system) to **Rust 1.99 / axum / SeaORM**, leaving the React/Vite/TypeScript frontend and
the PostgreSQL schema (`setup/sql/001_schema.sql`, Option-B boot gate) unchanged. The port proceeds
as **eight risk-ordered vertical slices** (0–7), each closing on three parity gates (G1/G2/G3). The
governing constraint: the **67 Playwright e2e specs** and the **~106 of 113 backend API test files**
pass **without modification** first — the sole backend-test change is **two lines** in
`test/backend/deno/helpers.tsx` that reroute the in-process `app.request()` transport to real
`fetch()` against the spawned Rust binary. Only after endpoint parity is confirmed per slice do the
4 transport-coupled files + ~9 seam files get re-ported as `cargo test`.

The full staged task queue is §D–§I below: every task carries a unique `PORT-*` id, one imperative
verb, a concrete path/command, and a measurable "done when" — sized to drop straight into a work
queue.

## Why

The owner directed a backend language migration to Rust. The system is pre-launch (addendum-213
confirms no protected deployments), so a clean cutover with a legacy-as-oracle shadow harness is
viable without a data-migration path. Risk-ordered slicing retires the load-bearing risks first
(request-wide transaction wrong → everything wrong; auth wrong → zero authed tests pass; FOR-UPDATE
serialization wrong → the core product guarantee breaks). The running legacy system is the
specification; parity is proven mechanically (shadow-diff + rerouted suites), never by eye.

## Impact (summary)

- **Frontend:** one generated type-mirror file replaces `import type … from '../../../server/types'`
  (`src/app/lib/contracts.ts:63`); otherwise untouched. No wire-shape change.
- **Schema:** unchanged and shared. The Rust binary honors the same Option-B `schema_state` boot gate.
- **Tests:** backend suite reroutes via 2 lines; 4 files re-expressed; ~9 seam files move to `cargo test`.
- **Divergences:** recorded in §J; any that would change wire behavior get promoted to their own
  addendum (215+) before landing — none are planned to.

---

## A. Port boundary (fixed)

| Layer | Action |
|---|---|
| Backend (Deno/Hono/Drizzle) | **Port to Rust (axum + SeaORM)** |
| Frontend (React/Vite/TypeScript) | **Unchanged** except one generated type-mirror file |
| PostgreSQL schema (`setup/sql/001_schema.sql`) | **Shared unchanged** — Option-B boot gate |
| `server/types/core.tsx` + `operations.tsx` | **Serde contract** — Rust reproduces enum strings + field names byte-identical |

**Single-port deployment:** the Rust binary serves `./dist` SPA static files **and** all API routes
on one port (mirrors `serveStatic` in `server/app.tsx`).

## B. Technology choices, refactor latitude, divergences

| Concern | Choice | Note |
|---|---|---|
| Web framework | **axum** (Tower layers map 1:1 onto Hono's ordered middleware chain) | — |
| DB layer | **SeaORM** | Diverges from `database-and-schema.md` ("sqlx `query_as!`, never two ORMs") — recorded as `DR-SeaORM` in §J. `ConnectionTrait` is the mechanism that replaces ALS-ambient transactions. |
| UUIDv7 | `uuid::Uuid::now_v7()` | Three mint sites (JS `generateId`, SQL `uuid_generate_v7()`, Rust) must agree on RFC-9562 layout |
| Request-wide tx | Explicit `TxHandle` extension threading `C: ConnectionTrait` | Replaces ALS-ambient `runInTransaction`; behavior identical, mechanism cleaner (no reentrant-join) |

**Refactor latitude (standing rule for this port):** refactoring to best practices on the **target
Rust code and target test organization** — module splits, guard clauses, naming, de-duplication,
breaking the 817-LOC `custody/service.tsx` into cohesive <800-LOC modules — is **permitted and
encouraged**, *provided the external wire contract stays byte-identical*: HTTP status, allowlisted
headers, JSON body shape / field names / enum strings, and `401`/`403`/`404` parity. Every refactor
is validated by shadow-diff (§F). The **legacy TypeScript is never refactored** — it remains frozen
as the executable oracle until the retirement commit (PORT-C.8).

## C. Pre-implementation — skill runs (first, after approval)

These precede any Rust code. The `greenfield-port` skill's default output paths are **redirected to
this repo's convention**: there is no `docs/plans/` or `docs/decisions/` dir — the plan **is this
addendum (214)**, and divergences live in §J (promoted to their own addenda when wire-affecting).

- [ ] **PRE-1** Run `modularity:review` over `server/**` — done when `docs/modularity-review/2026-10-27/modularity-review.md` exists and classifies, with balance-rule verdicts, at least the three known imbalances: the `pg.tsx` ALS-ambient transaction (~210 implicit call-sites), `custody/service.tsx` (817 LOC), and `server/types/core.tsx` frontend coupling.
- [ ] **PRE-2** Run `modularity:design` (requirements = legacy behavior as spec) — done when `docs/design/2026-10-27/<module>/{design,tests,architecture}.md` exist for all 8 modules (one per slice), each module's `tests.md` carrying its concrete G1/G2/G3 parity gate.
- [ ] **PRE-3** Run `greenfield-spec-and-plan` — done when its leaf exit-criteria + divergence content are folded into **this addendum** (§D–§J), not a new `docs/plans/` file; the skill's `docs/decisions/NNNN` outputs are redirected to §J here.

---

## D. Staged task queue — vertical slices 0–7

Each slice = one `modularity:design` module. Order retires risk first. Every slice closes on the
three gates in §E. Route groups come from `server/app.tsx:215-547` (~134 routes); test files from
`test/backend/deno/` (113 files).

### Slice 0 — Platform kernel

- [ ] **PORT-0.1** Scaffold the axum workspace (`crates/ffs-server` bin + lib, Tokio, `Cargo.toml` pinned to Rust 1.99) — done when `cargo build` is green and the binary boots and binds the `PORT` env var.
- [ ] **PORT-0.2** Wire SeaORM + a sqlx pool against `breakglass_test`, injecting the `-c timezone=UTC` session GUC (mirror `pg.tsx:18-26`, the non-UTC-host silent-corruption trap) — done when a connected session reports `SHOW timezone` = `UTC` and an integration test asserts it.
- [ ] **PORT-0.3** Implement the request-wide transaction middleware: `db.begin()`, insert `TxHandle(txn)` into request extensions, roll back on handler status ≥ 500, commit otherwise (4xx still commits — matches `app-middleware.tsx:376-383`) — done when one handler threads a single `DatabaseTransaction` through all its DB calls and two tests prove rollback-on-5xx / commit-on-4xx.
- [ ] **PORT-0.4** Implement audit-GUC plumbing: `SET LOCAL ffs.action='…'`, `ffs.actor_id='…'` on the txn in the exact order of `audit-context.tsx:30-84` — done when an audited mutation writes an audit row with the correct actor and the GUC set-order matches legacy.
- [ ] **PORT-0.5** Port the `routeError` formatter name-based mapping (`AuthorizationError`→403, `ValidationError`→400, `NotFoundError`→404, else `console.error` + opaque `{error}` 500) from `server/route-helpers.tsx` — done when a unit test maps all four classes plus an unknown error to the exact status + body.
- [ ] **PORT-0.6** Build the middleware chain in exact order (access-log → request-logger → CORS → security-headers+`Cache-Control: no-store` → CSRF double-submit → session/2FA gate → idempotency-in-transaction), per `app-middleware.tsx:43-409` — done when an ordered-probe integration test observes each layer's effect in sequence.
- [ ] **PORT-0.7** Implement the SPA static fallback (`GET /*` non-API → `./dist/index.html`) and `/health` — done when `GET /some-spa-route` returns `index.html` 200 and `GET /health` returns 200 JSON.
- **Gate G0:** `/health` 200; each middleware layer's effect reproduced; shadow-diff 0 for `/health`.

### Slice 1 — Auth / session / 2FA / idempotency (unblocks every other slice)

- [ ] **PORT-1.1** Port PBKDF2-SHA256 `hashPassword`/`derivePbkdf2` with the salt fed as **UTF-8 bytes of the 64-char hex string, not hex-decoded** (`server/utils.tsx:98-116`; §G HZ-6) — done when a legacy-exported golden vector (one `pbkdf2-sha256$600000$…` + one legacy `SHA-256(password+salt)` fallback) is reproduced byte-for-byte in `cargo test`.
- [ ] **PORT-1.2** Port `verifyPassword` (prefix-parse iterations ∈ [100k,600k]; legacy fallback; constant-time same-length XOR, no short-circuit) and `passwordHashNeedsUpgrade` — done when the upgrade predicate matches the legacy truth table.
- [ ] **PORT-1.3** Implement dual session transport (`X-Session-Token` bearer **and** `ffs_session`/`__Host-ffs_session` cookie) + the `X-Session-Transport: bearer|cookie` response header — done when login via bearer and via cookie both authenticate and cookie names match env (dev vs prod).
- [ ] **PORT-1.4** Implement CSRF double-submit (403 `{error, code}` on mismatch, **only when cookie present**) — done when mismatch→403, match→pass, no-cookie→pass tests are green.
- [ ] **PORT-1.5** Port TOTP RFC-6238 (step=30s, digits=6, algorithm=SHA1) byte-identical to the Deno `otpauth` lib — done when a legacy-generated secret + timestamp produces an identical 6-digit code in Rust (golden vector).
- [ ] **PORT-1.6** Implement `GATE_ALLOWLIST` (exact 11 paths + `/auth/entra/*` prefix + OPTIONS-always) and browser-nav pass-through (dead-session cookie-clear; unverified-2FA pass), per §H — done when the gate matrix test (token/no-token × html/json × dead/unverified) matches §H exactly.
- [ ] **PORT-1.7** Implement idempotency consume + rotate inside the tx wrapper (409 on missing/invalid/reused; mint next token **outside** the tx so rollback cannot undo rotation; set `X-Idempotency-Token` response header — matches `app-middleware.tsx:402-407`) — done when `idempotency.test.tsx` is green via rerouted helpers.
- [ ] **PORT-1.8** Port the auth routes (`/auth/login`, `/logout`, `/signup`, `/me`, `/me/capability-snapshot`, `/auth/2fa/enroll`, `/auth/2fa/verify`, `/auth/accept-invite`, `/auth/slack/callback`), pinning the `/auth/login` response field names `needs2faVerification`/`session` that `loginAs()` depends on — done when the `loginAs()` helper completes end-to-end against the Rust binary.
- **Gate G1:** `auth.test.tsx`, `sessions.test.tsx`, `idempotency.test.tsx`, `exceptional-conditions.test.tsx`, `authz-matrix.test.tsx` green via rerouted helpers.

### Slice 2 — Admin provisioning

- [ ] **PORT-2.1** Port cluster/team/system CRUD, storing `workflowDefinition` as normalized `system_workflow_steps` rows — done when `admin_clusters`, `admin_teams`, `admin_systems` suites are green.
- [ ] **PORT-2.2** Port organizations + org-edges with the deferred `live_owner_required` constraint and the liveness-FK trigger (reject references to soft-deleted rows, `SQLSTATE 23503`; see addendum-211) — done when the `org_dimension` suite is green including the deferred-constraint case.
- [ ] **PORT-2.3** Port the 50 `AdminCapability` types + role-grant CRUD + capability resolution, using `BTreeMap`/`IndexMap` anywhere keys reach the JSON snapshot (§G HZ-8) — done when the `admin_capabilities` suite is green and the capability-snapshot key order is deterministic across processes.
- [ ] **PORT-2.4** Port `/admin/users` provisioning + memberships + team rosters + delegates + system owners — done when the `admin_users` suite is green.
- **Gate G2.**

### Slice 3 — Request lifecycle (core domain)

- [ ] **PORT-3.1** Port `getNextState` (`workflow-machine.tsx:154-197`) as a **pure Rust match table** (no XState), golden-pinning the quirks: STEP/OWNER RETURN+REJECT do **not** reset `currentStepOrdinal`; `ADMIN_RESET`→`returned_to_vendor` ordinal = 2-if-`hasApprovalSteps`-else-0; resubmit SUBMIT from `returnedToVendor` with `hasApprovalSteps`→ordinal 2 — done when all `workflow-machine.test.tsx` transitions reproduce in `cargo test`.
- [ ] **PORT-3.2** Implement FOR UPDATE serialization via SeaORM `.lock_exclusive()` on the request `Select`, executed on the request txn (mirror `db/entities/requests.tsx:67`) — done when `concurrency.test.tsx` is green (this is the load-bearing serialization proof).
- [ ] **PORT-3.3** Port multi-step advancement + `ownerDecision` + the `/requests/*` routes (submit, list, detail, approve, reject, return-to-vendor, owner-decision, resubmit, admin-reset) — done when `requests.test.tsx` is green.
- [ ] **PORT-3.4** Audit handlers for parallel DB fan-out: `DatabaseTransaction` is `!Clone`, so any `tokio::join!` of two DB calls on the shared txn becomes sequential (see the `owner.test.tsx` N+1 regression) — done when no handler fans out on the shared txn and `owner.test.tsx` HTTP assertions are green (its query-count assertions move to the cargo bucket, PORT-T.2).
- [ ] **PORT-3.5** Port `generateRequestNumber` → `BG-{shortCode}-{YYYYMMDD-UTC}-{seq≥3-padded}` (UTC, pure; §G HZ-2) — done when a golden request-number vector across a multi-request day matches legacy.
- **Gate G3.**

### Slice 4 — Credential delivery

- [ ] **PORT-4.1** Implement async delivery polling (`GET /requests/:id/secret-material` returns 409-until-ready) — done when a poll test sees 409 then 200 with material.
- [ ] **PORT-4.2** Port `request_key_material` + RSA-OAEP-2048 keypair gen/encrypt — done when encrypted material decrypts with a legacy-compatible key.
- [ ] **PORT-4.3** Port AWS S3 tenant-exchange behind the kill-switch (`server/aws/**`) — done when `aws-*` suites are green in **both** kill-switch states.
- **Gate G4.**

### Slice 5 — Physical custody

- [ ] **PORT-5.1** Port `custody.rules.tsx` ACTION_PLAN as a pure table and split `custody/service.tsx` (817 LOC) into cohesive <800-LOC modules (refactor latitude, §B) — done when the custody rules are golden-pinned and service suites are green.
- [ ] **PORT-5.2** Implement handoffs + exceptions + exception-checks routes (`/requests/:id/asset-custody/actions|exceptions`) — done when `physical_asset_custody.test.tsx` is green.
- [ ] **PORT-5.3** Implement evidence-file **multipart upload** via axum multipart extraction (the `reqFormData` path over real `fetch()`) — done when the `reqFormData` multipart test uploads and persists a file.
- **Gate G5.**

### Slice 6 — Observability, notifications, cron

- [ ] **PORT-6.1** Port access-log finalization; `src_ip` is now the real `127.0.0.1`/`::1` (documented divergence, §I row 1) — done when `access-log.test.tsx` is green after its `src_ip` expectations are updated.
- [ ] **PORT-6.2** Port the `ffs_audit_mutation()` trigger parity + app-level `createAuditLog` (GUC ordering + delta key order; §G HZ-7) — done when audit delta rows byte-match legacy through the shadow normaliser.
- [ ] **PORT-6.3** Port the email outbox (Postman/SES/SMTP + Handlebars → Rust template engine with byte-identical rendered output) — done when a rendered-email golden matches and outbox tests are green.
- [ ] **PORT-6.4** Port the Slack notifier + cron registry + guarded executor with **session-scoped** advisory locks (`connectDedicated` analog: `pool.acquire()`, `pg_try_advisory_lock($key)`, unlock in a `Drop` guard on the same connection) — done when a cron-sweep test is green via injected clock (cargo bucket, PORT-T.1) and the advisory lock prevents a double-run at replicas > 1.
- **Gate G6.**

### Slice 7 — Peripheral integrations

- [ ] **PORT-7.1** Port Entra SSO `private_key_jwt` cert-auth (RFC 7523), using `BTreeMap` for the claims log key order (§G HZ-8, `auth-entra.tsx:178`) — done when `entra_*` suites are green.
- [ ] **PORT-7.2** Port identity-change + invites + link-mappings — done when the identity-change / invite / link-mapping suites are green.
- **Gate G7.**

---

## E. Per-slice exit criteria (G1/G2/G3)

Every slice needs all three to close:

- **G1** — that slice's rerouted `.test.tsx` files pass against the Rust binary (the ~106 portable files; the 4 transport-coupled exceptions handled per §I).
- **G2** — shadow-diff = 0 for that slice's route group, *after* the sabotage test (§F PORT-S.3) proves the normaliser catches mutations.
- **G3** — §J has an entry for every intentional difference (`kept-for-parity | changed-by-addendum-NNN | to-decide`); zero `to-decide` remain before the slice is declared done.

## F. Harness reroute mechanics (the 2-line change)

- [ ] **PORT-H.1** Change `helpers.tsx:204` `return app.request(path, { method, headers, body })` → `return fetch(\`${BASE}${path}\`, { method, headers, body, redirect: "manual" })`, `BASE = http://127.0.0.1:${RUST_TEST_PORT}` — done when `req()` reaches the Rust binary over HTTP.
- [ ] **PORT-H.2** Change `helpers.tsx:214` (`reqFormData`) identically — done when a multipart request reaches Rust.
- [ ] **PORT-H.3** Confirm `redirect: "manual"` on both so Entra/Slack 302s surface as-is — done when a redirect test asserts raw status + location.
- [ ] **PORT-H.4** Add a Rust-server spawn to the global-setup analog (spawn once, health-check `/health`, keep alive for the whole `deno test` run; `wipeDatabase()` at `helpers.tsx:140-148` still runs per-file) — done when `deno test` runs the whole backend suite against the spawned Rust binary.

Everything **above** line 204/214 is unchanged (Content-Type default, `X-Session-Transport ??= "bearer"`, idempotency auto-mint, multipart boundary handling). The Deno `pg.tsx` pool stays Deno-side as the oracle-seeding library against `breakglass_test`; it never talks to the Rust server. `loginAs` keeps working — `/auth/login` + `/auth/2fa/verify` go over `fetch()`; `SELECT totp_secret` (`helpers.tsx:328-330`) hits the shared DB via Deno `query()`.

## G. Twin-DB shadow harness

- [ ] **PORT-S.1** Build the twin-DB seeder: `ffs_shadow_legacy` + `ffs_shadow_rust`, identically seeded via `pg_dump --data-only` clone (guarantees byte-identical UUIDs) — done when both DBs are structurally + data identical.
- [ ] **PORT-S.2** Build the unit-tested normaliser (canonicalize volatile `*_id`/`created_at`/`updated_at`/`request_number` by first-appearance placeholder; strip sub-ms timestamp precision; `BTreeMap`-sort keys for audit-delta compare; **null ≠ absent — do not equate**) — done when normaliser unit tests pass.
- [ ] **PORT-S.3** Build the sabotage shim and prove it: `legacy-vs-legacy` → 0 diffs; `legacy-vs-sabotaged-legacy` catches **all** of flipped status (403→404), mutated field value, reordered list, dropped array element, omitted nullable key — done when every one of the five mutations is caught (if any passes silently, the normaliser is blind — fix before trusting any run).
- [ ] **PORT-S.4** Wire `TARGET_BACKEND=legacy|rust` in three places: the spawn layer (`deno task server` vs the Rust binary), the DB-URL selector (`…ffs_shadow_legacy` vs `…ffs_shadow_rust`), and Playwright `webServer.command` (`config/playwright.config.ts:113-166`) — done when `TARGET_BACKEND=rust npx playwright test` boots Rust.

Only after PORT-S.3 passes: run `legacy-vs-rust` per slice; 0 diffs is that slice's G2.

## H. Session gate parity (`app-middleware.tsx:211-310`)

**GATE_ALLOWLIST (exact):** `/health, /setup, /auth/signup, /auth/login, /auth/logout, /auth/me, /me/capability-snapshot, /auth/2fa/enroll, /auth/2fa/verify, /auth/accept-invite, /auth/slack/callback` + any path prefixed `/auth/entra/`. OPTIONS always passes. No token → pass through.

**Dead session:** token present but dead + **browser nav** (no `X-Session-Token` header AND `Accept` includes `text/html`) → clear dead cookie, pass through; otherwise → `{error:"Your session has expired. Please log in again.", code:"session_expired"}` 401.

**Unverified 2FA:** browser nav → pass through; otherwise → `{error:"Two-factor verification required.", code:"twofa_required"}` 403.

## I. Transport-coupled test exceptions (4 files — not "unchanged")

| File | Why it breaks | Handling |
|---|---|---|
| `access-log.test.tsx:38` | asserts `src_ip === null` (no socket under `app.request()`); real HTTP gives `127.0.0.1` | update expected to `127.0.0.1`/`::1`; log `changed-by-addendum` (§J) |
| `request_logger.test.tsx:18,44` | monkeypatches in-process `console.log`; can't reach the Rust process logger | re-port as a `tracing`-subscriber stdout-capture test → cargo bucket (PORT-T.3) |
| `demo_seed_contract.test.ts:59-61` | greps `server/index.tsx` source for `Deno.serve(...)`, which ceases to exist | re-port as a binary-binds-configured-port + answers-`/health` contract → cargo bucket (PORT-T.4) |
| `access-log.test.tsx` other `src_ip` sites | same root cause as row 1 | audit + batch-update all `src_ip` assertions |

**Net:** ~106 of 113 backend files reroute unchanged; these 4 handled as above.

## J. cargo-test re-port bucket (after endpoint parity)

- [ ] **PORT-T.1** Re-port the clock seam (`harness/time.ts`, `harness/harness.test.tsx`, any cron-freeze test) as `cargo test` with an injected clock — the module-mutable `setTestNow` can't cross the process boundary.
- [ ] **PORT-T.2** Re-port the query-count seam (`n_plus_one_regression.test.tsx`; the query-count assertions split out of `owner.test.tsx`) against the Rust pool's counter.
- [ ] **PORT-T.3** Re-port `request_logger.test.tsx` as a tracing-stdout capture.
- [ ] **PORT-T.4** Re-port `demo_seed_contract.test.ts` as the binary-binds-port contract.
- [ ] **PORT-T.5** Re-port the pure-logic tests: `server/domains/*.rules.test.ts` (8 files), `workflow-machine.test.tsx`, and the `hashPassword`/`verifyPassword`/`generateSalt` unit blocks from `auth.test.tsx`.

## K. Frontend type mirror

- [ ] **PORT-F.1** Generate `src/app/lib/generated/server-types.ts` from the Rust serde definitions, replacing the `import type … from '../../../server/types'` at `src/app/lib/contracts.ts:63` — done when the frontend builds with `server/types` gone and every enum string (`RequestStatus`, `UserStatus`, `Affiliation`, `ApprovalStepStatus`, `StepKind`, custody enums, `SYSTEM_USER_ID`/`UNKNOWN_USER_ID`) byte-matches `core.tsx` + `operations.tsx`.
- [ ] **PORT-F.2** Swap the 2 Playwright admin-capabilities fixture `import type` spots to local declarations and remove the dead `admin-capabilities/fixtures/setup.ts` runtime imports — done when Playwright compiles with zero `server/` imports.

---

## L. Determinism-hazard register (all goldens exported from running legacy, never hand-written)

| # | Site | Hazard | Rust mitigation |
|---|---|---|---|
| HZ-1 | UUIDv7 three mint sites | same-ms reorder if any list `ORDER BY id` | `Uuid::now_v7()`; golden-pin N IDs minted tight-loop, assert sortability |
| HZ-2 | `generateRequestNumber` | counter + gap-on-rollback semantics | golden-pin exact rendered number across a day |
| HZ-3 | sort order in ~60 GET list endpoints | `sort_unstable_by` not stable; no-`ORDER BY` SELECT undefined | forbid `sort_unstable_by`; every `ORDER BY` gets a total tiebreak (`… , id DESC`); reordered-list sabotage is the detector |
| HZ-4 | `Option`/null serde on nullable columns | `skip_serializing_if` omits key; frontend expects `field: null` | **never `skip_serializing_if` on business columns**; serialize `None` as `null` |
| HZ-5 | timestamp wire format | `Date.toISOString()` = ms + `Z`; chrono defaults differ | custom serializer: ms precision + `Z` |
| HZ-6 | PBKDF2 salt encoding | salt = UTF-8 bytes of hex string, not `hex::decode` | test vector required (see PORT-1.1) |
| HZ-7 | audit delta ordering | GUC/key order drift diverges audit rows | canonicalize key order in normaliser; match `audit-context.tsx:30-84` |
| HZ-8 | HashMap → JSON | `std` HashMap randomizes SipHash per process | `BTreeMap`/`IndexMap` where keys reach JSON |
| HZ-9 | integer/rounding | release-mode overflow wraps silently | `checked_*`/`saturating_*`; `Math.ceil(x/60000)` → `i64::div_ceil` |

## M. Divergence log seed (§J entries)

| Entry | Tag | Summary |
|---|---|---|
| `src_ip` null → `127.0.0.1` | `changed-by-addendum` | in-process `app.request()` yields null; real HTTP is more correct |
| ALS tx → explicit `ConnectionTrait` | `kept-behavior-different-mechanism` | identical behavior, no reentrant-join risk |
| SeaORM over sqlx (`DR-SeaORM`) | `changed-by-addendum` | needed for `ConnectionTrait` threading; `database-and-schema.md` prescribes sqlx-only |
| advisory-lock scope: session | `kept-for-parity` | holds across full job duration; xact-lock would change semantics |
| `request_logger` → tracing capture | `changed-by-addendum` | console.log monkeypatch can't cross processes |
| clock seam → cargo injected clock | `changed-by-addendum` | module-mutable clock unworkable across processes |
| implicit replicas=1 | `kept-for-parity` | advisory lock is the replicas>1 safety; per-process state scoped per process |

## N. Global cutover gates

- [ ] **PORT-C.1** All 8 slices closed (G1/G2/G3 each).
- [ ] **PORT-C.2** Playwright 67 specs green with `webServer.command` → Rust, `retries: 0` + `trace: retain-on-failure`, zero API mocks, real browser.
- [ ] **PORT-C.3** Rerouted ~106 backend files green; the 4 transport-coupled exceptions handled (2 updated, 2 moved to cargo).
- [ ] **PORT-C.4** `cargo test` bucket (PORT-T.1–T.5) green.
- [ ] **PORT-C.5** Shadow-diff = 0 across ALL routes in one combined run.
- [ ] **PORT-C.6** Staging rollback rehearsal: a session issued by Rust is honored by legacy mid-flight (`ffs_session` cookie + `X-Session-Token` + session-table schema interchangeable) — done when a mid-session rollback keeps the user logged in.
- [ ] **PORT-C.7** Prod cutover = one env flip (`config/playwright.config.ts:113-166` webServer + deploy binary).
- [ ] **PORT-C.8** Clean retirement commit, after one full cron cycle + one business cycle on Rust in prod: delete `server/**` Deno runtime, Hono app, `pg.tsx`/Drizzle bridge, `deno.json` server tasks; keep the oracle library only if still needed. `sidequest/` stays out of scope.

## O. Critical files reference

| File | Role in port |
|---|---|
| `server/app-middleware.tsx:43-409` | middleware chain order = parity contract |
| `server/app.tsx:215-547` | route table (~134 routes) = migration spec |
| `server/pg.tsx:61-184` | ALS tx model to replace; `connectDedicated` advisory-lock pattern |
| `test/backend/deno/helpers.tsx:140-215` | reroute chokepoint (`req()` :204, `reqFormData()` :214); oracle seeders stay Deno-side |
| `server/utils.tsx:85-170` | PBKDF2 parity + legacy SHA-256 fallback + constant-time compare |
| `server/workflow-machine.tsx:154-197` | `getNextState` → Rust match table (Slice 3) |
| `server/db/helpers.tsx:10-38` | UUIDv7 `generateId` + `setTestNow`/`now` clock seam |
| `setup/sql/001_schema.sql` / `server/db/schema.ts` | schema contract — shared unchanged |
| `server/types/core.tsx` + `operations.tsx` | serde contract the frontend depends on byte-for-byte |
| `server/route-helpers.tsx` | error formatter: name-based, not instanceof |
| `config/playwright.config.ts:113-166` | `webServer.command` = the one-line cutover edit |

## P. Execution sequence

```
Approval
  → PRE-1 modularity:review     (docs/modularity-review/2026-10-27/)
  → PRE-2 modularity:design     (docs/design/2026-10-27/<module>/{design,tests,architecture}.md)
  → PRE-3 greenfield-spec-and-plan  (folded into this addendum §D–§J)
  → Slice 0  PORT-0.*  platform kernel
  → Slice 1  PORT-1.*  auth/session/2FA/idempotency      [loginAs green = suite unlocked]
  → Slice 2  PORT-2.*  admin provisioning
  → Slice 3  PORT-3.*  request lifecycle                  [concurrency.test.tsx = core gate]
  → Slice 4  PORT-4.*  credential delivery
  → Slice 5  PORT-5.*  physical custody + multipart
  → Slice 6  PORT-6.*  observability/notifications/cron
  → Slice 7  PORT-7.*  peripheral integrations
  → PORT-H.* harness reroute (two lines)
  → PORT-S.* shadow harness + sabotage proof
  → PORT-T.* cargo-test re-port bucket
  → PORT-F.* frontend type mirror
  → PORT-C.* global cutover gates
  → staging rollback rehearsal → prod cutover (one env flip) → clean retirement commit
```

---

> **No implementation this session.** This addendum is the artifact. Implementation begins after
> approval; the first post-approval action is to land this file at
> `docs/specs/addenda/addendum-214-rust-backend-port-plan.md` with its `files.md` entry.
