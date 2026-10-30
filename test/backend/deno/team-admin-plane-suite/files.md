# team-admin-plane-suite/ files

- `00-context.ts` — Shared ordered-suite context.
- `01-add-member-validation.steps.ts` — POST /teams/:id/members validation arms (schema gate, unknown user, affiliation mismatch, duplicate, cluster exclusivity, team 404) + the non-global team_admin manage-plane positive.
- `02-role-and-remove-guards.steps.ts` — Role/remove guard arms (non-global self-lock on demote and on remove, idempotent role no-op, unknown-membership 404s).
