# crates/ffs-server/src/auth/ directory files

- `mod.rs` — Auth module exports.
- `password.rs` — PBKDF2 password hashing/verification and salt generation.
- `session.rs` — Session entity, token extraction, CRUD, exclusive mint, cookie transport.
- `totp.rs` — TOTP enrollment/verification seams.
- `routes.rs` — Auth/2FA/me HTTP handlers.
- `privileges.rs` — Canonical admin capability allow/deny decisions (`has_admin_privilege`, `require_admin_privilege`); role storage stays in `db::admin_roles`.

- `credentials.rs` — POST /auth/change-password with live policy, current-password verification, session revocation and audit.
