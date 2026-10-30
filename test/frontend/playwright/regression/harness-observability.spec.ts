// Self-check for the harness's addendum-105 observability features — the e2e
// counterpart of test/backend/deno/harness/harness.test.tsx. Proves, against
// the real stack (no mocks), that:
//   P1 — the universal console/pageerror ring buffer sees page activity, and
//        expectCleanConsole is allowlist-capable in both directions;
//   P2 — capture.bundle('label') writes the full bundle (manifest, console,
//        network, aria snapshot) a passing test can inspect.
// (P3's trace relocation fires only on genuine failures — asserting it would
// require a deliberately-failing test, which a green suite can't carry; the
// seam shares video-reporter.ts's proven copy path.)
//
// Exactly TWO tests: the screenshot-count self-check requires the per-run
// screenshot delta to be > 0 and EVEN — each test contributes its automatic
// end-of-test screenshot, and this spec deliberately takes no unpaired
// capture.shot()s.
import { test, expect } from '../helpers/harness';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

test.describe('harness observability (addendum-105)', () => {
  test('P1+P2: buffers collect page activity; bundle(label) writes a complete bundle', async ({ page, capture }) => {
    await page.goto('/');
    await page.evaluate(() => console.log('harness-observability-probe'));

    // P1 — the network buffer saw the initial page load (document + assets +
    // the app's bootstrap calls), and the console buffer saw our probe.
    expect(capture.network().length).toBeGreaterThan(0);
    expect(capture.consoleLog().some((e) => e.text.includes('harness-observability-probe'))).toBe(true);

    // P2 — a labeled bundle contains all four artifacts, parseable.
    const dir = await capture.bundle('probe');
    const manifest = readFileSync(join(dir, readFileSelf(dir, '.manifest.md')), 'utf-8');
    expect(manifest).toContain('harness observability (addendum-105)');

    const consoleJson = JSON.parse(readFileSync(join(dir, readFileSelf(dir, '.console.json')), 'utf-8')) as Array<{ text: string }>;
    expect(consoleJson.some((e) => e.text.includes('harness-observability-probe'))).toBe(true);

    const networkJson = JSON.parse(readFileSync(join(dir, readFileSelf(dir, '.network.json')), 'utf-8')) as { entries: unknown[] };
    expect(networkJson.entries.length).toBeGreaterThan(0);

    const aria = readFileSync(join(dir, readFileSelf(dir, '.aria-snapshot.yml')), 'utf-8');
    expect(aria.length).toBeGreaterThan(0);
  });

  test('P1: expectCleanConsole passes clean, throws on injected errors, allowlists both ways', async ({ page, capture }) => {
    await page.goto('/');

    // Chrome logs 4xx/5xx resource loads as console errors; an unauthenticated
    // bootstrap may 401 /auth/me. Allowlist pattern here so the test is robust
    // whether or not that call fired — the gate itself is what is asserted.
    capture.expectCleanConsole([/Failed to load resource/, /Content Security Policy/]);

    // An injected console.error fails the gate...
    await page.evaluate(() => console.error('harness-injected-error'));
    expect(() => capture.expectCleanConsole([/Failed to load resource/, /Content Security Policy/])).toThrow(/harness-injected-error/);

    // ...and the same entry is allowlistable (string-substring form).
    capture.expectCleanConsole([/Failed to load resource/, /Content Security Policy/, 'harness-injected-error']);
  });
});

// Bundle filenames are timestamped ("[ts] (<label>)<suffix>") and old bundles
// accumulate in the per-test directory across runs, so locate THIS test's
// probe-labeled file of each suffix (the latest, if a same-second collision
// ever produced two).
function readFileSelf(dir: string, suffix: string): string {
  const match = readdirSync(dir).filter((f) => f.endsWith(`(probe)${suffix}`)).sort().pop();
  if (!match) throw new Error(`bundle artifact not found: *(probe)${suffix} in ${dir}`);
  return match;
}
