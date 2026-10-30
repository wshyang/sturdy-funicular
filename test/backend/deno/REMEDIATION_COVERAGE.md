# Conversation remediation backend coverage ledger

| Phase/change | Positive backend contract | Negative/forbidden-state contract |
|---|---|---|
| Physical custody | `physical_asset_custody.test.tsx` six-stage, combined transitions, evidence | unauthorized/wrong-state actions, item exception isolation, invalid files |
| Business JSONB normalization | `jsonb_normalization.test.tsx` normalized child rows | business JSONB column census remains empty |
| Sent notifications + compatibility removal | `sent_notifications_multichannel.test.tsx`, `sent_notifications_outbox.test.tsx` relational hierarchy | legacy root projections absent |
| Aggregate transactions | `aggregate_transactions.test.tsx` valid commits and nested reentry | child failures roll back roots/base fields/children |
| Async notification outbox | `sent_notifications_outbox.test.tsx`, `cron-jobs.test.tsx` worker completion and registration | producer no IO, rollback, retry cap, stale/concurrent claims, wrong statuses absent |
| Canonical authorization | `auth-admin-roles.test.tsx`, `admin-capabilities-comprehensive.test.tsx`, `cross_org.test.tsx` | revoked/missing grants, duplicate decision exports absent, scoped 403/404 disguise |
| Set-based reads | `n_plus_one_regression.test.tsx` normalized shapes and real owing reviewer | query counts do not scale with roots/users |
| Frontend component splits | Not backend-applicable; covered by colocated jsdom suites | DOM/test-id negatives remain frontend contracts |
| Backend facade splits | `remediation_facades.test.tsx` export identity | duplicate/forbidden exports and producer IO imports absent |
| Type/contract facades | TypeScript + static bundles; runtime constants in `remediation_facades.test.tsx` | export census reports no missing/additional names |
| Generated schema representations | `generated_schema_representations.test.ts` and `schema:check` | stale output, missing normalized tables, seed DML/functions/triggers rejected |
| Shared validators + `routeError` | `utils_validators.test.tsx` identifier/name/email/temp-password contracts | injection charsets, non-Error throws, 500 body leaks nothing but the fallback |
| Request schema refinements | `request_schemas.test.tsx` each valid grant form, delegate window, 0-or-5 custody stages | scoped `grants` mixed with the global form, `updateUserRoles` neither/both, reversed and zero-length windows |
| Request content validation | `request_content_validation.test.tsx` resolved assets and ISO normalization | field bounds, unparseable/reversed times, duplicate, cross-system and soft-deleted assets |
| Organisation setting/template overrides | `admin_organization_overrides.test.tsx` override write/read-back/revert and provenance | non-overridable key refused 403/400/404, immutable fields, secret masked in response and audit |
| Entra identity guard | `identity_change.test.tsx` upgrade, re-point, reactivation, sweep | Object ID owned by another user, foreign identity row, expired/non-pending replay |

Actual PostgreSQL execution remains required on an environment with Deno and Docker/Postgres. Static bundling in Arena proves syntax/import closure, not transaction or query-count runtime behavior.
