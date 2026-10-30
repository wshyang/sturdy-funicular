// Playwright global setup — runs once before any e2e test/webServer starts.
// Wipes and reseeds the ISOLATED breakglass_test database (never the dev
// database, breakglass) with exactly one known-good active user, so
// login.spec.ts has a real account to log in with. Mirrors
// test/backend/deno/helpers.tsx's wipeDatabase() child-before-
// parent table order, since this runs under Node (via `pg`), not Deno, so it
// can't import that file directly.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// `pg` is a CommonJS module — importing the named export directly fails
// under Node's ESM loader (SyntaxError: Named export 'Client' not found).
import pg from 'pg';
import type { FullConfig } from '@playwright/test';

const { Client } = pg;

const PORT_OFFSET = Number(process.env['E2E_STACK_ID'] ?? 0) * 10000;
const E2E_DB_URL = process.env['E2E_DB_URL'] ??
  `postgres://postgres:postgres@localhost:${5432 + PORT_OFFSET}/breakglass_test`;

// Must match server/utils.tsx's generateSalt()/hashPassword() exactly — a
// per-user random salt (32 random bytes hex → 64 chars) and a stored hash of
// SHA-256(password + salt), hex-encoded. See addendum-045-per-user-password-
// salt.md (and addendum-004 for why this is SHA-256, not bcrypt).
function generateSalt(): string {
  return randomBytes(32).toString('hex');
}
function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(password + salt).digest('hex');
}

export const E2E_USER_EMAIL = 'e2e-user@test.local';
export const E2E_USER_PASSWORD = 'E2ePassword!2026';

// The fixture user is seeded UN-enrolled (no totp_secret). Every e2e login
// therefore goes through the REAL 2FA flow with no out-of-band secret: the
// first login for any user hits the enrollment modal, and e2e/helpers/ui.ts's
// completeTwoFactor() decodes that user's own QR from its rendered pixels to
// recover the secret (persisting it to a disk store so later logins can
// verify against it). No hardcoded/seeded secret exists anywhere — the secret
// is only ever the one the browser was shown. See addendum-046-totp-2fa.md.

const CLEAR_TABLES = [
  'audit_log',
  'access_log',
  // Append-only outbox — notification_templates/email_templates deliberately
  // NOT wiped (seeded config, like schema_migrations).
  'notification_deliveries',
  'sent_notifications',
  'external_identities',
  // Addendum-144 normalized custody children (all RESTRICT for traceability).
  'asset_custody_exception_evidence_files',
  'asset_custody_event_evidence_files',
  'asset_custody_exception_checks',
  'asset_custody_exceptions',
  'asset_custody_handoffs',
  'asset_custody_events',
  'request_asset_custody_cases',
  'request_asset_custody_run_items',
  'system_custody_stage_configs',
  // request_credential_items references assets (ON DELETE CASCADE), so clear
  // credential items before assets.
  'request_credential_items',
  'request_approval_steps',
  // request_key_material FKs to breakglass_requests — clear before requests.
  'request_key_material',
  // request_asset_custody_runs.system_id → systems RESTRICT; must clear runs
  // before systems. Steps CASCADE from runs (auto-handled).
  'request_asset_custody_runs',
  'aws_tenant_exchanges',
  'breakglass_requests',
  'system_owner_pa_mappings',
  'team_system_mappings',
  'system_delegates',
  'system_owners',
  // assets FKs to systems — clear after request_credential_items, before systems.
  'assets',
  'systems',
  'team_memberships',
  'teams',
  'clusters',
  // Formerly kv_store blobs, now typed tables (addendum-048) — no FK
  // dependents, safe to clear anywhere.
  'request_number_sequences',
  'entra_auth_states',
  'entra_handoffs',
  // Admin-invite signup tokens (addendum-051) — FK to users, cleared first.
  'user_invites',
  // Opaque email direct-link mappings (addendum-059) — created_by FK is
  // ON DELETE RESTRICT, so leftover rows from a prior run block the users
  // wipe below unless cleared first.
  'link_mappings',
  // Bearer-token sessions (addendum-047) — FK-reference users ON DELETE
  // CASCADE; cleared before the users wipe (which is WHERE NOT is_system).
  'sessions',
  'login_attempts',
  'slack_auth_states',
  'idempotency_tokens',
  'job_runs',
  // user_admin_role_grants.organization_id → organizations RESTRICT; must be
  // cleared before organizations. Also references users (user_id).
  'user_admin_role_grants',
  // organizations.created_by → users RESTRICT; must be cleared before users.
  // CASCADE from organizations handles: org_memberships, org_app_settings,
  // org_notification_templates (no explicit entry needed for those).
  'organizations',
  'users',
];

// Screenshot-count self-check (Pending Refinements.md item 9 follow-on):
// records how many files already exist in test_output/e2e/screenshots/
// BEFORE this run generates any more, so screenshot-count.spec.ts (run
// last, via a dependent Playwright project — see playwright.config.ts) can
// compute how many were generated DURING this run, not assume the
// directory started empty. Written to disk, not an in-memory/env value,
// since globalSetup and the worker process running the actual specs don't
// reliably share state. All run artifacts live under test_output/ so the
// repo root and e2e/ stay clean of gitignored output — see
// addendum-052-test-output-consolidation.md.
const SCREENSHOT_DIR = join(process.cwd(), 'test_output', 'e2e', 'screenshots');
const BASELINE_FILE = join(process.cwd(), 'test_output', 'e2e', '.screenshot-baseline.json');

function recordScreenshotBaseline(): void {
  mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const count = readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith('.png')).length;
  writeFileSync(BASELINE_FILE, JSON.stringify({ count }));
}

export default async function globalSetup(_config: FullConfig) {
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    // users is special-cased: the two reserved system-actor rows
    // (SYSTEM_USER_ID/UNKNOWN_USER_ID) are permanent and a DB-level trigger
    // rejects any DELETE against them — see
    // addendum-041-uuidv7-and-object-lifecycle-traceability.md and
    // server/tests/helpers.tsx's wipeDatabase() for the same fix.
    for (const table of CLEAR_TABLES) {
      if (table === 'users') {
        await client.query(`DELETE FROM users WHERE NOT is_system`);
      } else {
        await client.query(`DELETE FROM ${table}`);
      }
    }

    const e2eSalt = generateSalt();
    const e2eUserId = randomUUID();
    // 'admin' is no longer an affiliation — the E2E superadmin is an agency
    // user whose admin rights come from a full_admin grant (role id …006,
    // seeded by 001_schema.sql). granted_by is the reserved SYSTEM_USER_ID.
    await client.query(
      `INSERT INTO users (id, full_name, email, password_hash, password_salt, affiliation, status, approved_at)
       VALUES ($1, $2, $3, $4, $5, 'agency', 'active', now())`,
      [e2eUserId, 'E2E Test User', E2E_USER_EMAIL, hashPassword(E2E_USER_PASSWORD, e2eSalt), e2eSalt],
    );
    await client.query(
      `INSERT INTO user_admin_role_grants (id, user_id, role_key, granted_by, granted_at)
       VALUES ($1, $2, 'full_admin', '00000000-0000-7000-8000-000000000001', now())`,
      [randomUUID(), e2eUserId],
    );
  } finally {
    await client.end();
  }

  recordScreenshotBaseline();

  // Clear any TOTP secrets remembered by a previous run — the DB was just
  // wiped, so every prior enrollment secret is now stale. Each user re-enrolls
  // (and its secret is re-decoded from the QR) on its first login this run.
  // See e2e/helpers/totp.ts.
  const stackId = process.env['E2E_STACK_ID'] ?? '0';
  rmSync(join(process.cwd(), 'test_output', 'e2e', `.totp-secrets-${stackId}.json`), { force: true });

  // Warm up the backend server's DB connection pool so the first few tests
  // don't incur cold-start latency on their DB queries. The webServer is
  // already confirmed healthy by Playwright before globalSetup runs, so
  // this fetch reliably establishes the pool rather than racing the server.
  // /auth/me is used (rather than /health) because it queries the sessions
  // table synchronously, guaranteeing at least one pool connection is open
  // before the first test fires.
  const backendPort = 8789 + PORT_OFFSET;
  try {
    await Promise.all([
      fetch(`http://localhost:${backendPort}/auth/me`),
      fetch(`http://localhost:${backendPort}/auth/me`),
      fetch(`http://localhost:${backendPort}/auth/me`),
    ]);
  } catch { /* non-fatal */ }
}
