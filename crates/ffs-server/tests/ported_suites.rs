//! Ported legacy Deno/Node backend suites.
//! Each assertion carries a parity ID from test/rust/legacy-assertion-inventory.json.

#[path = "ported/fixtures.rs"]
mod fixtures;
#[path = "ported/health.rs"]
mod health;
#[path = "ported/schema_bootstrap.rs"]
mod schema_bootstrap;
#[path = "ported/bootstrap_seed_passwords.rs"]
mod bootstrap_seed_passwords;
#[path = "ported/auth.rs"]
mod auth;
#[path = "ported/sanitize_user.rs"]
mod sanitize_user;
#[path = "ported/auth_me_endpoints.rs"]
mod auth_me_endpoints;
#[path = "ported/sessions.rs"]
mod sessions;
#[path = "ported/twofa.rs"]
mod twofa;
#[path = "ported/twofa_login_enforcement_toggle.rs"]
mod twofa_login_enforcement_toggle;
#[path = "ported/idempotency.rs"]
mod idempotency;
#[path = "ported/uuid_v7.rs"]
mod uuid_v7;
#[path = "ported/jsonb_normalization.rs"]
mod jsonb_normalization;
#[path = "ported/name_seeds.rs"]
mod name_seeds;
#[path = "ported/generated_schema_representations.rs"]
mod generated_schema_representations;
#[path = "ported/demo_seed_contract.rs"]
mod demo_seed_contract;
#[path = "ported/drizzle_bridge.rs"]
mod drizzle_bridge;
#[path = "ported/schema_snapshot_vs_migrations.rs"]
mod schema_snapshot_vs_migrations;
#[path = "ported/harness.rs"]
mod harness;
#[path = "ported/admin_capabilities_comprehensive.rs"]
mod admin_capabilities_comprehensive;
#[path = "ported/auth_admin_roles.rs"]
mod auth_admin_roles;
#[path = "ported/admin_roles_crud.rs"]
mod admin_roles_crud;
#[path = "ported/role_summary.rs"]
mod role_summary;
#[path = "ported/org_dimension.rs"]
mod org_dimension;
#[path = "ported/system_org_edges.rs"]
mod system_org_edges;
#[path = "ported/four_org_access.rs"]
mod four_org_access;
#[path = "ported/cross_org_structure.rs"]
mod cross_org_structure;
#[path = "ported/admin_clusters.rs"]
mod admin_clusters;
#[path = "ported/admin_teams.rs"]
mod admin_teams;
#[path = "ported/admin_systems.rs"]
mod admin_systems;
#[path = "ported/admin_systems_update_delete.rs"]
mod admin_systems_update_delete;
#[path = "ported/admin_assets.rs"]
mod admin_assets;
#[path = "ported/asset_search.rs"]
mod asset_search;
#[path = "ported/team_admin_plane.rs"]
mod team_admin_plane;
#[path = "ported/admin_users.rs"]
mod admin_users;
#[path = "ported/admin_app_settings.rs"]
mod admin_app_settings;
#[path = "ported/app_settings_providers.rs"]
mod app_settings_providers;
#[path = "ported/app_settings_helper.rs"]
mod app_settings_helper;
#[path = "ported/app_settings_seed_drift.rs"]
mod app_settings_seed_drift;
#[path = "ported/org_overrides.rs"]
mod org_overrides;
#[path = "ported/admin_organization_overrides.rs"]
mod admin_organization_overrides;
#[path = "ported/admin_email_templates.rs"]
mod admin_email_templates;
#[path = "ported/admin_data.rs"]
mod admin_data;
#[path = "ported/pending_actions_admin.rs"]
mod pending_actions_admin;
#[path = "ported/workflow_machine.rs"]
mod workflow_machine;
#[path = "ported/request_schemas.rs"]
mod request_schemas;
#[path = "ported/request_content_validation.rs"]
mod request_content_validation;
#[path = "ported/decision_validation.rs"]
mod decision_validation;
#[path = "ported/request_sequences.rs"]
mod request_sequences;
#[path = "ported/mapping_droplist_repro.rs"]
mod mapping_droplist_repro;
#[path = "ported/pending_chips_contract.rs"]
mod pending_chips_contract;

// ── PORT-3B — request lifecycle / owner self-service ────────────────────────
#[path = "ported/requests.rs"]
mod requests;
#[path = "ported/owner.rs"]
mod owner;
#[path = "ported/owner_delegate_guards.rs"]
mod owner_delegate_guards;
#[path = "ported/concurrency.rs"]
mod concurrency;

// ── PORT-4A — direct credential delivery ───────────────────────────────────
#[path = "ported/direct_links.rs"]
mod direct_links;
#[path = "ported/direct_links_email.rs"]
mod direct_links_email;
#[path = "ported/test_secret_autorelease.rs"]
mod test_secret_autorelease;
#[path = "ported/user_credentials_lifecycle.rs"]
mod user_credentials_lifecycle;

// ── PORT-4B1 — AWS namespace and transport codec (no S3/SSM exchange yet) ──
#[path = "ported/aws_ssm.rs"]
mod aws_ssm;
#[path = "ported/aws_transport.rs"]
mod aws_transport;

// ── PORT-4B2 — AWS S3 naming (rest of ledger and LocalStack pending) ──────
#[path = "ported/aws_tenant_exchange.rs"]
mod aws_tenant_exchange;

// ── PORT-4B3 — AWS delivery payload contracts (remaining integration pending) ──
#[path = "ported/aws_integration.rs"]
mod aws_integration;

// ── PORT-5A — custody exception negative validation (positive custody pending) ──
#[path = "ported/custody_exception_guards.rs"]
mod custody_exception_guards;
#[path = "ported/physical_asset_custody_cases.rs"]
mod physical_asset_custody_cases;
