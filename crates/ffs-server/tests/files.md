# crates/ffs-server/tests/ directory files

- `ported_suites.rs` — Integration-test entry point for ported legacy Deno/Node backend suites.
- `ported/` — Ported legacy suite modules with one-to-one assertion parity IDs.
- `admin_auth.rs`, `admin_orgs_idor.rs`, `admin_teams_idor.rs`, `admin_users_idor.rs`, `teams_idor.rs` — Pre-existing Rust real-DB authorization/IDOR tests.
- Stage 2A modules: `admin_capabilities_comprehensive`, `auth_admin_roles`, `admin_roles_crud`, `role_summary` (481 legacy asserts).
