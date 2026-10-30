# crates/ffs-test-support/ directory files

- `Cargo.toml` — Black-box Rust test harness crate manifest.
- `src/lib.rs` — Leases per-test Postgres databases, spawns the real `ffs-server` binary, provides HTTP/DB helpers, parity assertion macros, and cleanup/artifact capture.
- `TestApp::start_with_env` / `spawn` / `db_url` — per-server env overrides for toggle suites, convenience spawn for ported suites, and direct DB URL access for session-layer seam tests.
- `name_seeds.rs` — SG/vendor fixture-name pools ported from `test/backend/deno/name-seeds.ts`.
- `time.rs` — harness test-clock seam (`set_test_now` / `now`) for deterministic artifacts.
- `artifacts.rs` — snapshot allowlist, sensitive-column redaction, bounded response bodies, and failure-bundle writers.


## Stage 3B update

- `src/lib.rs` — TestApp HTTP client timeout raised from 20s to 60s because Stage 3B request submission performs real RSA-2048 key generation and the full workflow suites can saturate the sandbox under parallel test load.
