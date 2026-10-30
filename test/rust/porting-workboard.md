# Rust porting workboard

Generated from 114 legacy backend suites and 4272 legacy assertion call sites.

Assertion parity is the count gate; this workboard is the organizing queue. A suite is not done until its assertion IDs are mapped, it runs against the real Rust binary, and its slice coverage evidence is recorded.

## Totals by wave

| Wave | Suites | Legacy assertions | Mapped |
|---:|---:|---:|---:|
| 1 | 10 | 317 | 317 |
| 2 | 25 | 1509 | 1509 |
| 3 | 11 | 534 | 534 |
| 4 | 12 | 320 | 253 |
| 5 | 2 | 59 | 34 |
| 6 | 16 | 427 | 0 |
| 7 | 9 | 446 | 0 |
| 8 | 12 | 355 | 0 |
| 9 | 17 | 305 | 106 |

## Totals by assertion style

| Style | Suites | Legacy assertions | Mapped |
|---|---:|---:|---:|
| module | 51 | 2253 | 1826 |
| user-flow | 34 | 1359 | 821 |
| coverage-security | 12 | 355 | 0 |
| seam | 17 | 305 | 106 |

## Suite queue

| Wave | Track | Style | Suite | Assertions | Mapped | Status |
|---:|---|---|---|---:|---:|---|
| 1 | foundation | module | `test/backend/deno/auth_me_endpoints.test.tsx` | 64 | 64 | ported |
| 1 | foundation | module | `test/backend/deno/auth.test.tsx` | 52 | 52 | ported |
| 1 | foundation | module | `test/backend/deno/bootstrap_seed_passwords.test.tsx` | 4 | 4 | ported |
| 1 | foundation | module | `test/backend/deno/health.test.tsx` | 22 | 22 | ported |
| 1 | foundation | module | `test/backend/deno/idempotency.test.tsx` | 29 | 29 | ported |
| 1 | foundation | module | `test/backend/deno/sanitize-user.test.tsx` | 10 | 10 | ported |
| 1 | foundation | module | `test/backend/deno/schema_bootstrap.test.tsx` | 12 | 12 | ported |
| 1 | foundation | module | `test/backend/deno/sessions.test.tsx` | 55 | 55 | ported |
| 1 | foundation | module | `test/backend/deno/twofa_login_enforcement_toggle.test.tsx` | 16 | 16 | ported |
| 1 | foundation | module | `test/backend/deno/twofa.test.tsx` | 53 | 53 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_app_settings.test.tsx` | 69 | 69 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_assets.test.tsx` | 68 | 68 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_clusters.test.tsx` | 33 | 33 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_data.test.tsx` | 37 | 37 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_email_templates.test.tsx` | 34 | 34 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_organization_overrides.test.tsx` | 54 | 54 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_roles_crud.test.tsx` | 27 | 27 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_systems_update_delete.test.tsx` | 59 | 59 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_systems.test.tsx` | 104 | 104 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_teams.test.tsx` | 76 | 76 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin_users.test.tsx` | 84 | 84 | ported |
| 2 | admin-plane | module | `test/backend/deno/admin-capabilities-comprehensive.test.tsx` | 244 | 244 | ported |
| 2 | admin-plane | module | `test/backend/deno/app_settings_helper.test.tsx` | 9 | 9 | ported |
| 2 | admin-plane | module | `test/backend/deno/app_settings_providers.test.tsx` | 43 | 43 | ported |
| 2 | admin-plane | module | `test/backend/deno/app_settings_seed_drift.test.tsx` | 3 | 3 | ported |
| 2 | admin-plane | module | `test/backend/deno/asset_search.test.tsx` | 10 | 10 | ported |
| 2 | admin-plane | module | `test/backend/deno/auth-admin-roles.test.tsx` | 192 | 192 | ported |
| 2 | admin-plane | module | `test/backend/deno/cross_org_structure.test.tsx` | 40 | 40 | ported |
| 2 | admin-plane | module | `test/backend/deno/four_org_access.test.tsx` | 66 | 66 | ported |
| 2 | admin-plane | module | `test/backend/deno/org_dimension.test.tsx` | 71 | 71 | ported |
| 2 | admin-plane | module | `test/backend/deno/org_overrides.test.tsx` | 59 | 59 | ported |
| 2 | admin-plane | module | `test/backend/deno/pending_actions_admin.test.tsx` | 16 | 16 | ported |
| 2 | admin-plane | module | `test/backend/deno/role_summary.test.tsx` | 18 | 18 | ported |
| 2 | admin-plane | module | `test/backend/deno/system_org_edges.test.tsx` | 68 | 68 | ported |
| 2 | admin-plane | module | `test/backend/deno/team_admin_plane.test.tsx` | 25 | 25 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/concurrency.test.tsx` | 14 | 14 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/decision_validation.test.tsx` | 32 | 32 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/mapping_droplist_repro.test.tsx` | 9 | 9 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/owner_delegate_guards.test.tsx` | 21 | 21 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/owner.test.tsx` | 89 | 89 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/pending_chips_contract.test.tsx` | 27 | 27 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/request_content_validation.test.tsx` | 30 | 30 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/request_schemas.test.tsx` | 78 | 78 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/request_sequences.test.tsx` | 14 | 14 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/requests.test.tsx` | 204 | 204 | ported |
| 3 | request-lifecycle | user-flow | `test/backend/deno/workflow-machine.test.tsx` | 16 | 16 | ported |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-asset-inventory.test.tsx` | 12 | 0 | pending |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-integration.test.tsx` | 44 | 43 | partial |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-localstack-ses.test.tsx` | 13 | 0 | pending |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-localstack.test.tsx` | 25 | 0 | pending |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-ssm.test.tsx` | 3 | 3 | ported |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-tenant-exchange.test.tsx` | 27 | 27 | ported |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-tenant-sweep.test.tsx` | 16 | 0 | pending |
| 4 | credential-delivery | user-flow | `test/backend/deno/aws-transport.test.tsx` | 44 | 44 | ported |
| 4 | credential-delivery | user-flow | `test/backend/deno/direct-links-email.test.tsx` | 31 | 31 | ported |
| 4 | credential-delivery | user-flow | `test/backend/deno/direct-links.test.tsx` | 25 | 25 | ported |
| 4 | credential-delivery | user-flow | `test/backend/deno/test-secret-autorelease.test.tsx` | 49 | 49 | ported |
| 4 | credential-delivery | user-flow | `test/backend/deno/user_credentials_lifecycle.test.tsx` | 31 | 31 | ported |
| 5 | physical-custody | user-flow | `test/backend/deno/custody_exception_guards.test.tsx` | 14 | 14 | ported |
| 5 | physical-custody | user-flow | `test/backend/deno/physical_asset_custody.test.tsx` | 45 | 20 | partial |
| 6 | observability-notifications-cron | module | `test/backend/deno/access_log_filters.test.tsx` | 69 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/access-log.test.tsx` | 23 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/audit_all_entities.test.tsx` | 16 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/audit_context.test.tsx` | 17 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/audit_inheritance.test.tsx` | 15 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/audit_sensitivity.test.tsx` | 20 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/audit.test.tsx` | 37 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/cron_worker_contract.test.tsx` | 17 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/cron-jobs.test.tsx` | 27 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/email_templates.test.tsx` | 27 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/generic_audit_timeline.test.tsx` | 22 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/job_runs.test.tsx` | 25 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/pending_actions_digest.test.tsx` | 24 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/sent_notifications_multichannel.test.tsx` | 7 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/sent_notifications_outbox.test.tsx` | 64 | 0 | pending |
| 6 | observability-notifications-cron | module | `test/backend/deno/smtp_send.test.tsx` | 17 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/entra_auth.test.tsx` | 53 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/entra_authorize_url.test.tsx` | 11 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/entra_exchange.test.tsx` | 38 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/identity_change.test.tsx` | 98 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/identity_entities.test.tsx` | 40 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/invite.test.tsx` | 73 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/slack_linking.test.tsx` | 48 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/slack-integration.test.tsx` | 76 | 0 | pending |
| 7 | integrations-identity | user-flow | `test/backend/deno/time_bound_delegations.test.tsx` | 9 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/authz-matrix.test.tsx` | 6 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/cross_org.test.tsx` | 49 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/cryptographic-failures.test.tsx` | 51 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/dependency_security.test.ts` | 8 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/exceptional-conditions.test.tsx` | 47 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/four_org_matrix.test.tsx` | 12 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/injection.test.tsx` | 40 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/request-validation-fuzz.test.tsx` | 21 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/runtime_mode.test.tsx` | 17 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/security-headers.test.tsx` | 55 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/security-misconfiguration.test.tsx` | 38 | 0 | pending |
| 8 | security-coverage | coverage-security | `test/backend/deno/state-guards.test.tsx` | 11 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/aggregate_transactions.test.tsx` | 21 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/demo_seed_contract.test.ts` | 13 | 13 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/drizzle_bridge.test.tsx` | 10 | 10 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/generated_schema_representations.test.ts` | 12 | 12 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/harness/harness.test.tsx` | 44 | 44 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/jsonb_normalization.test.tsx` | 2 | 2 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/key_validators.test.tsx` | 45 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/n_plus_one_regression.test.tsx` | 17 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/name_seeds.test.tsx` | 9 | 9 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/outbound_payload_partition.test.tsx` | 5 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/remediation_facades.test.tsx` | 16 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/request_logger.test.tsx` | 5 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/schema_snapshot_vs_migrations.test.tsx` | 13 | 13 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/system_actor_rows.test.tsx` | 9 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/utils_validators.test.tsx` | 66 | 0 | pending |
| 9 | cargo-seam | seam | `test/backend/deno/uuid_v7.test.tsx` | 3 | 3 | ported |
| 9 | cargo-seam | seam | `test/backend/deno/visibility_derivation.test.tsx` | 15 | 0 | pending |
