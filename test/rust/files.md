# test/rust/ directory files

- `legacy-assertion-inventory.json` — AST-generated inventory of every legacy Deno/Node backend assertion call site, including imported `*-suite` step modules, with stable parity IDs used by `scripts/check-assert-parity.mjs`.
- `porting-workboard.json` — Machine-readable Rust-port suite queue generated from the assertion inventory: dependency wave, track, assertion style, assertion budget, and mapped status.
- `porting-workboard.md` — Human-readable Rust-port suite queue and totals by wave/style.
- `porting-staging-plan.md` — Staged execution plan for the Rust port: baseline freeze, dependency waves split into reviewable batches, parallel seam lanes, and per-stage exit criteria.
- `sandbox-setup-log.md` — Step-by-step sandbox initialization/recovery log, including failed toolchain/vendor/OpenSSL/PostgreSQL attempts and the minimal reproduction runbook.
- `legacy-suite-map.json` — Legacy-suite to Rust-port module map used by `scripts/check-rust-test-map.mjs`; tracks ported/partial/pending status for all 114 backend suites.


## Stage 3B bookkeeping

- `porting-workboard.{json,md}` regenerated: wave 3 now 534/534 mapped; total mapped 2,466/4,272.
- `porting-staging-plan.md` gained the Stage 3B delivery table and seam notes.
- `sandbox-setup-log.md` records Stage 3B compile/filtered/full-regression commands and failed-attempt recoveries.


## Stage 4A bookkeeping

- `porting-workboard.{json,md}` regenerated with 136 Wave-4 assertion IDs (2,602 total mapped).
- `porting-staging-plan.md` and `sandbox-setup-log.md` track delivery, recovery, failures and regression.

## Stage 4B1 bookkeeping

- `legacy-suite-map.json` records `aws-ssm` 3/3 ported and `aws-transport` 35/44 partial; the remaining 9 enablement assertions are not claimed.
- `porting-workboard.{json,md}` regenerated at 2,640/4,272 mapped.
- `porting-staging-plan.md` describes the pending S3/SSM/LocalStack requirements and transport wiring; `sandbox-setup-log.md` records the commands and failed attempts.

## Stage 4B2 bookkeeping

- `legacy-suite-map.json`: aws-transport 44/44 ported; aws-tenant-exchange 22/27 partial.
- `porting-workboard.{json,md}`: regenerated at 2,671/4,272 mapped; 1,601 remain.
- `porting-staging-plan.md`: explicit unrun LocalStack contract and remaining wiring obligations.

## Stage 4B3 bookkeeping

- `aws-tenant-exchange` is 27/27; `aws-integration` payload assertions are 27/44 partial.
- Workboard regenerated at 2,703/4,272 mapped; 1,569 remain.
- Full workspace regressions after 4B1/4B2 are recorded separately; Stage 4B1's later rerun failed three long suites, and 4B2's queued run has not yet reported a result.

## Stage 4B4 bookkeeping

- `aws-integration` is 35/44 partial; its eight credential-strategy IDs use real AWS SDK providers.
- Workboard regenerated at 2,711/4,272 mapped; 1,561 remain.
- Sandbox reset/recovery commands and failures are appended to `sandbox-setup-log.md`.

## Stage 4B5 bookkeeping

- `aws-integration` has 43/44 source-annotated IDs; three env/DB flag checks and five real HTTP lifecycle checks are queued for focused execution before treating that count as verified.
- Workboard regenerated at 2,719/4,272 mapped; 1,553 missing; LocalStack assertions remain uncounted.
## Stage 5A bookkeeping

- `custody_exception_guards` has 14 annotated IDs tested via HTTP multipart validation; 45 positive `physical_asset_custody` IDs remain unmapped. A valid custody report returns 501 until write/audit/upload paths are ported.
- Workboard regenerated at 2,733/4,272 source-mapped IDs; 1,539 remain, zero unannotated. Stage 4B5 full regression outcome is unknown after reset.
- Sandbox reset and all Stage 5A test/build failures are recorded in `sandbox-setup-log.md`.
- Focused custody HTTP test 1/1 and targeted `decision_validation` regression 1/1 passed; no Stage 5A full-workspace result. Draft PR remains open.

## Stage 5B bookkeeping

- Admin custody stage configuration PUT/list projection added; `physical_asset_custody` is 2/45, not positive custody flow parity.
- Workboard regenerated at 2,735/4,272 source-mapped IDs; 1,537 missing, zero unannotated. Focused 2-assertion Rust HTTP test passed; admin-system regression passed 2/2.
- `sandbox-setup-log.md` records graph checks and the failed stage-order assertion followed by the passing rerun.
- Full Rust workspace regression after Stage 5B: ported suites **192/192** passed; ignored LocalStack contract is not execution evidence. Exact command and outcome are logged in `sandbox-setup-log.md`.

## Stage 5C bookkeeping

- `physical_asset_custody_cases.rs` now contains both the Stage 5B setup and Stage 5C approval/read-model/issue tests (20/45 frozen IDs); the former separate config test file was removed so the machine suite-map checker remains exact.
- Workboard regenerated at 2,753/4,272 source-mapped IDs; 1,519 remain. Focused 2/2 Rust HTTP tests passed; no Stage 5C full-workspace result yet.
- `sandbox-setup-log.md` records graph commands, exact focused runs and the failed two-module mapping attempts with correction.
