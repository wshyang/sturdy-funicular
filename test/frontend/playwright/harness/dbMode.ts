// Database mode helpers for Playwright tests
// Supports both PostgreSQL and SQLite backend modes

export type TestDbMode = 'postgres' | 'sqlite';

/**
 * Backend environment configuration for a specific database mode
 */
export interface BackendEnvConfig {
  DATABASE_URL: string;
  TEST_DB_MODE: TestDbMode;
  // Add other environment variables as needed
  [key: string]: string;
}

/**
 * PostgreSQL backend configuration
 */
export function postgresBackendEnv(): BackendEnvConfig {
  const portOffset = Number(process.env['E2E_STACK_ID'] ?? 0) * 10000;
  return {
    DATABASE_URL: process.env['E2E_DB_URL'] ??
      `postgres://breakglass:breakglass@localhost:${5432 + portOffset}/breakglass_test`,
    TEST_DB_MODE: 'postgres',
  };
}

/**
 * SQLite backend configuration
 */
export function sqliteBackendEnv(): BackendEnvConfig {
  return {
    DATABASE_URL: 'sqlite://test_output/test-db.sqlite',
    TEST_DB_MODE: 'sqlite',
  };
}

/**
 * Get backend environment for a specific mode
 */
export function backendEnvFor(mode: TestDbMode): BackendEnvConfig {
  switch (mode) {
    case 'postgres':
      return postgresBackendEnv();
    case 'sqlite':
      return sqliteBackendEnv();
    default:
      return postgresBackendEnv();
  }
}

/**
 * Frontend environment configuration
 */
export interface FrontendEnvConfig {
  VITE_API_BASE_URL: string;
  VITE_TEST_MODE: string;
  [key: string]: string;
}

/**
 * Get frontend environment for a specific backend mode
 */
export function frontendEnvFor(mode: TestDbMode): FrontendEnvConfig {
  return {
    VITE_API_BASE_URL: process.env['E2E_BACKEND_URL'] ?? `http://localhost:${8789 + Number(process.env['E2E_STACK_ID'] ?? 0) * 10000}`,
    VITE_TEST_MODE: mode,
  };
}

/**
 * Combined environment for backend and frontend
 */
export function getCombinedEnv(mode: TestDbMode): Record<string, string> {
  return {
    ...backendEnvFor(mode),
    ...frontendEnvFor(mode),
  };
}

/**
 * Check if we're running in test mode
 */
export function isTestMode(): boolean {
  return process.env['TEST_DB_MODE'] === 'postgres' || process.env['TEST_DB_MODE'] === 'sqlite';
}

/**
 * Get the current database mode from environment
 */
export function getCurrentDbMode(): TestDbMode {
  return (process.env['TEST_DB_MODE'] as TestDbMode) ?? 'postgres';
}
