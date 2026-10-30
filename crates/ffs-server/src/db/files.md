# crates/ffs-server/src/db/ directory files

- `mod.rs` — Entity-module exports.
- `admin_roles.rs` — Capability registry, system-role fallback, DB-backed role metadata/grants, custom-role CRUD, user-role settlement, scope resolution, and has_global_admin_grant (runtime visibility must not leak through scoped grants).
- `organizations.rs` — Org CRUD helpers plus live member/cluster/system-edge counts, membership liveness, and org audit insert.
- `clusters.rs`, `teams.rs`, `users.rs`, `sessions.rs`, `login_attempts.rs`, `user_invites.rs` — Entity/query helpers for their bounded contexts.
