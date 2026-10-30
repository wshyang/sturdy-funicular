# Rust port wave staging plan

Status: active execution plan
Source of truth for suite budgets: `test/rust/porting-workboard.json`
Assertion parity gate: `npm run test:assert-parity`

## Staging rules

1. Port vertical suite tickets, not loose assert categories.
2. Keep batches reviewable; split large waves into sub-batches.
3. Security negatives travel with their routes.
4. Pull seam tests forward when they unblock later waves.
5. No batch is done until it is green against the real Rust binary and its assertion IDs are mapped.

## Stage 0 — Baseline freeze

- Regenerate legacy assertion inventory: 4,272 assertions, 1,649 steps, 114 suites.
- Generate workboard: `npm run port:workboard`.
- Verify assertion gate: `npm run test:assert-parity:report`.
- Confirm Rust harness can spawn the binary, lease Postgres, run `/setup`, and write artifacts.
- Capture legacy coverage baseline and choose Rust coverage command.

## Stage 1 — Foundation

| Batch | Suites | Asserts |
|---|---|---:|
| 1A bootstrap — DONE | health, schema_bootstrap, bootstrap_seed_passwords | 38 |
| 1B identity — DONE | auth, auth_me_endpoints, sanitize-user | 126 |
| 1C session/2FA — DONE | sessions, twofa, twofa_login_enforcement_toggle | 124 |
| 1D idempotency — DONE | idempotency | 29 |
| 9A prerequisite seams — DONE | harness, schema snapshot, generated schema, demo seed contract, Drizzle bridge, name seeds, UUID/JSONB | 106 |

## Stage 2 — Admin plane

| Batch | Focus | Asserts |
|---|---|---:|
| 2A capabilities/roles | admin-capabilities-comprehensive, auth-admin-roles, admin_roles_crud, role_summary | 481 (**DONE**) |
| 2B org topology/access | org_dimension, system_org_edges, four_org_access, cross_org_structure | 245 (**DONE**) |
| 2C structure/assets | admin_clusters, admin_teams, team_admin_plane, admin_systems, admin_systems_update_delete, admin_assets, asset_search | 375 (**DONE**) |
| 2D users/settings/overrides | admin_users, admin_app_settings, app_settings_providers/helper/seed_drift, org_overrides, admin_organization_overrides, admin_email_templates, admin_data, pending_actions_admin | 408 (**DONE**) |

## Stage 3 — Request lifecycle

| Batch | Focus | Asserts |
|---|---|---:|
| 3A contracts/state machine | workflow-machine, request_schemas, request_content_validation, decision_validation, request_sequences, mapping_droplist_repro, pending_chips_contract | 206 (**DONE**) |
| 3B core user flows | requests, owner, owner_delegate_guards, concurrency | 328 (**DONE**) |

## Stage 4 — Credential delivery

| Batch | Focus | Asserts |
|---|---|---:|
| 4A direct delivery | direct-links, direct-links-email, test-secret-autorelease, user_credentials_lifecycle | 136 (**DONE**) |
| 4B AWS exchange/transport | aws-transport, aws-integration, aws-tenant-exchange, aws-tenant-sweep, aws-localstack, aws-localstack-ses, aws-asset-inventory, aws-ssm | 184 |

## Stage 5 — Physical custody

| Batch | Focus | Asserts |
|---|---|---:|
| 5A custody | physical_asset_custody, custody_exception_guards | 59 |

## Stage 6 — Observability, notifications, cron

| Batch | Focus | Asserts |
|---|---|---:|
| 6A access/audit | access-log, access_log_filters, audit, audit_context, audit_sensitivity, audit_all_entities, audit_inheritance, generic_audit_timeline | 219 |
| 6B notifications/cron | sent_notifications_outbox, sent_notifications_multichannel, email_templates, smtp_send, cron-jobs, cron_worker_contract, job_runs, pending_actions_digest | 208 |
| 9C runtime seams | n_plus_one_regression, request_logger | 22 |

## Stage 7 — Integrations and identity

| Batch | Focus | Asserts |
|---|---|---:|
| 7A invites/identity | invite, identity_change, identity_entities, time_bound_delegations | 220 |
| 7B SSO/Slack | entra_auth, entra_exchange, entra_authorize_url, slack-integration, slack_linking | 226 |

## Stage 8 — Security and coverage closure

| Batch | Focus | Asserts |
|---|---|---:|
| 8A headers/config/runtime | security-headers, security-misconfiguration, runtime_mode, dependency_security | 118 |
| 8B crypto/injection/fuzz/errors | cryptographic-failures, injection, request-validation-fuzz, exceptional-conditions | 159 |
| 8C access-control matrices | cross_org, four_org_matrix, state-guards, authz-matrix | 78 |

## Stage 9 — Final parity signoff

- `npm run test:assert-parity` passes: 4,272 / 4,272 mapped exactly once.
- No pending/partial suite tickets without explicit waiver.
- Rust workspace tests pass against the real binary.
- Rust coverage and route/OWASP evidence recorded.


## Stage 2D delivery note (users, settings, overrides, templates, data, pending actions)

Stage 2D is complete: all ten suites (408 frozen assertions) are ported, registered
in `tests/ported_suites.rs`, and green against the real Rust binary. Wave 2
(admin plane) is now **1,509 / 1,509**; cumulative parity is **1,932 / 4,272**.

Rust-side seams landed:

- `app_settings` registry/cache/getters (65 defaults, org-aware resolution,
  SMTP/SES readiness, env `EMAIL_DELIVERY_PROVIDER` override, secret masking).
- Admin app-settings CRUD with immutability, bounds, RSA PEM validation
  (PKCS#8 private / SPKI public / X.509 cert), secret audit `[hidden]`,
  all-or-nothing bulk import (`failures[]`), bulk export of all 65 keys, and
  `/admin/runtime-info` gated on `BREAKGLASS_DEV`.
- User lifecycle: pending list/approve/reject/tombstone/untombstone,
  affiliation change with global-grant guards, membership cascade, live-session
  invalidation, submitter-affiliation re-check, and lifecycle notifications.
- Org-scoped settings/templates overrides with provenance, soft-delete,
  capability/scope 404-disguise, and template sanitizer.
- Email-template CRUD (sanitized HTML allowlist, immutable trigger key,
  audit old/new values) and `/admin/sent-notifications`.
- Data export/import (`breakglass-export-v3`, deferred self-FKs, session
  preservation) and dev-only reset-seed.
- Admin pending-actions debtor report with scoped `UserRead` org filtering.

Behavioral repairs made while porting (each pinned by a legacy assertion):
rejected/tombstoned login now returns 401 (pending keeps 403); session gate rejects non-active accounts;
request submission re-checks vendor affiliation live; approve requires an
explicit valid affiliation and emits `user.approved`.


## Stage 3A delivery note (request-lifecycle contracts and state machine)

Stage 3A is complete: seven suites / 206 frozen assertions ported and green.
Cumulative parity is **2,138 / 4,272**; wave 3 is **206 / 534**.

Rust-side seams landed:

- `workflow_machine::get_next_state` — pure transition table preserving the
  legacy ordinal semantics (return/reject keep ordinal; admin-reset bypass).
- `schemas` — safeParse-style body contracts for auth, grant-form exclusivity,
  update-user-roles exactly-one, create/update system defaults + five-stage
  custody configs, and delegate window ordering.
- `request_helpers::validate_content` — shared submit/resubmit content guard
  (field lengths, timestamp normalization/order, asset identity/liveness).
- `pending_actions::actions_for` — viewer chip derivation shared by
  `/requests/my-requests` and the admin ledger (review_step / owner_decision).
- `next_request_sequence` exposed for the atomic per-system-per-day counter.

All seven suites passed filtered runs against the real Rust binary; the full
workspace regression is the pre-push gate.


## Stage 3B — request lifecycle / owner self-service (PORT-3, 328 assertions)

Status: delivered. Filtered suites green; full workspace regression exit 0 (`ported_suites` 172/172, 1532.41s). See `test/rust/sandbox-setup-log.md` and PR #12.

| Suite | Legacy source | Rust module | Asserts | Style |
|---|---|---:|---:|---|
| requests | `test/backend/deno/requests.test.tsx` | `crates/ffs-server/tests/ported/requests.rs` | 204 | user-flow |
| owner | `test/backend/deno/owner.test.tsx` | `crates/ffs-server/tests/ported/owner.rs` | 89 | module |
| owner_delegate_guards | `test/backend/deno/owner_delegate_guards.test.tsx` | `crates/ffs-server/tests/ported/owner_delegate_guards.rs` | 21 | module |
| concurrency | `test/backend/deno/concurrency.test.tsx` | `crates/ffs-server/tests/ported/concurrency.rs` | 14 | user-flow |

Application seams added/hardened:

- `routes/owner.rs`: real `GET /owner/systems` with batched owner/delegate/user enrichment and an `x-query-count` response header for the N+1 regression seam; `GET /owner/systems/:id/eligible-delegates` with primary-owner-only 404 disguise and the addendum-206 linked-org union; delegate add/remove validation, audit, and notifications; `GET /owner/statistics` with half-open date ranges and `COUNT(DISTINCT request)` hostname grouping.
- `routes/requests.rs`: state-preconditioned UPDATEs serialize step/owner/issue/close races (first-to-act wins) and emit exactly one step-approved audit row; submission enforces justification minimum and SR number; submitters cannot see `viewerCanOverride`; owner-decision authorization precedes terminal-state validation.
- `ffs-test-support`: HTTP client timeout 20s → 60s for real RSA keygen under full-suite load.

Wave 3 is now complete: **534/534** assertions mapped (3A 206 + 3B 328). Workspace parity after Stage 3B: **2,466 / 4,272** legacy backend assertions mapped, **0 unannotated Rust assertion sites**, map gate **OK 114**.


## Stage 4A — direct credential delivery (PORT-4, 136 assertions)

| Suite | Asserts | Contract |
|---|---:|---|
| direct-links | 25 | Base62 keys, atomic scope/TTL/usage, 2FA and live request visibility |
| direct-links-email | 31 | Rendered `?dl=` anchor in request lifecycle outbox |
| test-secret-autorelease | 49 | Wrapped PKCS#8, client key, seeded encrypted delivery, retrieval/decrypt/readiness/guards |
| user_credentials_lifecycle | 31 | Password change and admin 2FA/password reset |

Wave 4: **136/320** mapped; cumulative **2,602/4,272**. Full Rust workspace regression **exit 0**, `ported_suites` **179/179** in **1472.21s**. Stage 4B AWS exchange/transport remains pending; never conflate seeded encrypted delivery with a real cloud sweep. Full workspace regression result in `test/rust/sandbox-setup-log.md`.

## Stage 4B1 — AWS namespace and signed transport codec (partial, 2026-10-30)

| Legacy suite | Frozen | Mapped | State |
|---|---:|---:|---|
| aws-ssm | 3 | 3 | Ported: `derive_role_base_name` prefix convention |
| aws-transport | 44 | 35 | Partial: PEM, RSA-OAEP-256/AES-256-GCM envelope, PKCS#1 v1.5 SHA-256 signature, file wrap/unwrap, tamper/wrong-key/legacy cases |
| Remaining Stage 4B suites | 137 | 0 | Pending; AWS S3/SSM/LocalStack exchange, sweep, SES and inventory |

The remaining **9 aws-transport assertions** require the DB-backed
`resolveTransportKeys` enablement resolver, which is not implemented in Rust.
The codec and namespace helpers are production Rust library modules, tested
with the *same committed test-only RSA keys* as the legacy AWS suite; they are
**not yet wired into a Rust S3/SSM tenant channel**. In particular, no LocalStack
S3 → EventBridge → Lambda → S3 assertion has been counted as ported. Stage 4B2
must implement the real channel and DB-backed resolver, then exercise the real
application's exchange/sweep routes against equivalent AWS infrastructure.
Never equate these primitive assertions with an end-to-end AWS flow.

Stage 4B1 parity is **2,640 / 4,272** frozen assertion IDs, with 1,632 still
missing and zero unannotated Rust assertion sites. `aws-ssm` is exact 3/3;
`aws-transport` remains explicitly partial 35/44. A separate Rust unit
regression verifies that JSON property reordering cannot turn a signed schema-2
file into an unverified plaintext payload (a fail-closed improvement).

## Stage 4B2 — DB enablement, exchange ledger and opt-in AWS test (2026-10-30)

User approved writing LocalStack-dependent tests without a local emulator. Such
cases are **compiled but ignored**, not executed or counted in frozen parity.
`tests/aws_localstack_contract.rs` is an opt-in integration test requiring a
bootstrapped S3 bucket and `AWS_ENDPOINT_URL`; it exercises the production Rust
S3 channel, signed outbound PUT, inbound GET, and key resolution. It is a
hand-staged tenant response, **not** an EventBridge/Lambda, AssumeRole, SSM,
SES, endpoint/sweep, or request-flow substitute; all original LocalStack
assertions remain pending. It has no frozen parity annotations.

Executed Stage 4B2 frozen assertions: the 9 remaining `aws-transport` key
resolver cases (real Postgres `app_settings`) complete that suite at **44/44**;
`aws-tenant-exchange` maps **22/27** (six S3 object-key conventions and 16
Postgres correlation/transition/constraint assertions). Its five remaining
assertions require close-ack reconciliation and audit against a real closed
request. These are not claimed. The Rust `aws::exchange` ledger performs
conditional awaiting→received→processed/failed transitions and matches on
system, correlation and expected response type; `aws::channel` provides S3
PUT/GET with fail-closed key resolution. The channel is not yet attached to
Rust HTTP request/owner/sweep routes, so no end-to-end parity is claimed.

Cumulative mapped assertion IDs: **2,671/4,272** (1,601 missing, 0
unannotated). The `--require-complete` gate remains red by design. Stage 4B3
must wire the AWS channel and ledger to real Rust application routes, port the
remaining close-ack cases, and run the original LocalStack contracts in an
equivalent environment before mapping their frozen IDs.

## Stage 4B3 — close acknowledgement and delivery payloads (2026-10-30)

`aws-tenant-exchange` is now **27/27**: the remaining five frozen assertions
exercise the production `reconcile_close_acknowledgement` audit-only handler
against a genuinely closed Postgres request; it cannot mutate request closure.
`aws-integration` is **27/44**: its two versioned payload builders match the
legacy outbound credential-request and request-close field contracts. The
remaining 17 require env/credential-provider selection, real disabled-gate
behavior, and an HTTP owner-decision flow; these are not represented by pure
builder checks. The builders are production library code **not yet connected**
to the application's AWS publish routes. Stage 4B real AWS-flow closure remains
open despite the compiled opt-in S3 test. Total frozen parity is **2,703/4,272**;
1,569 missing; zero unannotated.

The Stage 4B1 post-hardening full-workspace rerun ended **FAILED** (178/181):
three long DB-backed suites reached 401 `Invalid or expired session` while
this turn also ran focused suites concurrently. The session inactivity timeout
is 15 minutes, and resource contention is plausible but not proven. The Stage
4B2 full-workspace run was queued after that run and is executing independently.
Do not claim full workspace green until its result is known; if red, reproduce
and investigate before another parity signoff.

## Stage 4B4 — AWS base-credential strategy (2026-10-30)

Eight frozen `aws-integration` assertion IDs cover ambient/default, static,
X.509, unknown-strategy rejection and provider selection. The Rust AWS
credential module now returns **actual AWS SDK credential providers** (lazy
environment provider for `static`, the SDK default chain for `ambient`) and
rejects X.509 as unsupported instead of silently selecting a different
identity. Tests call the same pure parser used by the environment-backed
production entry point, without mutating a process-global env var shared by
parallel tests. This slice does not exercise STS AssumeRole or SSM discovery.
`aws-integration` is **35/44** mapped; the remaining nine are three env/DB
kill-switch assertions, a disabled-channel check, and five real request-flow
assertions. Cumulative parity: **2,711/4,272**, with 1,561 missing and no
unannotated Rust assertions. The LocalStack contract remains ignored/unmapped.

The checkout and `/tmp` reset at the start of this slice. Pushed work was
restored by fast-forwarding the same branch to `7237abad`; the prior Stage 4B2
full-workspace run's final outcome was lost with `/tmp` and is **unknown**.
Do not claim it passed. The Stage 4B1 post-hardening full run was confirmed red
(178/181, three expired-session 401s); record new clean regressions separately.

## Stage 4B5 — isolated kill-switch checks and disabled AWS user flow (2026-10-30)

The original `aws-integration` suite's three flag assertions are now expressed
against `app_settings::get_aws_integration_enabled` and real Postgres, with the
`AWS_INTEGRATION_ENABLED` overrides each run in a **separate test subprocess**.
This prevents changing a process-global AWS flag while other Rust request tests
run in parallel. Five more frozen IDs exercise an actual submit → key-material
persist → approval steps → owner approval → approved detail flow against the
Rust HTTP server with AWS disabled. The Rust four-step fixture needs all four
approvals before owner decision; that differs from the legacy single-step
fixture but preserves the lifecycle checks. This does **not** prove an AWS
publish hook exists: the Rust request routes are not yet wired to the channel.

If the focused runs pass, `aws-integration` reaches **43/44**; the remaining
ID is `openTenantChannel`'s disabled no-call guard. Do not map it by inventing
a no-op channel or an S3 mock. Cumulative prospective mapped IDs:
**2,719/4,272**, with 1,553 missing. This total is provisional until the two
new focused tests run. The earlier Stage 4B4 full-workspace run was started
before this code and is not a regression check of these additions.

Stage 4B5 focused verification: all five `aws_integration::` Rust tests passed,
including the isolated env/DB flag checks and real HTTP approval flow. Thus
**2,719/4,272** annotated IDs are executed in focused tests; 1,553 remain.
The prior Stage 4B4 full workspace run completed successfully at **187/187**
ported-suite tests (2020.53s); it began before the 4B5 edits and therefore
must not be cited as 4B5 regression coverage. The fresh Stage 4B5 full run
reached 190 running tests, but a sandbox reset erased its result; outcome
**unknown**, not passed. The AWS publish/sweep wiring and all
LocalStack-dependent parity remain open.

## Stage 5A — physical-custody exception negative validation (2026-10-30)

The frozen `custody_exception_guards` suite's **14 assertions** (setup request
creation plus six HTTP 404/400 response pairs) have been added to a Rust
integration test. It submits a real request and sends raw multipart form data
through the Rust HTTP binary against an isolated Postgres database. A new
custody exception route resolves and authorizes the request before parsing the
body, rejects bad exception type/description/case ID and more than 20 files,
and checks that a valid case belongs to the requested request. Its valid-case
path explicitly returns **501 Not Implemented**, without persisting a report;
this is not a positive custody implementation. Legacy `physical_asset_custody`
(**45 assertions**) remains unmapped. Do not treat validation-only coverage as
complete custody support. Stage 4B5 full-workspace result was lost to sandbox
reset after reaching 190 running tests; last confirmed full run was the
pre-4B5 **187/187** pass. Stage 5A focused HTTP test passed **1/1**, exercising all 14 frozen assertions. A clean rerun after removing temporary diagnostics also passed **1/1**.

Workboard source annotation now reads **2,733/4,272**, 1,539 missing,
zero unannotated; the Stage 5A additions passed the focused HTTP test. AWS publish/sweep and LocalStack contracts remain
open; draft PR #12 must remain draft.

Stage 5A targeted `decision_validation` request-lifecycle regression passed
**1/1** against the real Rust binary and isolated Postgres. No fresh
full-workspace regression has completed after the Stage 4B5 changes.

## Stage 5B — physical custody stage configuration (2026-10-30)

The first **2/45** frozen `physical_asset_custody` assertions now cover an
admin PUT with all five fixed agency stages and a GET list round-trip against
real Rust HTTP and isolated Postgres. The Rust admin route validates unique
stages, live agency-cluster team membership, instruction length and due-hour
bounds, atomically replaces the five relational config rows, and projects
configs in enum stage order from a batched list query. The focused test passed
**1/1** after correcting a Postgres `stage::text` alias ordering mistake.
The other **43/45** assertions remain unmapped: approval-driven custody case
creation, actor-specific actions, exception upload/one-to-many evidence,
read-model/issue/close gating and security checks are not yet ported. The
Stage 5A exception route still returns 501 for a valid existing case. The
admin *create* path does not yet accept custody stage configuration; this
slice covers PUT/list only. No full-workspace post-4B5 regression has
completed; the targeted admin-system tests passed **2/2**. Parity: **2,735/4,272**, 1,537 missing, zero unannotated.

GitNexus staged impact flagged **CRITICAL** (55 indexed affected processes)
for changes in the high-use admin systems file; added helper definitions also
shifted anchors of untouched functions. The two targeted admin suites passed,
but these are not a substitute for a full-workspace run. Keep PR #12 draft.

### Stage 5B full regression update

The subsequent full offline Rust workspace run passed: **192/192** ported-suite
tests, with every other workspace target green. The opt-in LocalStack contract
remained **ignored**, not passing parity. This supersedes the earlier
"no post-4B5 full regression" status for the *current source*; the erased
Stage 4B5-only run's result is still unknown. The graph impact is still broad,
and strict frozen assertion equality is **not** reached (1,537 missing).

## Stage 5C — owner approval creates persisted manual custody cases (2026-10-30)

Eighteen additional frozen IDs from `physical_asset_custody` now run through
real Rust HTTP + isolated Postgres: submit and approval, owner terminal,
two manually managed assets producing separate run items/cases, the request
read model with team-scoped same-team `prepare_and_handover` availability, and
a second custody-only request whose direct credential issue is blocked with
409 while the request stays approved. Owner approval and case creation use one
transaction, and case hydration reads persisted relational rows. The earlier
Stage 5B config test and this test are grouped in one Rust suite module to
satisfy the exact per-module map: **20/45**; 25 remain.

This is **not** full physical custody: the action route, handover transitions,
exception uploads and one-to-many evidence, fulfillment/close transitions,
other state read-model hydration and authorization tests remain unported. The
Stage 5A valid-case exception path still fails closed with 501. Rust currently
creates cases only for manually managed request items when five stages are
configured; the legacy AWS-lockdown path can also route API-managed items to
custody and remains out of scope. A focused 2/2 pass is not a new full-workspace
regression. Overall source-mapped parity: **2,753/4,272**, 1,519 missing,
zero unannotated. Draft PR #12 stays draft.

Targeted existing `decision_validation` and disabled-AWS approval regression
tests each passed **1/1** after the owner-decision transaction change. Neither
is LocalStack evidence; the full-workspace post-5C result is not yet known.

GitNexus staged change detection marked Stage 5C **CRITICAL** (17 indexed
processes); request approval/issue/read routes are shared beyond custody. The
full-workspace test is required before claiming regression closure.
