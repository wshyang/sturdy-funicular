// Global setup for the admin-capabilities Playwright suite (addendum-066).
//
// Runs the base global-setup (DB wipe + single e2e user seed + TOTP clear)
// then seeds the capability test users with their admin roles, so the specs
// can log in as super.admin@test.local, user.admin@test.local, etc.
//
// Test users are seeded with correctly hashed passwords using the same
// SHA-256(password + salt) scheme as the rest of the app (server/utils.tsx).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import type { FullConfig } from '@playwright/test';

// Run the base global-setup first (wipes DB, seeds e2e user, clears TOTP).
import baseGlobalSetup from '../global-setup';

const { Client } = pg;

const PORT_OFFSET = Number(process.env.E2E_STACK_ID ?? 0) * 10000;
const E2E_DB_URL = process.env.E2E_DB_URL ??
  `postgres://postgres:postgres@localhost:${5432 + PORT_OFFSET}/breakglass_test`;

function generateSalt(): string {
  return randomBytes(32).toString('hex');
}
function hashPassword(password: string, salt: string): string {
  return createHash('sha256').update(password + salt).digest('hex');
}

// Capability test users matching capability-users.ts definitions.
// status 'active' + approved_at so they can log in immediately.
const CAPABILITY_TEST_USERS = [
  { email: 'super.admin@test.local', password: 'SuperAdmin!2026', fullName: 'Super Administrator', affiliation: 'agency', roles: ['full_admin'] },
  { email: 'user.admin@test.local', password: 'UserAdmin!2026', fullName: 'User Administrator', affiliation: 'agency', roles: ['user_admin'] },
  { email: 'org.admin@test.local', password: 'OrgAdmin!2026', fullName: 'Organization Administrator', affiliation: 'agency', roles: ['org_structure_admin'] },
  { email: 'systems.admin@test.local', password: 'SystemsAdmin!2026', fullName: 'Systems Administrator', affiliation: 'agency', roles: ['systems_assets_admin'] },
  { email: 'data.operator@test.local', password: 'DataOperator!2026', fullName: 'Data Operator', affiliation: 'agency', roles: ['data_operator'] },
  { email: 'config.admin@test.local', password: 'ConfigAdmin!2026', fullName: 'Configuration Administrator', affiliation: 'agency', roles: ['config_audit_admin'] },
  { email: 'regular.user@test.local', password: 'RegularUser!2026', fullName: 'Regular User', affiliation: 'agency', roles: [] },
  { email: 'pending.user@test.local', password: 'PendingUser!2026', fullName: 'Pending User', affiliation: 'agency', roles: [], status: 'pending_approval' },
  { email: 'user.org.admin@test.local', password: 'UserOrgAdmin!2026', fullName: 'User and Org Administrator', affiliation: 'agency', roles: ['user_admin', 'org_structure_admin'] },
  { email: 'full.admin.except.audit@test.local', password: 'FullAdminExceptAudit!2026', fullName: 'Full Admin Except Audit', affiliation: 'agency', roles: ['full_admin'] },
] as const;

async function seedCapabilityUsers(client: pg.Client): Promise<void> {
  // Upsert admin roles with their CURRENT capability arrays (mirrors 001_schema.sql).
  // ON CONFLICT DO UPDATE ensures stale DB rows (from an older schema run) are
  // refreshed — without this, getRoleCapabilities() finds dbCaps.length > 0 and
  // returns the stale set, hiding capabilities like SystemRead from the UI.
  const roleSeeds: [string, string, string, string, string[]][] = [
    ['00000000-0000-0000-0000-000000000001', 'user_admin', 'User Administrator', 'Manage user accounts, approvals, and lifecycle operations',
      ['UserRead','UserInvite','UserApprove','UserReject','UserTombstone','UserUntombstone','UserAffiliationChange','UserResetTwofa','UserResetPassword']],
    ['00000000-0000-0000-0000-000000000002', 'org_structure_admin', 'Cluster & Team Structure Administrator', 'Manage clusters, teams, and team memberships',
      ['OrgRead','OrgCreate','OrgUpdate','OrgDelete','ClusterRead','ClusterCreate','ClusterUpdate','ClusterDelete','TeamRead','TeamCreate','TeamUpdate','TeamDelete','TeamMemberRead','TeamMemberManage']],
    ['00000000-0000-0000-0000-000000000003', 'systems_assets_admin', 'Systems & Assets Administrator', 'Manage systems, assets, and their mappings',
      ['SystemRead','SystemCreate','SystemUpdate','SystemDelete','SystemMappingRead','SystemMappableTeamsRead','SystemOwnerManage','TeamSystemMappingManage','OwnerPAMappingManage','AssetRead','AssetCreate','AssetUpdate','AssetDelete','AssetSync']],
    ['00000000-0000-0000-0000-000000000004', 'data_operator', 'Data Operator', 'Perform data operations including exports, imports, and resets',
      ['DataExport','DataImport','DataResetSeed','RequestAdminReset']],
    ['00000000-0000-0000-0000-000000000005', 'config_audit_admin', 'Configuration & Audit Administrator', 'Manage application settings, email templates, and view audit logs',
      ['ConfigAppSettingsRead','ConfigAppSettingsWrite','ConfigEmailTemplateRead','ConfigEmailTemplateWrite','AuditLogRead','AuditAccessLogRead','AuditSentNotificationsRead','OrgAppSettingsRead','OrgAppSettingsWrite','OrgTemplateRead','OrgTemplateWrite']],
    ['00000000-0000-0000-0000-000000000006', 'full_admin', 'Full Administrator', 'Full access to all admin capabilities and role management',
      ['UserRead','UserInvite','UserApprove','UserReject','UserTombstone','UserUntombstone','UserAffiliationChange','UserResetTwofa','UserResetPassword','ClusterRead','ClusterCreate','ClusterUpdate','ClusterDelete','TeamRead','TeamCreate','TeamUpdate','TeamDelete','TeamMemberRead','TeamMemberManage','SystemRead','SystemCreate','SystemUpdate','SystemDelete','SystemMappingRead','SystemMappableTeamsRead','SystemOwnerManage','TeamSystemMappingManage','OwnerPAMappingManage','AssetRead','AssetCreate','AssetUpdate','AssetDelete','AssetSync','DataExport','DataImport','DataResetSeed','RequestAdminReset','ConfigAppSettingsRead','ConfigAppSettingsWrite','ConfigEmailTemplateRead','ConfigEmailTemplateWrite','AuditLogRead','AuditAccessLogRead','AuditSentNotificationsRead','AdminRolesManage','ConfigAppSettingsBulkTransfer','OrgRead','OrgCreate','OrgUpdate','OrgDelete','OrgAppSettingsRead','OrgAppSettingsWrite','OrgTemplateRead','OrgTemplateWrite']],
  ];
  for (const [id, key, name, description, capabilities] of roleSeeds) {
    await client.query(
      `INSERT INTO admin_roles (id, key, name, description, is_system_role, capabilities, created_at, updated_at)
       VALUES ($1, $2, $3, $4, TRUE, $5, now(), now())
       ON CONFLICT (id) DO UPDATE SET
         name = EXCLUDED.name,
         description = EXCLUDED.description,
         capabilities = EXCLUDED.capabilities,
         updated_at = now()`,
      [id, key, name, description, capabilities],
    );
  }

  for (const user of CAPABILITY_TEST_USERS) {
    const userId = randomUUID();
    const salt = generateSalt();
    const hash = hashPassword(user.password, salt);
    const status = ('status' in user && user.status) ? user.status : 'active';
    const approvedAt = status === 'active' ? 'now()' : 'NULL';

    // Insert user (base global-setup already wiped users, so no conflicts).
    await client.query(
      `INSERT INTO users (id, full_name, email, password_hash, password_salt, affiliation, status, approved_at, is_system, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::user_status, ${approvedAt}, FALSE, now(), now())`,
      [userId, user.fullName, user.email, hash, salt, user.affiliation, status],
    );

    // Grant roles. The granting user is itself (self-grant for test setup).
    for (const roleKey of user.roles) {
      await client.query(
        `INSERT INTO user_admin_role_grants (id, user_id, role_key, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT DO NOTHING`,
        [randomUUID(), userId, roleKey, userId],
      );
    }
  }

  console.log(`[admin-capabilities global-setup] Seeded ${CAPABILITY_TEST_USERS.length} capability test users.`);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  // Step 1: Base setup — wipes DB, seeds the regression e2e user, clears TOTP store.
  await baseGlobalSetup(config);

  // Step 2: Seed capability test users on top of the clean DB.
  const client = new Client({ connectionString: E2E_DB_URL });
  await client.connect();
  try {
    await seedCapabilityUsers(client);
  } finally {
    await client.end();
  }

  // Step 3: Clear any stale TOTP secrets for the capability users from a prior run
  // (base global-setup already cleared the shared store, but do it explicitly here too).
  rmSync(join(process.cwd(), 'test_output', 'e2e', '.totp-secrets.json'), { force: true });
}
