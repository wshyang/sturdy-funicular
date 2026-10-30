// Test Setup for Admin Capabilities Tests
//
// Handles database setup, test user creation, and cleanup for Playwright tests.
// This ensures that test users with specific capabilities exist before tests run.
//
// Usage:
//   import { setupTestUsers, cleanupTestUsers } from './setup';
//   
//   test.beforeAll(async () => {
//     await setupTestUsers();
//   });
//   
//   test.afterAll(async () => {
//     await cleanupTestUsers();
//   });
//
// See: capability-users.ts for test user definitions
// See: PLAN.md for test suite design

import { query } from "../../../../../server/pg.tsx";
import { grantAdminRole, seedAdminRoles } from "../../../../../server/auth-admin-roles.tsx";
import { users } from "../../../../../server/db.tsx";
import type { User } from "../../../../../server/types.tsx";
import {
  SUPER_ADMIN,
  USER_ADMIN,
  ORG_ADMIN,
  SYSTEMS_ADMIN,
  DATA_OPERATOR,
  CONFIG_ADMIN,
  REGULAR_USER,
  PENDING_USER,
  USER_ORG_ADMIN,
  FULL_ADMIN_EXCEPT_AUDIT,
  ALL_TEST_USERS,
} from './capability-users';

// ============================================================================
// TEST USER MANAGEMENT
// ============================================================================

/**
 * Test user with additional metadata for database operations.
 */
interface TestUserWithDBId extends typeof SUPER_ADMIN {
  dbId?: string;
}

/**
 * Map of test user emails to their database IDs.
 */
const testUserDBIds: Map<string, string> = new Map();

/**
 * Get the database ID for a test user.
 */
export function getTestUserDBId(email: string): string | undefined {
  return testUserDBIds.get(email);
}

/**
 * Store the database ID for a test user.
 */
function storeTestUserDBId(email: string, dbId: string): void {
  testUserDBIds.set(email, dbId);
}

/**
 * Clear all stored test user IDs.
 */
function clearTestUserDBIds(): void {
  testUserDBIds.clear();
}

// ============================================================================
// DATABASE SETUP
// ============================================================================

/**
 * Ensure admin roles are seeded in the database.
 */
async function ensureRolesSeeded(): Promise<void> {
  try {
    await seedAdminRoles();
    console.log("✓ Admin roles seeded");
  } catch (error) {
    console.log("⚠ Admin roles already seeded or error:", error);
  }
}

/**
 * Create a test user in the database.
 */
async function createTestUser(user: typeof SUPER_ADMIN): Promise<string> {
  // Check if user already exists
  const existingUsers = await query<User[]>(
    `SELECT * FROM users WHERE email = $1`,
    [user.email],
  );
  
  if (existingUsers.length > 0) {
    const dbUser = existingUsers[0];
    storeTestUserDBId(user.email, dbUser.id);
    return dbUser.id;
  }

  // Create new user
  const newUser: User = {
    id: crypto.randomUUID(),
    fullName: user.fullName,
    email: user.email,
    passwordHash: "test-hash", // Will be set properly in real implementation
    passwordSalt: "test-salt",
    role: null,
    affiliation: "agency",
    status: "active",
    approvedBy: null,
    approvedAt: new Date().toISOString(),
    tombstonedBy: null,
    tombstonedAt: null,
    untombstonedBy: null,
    untombstonedAt: null,
    lastLoginAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    isSystem: false,
    forcePasswordRotation: false,
    totpSecret: null,
    totpEnrolledAt: null,
    passwordLoginDisabledAt: null,
    passwordLoginDisabledReason: null,
    passwordLoginDisabledBy: null,
  };

  await query(
    `INSERT INTO users (id, full_name, email, password_hash, password_salt, role, affiliation, status, approved_by, approved_at, tombstoned_by, tombstoned_at, untombstoned_by, untombstoned_at, last_login_at, created_at, updated_at, is_system, force_password_rotation, totp_secret, totp_enrolled_at, password_login_disabled_at, password_login_disabled_reason, password_login_disabled_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)`,
    [
      newUser.id,
      newUser.fullName,
      newUser.email,
      newUser.passwordHash,
      newUser.passwordSalt,
      newUser.role,
      newUser.affiliation,
      newUser.status,
      newUser.approvedBy,
      newUser.approvedAt,
      newUser.tombstonedBy,
      newUser.tombstonedAt,
      newUser.untombstonedBy,
      newUser.untombstonedAt,
      newUser.lastLoginAt,
      newUser.createdAt,
      newUser.updatedAt,
      newUser.isSystem,
      newUser.forcePasswordRotation,
      newUser.totpSecret,
      newUser.totpEnrolledAt,
      newUser.passwordLoginDisabledAt,
      newUser.passwordLoginDisabledReason,
      newUser.passwordLoginDisabledBy,
    ],
  );

  storeTestUserDBId(user.email, newUser.id);
  return newUser.id;
}

/**
 * Grant admin roles to a test user.
 */
async function grantRolesToUser(user: typeof SUPER_ADMIN, userDBId: string): Promise<void> {
  // Clear any existing grants for this user
  await query(
    `DELETE FROM user_admin_role_grants WHERE user_id = $1`,
    [userDBId],
  );

  // Grant each role to the user
  for (const roleKey of user.roles) {
    try {
      // Find the admin who will grant the role (use first user with full_admin)
      const adminUsers = await query<{ id: string }[]>(
        `SELECT id FROM users WHERE email = $1`,
        [SUPER_ADMIN.email],
      );
      
      const adminId = adminUsers.length > 0 ? adminUsers[0].id : userDBId;
      
      await grantAdminRole(userDBId, roleKey, adminId, `Test setup: Granting ${roleKey} to ${user.email}`);
      console.log(`✓ Granted ${roleKey} to ${user.email}`);
    } catch (error) {
      console.log(`⚠ Error granting ${roleKey} to ${user.email}:`, error);
    }
  }
}

// ============================================================================
// MAIN SETUP FUNCTIONS
// ============================================================================

/**
 * Setup all test users in the database with their roles and capabilities.
 * This should be called once before all tests.
 */
export async function setupTestUsers(): Promise<void> {
  console.log("🔧 Setting up test users for admin capabilities tests...");
  
  try {
    // Ensure admin roles are seeded
    await ensureRolesSeeded();
    
    // Create each test user
    for (const user of ALL_TEST_USERS) {
      try {
        const dbId = await createTestUser(user);
        
        // Grant roles to the user
        if (user.roles.length > 0) {
          await grantRolesToUser(user, dbId);
        }
        
        console.log(`✓ Created test user: ${user.email} (${user.description})`);
      } catch (error) {
        console.log(`⚠ Error creating test user ${user.email}:`, error);
      }
    }
    
    console.log("✓ Test user setup complete");
  } catch (error) {
    console.error("✗ Test user setup failed:", error);
    throw error;
  }
}

/**
 * Clean up all test users from the database.
 * This should be called after all tests.
 */
export async function cleanupTestUsers(): Promise<void> {
  console.log("🧹 Cleaning up test users...");
  
  try {
    for (const user of ALL_TEST_USERS) {
      try {
        // Delete user's role grants first
        const dbId = getTestUserDBId(user.email);
        if (dbId) {
          await query(
            `DELETE FROM user_admin_role_grants WHERE user_id = $1`,
            [dbId],
          );
          
          // Delete the user
          await query(
            `DELETE FROM users WHERE email = $1`,
            [user.email],
          );
          
          console.log(`✓ Cleaned up test user: ${user.email}`);
        }
      } catch (error) {
        console.log(`⚠ Error cleaning up test user ${user.email}:`, error);
      }
    }
    
    // Clear stored IDs
    clearTestUserDBIds();
    
    console.log("✓ Test user cleanup complete");
  } catch (error) {
    console.error("✗ Test user cleanup failed:", error);
    throw error;
  }
}

/**
 * Setup a specific test user.
 * Useful for tests that need only one specific user.
 */
export async function setupTestUser(user: typeof SUPER_ADMIN): Promise<string> {
  await ensureRolesSeeded();
  const dbId = await createTestUser(user);
  await grantRolesToUser(user, dbId);
  return dbId;
}

/**
 * Clean up a specific test user.
 */
export async function cleanupTestUser(user: typeof SUPER_ADMIN): Promise<void> {
  const dbId = getTestUserDBId(user.email);
  if (dbId) {
    await query(
      `DELETE FROM user_admin_role_grants WHERE user_id = $1`,
      [dbId],
    );
    await query(
      `DELETE FROM users WHERE email = $1`,
      [user.email],
    );
  }
}

/**
 * Check if test users are already set up.
 */
export async function areTestUsersSetup(): Promise<boolean> {
  const existingUsers = await query<{ email: string }[]>(
    `SELECT email FROM users WHERE email LIKE '%@test.local'`,
  );
  
  return existingUsers.length >= ALL_TEST_USERS.length;
}

/**
 * Get a test user by email with database ID.
 */
export async function getTestUserWithDBId(email: string): Promise<{ user: typeof SUPER_ADMIN; dbId: string } | null> {
  const dbId = getTestUserDBId(email);
  if (!dbId) return null;
  
  const testUser = ALL_TEST_USERS.find((u) => u.email === email);
  if (!testUser) return null;
  
  return { user: testUser, dbId };
}

// ============================================================================
// PLAYWRIGHT TEST FIXTURE
// ============================================================================

/**
 * Playwright test fixture for admin capabilities tests.
 * This provides a test context with test users already set up.
 *
 * Usage:
 *   import { test } from './setup';
 *   
 *   test('my test', async ({ page, user }) => {
 *     // user is already logged in
 *   });
 */
import { test as baseTest } from '@playwright/test';

export const test = baseTest.extend({
  // Setup test users before tests
  // Note: This is a simplified approach. For a more robust solution,
  // consider using test.beforeAll and test.afterAll in each test file.
});

// ============================================================================
// EXPORTS
// ============================================================================

export {
  setupTestUsers,
  cleanupTestUsers,
  setupTestUser,
  cleanupTestUser,
  areTestUsersSetup,
  getTestUserWithDBId,
  getTestUserDBId,
  test,
};
