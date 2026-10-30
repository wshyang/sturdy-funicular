// Self-check: the suite's own screenshot-capture mechanism (captureBefore/
// captureAfter, ../helpers/ui.ts) is verified by comparing the number of
// screenshot files present at the START of this run (recorded by
// global-setup.ts into .screenshot-baseline.json, BEFORE any spec runs) to
// the number present now. Wired via a second Playwright PROJECT with
// `dependencies: ['chromium']` (playwright.config.ts) — the explicit,
// robust "run after everything else" mechanism Playwright provides, not
// filename-ordering (implicit and fragile: a spec file named earlier
// alphabetically would otherwise run first regardless of intent).
//
// Not an exact hard-coded count — that would be brittle and drift every
// time a spec adds/removes a capture point. The two INVARIANTS that matter:
//   1. delta > 0   — the suite actually generated screenshots this run.
//   2. delta even  — every capture happens in Before/After pairs
//      (captureBefore + captureAfter, or the submitWithCapture/
//      clickWithCapture helpers that wrap both) — an odd delta would
//      itself indicate a bug in the capture helpers, e.g. a crash between
//      a Before and its matching After.
import { test, expect } from '../helpers/harness';
import { readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCREENSHOT_DIR = join(process.cwd(), 'test_output', 'e2e', 'screenshots');
const BASELINE_FILE = join(process.cwd(), 'test_output', 'e2e', '.screenshot-baseline.json');

test.describe('screenshot-count self-check', () => {
  test('the suite generated a positive, even number of screenshots this run', () => {
    const { count: baseline } = JSON.parse(readFileSync(BASELINE_FILE, 'utf-8')) as { count: number };

    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    const current = readdirSync(SCREENSHOT_DIR).filter((f) => f.endsWith('.png')).length;

    const delta = current - baseline;
    expect(delta).toBeGreaterThan(0);
    expect(delta % 2).toBe(0);
  });
});
