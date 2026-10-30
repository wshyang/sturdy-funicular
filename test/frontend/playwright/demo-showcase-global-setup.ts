// Demo-showcase global setup.
//
// Playwright starts webServer BEFORE globalSetup. The DEMO backend applies
// 003_seed_demo_live.sql on startup (ON CONFLICT DO NOTHING), so the standard
// globalSetup — which only wipes — destroys the demo seed immediately after
// the backend laid it down. This file wipes the database and then re-applies
// the demo seed so tests always start from a clean, known-good DEMO state.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { FullConfig } from '@playwright/test';

const { Client } = pg;

const PORT_OFFSET = Number(process.env['E2E_STACK_ID'] ?? 0) * 10000;
const E2E_DB_URL = process.env['E2E_DB_URL'] ??
  `postgres://postgres:postgres@localhost:${5432 + PORT_OFFSET}/breakglass_test`;

// Same child-before-parent order as global-setup.ts — FK rationale preserved.
const CLEAR_TABLES = [
  'audit_log',
  'access_log',
  'notification_deliveries',
  'sent_notifications',
  'external_identities',
  'asset_custody_exception_evidence_files',
  'asset_custody_event_evidence_files',
  'asset_custody_exception_checks',
  'asset_custody_exceptions',
  'asset_custody_handoffs',
  'asset_custody_events',
  'request_asset_custody_cases',
  'request_asset_custody_run_items',
  'system_custody_stage_configs',
  'request_credential_items',
  'request_approval_steps',
  'request_key_material',
  'request_asset_custody_runs',
  'aws_tenant_exchanges',
  'breakglass_requests',
  'system_owner_pa_mappings',
  'team_system_mappings',
  'system_delegates',
  'system_owners',
  'assets',
  'systems',
  'team_memberships',
  'teams',
  'clusters',
  'request_number_sequences',
  'entra_auth_states',
  'entra_handoffs',
  'user_invites',
  'link_mappings',
  'sessions',
  'login_attempts',
  'slack_auth_states',
  'idempotency_tokens',
  'job_runs',
  // user_admin_role_grants.organization_id → organizations RESTRICT; must be
  // cleared before organizations. Also references users (user_id).
  'user_admin_role_grants',
  // organizations.created_by → users RESTRICT; must be cleared before users.
  'organizations',
  'users',
];

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
    for (const table of CLEAR_TABLES) {
      if (table === 'users') {
        await client.query(`DELETE FROM users WHERE NOT is_system`);
      } else {
        await client.query(`DELETE FROM ${table}`);
      }
    }
  } finally {
    await client.end();
  }

  // Re-apply the demo seed now that the database is clean. Read the SQL file
  // and execute it via the pg client (node-postgres supports multi-statement
  // queries via the simple query protocol). The seed is idempotent but the
  // wipe above means every row is fresh.
  const seedPath = join(process.cwd(), 'setup', 'sql', '003_seed_demo_live.sql');
  const seedSql = readFileSync(seedPath, 'utf8');
  const seedClient = new Client({ connectionString: E2E_DB_URL });
  await seedClient.connect();
  try {
    await seedClient.query(seedSql);
  } finally {
    await seedClient.end();
  }

  recordScreenshotBaseline();

  // Clear TOTP secrets from prior runs — demo users have no pre-seeded secret,
  // so each run re-enrolls through the QR modal on first login.
  rmSync(join(process.cwd(), 'test_output', 'e2e', '.totp-secrets.json'), { force: true });
}
