// Artifact capture helpers for the new Playwright harness — screenshots
// (before/after/element/full-page) written under test_output/e2e/.
//
// Recorded-demo runs continue to write their capture pairs via
// demo/helpers/index.ts into test_output/e2e/demo/screenshots/ — this
// module is the GENERAL-purpose artifact store for the new harness. The
// default directory can be overridden per runner process with
// E2E_ARTIFACT_SCREENSHOT_DIR (set it before `playwright test` starts;
// Playwright config `use` blocks cannot reach the runner's env, so the
// demo configs deliberately keep using their demo/helpers wrappers).
import type { Locator, Page, TestInfo } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

/** Configuration for artifact capture. */
export interface ArtifactConfig {
  /** Directory for screenshots (default: test_output/e2e/screenshots). */
  screenshotDir?: string;
  /** Directory for videos. */
  videoDir?: string;
  /** Test suite ID for naming artifacts. */
  testSuiteId?: string;
  /** Whether to capture artifacts (default: true). */
  enabled?: boolean;
}

const DEFAULT_CONFIG: Required<ArtifactConfig> = {
  screenshotDir: process.env['E2E_ARTIFACT_SCREENSHOT_DIR'] ?? 'test_output/e2e/screenshots',
  videoDir: 'test_output/e2e/videos',
  testSuiteId: 'test',
  enabled: true,
};

/** Ensure artifact directory exists. */
function ensureDirectory(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** Generate timestamp-based filename. */
function generateTimestampFilename(prefix: string, extension: string): string {
  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-');
  return `${timestamp} (${prefix}).${extension}`;
}

function resolveTarget(config: ArtifactConfig | undefined, actionName: string, kind: string): string | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  if (!cfg.enabled) return null;
  ensureDirectory(cfg.screenshotDir);
  return path.join(cfg.screenshotDir, generateTimestampFilename(`${cfg.testSuiteId} - ${actionName} - ${kind}`, 'png'));
}

// Best-effort capture: an unwritable artifact must never fail a test. The
// write callback returns whatever the underlying screenshot API returns
// (Buffer) — only completion matters here.
async function tryWrite(filepath: string, write: () => Promise<unknown>): Promise<string | null> {
  try {
    await write();
    return filepath;
  } catch (error) {
    // eslint-disable-next-line no-console -- reported to the runner log, never the UI
    console.error(`Failed to capture screenshot '${filepath}': ${String(error)}`);
    return null;
  }
}

/** Capture screenshot before an action. Returns the written path, or null. */
export async function captureBefore(
  page: Page,
  _testInfo: TestInfo,
  actionName: string,
  config?: ArtifactConfig,
): Promise<string | null> {
  const target = resolveTarget(config, actionName, 'Before');
  if (!target) return null;
  return tryWrite(target, () => page.screenshot({ path: target, fullPage: false }));
}

/** Capture screenshot after an action. Returns the written path, or null. */
export async function captureAfter(
  page: Page,
  _testInfo: TestInfo,
  actionName: string,
  config?: ArtifactConfig,
): Promise<string | null> {
  const target = resolveTarget(config, actionName, 'After');
  if (!target) return null;
  return tryWrite(target, () => page.screenshot({ path: target, fullPage: false }));
}

/** Capture element-only screenshot. Returns the written path, or null. */
export async function captureElement(
  locator: Locator,
  actionName: string,
  config?: ArtifactConfig,
): Promise<string | null> {
  const target = resolveTarget(config, actionName, 'Element');
  if (!target) return null;
  return tryWrite(target, () => locator.screenshot({ path: target }));
}

/** Capture full page screenshot. Returns the written path, or null. */
export async function captureFullPage(
  page: Page,
  actionName: string,
  config?: ArtifactConfig,
): Promise<string | null> {
  const target = resolveTarget(config, actionName, 'FullPage');
  if (!target) return null;
  return tryWrite(target, () => page.screenshot({ path: target, fullPage: true }));
}
