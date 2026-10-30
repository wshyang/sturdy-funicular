# decision-validation-suite/ files

- `00-context.ts` — Shared ordered-suite context (sessions, system/cluster ids, in-flight request id, delegate identity).
- `01-step-decision-validation.steps.ts` — Step-decision validation + per-step authorization arms (invalid value, notes-required, 404, wrong-step 403, override denied/granted, chain advancement).
- `02-owner-decision-validation.steps.ts` — Owner-decision validation + terminal authorization arms (invalid value, notes-required, stranger 403, 404, delegate terminal-approval positive, post-decision guard).
