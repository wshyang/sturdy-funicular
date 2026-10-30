# crates/ffs-server/src/ directory files

- `lib.rs` — Library crate root exposing the server modules used by the binary and integration tests.
- `main.rs` — Axum binary entrypoint: config/DB startup, router assembly, middleware, cron, and graceful shutdown.
- `config.rs` — Environment-backed server configuration.
- `database.rs` — SeaORM connection setup and database helpers.
- `models.rs` — SeaORM entity models for the typed schema.
- `errors.rs` — AppError/RouteResult HTTP error mapping (401/403/400/404/409/429/opaque 500).
- `tx.rs` — Request-wide transaction handle shared by idempotency and handler writes.
- `idempotency.rs` — Idempotency-token middleware and expired-token sweep.
- `access_log.rs` — Request access-log capture helpers.
- `security_headers.rs` — Security-header middleware.
- `sanitize_user.rs` — User-response sanitization seam.
- `bootstrap.rs` — Startup schema/bootstrap initialization seams.
- `mapping_sync.rs` — Workflow-save auto-sync of team↔system mappings with in-flight retention and audit provenance.
- `notifications.rs` — Notification outbox trigger helper (sent_notifications + recipients).
- `app_settings.rs` — App-settings registry/cache/getters (org-aware resolution, SMTP/SES readiness, env provider override, secret masking).
- `app_settings_defaults.rs` — Frozen 65-key DEFAULTS registry (key/type/default/category/overridable).
- `audit.rs` — Shared audit_log writer (actor/action/target/details/org).
- `email_html.rs` — Email-template HTML sanitizer (tag/attribute allowlist, safe link schemes, rel=noopener).
- `workflow_machine.rs` — Pure request-lifecycle transition table (getNextState) preserving legacy status/ordinal semantics.
- `request_helpers.rs` — Shared request-content guard (validateContent) for submit/resubmit/edit.
- `schemas.rs` — safeParse-style request-body schema contracts with defaults and human-facing messages.
- `pending_actions.rs` — Viewer pending-action derivation shared by my-requests chips and the admin aggregate ledger.

- `direct_links.rs` — Cryptographically random base62 link locators, persisted recipient/TTL scope, atomic usage count, URL assembly and expiry sweep.
- `email_templates.rs` — Real seeded Handlebars email rendering with safe `directLink` anchor and text fallback.
- `request_crypto.rs` — RSA-2048 request keypair with AES-256-GCM wrapped PKCS#8 private-key download and client-SPKI validation.
