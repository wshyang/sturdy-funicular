# owner-delegate-guards-suite/ files

- `00-context.ts` — Shared ordered-suite context (owner session, system + cluster ids, fixture targets).
- `01-delegate-validation.steps.ts` — Delegate POST/DELETE arms not already pinned by owner.test.tsx / time_bound_delegations.test.tsx: unknown-system 404, inactive-target 400, already-owner 400, duplicate 400 (after a real 201), delete-unknown 404.
- `02-statistics-validation.steps.ts` — /owner/statistics range-validation arms (missing/unparseable/inverted 400s) plus the empty-owner 200 shape.
