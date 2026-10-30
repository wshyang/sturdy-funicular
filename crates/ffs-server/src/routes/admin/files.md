# crates/ffs-server/src/routes/admin/ directory files

- `mod.rs` — Admin route-module exports.
- `capabilities.rs` — Capability/role introspection handlers and effective-capability projection.
- `roles.rs` — Custom-role CRUD and per-user role settlement handlers (AdminRolesManage; mutations share the idempotency TxHandle).
- `organizations.rs` — Org registry CRUD, short-code regime, delete guards (members/clusters/system edges), member add/list/remove, scoped 404-disguise, and org audits.
- `systems.rs` — System CRUD (full create projection, workflow validation, AWS note, backup owner), /my-systems, org edges, owners (kind/sole-primary guards), asset CRUD/sync/reconcile dispatch, mappings + mappable-teams; scoped reads key on the owner org edge.
- `mappings.rs` — Owner-PA and team↔system mapping create/delete; invalidated team/system rejection, cluster-membership and duplicate guards; scoped capability checks key on the ownership/system org.
- `users.rs` — Admin user list (scoped shared-org, pending hidden), invite/approve with organizationIds validation and membership assignment.
- `clusters.rs`, `teams.rs` — Cluster/team CRUD with org anchors, scoped list/keyed behavior, cluster org-move guard, team level/name uniqueness, and the F3 live-workflow delete guard (force acknowledgement, scope-indifferent).
- `app_settings.rs` — App-settings registry CRUD, bounds/immutability, secret masking + audit hiding, RSA PEM validation, bulk export/import, and runtime-info.
- `notification_templates.rs` — Global email-template listing/CRUD (sanitized HTML, immutable trigger key, audit old/new values) and sent-notifications outbox.
- `users_lifecycle.rs` — Pending list, reject, tombstone/untombstone (membership cascade, session invalidation, auto-cancel), and affiliation change with global-grant guards.
- `organization_overrides.rs` — Org-scoped settings/templates overrides with provenance, soft-delete, capability/scope 404-disguise.
- `data.rs` — breakglass-export-v3 export/import (deferred self-FKs, session preservation) and dev-only reset-seed.
- `pending_actions.rs` — Admin pending-actions debtor report with scoped UserRead org filtering.
