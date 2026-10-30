# custody-exception-guards-suite/ files

- `00-context.ts` — Shared ordered-suite context (sessions, submitted request id).
- `01-exception-validation.steps.ts` — Exception-report route-validation arms: unknown-request 404; report-validity 400s (bogus type, empty/over-long description, non-UUID case id); 21-file attachment cap 400. (Spoofed/executable/empty/oversized upload arms and action-route bounds stay in physical_asset_custody.test.tsx.)
