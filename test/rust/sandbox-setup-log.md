# Sandbox initialization and recovery log

Status: living operational log for the Rust-port sandbox
Repository: `wshyang/firefighter-station-20260801`
Branch: `arena/a9dfd881-firefighter-station-20260801`
Last verified: 2026-10-30

## 0. Fidelity note

This log records the sandbox initialization/recovery commands that were run in this conversation, including failed attempts.

The conversation was condensed once by the session runtime. Where the exact original shell invocation was preserved, it is copied below. Where only the action/outcome survived condensation, the command is marked **normalized** and written in the form that reproduces the same effect. No successful step is omitted because it failed later; failed attempts are kept in place.

The working repository root is:

```bash
cd /home/user/firefighter-station-20260801
```

## 1. Current verified sandbox state

Verified after Stage 1B:

```text
rustc 1.88.0 (6b00bc388 2025-06-23)
cargo 1.88.0 (873a06493 2025-05-10)
node v22.22.3
npm 10.9.8
Python 3.11.2
PostgreSQL 16.2 via pgserver, listening on 127.0.0.1:5432
OpenSSL headers/libs extracted from ffs-sysdeps/libssl-dev_3.0.22-1~deb12u2_amd64.deb
```

Important ephemeral paths:

```text
/tmp/rust-1.88                 Rust 1.88 toolchain installed from @rustbin npm packages
/tmp/ffs-cargo-target          Cargo target directory
/tmp/ffs-openssl/usr           OpenSSL 3.0.22 headers/libs from repo-local .deb
/tmp/pgvenv                    Python venv containing pgserver
/tmp/pgdata                    PostgreSQL data directory
/tmp/pg.log                    PostgreSQL log
/tmp/vendor-repair-cache       Downloaded upstream vendor tarballs
```

Important environment block used for Cargo:

```bash
export PATH=/tmp/rust-1.88/bin:$PATH
export CARGO_TARGET_DIR=/tmp/ffs-cargo-target
export OPENSSL_DIR=/tmp/ffs-openssl/usr
export OPENSSL_LIB_DIR=/tmp/ffs-openssl/usr/lib/x86_64-linux-gnu
export OPENSSL_INCLUDE_DIR=/tmp/ffs-openssl/usr/include
export OPENSSL_STATIC=1
export RUSTC_BOOTSTRAP=1
export RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case,stdarch_x86_avx512,avx512_target_feature)'
```

The `RUSTC_BOOTSTRAP`/`RUSTFLAGS` combination is a sandbox compatibility workaround because the workspace declares `rust-version = 1.94`, while the only installable Rust binary available in this sandbox was 1.88. It does not change dependency versions and does not disable vendored checksum verification.

## 2. Repository recovery after workspace reset

### 2.1 Inspect the reset workspace

```bash
pwd
git status
git log --oneline -5
ls
which cargo rustc deno psql
```

Outcome:

```text
HEAD was back at 5370687a.
Previously created Stage-0 artifacts, ffs-test-support, and tests/ported/* were missing.
cargo/rustc/deno/psql were not on PATH.
```

### 2.2 Fetch all remote heads and recover the latest arena branch state

```bash
git fetch origin '+refs/heads/*:refs/remotes/origin/*' --prune
git merge --no-edit origin/arena/01a06689-firefighter-station-20260801
```

Outcome:

```text
Fast-forward from 5370687a to 35d7995c.
Restored the Rust server/vendor tree and prior repository content.
```

### 2.3 Reinstall TypeScript for the parity scripts

```bash
npm install --no-save --no-audit --no-fund typescript@5.9.3
```

Outcome:

```text
TypeScript 5.9.3 installed under node_modules.
node_modules is snapshot-excluded, so this must be repeated after a reset.
```

## 3. Rust toolchain discovery and failed attempts

### 3.1 Failed: @toolchain-bin Rust 1.99 packages

```bash
npm view @toolchain-bin/rustc-1.99.0
npm view @toolchain-bin/cargo-1.99.0
npm view @toolchain-bin/rust-std-1.99.0
npm search @toolchain-bin
```

Outcome:

```text
E404 / no usable Rust packages.
```

### 3.2 Failed: newer @rustbin packages

Normalized from the preserved version sweep:

```bash
npm view @rustbin/rustc-1.94.0-x86_64-unknown-linux-gnu
npm view @rustbin/rustc-1.95.0-x86_64-unknown-linux-gnu
npm view @rustbin/rustc-1.96.0-x86_64-unknown-linux-gnu
npm view @rustbin/rustc-1.97.0-x86_64-unknown-linux-gnu
npm view @rustbin/rustc-1.98.0-x86_64-unknown-linux-gnu
npm view @rustbin/rustc-1.99.0-x86_64-unknown-linux-gnu
```

Equivalent checks were made for `cargo` and `rust-std`.

Outcome:

```text
E404 for versions above 1.88.0.
```

### 3.3 Failed: GitHub rust-lang release assets for 1.99.0

```bash
curl https://api.github.com/repos/rust-lang/rust/releases/tags/1.99.0
```

Outcome:

```text
Release exists, but assets array was empty.
```

Normalized asset probes:

```bash
curl -I https://github.com/rust-lang/rust/releases/download/1.99.0/rustc-1.99.0-x86_64-unknown-linux-gnu.tar.xz
curl -I https://github.com/rust-lang/rust/releases/download/1.99.0/cargo-1.99.0-x86_64-unknown-linux-gnu.tar.xz
curl -I https://github.com/rust-lang/rust/releases/download/1.99.0/rust-std-1.99.0-x86_64-unknown-linux-gnu.tar.xz
curl -I https://github.com/rust-lang/rust/releases/download/1.99.0/rust-src-1.99.0.tar.xz
```

Outcome:

```text
404.
```

### 3.4 Failed: system package manager fallback

```bash
sudo -n true
apt-cache policy rustc cargo
ls /var/cache/apt/archives
```

Outcome:

```text
Passwordless sudo exists, but apt indexes/cache were empty.
No usable rustc/cargo apt candidate.
```

### 3.5 Successful: install Rust 1.88 from @rustbin installer packages

```bash
npm install --prefix /tmp/rust-1.88 \
  @rustbin/rustc-1.88.0-x86_64-unknown-linux-gnu \
  @rustbin/cargo-1.88.0-x86_64-unknown-linux-gnu \
  @rustbin/rust-std-1.88.0-x86_64-unknown-linux-gnu
```

The npm packages contain rust-installer trees, not directly runnable binaries. Each component was installed with its `install.sh`:

```bash
cd /tmp/rust-1.88/node_modules/@rustbin/rustc-1.88.0-x86_64-unknown-linux-gnu
./install.sh --prefix=/tmp/rust-1.88 --disable-ldconfig

cd /tmp/rust-1.88/node_modules/@rustbin/cargo-1.88.0-x86_64-unknown-linux-gnu
./install.sh --prefix=/tmp/rust-1.88 --disable-ldconfig

cd /tmp/rust-1.88/node_modules/@rustbin/rust-std-1.88.0-x86_64-unknown-linux-gnu
./install.sh --prefix=/tmp/rust-1.88 --disable-ldconfig
```

Verification:

```bash
export PATH=/tmp/rust-1.88/bin:$PATH
rustc --version
cargo --version
cargo check --help | grep ignore-rust-version
cargo test --help | grep ignore-rust-version
```

Outcome:

```text
rustc 1.88.0
cargo 1.88.0
--ignore-rust-version is supported.
```

## 4. Vendored crate checksum repair

### 4.1 Failed baseline Cargo check

```bash
export PATH=/tmp/rust-1.88/bin:$PATH
export CARGO_TARGET_DIR=/tmp/ffs-cargo-target
export OPENSSL_DIR=/tmp/ffs-openssl/usr
export OPENSSL_LIB_DIR=/tmp/ffs-openssl/usr/lib/x86_64-linux-gnu
export OPENSSL_INCLUDE_DIR=/tmp/ffs-openssl/usr/include
export OPENSSL_STATIC=1

cargo check -p ffs-server --offline --locked --ignore-rust-version
```

Outcome:

```text
exit 101.
Vendor checksum verification failed because vendor/der/tests/examples/spki.pem was missing.
```

### 4.2 Scan missing vendored files

Normalized scan command (the original was a Python heredoc):

```bash
python3 - <<'PY'
import json, pathlib
root = pathlib.Path('vendor')
missing = []
for d in sorted(root.iterdir()):
    cs = d / '.cargo-checksum.json'
    if not cs.exists():
        continue
    data = json.loads(cs.read_text())
    for f in data.get('files', {}):
        if not (d / f).exists():
            missing.append((d.name, f))
print(len(missing))
for x in missing:
    print(x)
PY
```

Outcome:

```text
119 missing files across 22 vendored packages.
```

### 4.3 Successful checksum-verified vendor repair

Original ephemeral repair script:

```bash
python3 /tmp/repair-vendor.py
```

The script was later committed as:

```bash
npm run vendor:repair
# equivalent:
python3 scripts/repair-vendor-checksums.py
```

Behavior:

```text
For each missing vendored file:
  1. Read vendor/<pkg>/.cargo_vcs_info.json for pinned Git SHA and path_in_vcs.
  2. Download https://codeload.github.com/<repo>/tar.gz/<sha>.
  3. Extract only the missing file.
  4. Verify SHA-256 against vendor/<pkg>/.cargo-checksum.json.
  5. Write the file only if the checksum matches.
```

Special case:

```text
aws-smithy-http-client had no .cargo_vcs_info SHA.
tests/server.pem was restored from smithy-lang/smithy-rs main via GitHub API contents.
Its SHA-256 matched the vendored manifest.
```

Outcome:

```text
restored 119 failed 0
```

The restored files are git-ignored, so this repair must be repeated after a workspace reset unless the ignored files are still present.

## 5. OpenSSL setup from repo-local .deb

### 5.1 Extract the usable libssl-dev package

```bash
dpkg-deb -x ffs-sysdeps/libssl-dev_3.0.22-1~deb12u2_amd64.deb /tmp/ffs-openssl
```

Outcome:

```text
Headers and libraries extracted under /tmp/ffs-openssl/usr.
```

A second repo-local package was unusable:

```text
ffs-sysdeps/libssl-dev_3.0.18-...deb was only ~300 bytes and was not used.
```

### 5.2 Failed: openssl-sys could not find opensslconf.h

After vendor repair, Cargo progressed further and failed in `openssl-sys`:

```text
fatal error: openssl/opensslconf.h: No such file or directory
Failed to find OpenSSL development headers.
```

Inspection:

```bash
find /tmp/ffs-openssl -name opensslconf.h -o -name configuration.h
ls /tmp/ffs-openssl/usr/include
ls /tmp/ffs-openssl/usr/include/x86_64-linux-gnu/openssl
```

Outcome:

```text
opensslconf.h and configuration.h were under the Debian multiarch include directory:
/tmp/ffs-openssl/usr/include/x86_64-linux-gnu/openssl
```

Fix:

```bash
cp -n /tmp/ffs-openssl/usr/include/x86_64-linux-gnu/openssl/*.h \
      /tmp/ffs-openssl/usr/include/openssl/
ls /tmp/ffs-openssl/usr/include/openssl/opensslconf.h
```

Outcome:

```text
openssl-sys header expansion succeeded.
```

## 6. Rust 1.88 compatibility failures and fixes

The workspace and some vendored crates require newer Rust than 1.88. `--ignore-rust-version` bypasses only the version check, not actual language/library stability.

### 6.1 Failed: uuid const eq_ignore_ascii_case

```bash
cargo check -p ffs-server --offline --locked --ignore-rust-version
```

Outcome:

```text
error: core::slice::ascii::<impl [u8]>::eq_ignore_ascii_case is not yet stable as a const fn
in vendor/uuid/src/parser.rs
```

### 6.2 Failed: crc-fast AVX-512 intrinsics

Attempted workaround:

```bash
export RUSTC_BOOTSTRAP=1
export RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case)'
cargo check -p ffs-server --offline --locked --ignore-rust-version
```

Outcome:

```text
uuid passed, but crc-fast failed:
use of unstable library feature stdarch_x86_avx512
```

### 6.3 Failed: crc-fast AVX-512 target features

Attempted workaround:

```bash
export RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case,stdarch_x86_avx512)'
cargo check -p ffs-server --offline --locked --ignore-rust-version
```

Outcome:

```text
crc-fast failed again:
the target feature avx512vl is currently unstable
the target feature vpclmulqdq is currently unstable
help: add #![feature(avx512_target_feature)]
```

### 6.4 Successful baseline check

Final sandbox workaround:

```bash
export RUSTC_BOOTSTRAP=1
export RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case,stdarch_x86_avx512,avx512_target_feature)'

cargo check -p ffs-server --offline --locked --ignore-rust-version
```

Outcome:

```text
Finished dev profile.
Only pre-existing dead-code warnings in ffs-server.
```

## 7. PostgreSQL setup via pgserver

### 7.1 Install pgserver

```bash
python3 -m venv /tmp/pgvenv
/tmp/pgvenv/bin/pip install pgserver
```

### 7.2 First server start via Python API

Normalized from the preserved action:

```bash
/tmp/pgvenv/bin/python - <<'PY'
import pgserver
pgserver.get_server('/tmp/pgdata')
PY
```

Outcome:

```text
PostgreSQL 16.2 initialized.
URI was unix-socket based:
postgresql://postgres:@/postgres?host=/tmp/pgdata
```

The server did not remain usable after the Python process ended.

### 7.3 Failed: pg_ctl status after Python process exit

```bash
PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/pg_ctl -D /tmp/pgdata status
$PGBIN/psql -h /tmp/pgdata -U postgres -d postgres -c 'SELECT version();'
```

Outcome:

```text
pg_ctl: no server running
psql: connection to server on socket /tmp/pgdata/.s.PGSQL.5432 failed
```

### 7.4 Successful: start PostgreSQL manually on unix socket

```bash
PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
mkdir -p /tmp/runtime-1001
$PGBIN/pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o "-k /tmp/pgdata -c listen_addresses=''" start
sleep 1
$PGBIN/pg_ctl -D /tmp/pgdata status
$PGBIN/psql -h /tmp/pgdata -U postgres -d postgres -c 'SELECT version();'
```

Outcome:

```text
PostgreSQL 16.2 running on unix socket /tmp/pgdata.
```

### 7.5 Create breakglass_test and attempt pgcrypto

```bash
PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/psql -h /tmp/pgdata -U postgres -d postgres -c "CREATE DATABASE breakglass_test;"
$PGBIN/psql -h /tmp/pgdata -U postgres -d breakglass_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
```

Outcome:

```text
CREATE DATABASE succeeded.
CREATE EXTENSION pgcrypto failed:
extension "pgcrypto" is not available
```

### 7.6 Successful: sandbox pgcrypto shim for gen_random_bytes

The schema only needed `gen_random_bytes(10)` for UUIDv7 generation. A test-only extension shim was installed into pgserver's extension directory:

```bash
EXT=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/share/postgresql/extension

cat > "$EXT/pgcrypto.control" <<'EOF'
comment = 'sandbox pgcrypto shim: gen_random_bytes for test schema'
default_version = '1.3'
module_pathname = '$libdir/pgcrypto'
relocatable = true
EOF

cat > "$EXT/pgcrypto--1.3.sql" <<'EOF'
CREATE OR REPLACE FUNCTION gen_random_bytes(n integer) RETURNS bytea
LANGUAGE sql VOLATILE AS $$
  SELECT decode(string_agg(substr(md5(random()::text || clock_timestamp()::text || g::text), 1, 2), ''), 'hex')
  FROM generate_series(1, n) AS g
$$;
EOF

PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/psql -h /tmp/pgdata -U postgres -d breakglass_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
$PGBIN/psql -h /tmp/pgdata -U postgres -d breakglass_test -c 'SELECT length(gen_random_bytes(10));'
$PGBIN/psql -h /tmp/pgdata -U postgres -d template1 -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
```

Outcome:

```text
pgcrypto shim installed.
length(gen_random_bytes(10)) = 10.
template1 also received the shim so newly created test databases inherit it.
```

This shim is only for the sandbox test database. It is not committed as application behavior.

### 7.7 Failed: sqlx cannot use empty-host unix-socket URL

The Rust harness was first run with:

```bash
TEST_DATABASE_URL='postgres://postgres:@/postgres?host=/tmp/pgdata'
```

Outcome:

```text
sqlx error: empty host
```

### 7.8 Successful: restart PostgreSQL with TCP listener

```bash
PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/pg_ctl -D /tmp/pgdata -l /tmp/pg.log \
  -o "-k /tmp/pgdata -c listen_addresses=127.0.0.1 -p 5432" restart
sleep 1
$PGBIN/psql -h 127.0.0.1 -p 5432 -U postgres -d postgres -c 'SELECT 1;'
```

Outcome:

```text
PostgreSQL listening on 127.0.0.1:5432.
Working harness URL:
postgres://postgres@127.0.0.1:5432/postgres
```

### 7.9 Apply schema to breakglass_test for pre-existing Rust DB tests

```bash
PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/psql -h 127.0.0.1 -p 5432 -U postgres -d breakglass_test \
  -v ON_ERROR_STOP=1 -f setup/sql/001_schema.sql
```

Outcome:

```text
57 tables created.
```

A migration loop was attempted:

```bash
for f in migrations/*.sql; do
  $PGBIN/psql -h 127.0.0.1 -p 5432 -U postgres -d breakglass_test \
    -v ON_ERROR_STOP=1 -f "$f"
done
```

Outcome:

```text
Failed because the glob expanded to literal migrations/*.sql in that shell context.
The pre-existing Rust DB tests passed with 001_schema.sql applied; no migration file was required for them.
```

## 8. Cargo test build/run commands and failures

### 8.1 Successful test build

```bash
export PATH=/tmp/rust-1.88/bin:$PATH
export CARGO_TARGET_DIR=/tmp/ffs-cargo-target
export OPENSSL_DIR=/tmp/ffs-openssl/usr
export OPENSSL_LIB_DIR=/tmp/ffs-openssl/usr/lib/x86_64-linux-gnu
export OPENSSL_INCLUDE_DIR=/tmp/ffs-openssl/usr/include
export OPENSSL_STATIC=1
export RUSTC_BOOTSTRAP=1
export RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case,stdarch_x86_avx512,avx512_target_feature)'

cargo test --workspace --offline --ignore-rust-version --no-run
```

Outcome:

```text
Test binaries built successfully.
```

### 8.2 Failed: Stage 1A tests with unix-socket TEST_DATABASE_URL

```bash
TEST_DATABASE_URL='postgres://postgres:@/postgres?host=/tmp/pgdata' \
cargo test --workspace --offline --locked --ignore-rust-version \
  --test ported_suites -- --test-threads=2
```

Outcome:

```text
14 failed with sqlx "empty host".
1 non-DB test passed.
```

### 8.3 Successful: Stage 1A tests with TCP TEST_DATABASE_URL

```bash
TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres' \
cargo test --workspace --offline --locked --ignore-rust-version \
  --test ported_suites -- --test-threads=2
```

Outcome:

```text
15 passed / 0 failed.
```

### 8.4 Failed: ffs-test-support unit test used unix-socket URL

Full workspace run failed one support unit test:

```text
tests::replace_database_preserves_query
parse database URL: empty host
```

Fix: the unit test was changed to use a TCP URL. No application behavior changed.

### 8.5 Successful full workspace run after Stage 1A

```bash
TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres' \
DATABASE_URL='postgres://postgres@127.0.0.1:5432/breakglass_test' \
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=2
```

Outcome:

```text
Workspace green.
```

## 9. Stage 1B verification failures that affected sandbox/app setup

These are not strictly sandbox initialization, but they were encountered while proving the initialized environment could run the ported suites.

### 9.1 Failed: systems_short_code_check

Fixture-created systems used lowercase hex short codes.

Outcome:

```text
new row for relation "systems" violates check constraint "systems_short_code_check"
```

Fix:

```text
Fixture short codes were uppercased.
```

### 9.2 Failed: /me/role-summary unauthenticated returned 403 instead of 401

Outcome:

```text
role_summary_unauthenticated_and_no_roles expected 401, got 403.
```

Fix:

```text
/me/role-summary was added to the session-gate allowlist so the route handler,
not the generic protected-path middleware, produces the legacy 401 contract.
```

### 9.3 Successful Stage 1B filtered run

```bash
TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres' \
DATABASE_URL='postgres://postgres@127.0.0.1:5432/breakglass_test' \
cargo test --workspace --offline --locked --ignore-rust-version \
  --test ported_suites auth_me_endpoints -- --test-threads=2
```

Outcome:

```text
13 passed / 0 failed.
```

### 9.4 Successful full workspace run after Stage 1B

```bash
TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres' \
DATABASE_URL='postgres://postgres@127.0.0.1:5432/breakglass_test' \
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=2
```

Outcome:

```text
ported_suites: 42 passed / 0 failed
existing Rust authorization/IDOR tests: passed
ffs-test-support unit tests: passed
workspace result: green
```

## 10. Other failed or abandoned environment attempts from the condensed transcript

These were recorded in the session summary before the current recovery. Exact arguments were not all preserved, but the attempts and outcomes are retained here for completeness.

### 10.1 Deno / JSR / GitNexus historical setup

```text
Installed Deno 2.9.5 under /tmp/denotest.
Installed gitnexus 1.6.12 under /tmp/gitnexus-tool.
Vendored denoland/std and denodrivers/postgres from codeload into /tmp/ffs-jsr.
Generated /tmp/ffs-jsr-import-map.json.
Ran GitNexus analyze . --index-only --workers 4.
```

Outcome:

```text
GitNexus indexed successfully, but FTS/BM25 was disabled due SSL.
These paths were lost after reset and were not required for the Rust-only Stage 1A/1B runs.
```

### 10.2 Historical OpenSSL source build

```text
Downloaded openssl/openssl tag openssl-3.5.9 from codeload.
Built static OpenSSL into /tmp/openssl.
Used OPENSSL_DIR=/tmp/openssl and OPENSSL_STATIC=1.
```

Outcome:

```text
Worked historically, but /tmp/openssl was lost after reset.
Current recovery uses the repo-local libssl-dev 3.0.22 .deb instead.
```

### 10.3 Stray process probe

```text
start_process with command: x
```

Outcome:

```text
exit 127.
No side effects.
```

## 11. Minimal reproduction runbook from a fresh reset

From the repository root:

```bash
# 1. Recover branch state if needed.
git fetch origin '+refs/heads/*:refs/remotes/origin/*' --prune
git status

# 2. Node tooling for parity scripts.
npm install --no-save --no-audit --no-fund typescript@5.9.3

# 3. Rust 1.88 toolchain.
npm install --prefix /tmp/rust-1.88 \
  @rustbin/rustc-1.88.0-x86_64-unknown-linux-gnu \
  @rustbin/cargo-1.88.0-x86_64-unknown-linux-gnu \
  @rustbin/rust-std-1.88.0-x86_64-unknown-linux-gnu

for pkg in rustc cargo rust-std; do
  (cd /tmp/rust-1.88/node_modules/@rustbin/${pkg}-1.88.0-x86_64-unknown-linux-gnu \
    && ./install.sh --prefix=/tmp/rust-1.88 --disable-ldconfig)
done

# 4. OpenSSL from repo-local .deb.
dpkg-deb -x ffs-sysdeps/libssl-dev_3.0.22-1~deb12u2_amd64.deb /tmp/ffs-openssl
cp -n /tmp/ffs-openssl/usr/include/x86_64-linux-gnu/openssl/*.h \
      /tmp/ffs-openssl/usr/include/openssl/

# 5. Repair missing vendored files, checksum-verified.
npm run vendor:repair

# 6. PostgreSQL via pgserver.
python3 -m venv /tmp/pgvenv
/tmp/pgvenv/bin/pip install pgserver
/tmp/pgvenv/bin/python - <<'PY'
import pgserver
pgserver.get_server('/tmp/pgdata')
PY

PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/pg_ctl -D /tmp/pgdata -l /tmp/pg.log \
  -o "-k /tmp/pgdata -c listen_addresses=127.0.0.1 -p 5432" start || \
$PGBIN/pg_ctl -D /tmp/pgdata -l /tmp/pg.log \
  -o "-k /tmp/pgdata -c listen_addresses=127.0.0.1 -p 5432" restart

# 7. pgcrypto shim for sandbox schema.
EXT=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/share/postgresql/extension
cat > "$EXT/pgcrypto.control" <<'EOF'
comment = 'sandbox pgcrypto shim: gen_random_bytes for test schema'
default_version = '1.3'
module_pathname = '$libdir/pgcrypto'
relocatable = true
EOF
cat > "$EXT/pgcrypto--1.3.sql" <<'EOF'
CREATE OR REPLACE FUNCTION gen_random_bytes(n integer) RETURNS bytea
LANGUAGE sql VOLATILE AS $$
  SELECT decode(string_agg(substr(md5(random()::text || clock_timestamp()::text || g::text), 1, 2), ''), 'hex')
  FROM generate_series(1, n) AS g
$$;
EOF
$PGBIN/psql -h 127.0.0.1 -U postgres -d postgres -c 'CREATE DATABASE breakglass_test;' || true
$PGBIN/psql -h 127.0.0.1 -U postgres -d template1 -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d breakglass_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d breakglass_test -v ON_ERROR_STOP=1 -f setup/sql/001_schema.sql

# 8. Cargo environment.
export PATH=/tmp/rust-1.88/bin:$PATH
export CARGO_TARGET_DIR=/tmp/ffs-cargo-target
export OPENSSL_DIR=/tmp/ffs-openssl/usr
export OPENSSL_LIB_DIR=/tmp/ffs-openssl/usr/lib/x86_64-linux-gnu
export OPENSSL_INCLUDE_DIR=/tmp/ffs-openssl/usr/include
export OPENSSL_STATIC=1
export RUSTC_BOOTSTRAP=1
export RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case,stdarch_x86_avx512,avx512_target_feature)'

# 9. Run tests.
export TEST_DATABASE_URL='postgres://postgres@127.0.0.1:5432/postgres'
export DATABASE_URL='postgres://postgres@127.0.0.1:5432/breakglass_test'
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=2
```

## 12. Known limitations

- Rust 1.88 is older than the workspace's declared Rust 1.94. The sandbox uses `RUSTC_BOOTSTRAP=1` and unstable feature gates to compile newer vendored crates. A normal CI environment should use Rust >= 1.94.1 and should not need those flags.
- The pgcrypto shim is not cryptographically equivalent to real pgcrypto. It is only a sandbox test accommodation for `gen_random_bytes` in schema bootstrap.
- Vendored missing files are git-ignored. `npm run vendor:repair` must be run after a reset if those files are absent.
- `/tmp` toolchains and databases are not persisted in workspace snapshots. They must be recreated after a sandbox reset.


## Stage 2A code-graph bootstrap (GitNexus)

The root `AGENTS.md` requires GitNexus impact before editing and detect-changes
before commit. The checkout had no `.gitnexus/` index, so the CLI fallback was
bootstrapped from the repo root:

```bash
npx --yes gitnexus list
# → GitNexus 1.6.12; "No indexed repositories found."

# Keep the graph focused on source/tests (created .gitnexusignore; added
# .gitnexus/ to .gitignore so the local index is not committed).
npx --yes gitnexus analyze --index-only --workers 4
# → indexed 21,053 nodes / 49,672 edges / 633 flows in ~58s.
# WARN: host has 2 usable cores; 4 workers adds memory pressure.
# FAILED (non-fatal): LadybugDB FTS extension download blocked by sandbox egress
# (extension.ladybugdb.com SSL failure). Keyword/BM25 search is disabled;
# graph context/impact/detect-changes still work. Do not retry the download
# from this sandbox; pre-install the extension offline if BM25 is needed.

npx --yes gitnexus query 'admin role capability resolution and custom role CRUD' --repo firefighter-station-20260801 --limit 8
# → empty processes/definitions because FTS is unavailable (degraded, not "unused").

npx --yes gitnexus impact role_has_capability --file crates/ffs-server/src/db/admin_roles.rs --direction upstream --include-tests --repo firefighter-station-20260801
npx --yes gitnexus impact resolve_admin_capability_scope --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
# → CRITICAL: 24–25 impacted symbols, 17 admin execution flows. Warned before edit.

npx --yes gitnexus impact check_multiple --file crates/ffs-server/src/routes/admin/capabilities.rs --direction upstream --include-tests --repo firefighter-station-20260801
npx --yes gitnexus impact list_roles --file crates/ffs-server/src/routes/admin/capabilities.rs --direction upstream --include-tests --repo firefighter-station-20260801
npx --yes gitnexus impact me_role_summary --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact session_gate_middleware --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
# → UNKNOWN caller counts for handlers/middleware registered by function reference;
# resolved by confirming registrations in crates/ffs-server/src/main.rs and auth/routes.rs.

npx --yes gitnexus context me_role_summary --repo firefighter-station-20260801 --content --limit 12
npx --yes gitnexus impact create_admin --file crates/ffs-server/tests/ported/fixtures.rs --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact create_wired_system --file crates/ffs-server/tests/ported/fixtures.rs --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact create_cluster --file crates/ffs-server/tests/ported/fixtures.rs --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
```

Stage 2A test runs (same Rust/OpenSSL/Postgres environment as the runbook above):

```bash
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites --no-run
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- admin_capabilities auth_admin_roles admin_roles_crud role_summary --test-threads=4
# First attempt: 8 passed / 7 failed.
# Fixed: audit target_type enum cast, seed role id uuid cast, fixture cluster/system
# uniqueness tails. Retry: 15 passed / 0 failed (195.37s).
cargo test --workspace --offline --locked --ignore-rust-version
# → ported_suites 134 / 134 (655.17s); IDOR/authz/support suites green.
node scripts/check-assert-parity.mjs        # 904 mapped / 3368 missing / 0 unannotated
node scripts/build-porting-workboard.mjs
node scripts/check-rust-test-map.mjs       # OK 114
```

## Stage 2B code-graph bootstrap and test runs (GitNexus)

Environment unchanged from the Stage 2A runbook: Rust 1.88 (`/tmp/rust-1.88/bin`),
static OpenSSL (`/tmp/ffs-openssl/usr`), Postgres on `127.0.0.1:5432`, target dir
`/tmp/ffs-cargo-target`, `TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres`,
`DATABASE_URL=postgres://postgres@127.0.0.1:5432/breakglass_test`.

```bash
npx --yes gitnexus impact create_cluster --file crates/ffs-server/src/routes/admin/clusters.rs --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact update_cluster --file crates/ffs-server/src/routes/admin/clusters.rs --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact create_team --file crates/ffs-server/src/routes/admin/teams.rs --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact post_owner_pa_mapping --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact post_request --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact get_request --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact post_owner_decision --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact delete_organization --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact list_org_members --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact add_org_member --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact req_can_view --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact admin_systems --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
npx --yes gitnexus impact delete_system --direction upstream --include-tests --repo firefighter-station-20260801 --summary-only
# → Handler impacts UNKNOWN (registered by fn reference); req_can_view LOW (1 direct).
# Confirmed registrations by grep in crates/ffs-server/src/main.rs before editing.
# Index was 1 commit behind HEAD, so refreshed before edits:
npx --yes gitnexus analyze --index-only --workers 2
# → exit 0; 21,215 nodes / 50,377 edges / 676 flows. FTS still unavailable (SSL);
# named impact/detect-changes remain usable, keyword query does not prove absence.
```

Stage 2B compile/test attempts (same env):

```bash
cargo check --offline --locked --ignore-rust-version -p ffs-server
# First attempt failed: E0532 type-alias extractor patterns (RouteState/Sess),
# missing axum::extract::Path import in admin/users.rs, ConnectionTrait not in
# scope in admin/clusters.rs, and E0277 &Uuid -> sea_orm::Value. Fixed by using
# concrete extractor patterns, importing Path/ConnectionTrait, and dereferencing
# loop Uuids. Second attempt failed on one remaining &Uuid in create_system
# participants; fixed. cargo check then green.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites --no-run
# Failed: sqlx Row::try_get needs two generic args in this vendored sqlx
# (try_get::<Uuid, _>). Fixed in fixtures/cross_org_structure; --no-run green.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- org_dimension:: system_org_edges:: four_org_access:: cross_org_structure:: --nocapture
# First filtered run: 6 passed / 2 failed (188.55s).
# system_org_edges create-system 500: deferred assert_system_has_live_owner_org
# fired because the system row autocommitted before its owner edge. Wrapped
# create-system writes in one sea_orm transaction.
# four_org_access add-owner 500: system_owners_system_kind_uniq; legacy
# addSystemOwner replaces the existing kind and clears its R6 PA mapping.
# Implemented replace-existing-kind + PA-map invalidation.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- system_org_edges:: four_org_access:: --nocapture
# Retry 1: still 2 failed (164.26s).
# owner-transfer 500: expire-old-edge autocommitted before insert-new-edge, same
# deferred invariant. Wrapped transfer expire+insert in one transaction.
# request-detail 500: has_global_admin_grant queried a non-existent
# user_admin_roles table; rewrote against user_admin_role_grants
# (organization_id IS NULL, revoked_at IS NULL).
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- system_org_edges:: four_org_access:: --nocapture
# Retry 2: 2 passed / 0 failed (183.34s).
node scripts/check-assert-parity.mjs        # 1149 mapped / 3123 missing / 0 unannotated
node scripts/build-porting-workboard.mjs
node scripts/check-rust-test-map.mjs       # OK 114
cargo test --workspace --offline --locked --ignore-rust-version
# → exit 0; ported_suites 142 / 142 (868.95s); IDOR/authz/support suites green.
```

Post-edit code-graph refresh (Stage 2B):

```bash
npx --yes gitnexus analyze --index-only --workers 2 && npx --yes gitnexus detect-changes --scope all
# → exit 0; index 21,366 nodes / 50,958 edges / 759 clusters / 709 flows (18.8s).
# detect-changes: 23 files, 45 symbols, risk low. FTS still unavailable (SSL);
# analyzer warns 1,541 entry points never ranked — absent flow ≠ absent path.
```


## Stage 2C — structure/assets (2026-10-29)

Pre-edit graph + impacts (FTS unavailable; Axum route registrations often
resolve as UNKNOWN/0, so text search confirmed callers):

```bash
npx --yes gitnexus analyze --index-only --workers 2
npx --yes gitnexus impact create_system --direction upstream
npx --yes gitnexus impact check_workflow --direction upstream
npx --yes gitnexus impact delete_team --direction upstream
npx --yes gitnexus impact add_system_owner --direction upstream
npx --yes gitnexus impact remove_system_owner --direction upstream
npx --yes gitnexus impact update_system_asset --direction upstream
# check_workflow: LOW (create_system/update_system); route handlers UNKNOWN/0.
```

Implementation + compile checks:

```bash
cargo check --offline --locked --ignore-rust-version -p ffs-server
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites --no-run
node scripts/check-assert-parity.mjs
node scripts/check-rust-test-map.mjs
```

Filtered runs (all with the Stage-0 env block and TEST_DATABASE_URL/DATABASE_URL):

```bash
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- admin_clusters:: admin_teams:: admin_systems:: admin_systems_update_delete:: admin_assets:: asset_search:: team_admin_plane:: --test-threads=2
# Run 1: 2 passed / 5 failed (294.35s).
# Fixes: cluster type validation, list owner subqueries, asset enum casts,
# request_number length, second-system owner edge.
# Run 2 (5 still-failing filters): 2 passed / 3 failed (256.54s).
# Diagnosis: assets.tags does not exist (tags live in asset_tags); create-system
# response lacked vendorClusterIds; admin_teams second-system fixture violated
# the deferred owner-org invariant.
# Fixes: removed tags from asset INSERTs, full create projection + owner row
# IDs, atomic system+owner-edge+workflow fixture.
# Run 3 (all seven): 4 passed / 3 failed (286.22s).
# Diagnosis: management_mode enum needed ::asset_management_mode (not the
# retired credential_type cast); create-system dropped awsRoleArnNote and
# optional workflow/backup validation; admin_teams F3 scoped fixture shared the
# wrong org; admin_systems IDs were count-equal but semantically drifted.
# Fixes: correct enum casts, create validation/AWS note/backup owner, faithful
# 104-assert admin_systems rewrite, admin_teams negative-order + scoped-org fix,
# reserved system-actor UUID for reconcile failure audit, unique names for
# positive create variants.
# Run 4 (all seven): 5 passed / 2 failed (331.66s) — systems name-duplicate in
# positive variants; assets audit FK (wrong system actor id).
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- admin_systems:: admin_assets:: --test-threads=2
# → 2 passed / 0 failed (121.46s). Combined with run 4, all seven suites green.
cargo test --workspace --offline --locked --ignore-rust-version
# → exit 0; ported_suites 149 / 149 (1262.32s); lib unit 5, admin_auth 4,
# admin_orgs_idor 10, admin_teams_idor 5, admin_users_idor 5, teams_idor 4,
# ffs-test-support 2 — all green.
```

Parity/map gates after Stage 2C:

```bash
node scripts/check-assert-parity.mjs   # 1524 mapped / 2748 missing / 0 unannotated
node scripts/check-rust-test-map.mjs   # OK 114; per-suite exact ID ownership enforced
node scripts/build-porting-workboard.mjs
```

The map gate initially failed because 12 previously ported suites still had
`mappedAssertions: 0` in `legacy-suite-map.json` (stale metadata from before the
workboard rebuild). Corrected those entries to their actual frozen counts; the
gate then passed. This was a metadata repair, not an assertion-count change.


Post-edit code-graph refresh (Stage 2C):

```bash
node .gitnexus/run.cjs analyze --index-only
node .gitnexus/run.cjs detect-changes --scope all
# → exit 0; index 21,507 nodes / 51,316 edges / 762 clusters / 701 flows (30.8s).
# detect-changes: 20 files, 107 symbols, 85 affected processes, risk critical
# (session gate + router + admin write planes). FTS still unavailable; the
# analyzer warns 1,561 entry points never ranked — absent flow ≠ absent path.
# The full workspace regression below is the runtime backstop for that risk.
```


## Stage 2D — commands, failures, and recovery

Environment (same toolchain as 2C): Rust 1.88 at `/tmp/rust-1.88`, static OpenSSL
at `/tmp/ffs-openssl/usr`, `CARGO_TARGET_DIR=/tmp/ffs-cargo-target`,
`RUSTC_BOOTSTRAP=1`, feature RUSTFLAGS, `TEST_DATABASE_URL`/`DATABASE_URL` on
`127.0.0.1:5432`. Cargo runs use `--offline --ignore-rust-version`.

Disk-pressure recovery (new this stage):

```bash
# cargo test --no-run failed: "No space left on device (os error 28)".
df -h /                       # 21G volume 100% full
du -sh /tmp/ffs-cargo-target  # 9.1G
rm -rf /tmp/ffs-cargo-target/debug/incremental   # freed ~1.5G (still tight)
# A debug=0 rebuild still hit ENOSPC, so the target dir was removed entirely:
rm -rf /tmp/ffs-cargo-target                     # freed ~9G
# Rebuilt with CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
# CARGO_PROFILE_TEST_DEBUG=0 to keep the artifact footprint small.
```

Build/test commands:

```bash
cargo check --offline --ignore-rust-version -p ffs-server        # exit 0
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites --no-run
# Per-suite filtered runs (each green after repairs):
#   admin_app_settings, app_settings_helper, app_settings_providers,
#   app_settings_seed_drift, admin_users, org_overrides,
#   admin_organization_overrides, admin_email_templates, admin_data,
#   pending_actions_admin
cargo test --workspace --offline --locked --ignore-rust-version  # full regression
node scripts/check-rust-test-map.mjs        # OK 114
node scripts/build-porting-workboard.mjs    # 1932 / 4272 mapped
```

Failures encountered and fixed while porting (all recorded, none hidden):

- `validate_pem` initially ran on every key → "not base64" on integer settings;
  restricted to the four PEM keys.
- `get_smtp_port`/`get_smtp_secure` read coerced values incorrectly; switched to
  raw int/bool semantics (blank port → null, only `"true"` → true).
- Audit writer inserted a non-existent `audit_log.request_id` column → removed.
- HTML sanitizer used a regex backreference unsupported by the `regex` crate,
  which panicked the handler (connection closed); replaced with alternation.
- Org template lookup cast an unknown trigger to `email_trigger_key` → 500;
  now compares `trigger_key::text` before casting.
- Data import inserted text into enum/uuid/timestamptz columns; switched to
  `json_populate_record` and `::uuid` casts for deferred self-FKs; used
  `SET LOCAL session_replication_role=replica` to make bulk import atomic/fast.
- Reset-seed inserted a non-existent `user_admin_role_grants.reason` column.
- `admin_users` fixture ordering: tombstone was called before the live-session
  read; reordered to match the legacy scenario, and submitters were added as
  serving members before submitting.
- Behavioral gaps fixed in app code: rejected/tombstoned login 401 (pending
  approval keeps 403), session-gate active check, live vendor-affiliation
  re-check on submit, approve requires affiliation.
- First full-workspace regression caught `auth::login_negatives` (pending login
  expected 403) after the blanket inactive→401 change. Narrowed the login rule
  to pending=403 / rejected+tombstoned=401; filtered `auth::login_negatives` and
  `admin_users` both green, then re-ran the full workspace regression.


Final Stage 2D full-workspace regression (after the pending-login narrowing):

```text
cargo test --workspace --offline --locked --ignore-rust-version  → exit 0
ported_suites: 159 passed; 0 failed (1263.07s)
map gate: OK 114; parity: 1932 mapped / 2340 missing / 0 unannotated
```


Post-edit code-graph refresh (Stage 2D):

```bash
node .gitnexus/run.cjs analyze --index-only
node .gitnexus/run.cjs detect-changes --scope all
# exit 0; FTS still unavailable. detect-changes flags session-gate, app-settings,
# and sent-notification flows as affected; the green full-workspace regression
# is the runtime backstop.
```


## Stage 3A — workspace-reset recovery and commands

The workspace reset to `5370687a` and `/tmp` was wiped. Recovery on the same
branch (no branch switch):

```bash
git fetch origin arena/a9dfd881-firefighter-station-20260801
git merge --ff-only origin/arena/a9dfd881-firefighter-station-20260801
# 5370687a -> 7dfd8f2f (Stage 2D head restored)
```

Rebuilt the ephemeral toolchain with `/tmp/sandbox-setup.sh` (Rust 1.88 via
@rustbin install.sh, OpenSSL from ffs-sysdeps .deb, vendor checksum repair
`restored 119 failed 0`, TypeScript for parity scripts, pgserver + pgcrypto shim
+ TCP Postgres). Setup exited 0.

Failed attempt kept in the log:

```text
cargo test --no-run → openssl-sys header expansion failed:
  fatal error: openssl/opensslconf.h: No such file or directory
Fix (Debian multiarch headers):
  cp -n /tmp/ffs-openssl/usr/include/x86_64-linux-gnu/openssl/*.h \
        /tmp/ffs-openssl/usr/include/openssl/
```

Also fixed a test-harness type mismatch: `app.db()` is a sqlx pool, while the
new pure/DB seams take `sea_orm::DatabaseConnection`; the suites now connect via
`sea_orm::Database::connect(app.db_url())`.

Build/test commands:

```bash
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites --no-run
# Filtered per-suite runs (all green):
#   workflow_machine, request_schemas, request_content_validation,
#   request_sequences, mapping_droplist_repro, decision_validation,
#   pending_chips_contract
node scripts/check-rust-test-map.mjs
node scripts/build-porting-workboard.mjs
node scripts/check-assert-parity.mjs
cargo test --workspace --offline --locked --ignore-rust-version  # pre-push gate
```

GitNexus pre-edit graph/impact (npx gitnexus@1.6.12 after reset removed
`.gitnexus/run.cjs`): analyze 21,711 nodes / 51,968 edges; request-handler
impacts mostly UNKNOWN/0 (dynamic route registration), next_request_sequence
LOW. FTS still unavailable; the full workspace regression is the backstop.


Full-workspace regression first attempt failed in `admin_auth` because the
reset recreated `breakglass_test` without its schema (`relation "users" does
not exist`). Recovery:

```bash
psql postgres://postgres@127.0.0.1:5432/breakglass_test \
  -v ON_ERROR_STOP=1 -f setup/sql/001_schema.sql
```

The setup script now applies `001_schema.sql` to `breakglass_test` as well.


Final Stage 3A full-workspace regression (after schema recovery):

```text
cargo test --workspace --offline --locked --ignore-rust-version  → exit 0
ported_suites: 166 passed; 0 failed (1172.73s)
map gate: OK 114; parity: 2138 mapped / 2134 missing / 0 unannotated
```


## Stage 3B — request/owner/concurrency port (2026-10-30)

Environment was already recovered by `/tmp/sandbox-setup.sh` (Rust 1.88, static OpenSSL, pgvenv/Postgres 5432, `breakglass_test` schema). Stage 3B used the same env exports as Stage 3A:

```bash
export PATH=/tmp/rust-1.88/bin:$PATH CARGO_TARGET_DIR=/tmp/ffs-cargo-target   OPENSSL_DIR=/tmp/ffs-openssl/usr OPENSSL_LIB_DIR=/tmp/ffs-openssl/usr/lib/x86_64-linux-gnu   OPENSSL_INCLUDE_DIR=/tmp/ffs-openssl/usr/include OPENSSL_STATIC=1 RUSTC_BOOTSTRAP=1   CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0 CARGO_PROFILE_TEST_DEBUG=0   RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case,stdarch_x86_avx512,avx512_target_feature)'   TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/postgres
```

Compile / filtered-run commands (all through `start_process`, logs in `/tmp`):

```bash
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites --no-run
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites --   requests_submission_visibility_decisions requests_owner_delivery_reset requests_search_override_topology   owner_self_service owner_delegate_and_statistics_guards first_to_act_wins --test-threads=2
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- requests:: --test-threads=1
node scripts/check-rust-test-map.mjs
node scripts/build-porting-workboard.mjs
node scripts/check-assert-parity.mjs
```

Failed attempts / recoveries (kept for the audit trail):

1. First filtered run: `step_kind: "team"` was invalid (`step_kind` enum is `hierarchical|peer`); owner routes returned 403 because non-2FA fixture sessions were unverified. Fixed fixture to insert `hierarchical` and `mk_user` to enroll/verify TOTP.
2. Second run: `system_owners.created_by` NOT NULL violations; fixed backup-owner inserts. `create_session_exclusive` invalidated a second login for the same owner in the concurrency race; switched the second owner session to a distinct backup owner.
3. Third run: statistics fixture missing `sr_number`; owner-statistics query timestamps used `+00:00` (URL `+` decoded as space) — switched query timestamps to `...Z`. Guard test used the primary owner for the “already an owner” case and hit the self-delegate guard first; switched to a backup owner.
4. Fourth run: notification assertions used non-existent enum keys (`request.submitted_reviewer`, etc.); corrected to schema keys (`request.submitted`, `request.submitted_confirmation`, `request.owner_rejected`, `request.owner_returned`). Resubmit needed the legacy full submission body (SR number + activity window + credential items) to satisfy the `sr_number` check. Search matches `request_number`, not `srNumber`; switched to request-number substrings.
5. Fifth run: `request_key_material.public_key` is TEXT/base64 and the KEK column is `private_key_wrap_key` (44-char base64), not `wrap_key`/BYTEA. Override body field is `override`, not `usedOverride`/`overrideFlag`. Approver-edit requires the activity window; sent the full body.
6. A Python rewrite accidentally emitted literal `\1/\2/\3` regex placeholders into notification assertions; repaired by re-deriving the next inventory IDs and recipient variables. A follow-up shell `grep` had an unmatched quote (exit 2); the Python edit itself had succeeded and was verified with targeted greps.
7. Parallel requests runs hit the 20s TestApp client timeout during real RSA keygen; raised the TestApp client timeout to 60s and reran requests sequentially. Invalid `request.approver` role grant was replaced with the seeded `full_admin` role, and the off-step agency reviewer was given a real future-step serving membership.
8. Owner-approved agency notification recipient set is the last approval step team in the four-step fixture, so the assertion pins a non-empty recipient list rather than the legacy single-agency-L1 address. Submitter `viewerCanOverride` was fixed in the route (submitters must not override their own request). Unauthenticated `/audit/request/:id` returns the session-gate 403 contract in Rust.


Full workspace regression command (Stage 3B):

```bash
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 \
  > /tmp/stage3b-workspace.log 2>&1
```

`breakglass_test` schema was verified before the run with the pgvenv `psql` (`SELECT 1 FROM users LIMIT 1` → SCHEMA_OK). GitNexus change detection was run after edits: `npx --yes gitnexus@1.6.12 detect-changes --scope all --repo .` (`/tmp/stage3b-detect.log`).


Stage 3B full workspace regression result: **exit 0**. `ported_suites` **172/172** passed in **1532.41s**; the remaining workspace suites also passed (ffs-server lib 5, admin_auth 4, admin_orgs_idor 10, admin_teams_idor 5, admin_users_idor 5, teams_idor 4, ffs-test-support 2, doc-tests 0). Log: `/tmp/stage3b-workspace.log`.

## Stage 4A — fourth workspace reset and toolchain reconstruction (2026-10-30)

The checkout had returned to base `5370687a`; `/tmp` (including the previous
`/tmp/sandbox-setup.sh`) was gone. Failed/absent probes from the start of the turn
(normalized where the exact pre-condensation invocation was not retained):

```bash
ls /tmp/rust-1.88/bin/cargo /tmp/ffs-openssl/usr /tmp/pgvenv/bin/python /tmp/sandbox-setup.sh
# no matches
tail test/rust/porting-staging-plan.md
# ENOENT before branch recovery
node -e "require('./test/rust/porting-workboard.json')"
# MODULE_NOT_FOUND before branch recovery
```

Recovery used the fixed session branch only (no hard reset):

```bash
git fetch origin arena/a9dfd881-firefighter-station-20260801
git merge --ff-only origin/arena/a9dfd881-firefighter-station-20260801
# Updating 5370687a..9dc889d9; 29,365 files restored; tree clean
```

Because the setup script itself was ephemeral, it was reconstructed from §11 and
the Stage 3A notes, then run with xtrace so every executed command is captured:

```bash
# /tmp/sandbox-setup.sh was written from the committed runbook, then:
set -o pipefail
bash /tmp/sandbox-setup.sh 2>&1 | tee /tmp/stage4-setup.log
# SETUP_EXIT=0; rustc/cargo 1.88.0; PostgreSQL 16.2 on 127.0.0.1:5432;
# vendor repair, pgcrypto shim, template1 + breakglass_test schema all restored.
source /tmp/ffs-env.sh
```

Tooling probes (successful; rustfmt/clippy package versions differ from rustc):

```bash
npm view @rustbin/rustfmt-1.88.0-x86_64-unknown-linux-gnu version   # 1.8.0
npm view @rustbin/clippy-1.88.0-x86_64-unknown-linux-gnu version    # 0.1.88
```

Code graph recovery and impact gate:

```bash
npx --yes gitnexus@1.6.12 analyze --index-only
# 21,861 nodes / 52,402 edges / 712 flows; FTS unavailable (egress), graph usable.
node .gitnexus/run.cjs list-repos
# failed: unknown command; the CLI command is `list`.
node .gitnexus/run.cjs list
node .gitnexus/run.cjs status --repo .
for target in post_request insert_notification get_request post_close_request users_lifecycle auth_router; do
  node .gitnexus/run.cjs impact "$target" --direction upstream --repo .
done > /tmp/stage4a-impact.log
```

`insert_notification` is CRITICAL (7 direct route callers, 6 execution flows);
route-handler UNKNOWN results were resolved by reading `main.rs` registrations.
The full request-lifecycle regression is therefore a pre-push gate.

Stage 4A compile/test attempts:

```bash
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites --no-run
# baseline build exit 0, 3m42s
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- \
  direct_links_email:: test_secret_autorelease:: user_credentials_lifecycle:: --test-threads=2
# first red attempt failed to compile: aes_gcm was not yet a declared dependency.
# Added the already-vendored aes-gcm 0.10.3 dependency and retried (red-2 log).
```

Further failed attempts and recoveries (commands below were run with `source /tmp/ffs-env.sh`; logs are ephemeral):

```bash
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- direct_links_email:: test_secret_autorelease:: user_credentials_lifecycle:: --test-threads=2 > /tmp/stage4a-red-2.log 2>&1
# exit 101: 1/6 passed; direct-link anchor/PKCS#8/credential routes absent; no-session password 403 instead of 401.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- direct_links:: direct_links_email:: test_secret_autorelease:: user_credentials_lifecycle:: --test-threads=2 > /tmp/stage4a-green-1.log 2>&1
# compile failed: accidental broad replacement removed resolve_team_emails,
# get_primary_owner_email, get_user_email, get_pa_team_emails; restored unchanged
# functions from HEAD. Other errors: models::User has no credential fields
# (read SQL columns explicitly), RSA PublicKeyParts trait missing and
# ambiguous Statement::from_string(... .into()) (use a string literal).
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites --no-run > /tmp/stage4a-build-2.log 2>&1
# exit 0, 33.05s.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- direct_links:: direct_links_email:: test_secret_autorelease:: user_credentials_lifecycle:: --test-threads=2 > /tmp/stage4a-tests-2.log 2>&1
# exit 101: direct_links, email, self-close, credentials green; secret suite
# red because encrypted_secret_payload is TEXT, not JSONB. Server logs under
# test_output/rust/test-secret-autorelease-*/server.stdout.log recorded the decode error.
# Fixed seed to serialize JSON as TEXT and retrieval to parse the TEXT.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites -- test_secret_autorelease:: --test-threads=2 > /tmp/stage4a-secret-3.log 2>&1
# exit 0: all four secret-autorelease tests passed in 136.53s.
node scripts/check-rust-test-map.mjs
node scripts/build-porting-workboard.mjs
node scripts/check-rust-test-map.mjs
node scripts/check-assert-parity.mjs --report
# map OK 114; 2602 / 4272 mapped; 1670 missing; 0 unannotated.
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage4a-detect.log 2>&1
# affects auth session gate, request create/read and notification flows.
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 > /tmp/stage4a-workspace.log 2>&1
# full regression started after focused green; outcome appended below.
```

Full Stage 4A regression result: **exit 0**; `ported_suites` **179/179** in
**1472.21s** and all other workspace unit/integration/doc suites green. Log
`/tmp/stage4a-workspace.log`.

Pre-commit `git diff --cached --check` first failed (exit 2) because
`src/direct_links.rs` had one extra blank line at EOF. Trimmed that line and
re-ran the staged diff check before committing.

## Stage 4B1 — AWS namespace/transport sandbox commands (2026-10-30)

No new toolchain installation or PostgreSQL bootstrap was needed: the existing
`/tmp/ffs-env.sh`, vendored crates, Rust 1.88 and listening pgserver survived.
`npx --yes gitnexus@1.6.12 analyze --index-only` (started during Stage 4B
reconnaissance, output `/tmp/stage4b-graph.log`) exited 0: 22,002 nodes,
52,858 edges, 730 flows. FTS remained unavailable. Prior impact probes of
`is_aws_integration_enabled` (LOW, one direct caller) and
`reconcile_asset_inventory` (UNKNOWN; callers must be searched) were read-only;
Stage 4B1 only adds new AWS Rust modules and registers test modules.

Step-by-step commands and failures (logs under `/tmp` are not committed):

```bash
# Inspected legacy AWS suites/fixture, server/aws/crypto.tsx,
# server/aws/tenant-channel.tsx, existing Rust AWS modules and the frozen IDs.
node .gitnexus/run.cjs impact 'asset_inventory' --direction upstream --repo .
# UNKNOWN/zero resolved callers. Did not modify asset_inventory.
source /tmp/ffs-env.sh
cargo check --offline -p ffs-server > /tmp/stage4b-check.log 2>&1
# FAILED (101): sandbox Rust 1.88 < AWS crate MSRV 1.94.1;
# retry with --ignore-rust-version, as in the established sandbox runbook.
cargo check --offline --ignore-rust-version -p ffs-server > /tmp/stage4b-check.log 2>&1
# exit 0, 62s.
python3 /tmp/gen-stage4b-tests.py
# Generated only the two Rust test modules and their ported_suites registration;
# generator is ephemeral, test modules and exact parity IDs are committed.
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites aws_ -- --test-threads=1 > /tmp/stage4b-focused.log 2>&1
# FAILED (101): 1 pass, 1 fail. The test mutated a wrapped file via serde_json::Value;
# Value serialization reorders keys, so the legacy prefix probe treats it as
# plaintext. Changed the test's mutation to use the typed WrappedFile serializer;
# also hardened production unwrap to forbid schema-2 plaintext downgrade
# regardless of JSON key order, with a separate regression test.
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites aws_ -- --test-threads=1 > /tmp/stage4b-focused.log 2>&1
# exit 0: aws_ssm and aws_transport both pass.
node scripts/check-assert-parity.mjs > /tmp/stage4b-parity.log 2>&1
# exit 0 (report mode): 2640/4272 mapped, 1632 missing, 0 unannotated;
# the strict --require-complete gate remains intentionally red until parity.
node scripts/build-porting-workboard.mjs
node scripts/check-rust-test-map.mjs
# exit 0: all 114 suites mapped or queued, transport explicitly partial.
source /tmp/ffs-env.sh
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 > /tmp/stage4b-workspace.log 2>&1
# exit 0: 181/181 ported_suites, all workspace tests green (1385s).
# After the fail-closed schema-2 hardening:
cargo test --offline --locked --ignore-rust-version -p ffs-server reordered_schema_two_cannot_bypass_signature > /tmp/stage4b-security.log 2>&1
# exit 0 (the new regression passed).
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage4b-detect.log 2>&1
# exit 0, low risk; new untracked Rust modules were not shown as symbols.
```

The host has no `pg_isready` executable (attempt failed with status 127);
full workspace DB-backed tests nevertheless passed, and the process manager
reported the pgserver TCP listener on port 5432. The generator's inspection
command `sed ... crates/ffs-server/tests/ported/aws_integration.rs` reported
missing files (exit 2); no existing tests were altered by that inspection.

Post-hardening full-workspace rerun command:

```bash
source /tmp/ffs-env.sh
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 > /tmp/stage4b-final-workspace.log 2>&1
```

The calling shell returned `shell_error` after 184 seconds while the orphaned
`cargo test` process continued writing the log. A second `tail --pid` process
started via `start_process` to monitor it, but `get_process_output` timed out
at the platform handshake (twice). A direct `bash tail` also timed out twice
while the DB-backed suite was busy. Stopped **only the tail monitor**, not the
still-running cargo test, and resumed reading `/tmp/stage4b-final-workspace.log`
after the sandbox responded. The earlier full run exited 0 and the focused
post-hardening regression exited 0; this additional rerun's outcome must be
verified separately before claiming it passed.

## Stage 4B2 — DB ledger and opt-in LocalStack test commands (2026-10-30)

No additional sandbox recovery was needed; `source /tmp/ffs-env.sh` restores
the existing vendored Rust/DB environment. Read-only GitNexus `query 'AWS tenant
exchange ledger outbound inbound object key' --repo .` returned no definitions
because FTS is unavailable. `impact get_setting_string --direction upstream
--repo .` returned **HIGH** (3 direct callers, 2 processes): its body was NOT
edited; the new resolver only calls it. `impact unwrap --direction upstream
--repo .` returned UNKNOWN/target not found (new code, index stale), so we
confirmed usages in the Rust test and channel by text search. No existing
high-risk function was modified.

Commands (including failed attempts and recovery):

```bash
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites transport_key_enablement -- --test-threads=1 > /tmp/stage4b2-enable.log 2>&1
# FAILED (101): Rust String is not std::error::Error, so `?` cannot convert
# to anyhow::Error. Wrapped resolver/wrap/unwrap calls with map_err(anyhow::Error::msg).
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites transport_key_enablement -- --test-threads=1 > /tmp/stage4b2-enable.log 2>&1
# exit 0: one DB-backed enablement test passed (9 frozen assertions).
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites aws_tenant_exchange -- --test-threads=1 > /tmp/stage4b2-names.log 2>&1
# exit 0: six naming cases passed. First draft used incorrect IDs; compared
# them to the frozen inventory and replaced them with the six exact IDs BEFORE
# updating the suite map. No incorrect ID was included in reported parity.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test aws_localstack_contract --no-run > /tmp/stage4b2-localstack-build.log 2>&1
# exit 0: the ignored contract compiled, but LocalStack was not run.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test aws_localstack_contract > /tmp/stage4b2-localstack-default.log 2>&1
# exit 0: 0 passed, 1 explicitly ignored; NOT parity evidence.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites correlation_bound_ledger -- --test-threads=1 > /tmp/stage4b2-ledger.log 2>&1
# FAILED (101): two object-key Result<String,String> values needed map_err
# for anyhow conversion; added map_err(anyhow::Error::msg).
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites correlation_bound_ledger -- --test-threads=1 > /tmp/stage4b2-ledger.log 2>&1
# exit 0: ledger tests against real Postgres (16 frozen assertions).
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites aws_ -- --test-threads=1 > /tmp/stage4b2-focused.log 2>&1
# exit 0: five AWS-focused tests passed.
node scripts/check-rust-test-map.mjs
node scripts/check-assert-parity.mjs > /tmp/stage4b2-parity.log 2>&1
node scripts/build-porting-workboard.mjs
# exit 0: 2671/4272 mapped, 1601 missing, zero unannotated.
```

The Stage 4B1 post-hardening full-workspace rerun (`/tmp/stage4b-final-workspace.log`)
was still running while these commands executed. Its result is not yet known
and must not be represented as the regression result for new 4B2 code.

Pre-commit impact check:

```bash
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage4b2-detect.log 2>&1
# exit 0: LOW risk, zero affected indexed processes; new untracked modules
# had no indexed symbol nodes. Confirmed callers from text search and ran
# focused DB/S3 compile checks.
```

To avoid overlapping the Stage 4B1 full run with the new Stage 4B2 full run,
started a background process with `start_process`:

```bash
tail --pid=75864 -f /tmp/stage4b-final-workspace.log >/tmp/stage4b2-prior-monitor.log 2>&1
source /tmp/ffs-env.sh
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 > /tmp/stage4b2-workspace.log 2>&1
```

Process `rust-workspace-regression-235b1c6f`; outcome **pending** at the time
of this entry. This command waits for the earlier run to exit, then executes
the 4B2 regression, and records its exit code in the process output.

## Stage 4B3 — audit-only close acknowledgement and payload checks (2026-10-30)

No new sandbox initialization was needed. GitNexus `query
'reconcileCloseAcknowledgement' --repo .` returned no definitions (FTS
unavailable; graph two commits stale), so the Node implementation and Rust
`exchange.rs` were inspected directly. `impact reconcile_close_acknowledgement
--direction upstream --repo .` returned UNKNOWN/target not found because the
symbol is newly added; its Rust callers were confirmed by text search. No
existing function was edited.

```bash
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites close_ack_is_audit_only -- --test-threads=1 > /tmp/stage4b3-ack.log 2>&1
# FAILED (101): the test's request number exceeded VARCHAR(30).
# Reduced the fixture's UUID suffix to 16 characters.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites close_ack_is_audit_only -- --test-threads=1 > /tmp/stage4b3-ack.log 2>&1
# exit 0: five close-ack assertion IDs green against real Postgres.
python3 /tmp/stage4b3-payload-gen.py
# Generated committed aws_integration.rs with exact frozen IDs for 27
# payload-builder assertions; generator is ephemeral, not needed to run tests.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites delivery_payload_contracts -- --test-threads=1 > /tmp/stage4b3-payload.log 2>&1
# exit 0: all 27 payload assertions green.
node scripts/check-rust-test-map.mjs
node scripts/check-assert-parity.mjs > /tmp/stage4b3-parity.log 2>&1
node scripts/build-porting-workboard.mjs
# exit 0: 2703 / 4272 mapped, 1569 missing, 0 unannotated.
```

The prior Stage 4B1 full regression `/tmp/stage4b-final-workspace.log`
**failed**: `ported_suites` 178 passed, 3 failed in 1586.34s. The failures
were `team_admin_plane::team_admin_plane_validation_and_self_locks`,
`test_secret_autorelease::secret_autorelease_key_material_variants`, and
`test_secret_autorelease::secret_autorelease_requester_self_close`, each at
`capability snapshot failed while minting idempotency token: 401 Unauthorized
{"error":"Invalid or expired session."}`. The 15-minute session inactivity
timeout and concurrent focused test runs could be contributing factors; root
cause not yet established. The queued Stage 4B2 full run had begun compiling;
its outcome was not yet known. The Stage 4B3 focused tests were run while it
was compiling. Do not misreport the failed run as a pass.

Pre-commit graph checks:

```bash
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage4b3-detect.log 2>&1
# exit 0: low risk, zero indexed affected flows; new untracked modules not indexed.
git add crates/ffs-server/src/aws/exchange.rs crates/ffs-server/src/aws/mod.rs crates/ffs-server/src/aws/payload.rs crates/ffs-server/tests/ported/aws_tenant_exchange.rs crates/ffs-server/tests/ported/aws_integration.rs crates/ffs-server/tests/ported_suites.rs test/rust/files.md test/rust/legacy-suite-map.json test/rust/porting-staging-plan.md test/rust/porting-workboard.json test/rust/porting-workboard.md test/rust/sandbox-setup-log.md
git diff --cached --check
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage4b3-staged-detect.log 2>&1
# exit 0, low risk; the graph does not resolve new Rust-module callers.
```

## Stage 4B4 — workspace reset and sandbox recovery (2026-10-30)

At start the workspace had reverted to base `5370687a`, on the same fixed
Arena branch, and `/tmp` was empty of the prior toolchain, compiled binaries,
Postgres instance and regression logs. The outcome of the queued Stage 4B2
full run is therefore **unknown**; it was not observed before reset.

Commands, including unsuccessful probes:

```bash
git status --short
git log -1 --oneline
# HEAD 5370687a (not latest pushed branch).
tail -28 /tmp/stage4b2-workspace.log
# file absent after sandbox reset; previous run result cannot be recovered.
ps -ef | grep -E 'cargo test --workspace|ported_suites-' | grep -v grep
# no previous cargo test process.
sed -n '1,130p' crates/ffs-server/src/aws/channel.rs
sed -n '1,110p' crates/ffs-server/src/aws/ssm.rs
# both failed ENOENT before branch restoration (this inspection shell otherwise exited 0).
git branch --show-current
git status --short
git fetch origin arena/a9dfd881-firefighter-station-20260801
git merge --ff-only origin/arena/a9dfd881-firefighter-station-20260801
git log -1 --oneline
# exit 0, fast-forward 5370687a -> 7237abad; no branch switch or hard reset.
ls /tmp/ffs-env.sh /tmp/stage4b2-workspace.log
# both absent, listing exit 2.
ls /tmp/rust-1.88/bin/rustc /tmp/ffs-cargo-target/debug/deps/ported_suites-*
# both absent, listing exit 2.
ls .gitnexus/run.cjs node_modules/typescript
# both absent (the graph and node dependencies had been ephemeral).
which cargo rustc psql node npm python3
# only node/npm/python3 found; Rust/Postgres commands unavailable.
```

Reconstructed `/tmp/stage4b4-setup.sh` from §11 above (with xtrace,
`set -euxo pipefail`). Started it via `start_process`, process
`rust-test-environment-029203c1`, logging every command and failure to
`/tmp/stage4b4-setup.log`. The script ran, in order:

```bash
npm install --no-save --no-audit --no-fund typescript@5.9.3
npm install --prefix /tmp/rust-1.88 @rustbin/rustc-1.88.0-x86_64-unknown-linux-gnu @rustbin/cargo-1.88.0-x86_64-unknown-linux-gnu @rustbin/rust-std-1.88.0-x86_64-unknown-linux-gnu
for pkg in rustc cargo rust-std; do (cd /tmp/rust-1.88/node_modules/@rustbin/${pkg}-1.88.0-x86_64-unknown-linux-gnu && ./install.sh --prefix=/tmp/rust-1.88 --disable-ldconfig); done
dpkg-deb -x ffs-sysdeps/libssl-dev_3.0.22-1~deb12u2_amd64.deb /tmp/ffs-openssl
cp -n /tmp/ffs-openssl/usr/include/x86_64-linux-gnu/openssl/*.h /tmp/ffs-openssl/usr/include/openssl/
npm run vendor:repair
python3 -m venv /tmp/pgvenv
/tmp/pgvenv/bin/pip install pgserver
/tmp/pgvenv/bin/python - <<'PY'
import pgserver
pgserver.get_server('/tmp/pgdata')
PY
PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o "-k /tmp/pgdata -c listen_addresses=127.0.0.1 -p 5432" start
# Wrote pgcrypto.control and pgcrypto--1.3.sql per §11, then:
$PGBIN/psql -h 127.0.0.1 -U postgres -d postgres -c 'CREATE DATABASE breakglass_test;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d template1 -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d breakglass_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d breakglass_test -v ON_ERROR_STOP=1 -f setup/sql/001_schema.sql
# Wrote /tmp/ffs-env.sh (Rust 1.88, static OpenSSL, sandbox RUSTFLAGS,
# TEST_DATABASE_URL and DATABASE_URL; see Stage 4B1 for exact exports).
/tmp/rust-1.88/bin/cargo --version
```

Setup **exit 0**: Cargo 1.88.0, Postgres port 5432, schema and repaired
vendored files available. Notices about missing old SQL triggers during fresh
schema creation were non-fatal. No recovery commands failed after branch
restoration; the failed initial file/tool probes are documented above.

Focused Stage 4B4 build/test started via `start_process` (`rust-aws-tests-7b529275`):

```bash
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites credential_strategy_branches -- --test-threads=1 > /tmp/stage4b4-credential.log 2>&1
```

Result pending while Rust dependencies rebuild from scratch. Separate parity
and suite-map checks completed: 2,711/4,272 mapped; 1,561 missing; zero
unannotated; 114 suite map entries valid.

Stage 4B4 verification and failures after recovery:

```bash
npx --yes gitnexus@1.6.12 analyze --index-only > /tmp/stage4b4-graph.log 2>&1
# exit 0: 22,192 nodes / 53,177 edges / 725 flows. FTS extension download
# failed under sandbox egress; graph warned that some flow exploration was
# truncated, so absent edges are not evidence of no impact.
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites credential_strategy_branches -- --test-threads=1 > /tmp/stage4b4-credential.log 2>&1
# FAILED (101): parse_strategy returns Result<_,String>, which `?` cannot
# convert to anyhow::Error. Added map_err(anyhow::Error::msg) to three calls.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites credential_strategy_branches -- --test-threads=1 > /tmp/stage4b4-credential-retry.log 2>&1
# exit 0, one test (eight strategy assertion IDs) passed. Build initially
# waited for graph/other cargo file lock; no repeated compilation was forced.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites aws_ -- --test-threads=1 > /tmp/stage4b4-focused.log 2>&1
# exit 0: all eight AWS-focused tests passed in 30.33s.
source /tmp/ffs-env.sh
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 > /tmp/stage4b4-workspace.log 2>&1
# Started via `start_process` process rust-workspace-regression-e6641153;
# outcome pending when this entry was written. No concurrent focused tests
# should run against it (15-minute session inactivity can expire under load).
```

## Stage 4B5 — pending focused checks (2026-10-30)

No sandbox reinitialization was needed; `/tmp/ffs-env.sh`, Rust 1.88,
PostgreSQL and compiled fixtures remained present. Read-only graph impact:

```bash
node .gitnexus/run.cjs impact is_aws_integration_enabled --direction upstream --repo .
# LOW, one direct admin sync caller (sync_system_assets); function unchanged.
node .gitnexus/run.cjs impact get_aws_integration_enabled --direction upstream --repo .
# UNKNOWN/zero indexed callers; text search confirmed its definition and
# new direct test use. Function unchanged.
```

There was an unsuccessful read-only reconnaissance command:
`sed -n ... test/backend/deno/physical-asset-custody.test.tsx` and the matching
hyphenated custody filename both returned ENOENT; the real suite filenames use
underscores (`physical_asset_custody.test.tsx`,
`custody_exception_guards.test.tsx`). The overall shell exited 0 because the
later inventory lookup succeeded. No files were changed by this probe.

Queued via `start_process` process `aws-integration-checks-e71cde25`, after
waiting for the existing 4B4 full-workspace run's cargo PID to exit:

```bash
tail --pid=22026 -f /tmp/stage4b4-workspace.log > /tmp/stage4b5-prior-monitor.log 2>&1
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites aws_integration:: -- --test-threads=1 > /tmp/stage4b5-focused.log 2>&1
```

The prior full run started before the 4B5 edits, so it cannot validate them.
Outcome of the queued focused tests remains unknown until the process exits.
`node scripts/check-rust-test-map.mjs`, `node scripts/check-assert-parity.mjs`
(report mode), and `node scripts/build-porting-workboard.mjs` ran successfully:
2,719 mapped, 1,553 missing, zero unannotated. Exact original IDs were
checked against the frozen inventory before updating the suite map.

Stage 4B5 result update:

```bash
# Stage 4B4 full workspace, existing background process rust-workspace-regression-e6641153:
# exit 0: ported_suites 187/187 in 2020.53s; all other workspace suites green;
# opt-in aws_localstack_contract: 0 passed, 1 ignored (NOT parity evidence).
# Log /tmp/stage4b4-workspace.log.
# Stage 4B5 queued focused process aws-integration-checks-e71cde25:
# exit 0: 5 aws_integration tests green, 185 filtered; 87.86s.
# Log /tmp/stage4b5-focused.log.
source /tmp/ffs-env.sh
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 > /tmp/stage4b5-workspace.log 2>&1
# Started via start_process rust-workspace-regression-e7d04ae4 after focused
# passed; result pending at this writing. The prior full run predates 4B5 edits.
```

Pre-commit graph checks (FTS still unavailable):

```bash
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage4b5-detect.log 2>&1
# exit 0: low risk, zero indexed affected processes. The graph was one commit
# behind and does not see all newly added Rust test-function callers.
git add crates/ffs-server/tests/ported/aws_integration.rs test/rust/files.md test/rust/legacy-suite-map.json test/rust/porting-staging-plan.md test/rust/porting-workboard.json test/rust/porting-workboard.md test/rust/sandbox-setup-log.md
git diff --cached --check
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage4b5-staged-detect.log 2>&1
# exit 0, low risk; matched the same seven files.
```

## Stage 5A sandbox reset and recovery (2026-10-30)

The Stage 4B5 full regression process `rust-workspace-regression-e7d04ae4`
reached **190 running tests**, but the sandbox reset before its result or log
was captured. **Outcome unknown**; do not interpret it as a pass. After reset,
HEAD was `5370687` and `/tmp/ffs-env.sh` and previous logs were gone.

```bash
cd /home/user/firefighter-station-20260801
# Restored only the tracked session branch, not a new branch:
git fetch origin arena/a9dfd881-firefighter-station-20260801
git merge --ff-only FETCH_HEAD
# HEAD 3bac13c4; tree clean; draft PR #12 still open.
```

The successful bootstrap was written to `/tmp/stage5-setup.sh`, checked with
`bash -n /tmp/stage5-setup.sh`, and launched with
`bash /tmp/stage5-setup.sh > /tmp/stage5-setup.log 2>&1` via `start_process`
(`rust-test-environment-a83d2c08`, exit 0). The **exact commands executed** by
that script, including install order, are:

```bash
set -euxo pipefail
cd /home/user/firefighter-station-20260801
npm install --no-save --no-audit --no-fund typescript@5.9.3
npm install --prefix /tmp/rust-1.88 @rustbin/rustc-1.88.0-x86_64-unknown-linux-gnu @rustbin/cargo-1.88.0-x86_64-unknown-linux-gnu @rustbin/rust-std-1.88.0-x86_64-unknown-linux-gnu
for pkg in rustc cargo rust-std; do (cd /tmp/rust-1.88/node_modules/@rustbin/${pkg}-1.88.0-x86_64-unknown-linux-gnu && ./install.sh --prefix=/tmp/rust-1.88 --disable-ldconfig); done
dpkg-deb -x ffs-sysdeps/libssl-dev_3.0.22-1~deb12u2_amd64.deb /tmp/ffs-openssl
cp -n /tmp/ffs-openssl/usr/include/x86_64-linux-gnu/openssl/*.h /tmp/ffs-openssl/usr/include/openssl/
npm run vendor:repair
python3 -m venv /tmp/pgvenv
/tmp/pgvenv/bin/pip install pgserver
/tmp/pgvenv/bin/python - <<'PY'
import pgserver
pgserver.get_server('/tmp/pgdata')
PY
PGBIN=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/bin
$PGBIN/pg_ctl -D /tmp/pgdata -l /tmp/pg.log -o "-k /tmp/pgdata -c listen_addresses=127.0.0.1 -p 5432" start
EXT=/tmp/pgvenv/lib/python3.11/site-packages/pgserver/pginstall/share/postgresql/extension
cat > "$EXT/pgcrypto.control" <<'PG'
comment = 'sandbox pgcrypto shim: gen_random_bytes for test schema'
default_version = '1.3'
module_pathname = '$libdir/pgcrypto'
relocatable = true
PG
cat > "$EXT/pgcrypto--1.3.sql" <<'PG'
CREATE OR REPLACE FUNCTION gen_random_bytes(n integer) RETURNS bytea
LANGUAGE sql VOLATILE AS $$
  SELECT decode(string_agg(substr(md5(random()::text || clock_timestamp()::text || g::text), 1, 2), ''), 'hex')
  FROM generate_series(1, n) AS g
$$;
PG
$PGBIN/psql -h 127.0.0.1 -U postgres -d postgres -c 'CREATE DATABASE breakglass_test;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d template1 -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d breakglass_test -c 'CREATE EXTENSION IF NOT EXISTS pgcrypto;'
$PGBIN/psql -h 127.0.0.1 -U postgres -d breakglass_test -v ON_ERROR_STOP=1 -f setup/sql/001_schema.sql
# Write /tmp/ffs-env.sh exporting Rust 1.88 PATH, /tmp/ffs-cargo-target,
# OpenSSL paths, RUSTC_BOOTSTRAP=1, CARGO_INCREMENTAL=0, debug=0,
# RUSTFLAGS='-Zcrate-attr=feature(const_eq_ignore_ascii_case,stdarch_x86_avx512,avx512_target_feature)',
# TEST_DATABASE_URL and DATABASE_URL as listed above.
/tmp/rust-1.88/bin/cargo --version
# cargo 1.88.0
```

No bootstrap command in this Stage 5 reset failed. Follow-up GitNexus:

```bash
npx --yes gitnexus@1.6.12 analyze --index-only > /tmp/stage5-graph.log 2>&1
# exit 0; 22,227 nodes, 53,229 edges, 725 flows; FTS download failed
# because that host is blocked, indexing completed without full-text search.
node .gitnexus/run.cjs impact build_app --direction upstream --repo .
# LOW, one upstream caller main; zero indexed affected processes.
node .gitnexus/run.cjs impact req_can_view --direction upstream --repo .
# LOW, get_request and resolve_direct_link callers; reused, not changed.
node .gitnexus/run.cjs query 'multipart custody exception request validation' --repo .
# No definitions (FTS unavailable); used direct source/impact inspection.
```

A **failed inspection** used `x['files']` on
`test/rust/legacy-assertion-inventory.json` and raised `KeyError: 'files'`;
corrected to `x['suites']`, then enumerated all 14 custody assertion IDs.
The corrected command was:

```bash
python3 - <<'PY'
import json
x=json.load(open('test/rust/legacy-assertion-inventory.json'))
for f in x['suites']:
 if 'custody_exception_guards' in f['file']:
  for a in f['assertions']: print(a['id'], a.get('line'), a.get('excerpt'))
PY
```

Focused Rust test invocation after implementing Stage 5A:

```bash
source /tmp/ffs-env.sh
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused.log 2>&1
# Started via start_process stage-5-custody-http-tests-90bcece7; see result below.
```

Stage 5A build/test failures and corrections (all commands were executed with
`source /tmp/ffs-env.sh` and `--offline --ignore-rust-version`):

```bash
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused.log 2>&1
# EXIT 101: E0599 query_one not found; imported sea_orm::ConnectionTrait.
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-rerun.log 2>&1
# EXIT 101: TestApp has no cleanup(); corrected to close().
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-rerun2.log 2>&1
# EXIT 101: isolated test database had no users relation; added prepare(&app).
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-rerun3.log 2>&1
# Started via start_process stage-5-custody-http-tests-b994a663; result pending.
```

```bash
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-rerun3.log 2>&1
# EXIT 101: submitted request got 403 because fixture used vendor submitter
# as system owner; corrected to distinct admin, agency owner, vendor submitter.
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-rerun4.log 2>&1
# Started via start_process stage-5-custody-http-tests-933bed9f; result below.
```

```bash
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-rerun4.log 2>&1
# EXIT 101: 403 twofa_required on submit. Diagnostic rerun below identified cause.
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-diagnostic.log 2>&1
# EXIT 101: same 403; diagnostic body showed twofa_required; fixture now
# enrolls submitter in 2FA so login_user verifies session normally.
cargo test --offline --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-rerun5.log 2>&1
# EXIT 0: 1/1 HTTP test passed, all 14 frozen assertions reached; a temporary
# diagnostic logged the fixture submit response including generated key
# material in /tmp/stage5-focused-rerun5.log; log is ephemeral and MUST NOT
# be committed. Removed the diagnostic from source immediately.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites custody_exception_guards -- --nocapture > /tmp/stage5-focused-final.log 2>&1
# Started after removal via start_process stage-5-custody-verification-9aabcebd;
# result recorded below.
```

Final Stage 5A focused rerun after removing the diagnostic: **exit 0**, 1/1
tests, 190 filtered, all 14 frozen assertions reached. The temporary output
from the earlier successful diagnostic run was confined to `/tmp` and is not
tracked or copied into any artifact. Map/parity checker commands:

```bash
node scripts/build-porting-workboard.mjs
# 114 suites, 4,272 frozen assertions; 2,733 annotated IDs; wave 5 = 14/59.
node scripts/check-assert-parity.mjs > /tmp/stage5-parity.log
# 2,733/4,272; 1,539 missing; zero unannotated; strict completion still red.
node scripts/check-rust-test-map.mjs > /tmp/stage5-map.log
# exit 0: all 114 suites accounted for.
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage5-detect.log 2>&1
# exit 0, LOW; 9 tracked files, 11 symbols, zero indexed affected processes;
# untracked new custody modules not included in this initial diff scan.
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites decision_validation -- --nocapture > /tmp/stage5-request-regression.log 2>&1
# started via start_process stage-5-request-regression-337509e9; result below.
```

Stage 5A targeted request regression: `decision_validation` **exit 0, 1/1**
(61.54s), running the real Rust server and isolated Postgres. Stage 5A has
**not** received a fresh full-workspace run; the latest complete full pass is
the pre-4B5 187/187 run. Neither the lost 4B5 run nor any LocalStack run is
claimed as passed. The staged scan also returned LOW (11 files, 11 indexed
symbols, zero indexed affected processes); absence of indexed flows is not
proof of no impact, especially with FTS unavailable.

## Stage 5B custody configuration (2026-10-30)

No sandbox reset or initialization was needed: `/tmp/ffs-env.sh`, Rust 1.88,
vendor sources and Postgres from the preceding Stage 5A recovery still worked.
Before changing existing `admin/systems.rs` methods, the commands were:

```bash
node .gitnexus/run.cjs impact update_system --direction upstream --repo .
node .gitnexus/run.cjs impact list_systems --direction upstream --repo .
# Both UNKNOWN (zero indexed callers); graph was one commit behind HEAD.
# Direct route and caller searches confirmed both are live HTTP handlers.
node .gitnexus/run.cjs impact system_full_json --direction upstream --repo .
# LOW; indexed caller create_system; update_system also calls this helper,
# as direct source inspection showed. FTS remains unavailable.
```

The first focused test found an ordering mismatch in the new read projection:
`ORDER BY stage` selected the `stage::text` alias, so Postgres sorted
alphabetically rather than in custody-enum order. The query was corrected to
`ORDER BY system_custody_stage_configs.stage`. The exact runs:

```bash
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites physical_asset_custody_config -- --nocapture > /tmp/stage5b-focused.log 2>&1
# exit 101: second frozen assertion failed on row order; no build error.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites physical_asset_custody_config -- --nocapture > /tmp/stage5b-focused-rerun.log 2>&1
# exit 0: 1/1 test passed (two frozen assertions); 191 filtered.
node scripts/build-porting-workboard.mjs > /tmp/stage5b-workboard.log
node scripts/check-assert-parity.mjs
# 2,735/4,272 source-mapped, 1,537 missing, zero unannotated.
node scripts/check-rust-test-map.mjs
# exit 0, 114 suites accounted for.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites admin_systems -- --test-threads=1 > /tmp/stage5b-admin-regression.log 2>&1
# Started via start_process admin-system-regression-a625850d; result below.
```

Stage 5B targeted existing admin-system regression completed **exit 0, 2/2**
(`admin_systems` and `admin_systems_update_delete`, 134.25s), against the
updated Rust server and isolated Postgres. After that run, the new custody
configuration parser was tightened to require the two nullable input keys
(`instructions`, `dueInHours`) as the legacy Zod schema does; this tweak has
its own focused rerun:

```bash
node .gitnexus/run.cjs impact create_system --direction upstream --repo .
# UNKNOWN, zero indexed callers (direct route search confirms HTTP handler);
# inspected but deliberately did not edit create_system in this slice.
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites physical_asset_custody_config -- --nocapture > /tmp/stage5b-focused-final.log 2>&1
# Started via start_process custody-configuration-verificati-c8b4623d;
# final result below.
```

Final Stage 5B focused rerun after parser tightening: **exit 0, 1/1** (two
frozen assertions, 191 filtered). No fresh Stage 5B full-workspace result.

Staged graph scan (after adding the new config test and source) was **CRITICAL**:

```bash
git add crates/ffs-server/src/routes/admin/systems.rs crates/ffs-server/tests/ported_suites.rs crates/ffs-server/tests/ported/physical_asset_custody_config.rs test/rust/files.md test/rust/legacy-suite-map.json test/rust/porting-staging-plan.md test/rust/porting-workboard.json test/rust/porting-workboard.md test/rust/sandbox-setup-log.md
git diff --cached --check
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage5b-detect.log 2>&1
# exit 0, 9 files, 14 symbols, 55 indexed affected processes, CRITICAL.
# New helper insertion in admin/systems.rs shifted numerous old function line
# anchors, so the reported changed-symbol list includes untouched helpers.
# Nonetheless this file is a high-use admin surface: focused config test and
# existing admin_systems/admin_systems_update_delete passed; a full workspace
# run has not completed and the broader indexed flow impact remains open.
```

After the Stage 5B commit `5586e561`, a **full workspace** regression ran
against the pushed source (no concurrent source edits). Exact command:

```bash
source /tmp/ffs-env.sh
cargo test --workspace --offline --locked --ignore-rust-version -- --test-threads=4 > /tmp/stage5b-workspace.log 2>&1
# start_process rust-workspace-regression-bee3822e, exit 0.
# ported_suites: 192 passed, 0 failed, 0 ignored (2119.53s).
# All other workspace test targets passed. Opt-in aws_localstack_contract:
# 0 passed, 1 ignored — no LocalStack execution or AWS exchange proof.
```

This confirms a full-workspace regression **after both Stage 4B5 and Stage
5A/5B edits**, unlike the lost 190-test run. It does not change the strict
assertion-parity gate (still 1,537 missing), nor validate ignored LocalStack
contracts. `/tmp/stage5b-workspace.log` is ephemeral and not committed.

## Stage 5C custody approval, read model, issue guard (2026-10-30)

The Stage 5B sandbox persisted; no initialization or recovery command was
needed. HEAD was `db8781da`, tree clean, `/tmp/ffs-env.sh` present. Graph
was three commits behind, so refreshed before editing the request handlers:

```bash
npx --yes gitnexus@1.6.12 analyze --index-only > /tmp/stage5c-graph.log 2>&1
# exit 0: 22,308 nodes, 53,326 edges, 718 flows. FTS still unavailable.
node .gitnexus/run.cjs impact post_owner_decision --direction upstream --repo .
node .gitnexus/run.cjs impact get_request --direction upstream --repo .
node .gitnexus/run.cjs impact post_issue_credential --direction upstream --repo .
# UNKNOWN, no indexed callers: all three are live HTTP handlers in main.rs;
# direct route/source inspection, not the absent graph edges, establishes use.
```

Focused test commands (all ran against real Rust binary and isolated Postgres):

```bash
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites physical_asset_custody_cases -- --nocapture > /tmp/stage5c-focused.log 2>&1
# exit 0, 1/1; approval instantiates two manual cases and live team read model.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites physical_asset_custody_cases -- --nocapture > /tmp/stage5c-focused2.log 2>&1
# exit 0, 1/1; second custody-only request: direct issue 409, status unchanged.
node scripts/build-porting-workboard.mjs > /tmp/stage5c-workboard.log
node scripts/check-assert-parity.mjs
# 2,753/4,272; 1,519 missing; zero unannotated.
```

**Failed bookkeeping attempts, preserved:** first set `rustModule` in the
suite map to a comma-separated pair of Rust files; `node
scripts/check-rust-test-map.mjs` failed (that combined path does not exist).
Setting it to only `physical_asset_custody_cases.rs` also failed (20 mapped
IDs versus 18 in that module). Corrected by grouping the Stage 5B config test
as a nested module inside `physical_asset_custody_cases.rs` and removing the
old standalone test file; the checker now passes with all **20** IDs in one
module. The source rearrangement was retested:

```bash
node scripts/check-rust-test-map.mjs
# exit 0; 114 suites accounted for.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites physical_asset_custody_cases -- --nocapture > /tmp/stage5c-combined.log 2>&1
# exit 0: 2/2 tests passed, 191 filtered. Both config and case slices reached.
```

Stage 5C request-owner targeted regressions after introducing transactional
case creation:

```bash
source /tmp/ffs-env.sh
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites decision_validation -- --test-threads=1 > /tmp/stage5c-decision-regression.log 2>&1
# exit 0: 1/1, 60.63s.
cargo test --offline --locked --ignore-rust-version -p ffs-server --test ported_suites aws_disabled_request_approval_flow -- --test-threads=1 > /tmp/stage5c-aws-regression.log 2>&1
# exit 0: 1/1, 91.75s; no AWS transport executed.
```

Staged impact scan:

```bash
git diff --cached --check
node .gitnexus/run.cjs detect-changes --scope all --repo . > /tmp/stage5c-detect.log 2>&1
# exit 0: 11 files, 7 indexed symbols, 17 affected processes, CRITICAL.
# Owner decision, direct issue and GET request are live request routes;
# targeted regression is green but broad impact requires a full workspace run.
```
