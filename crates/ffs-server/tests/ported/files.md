# crates/ffs-server/tests/ported/ directory files

- `health.rs` — Port of `test/backend/deno/health.test.tsx` (22 parity assertions).
- `schema_bootstrap.rs` — Port of `test/backend/deno/schema_bootstrap.test.tsx` (12 parity assertions).
- `bootstrap_seed_passwords.rs` — Port of `test/backend/deno/bootstrap_seed_passwords.test.tsx` (4 parity assertions).
- `fixtures.rs` — Shared ported-suite fixtures: schema preparation, active/admin users, TOTP login, wired systems, assets, memberships, and request submission.
- `auth.rs` — Port of `test/backend/deno/auth.test.tsx` (52 parity assertions).
- `auth_me_endpoints.rs` — Port of `test/backend/deno/auth_me_endpoints.test.tsx` (64 parity assertions).
- `sanitize_user.rs` — Port of `test/backend/deno/sanitize-user.test.tsx` (10 parity assertions).
- `sessions.rs` — Port of `sessions.test.tsx` (55 asserts): session CRUD/TTL/inactivity/touch/destroy, single-session sign-in, exclusive mint, central gate, and browser-navigation pass-through for dead-cookie and mid-2FA sessions.
- `twofa.rs` — Port of `twofa.test.tsx` (53 asserts): pure TOTP verifier, login flags, enrollment/returning verification, auth negatives, session scoping, twofa_required gate, and five-attempt session invalidation.
- `twofa_login_enforcement_toggle.rs` — Port of `twofa_login_enforcement_toggle.test.tsx` (16 asserts): exact-`false` enforcement toggle, mandatory enrollment, and fail-closed empty/garbage env values via per-server env overrides.
- `idempotency.rs` — Port of `idempotency.test.tsx` (29 asserts): missing/invalid/reused/cross-user tokens, rotation on success and validation failure, GET/unauth/excluded paths, real transaction rollback/commit, concurrent token consumption, mid-handler DB failure rollback, and expired-token sweep.
- `uuid_v7.rs` — Port of `uuid_v7.test.tsx` (3 asserts): UUIDv7 shape, timestamp ordering, and real-insert ordering.
- `jsonb_normalization.rs` — Port of `jsonb_normalization.test.tsx` (2 asserts): exact retained JSONB allowlist and FK-backed normalized replacements.
- `name_seeds.rs` — Port of `name_seeds.test.tsx` (9 asserts): SG/vendor fixture name pools and affiliation routing.
- `generated_schema_representations.rs` — Port of `generated_schema_representations.test.ts` (12 asserts): generated catalog/SQL source, counts, critical aggregates, structure-only.
- `demo_seed_contract.rs` — Port of `demo_seed_contract.test.ts` (13 asserts): seed INSERT targets/columns, canonical contracts, startup order, dev seed contracts.
- `drizzle_bridge.rs` — Port of `drizzle_bridge.test.tsx` (10 asserts): SeaORM writes share the request transaction with raw SQL; commit/rollback/no-tx/typed select.
- `schema_snapshot_vs_migrations.rs` — Port of `schema_snapshot_vs_migrations.test.tsx` (13 asserts): static snapshot/migration invariants and DB convergence fingerprint.
- `harness.rs` — Port of `harness/harness.test.tsx` (44 asserts): time seam, seeded context, keyed world builders, DB assertions, artifacts, drift/redaction, bounded bodies, failure bundles.
- `admin_capabilities_comprehensive.rs` — Port of `admin-capabilities-comprehensive.test.tsx` (244 asserts): baseline/grant/revoke matrix for 43 capabilities plus full_admin, additive union, require/isAdmin lifecycle, invalid inputs, and redundant-role revocation.
- `auth_admin_roles.rs` — Port of `auth-admin-roles.test.tsx` (192 asserts): capability/role catalogue, DB-backed grant/revoke/settlement seams, effective capabilities, hygiene, and introspection HTTP routes.
- `admin_roles_crud.rs` — Port of `admin_roles_crud.test.tsx` (27 asserts): custom-role CRUD, user-role settlement, protected-user guard, system/still-granted delete guards, and non-admin rejection over HTTP.
- `role_summary.rs` — Port of `role_summary.test.tsx` (18 asserts): dashboard role applicability, owner/reviewer/delegate pending counts, ordering, and admin+reviewer own-current-step badge scoping.
- `org_dimension.rs` — Port of `org_dimension.test.tsx` (71 asserts): org registry CRUD/short-code regime/delete guards, approval/invite org assignment, cluster org anchor + move guard, and member-management CRUD/audit/404-disguise/session negatives.
- `system_org_edges.rs` — Port of `system_org_edges.test.tsx` (68 asserts): explicit/derived owner+participant edges, scoped create/read, global-only owner transfer + participant add/remove, delegate orphan guards, audits, and org-delete edge guard.
- `four_org_access.rs` — Port of `four_org_access.test.tsx` (66 asserts): four-org crossed cast, R6 per-ownership owner-PA mappings, /my-systems, scoped admin object access, D1 vendor service gate, request-detail visibility, and PA notification org partition.
- `cross_org_structure.rs` — Port of `cross_org_structure.test.tsx` (40 asserts): scoped cluster/team lists and keyed mutations, roster disguise, anchored vendor roster plane, systems/assets keyed THROUGH the owner org edge, and shared-org user list.
- `admin_clusters.rs` — Port of `admin_clusters.test.tsx` (33 asserts): cluster CRUD, type/name uniqueness, org anchor/re-anchor, delete guards, and non-admin rejection.
- `admin_teams.rs` — Port of `admin_teams.test.tsx` (76 asserts): team CRUD/level+name uniqueness, eligible members, first-member admin + email, roster/role/self/sole-admin/cross-team guards, managed teams, and F3 workflow-reference delete guard/force/scoped block.
- `team_admin_plane.rs` — Port of `team_admin_plane.test.tsx` (25 asserts): add-member validation, affiliation/duplicate/one-team-per-cluster guards, role-change and remove self-locks.
- `admin_systems.rs` — Port of `admin_systems.test.tsx` (104 asserts across 01/02/03 step modules): authorization/no-mutation, create validation/workflow rules/AWS note, rename/owner reassignment, delete/mappings/mappable-teams/owners, team-system + owner-PA mappings, /my-systems, and workflow auto-sync idempotence/in-flight retention/team-less steps.
- `admin_systems_update_delete.rs` — Port of `admin_systems_update_delete.test.tsx` (59 asserts): update shape/text/owner cross-field validation, backup set/clear, primary reassignment expiry, cluster/workflow rejection, and soft-delete cascade/open-request guard.
- `admin_assets.rs` — Port of `admin_assets.test.tsx` (68 asserts): asset CRUD/immutable fields/service uniqueness, management-mode/AWS-note guards, sync negatives, and reconcile create/expire/restore/manual-isolation/failure-notification contracts.
- `asset_search.rs` — Port of `asset_search.test.tsx` (10 asserts): submitter autocomplete prefix/live-row/org/short-query/unknown-system gates.
- `admin_users.rs` — Port of `admin_users.test.tsx` (84 asserts): non-admin negatives, pending/approve/reject, tombstone cascade + session invalidation + auto-cancel, untombstone, affiliation global-grant guards, and scoped role-field rejection.
- `admin_app_settings.rs` — Port of `admin_app_settings.test.tsx` (69 asserts): registry listing, CRUD/immutability/bounds, secret masking + audit hiding, RSA PEM validation, bulk export/import all-or-nothing, and runtime-info.
- `app_settings_providers.rs` — Port of `app_settings_providers.test.tsx` (43 asserts): SMTP/SES readiness, secure-flag semantics, env provider override, and cache invalidation.
- `app_settings_helper.rs` — Port of `app_settings_helper.test.tsx` (9 asserts): typed getters, defaults, cache clear, unknown-key error, and Entra PEM getter.
- `app_settings_seed_drift.rs` — Port of `app_settings_seed_drift.test.tsx` (3 asserts): DEFAULTS ⊆ seeded rows and single disabled email provider.
- `org_overrides.rs` — Port of `org_overrides.test.tsx` (59 asserts): org-scoped settings/templates provenance, soft-delete, capability/scope negatives, and sanitizer.
- `admin_organization_overrides.rs` — Port of `admin_organization_overrides.test.tsx` (54 asserts): admin org override CRUD, immutability, 404-disguise, and template override lifecycle.
- `admin_email_templates.rs` — Port of `admin_email_templates.test.tsx` (34 asserts): template listing/CRUD, HTML allowlist sanitization, immutable trigger key, audit old/new values, and sent-notifications outbox.
- `admin_data.rs` — Port of `admin_data.test.tsx` (37 asserts): export shape, import validation/round-trip/deferred self-FKs, session preservation, and dev-only reset-seed.
- `pending_actions_admin.rs` — Port of `pending_actions_admin.test.tsx` (16 asserts): debtor report, org attribution, scoped UserRead filtering, and capability introspection.
- `workflow_machine.rs` — Port of `workflow-machine.test.tsx` (16 asserts): pure getNextState transition pairs, ordinal preservation, admin-reset bypass, and unrecognized-status rejection.
- `request_schemas.rs` — Port of `request_schemas.test.tsx` (78 asserts): auth body contracts, grant-form exclusivity, exactly-one role update, system defaults/custody stages, and delegate window ordering.
- `request_content_validation.rs` — Port of `request_content_validation.test.tsx` (30 asserts): shared validateContent field/timestamp/asset guards and exact operator messages.
- `decision_validation.rs` — Port of `decision_validation.test.tsx` (32 asserts): step/owner decision validation, authorization negatives, downstream override lane, and delegate terminal decision.
- `request_sequences.rs` — Port of `request_sequences.test.tsx` (14 asserts): per-system-per-day atomic counter semantics and concurrent uniqueness.
- `mapping_droplist_repro.rs` — Port of `mapping_droplist_repro.test.tsx` (9 asserts): demo-shaped provisioning auto-maps all teams; mappable-teams empty and no unmapped clusters.
- `pending_chips_contract.rs` — Port of `pending_chips_contract.test.tsx` (27 asserts): my-requests chip vocabulary, submitter visibility without actionability, step transition, owner terminal, and admin ledger parity.

## Stage 3B additions

- `requests.rs` — PORT-3B user-flow port of `test/backend/deno/requests.test.tsx` (204 parity assertions). Three real-HTTP tests cover submission/validation/key material, owner delivery/resubmit/admin-reset, and search/override/topology. Uses `fixtures::create_four_step_system` and real Postgres notification/audit reads.
- `owner.rs` — PORT-3B module port of `owner.test.tsx` (89 parity assertions). Exercises `/owner/systems` enriched batched reads + `x-query-count` seam, eligible-delegates org union, delegate add/remove notifications, and `/owner/statistics` date-range/grouping contracts.
- `owner_delegate_guards.rs` — PORT-3B validation port of `owner_delegate_guards.test.tsx` (21 parity assertions). Pins exact delegate/statistics error bodies and empty-owner statistics shape.
- `concurrency.rs` — PORT-3B race port of `concurrency.test.tsx` (14 parity assertions). Two distinct authorized actors race step/owner/issue/close mutations; asserts exactly one 2xx, one 4xx, single ordinal advance, and one step-approved audit row.


## Stage 4A additions

- `direct_links.rs` — 25 frozen assertions for opaque key generation, scoped/expired atomic consume and re-authorized HTTP resolution.
- `direct_links_email.rs` — 31 frozen assertions for rendered direct-link anchors across request notifications and lifecycle triggers.
- `test_secret_autorelease.rs` — 49 frozen assertions for wrapped PKCS#8 delivery, client-SPKI path, real AES/RSA decrypt roundtrip, readiness and retrieval guards.
- `user_credentials_lifecycle.rs` — 31 frozen assertions for password rotation and admin TOTP/password recovery through the Rust server.
