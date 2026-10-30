// Common Playwright harness for the whole e2e suite.
//
// Every spec imports { test, expect } from THIS file instead of directly from
// '@playwright/test', so that screenshot + video capture are built in by
// default rather than opt-in per spec:
//
//   * VIDEO — recorded by Playwright itself via each config's `use.video`
//     ('on' unless E2E_DISABLE_VIDEO is set) and relocated into
//     test_output/e2e/videos/ by test/frontend/playwright/helpers/video-reporter.ts. The harness
//     doesn't re-implement this; it documents the dependency and guarantees
//     every spec runs under a config that has it. (A spec that imported
//     '@playwright/test' directly still recorded video — video is config-level
//     — but it bypassed the shared `capture` fixture below and the standard
//     end-of-test screenshot, which is exactly the inconsistency this harness
//     removes.)
//   * TRACES (addendum-105) — use.trace is 'retain-on-failure'; the reporter
//     now also relocates retained traces to test_output/e2e/traces/ so a
//     failure's `npx playwright show-trace` input survives the next run's
//     test-results/ wipe.
//   * SCREENSHOTS — a per-test `capture` fixture (below) plus an automatic
//     end-of-test screenshot, both written to test_output/e2e/screenshots/
//     using the same timestamped naming convention as test/frontend/playwright/helpers/ui.ts's
//     submitWithCapture/captureBefore/captureAfter.
//   * HISTORICAL TIMEOUTS (addendum-145) — an automatic fixture reads the
//     committed timing history beside the current spec and applies either the
//     180-second cold start or exactly 1.25× its latest-20 eligible average.
//   * OBSERVABILITY (addendum-105) — universal per-test console, pageerror
//     and network-response ring buffers (attached via a `page` fixture wrap,
//     so even specs that never touch `capture` are covered), an opt-in
//     console-error gate (capture.expectCleanConsole, allowlist-capable),
//     and an automatic FAILURE BUNDLE under
//     test_output/e2e/failure-bundles/<test>/ (console, network, aria
//     snapshot, manifest) — the e2e counterpart of the backend harness's
//     addendum-081/103 failure artifacts.
//
// See addendum-016 (video), addendum-052 (test_output consolidation),
// addendum-063 (this harness), addendum-105 (observability + bundles).
import { test as base, expect, type Page } from '@playwright/test';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolveTestTimeoutMs, timingLogPath, type TimingHistory } from '../../../../src/app/lib/playwrightTiming';

// Same directory + timestamp convention as test/frontend/playwright/helpers/ui.ts, so harness
// screenshots and submitWithCapture's before/after pairs land side by side.
const SCREENSHOT_DIR = join(process.cwd(), 'test_output', 'e2e', 'screenshots');
const FAILURE_BUNDLE_ROOT = join(process.cwd(), 'test_output', 'e2e', 'failure-bundles');
mkdirSync(SCREENSHOT_DIR, { recursive: true });
mkdirSync(FAILURE_BUNDLE_ROOT, { recursive: true });

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Filesystem-safe slug of a test's full title path (describe > test), so a
// screenshot filename identifies which test produced it.
function slugifyTitlePath(titlePath: string[]): string {
  return titlePath
    .filter(Boolean)
    .join(' > ')
    .replace(/[^0-9A-Za-z >_-]+/g, '_')
    .slice(0, 120);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(+${text.length - max} chars)` : text;
}

// Query-string values for secret-ish keys are replaced with '[hidden]' — the
// audit trigger's redaction marker (addendum-092), reused here per the
// addendum-103 precedent — so invite/SSO/handoff links in network logs never
// leak tokens into artifacts. Key NAMES are kept; they're the debug signal.
const SENSITIVE_QUERY_KEYS = /token|code|secret|key|nonce|session|sig/i;
function scrubUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const key of [...u.searchParams.keys()]) {
      if (SENSITIVE_QUERY_KEYS.test(key)) u.searchParams.set(key, '[hidden]');
    }
    return truncate(u.toString(), 300);
  } catch {
    return truncate(rawUrl, 300);
  }
}

export interface ConsoleEntry {
  // console message type ('log' | 'warning' | 'error' | ...) or 'pageerror'
  // for uncaught exceptions.
  type: string;
  text: string;
  at: string;
}

export interface NetworkEntry {
  kind: 'response' | 'requestfailed';
  method: string;
  url: string;
  status?: number;
  error?: string;
  at: string;
}

interface PageObservability {
  consoleLog: ConsoleEntry[];
  network: NetworkEntry[];
  // Favicon/static-asset noise can be filtered by callers; kept for honesty —
  // the count of entries DISCARDED by the ring bound.
  dropped: number;
}

const BUFFER_LIMIT = 300;
const observabilityByPage = new WeakMap<Page, PageObservability>();

// Attaches the listeners once per page and returns the page's buffers. Called
// from the overridden `page` fixture below, so coverage starts BEFORE the test
// body's first navigation and needs no per-spec opt-in.
function ensureObservability(page: Page): PageObservability {
  const existing = observabilityByPage.get(page);
  if (existing) return existing;
  const obs: PageObservability = { consoleLog: [], network: [], dropped: 0 };
  const push = <T>(ring: T[], item: T): void => {
    if (ring.length >= BUFFER_LIMIT) {
      ring.shift();
      obs.dropped += 1;
    }
    ring.push(item);
  };
  page.on('console', (msg) =>
    push(obs.consoleLog, { type: msg.type(), text: truncate(msg.text(), 500), at: new Date().toISOString() }),
  );
  page.on('pageerror', (err) =>
    push(obs.consoleLog, { type: 'pageerror', text: truncate(String(err?.stack ?? err), 1000), at: new Date().toISOString() }),
  );
  page.on('response', (res) =>
    push(obs.network, {
      kind: 'response',
      method: res.request().method(),
      url: scrubUrl(res.url()),
      status: res.status(),
      at: new Date().toISOString(),
    }),
  );
  page.on('requestfailed', (req) =>
    push(obs.network, {
      kind: 'requestfailed',
      method: req.method(),
      url: scrubUrl(req.url()),
      error: truncate(req.failure()?.errorText ?? 'unknown', 200),
      at: new Date().toISOString(),
    }),
  );
  observabilityByPage.set(page, obs);
  return obs;
}

// Writes a labeled bundle (passing tests via capture.bundle('label')) or a
// failure bundle (automatic, from the afterEach below). Best-effort per file:
// an unwritable artifact must never fail a test.
async function writeBundle(opts: {
  title: string;
  titlePath: string[];
  label: string;
  page: Page;
  obs: PageObservability;
  status: string;
  error?: string | undefined;
}): Promise<string> {
  const dir = join(FAILURE_BUNDLE_ROOT, opts.title);
  mkdirSync(dir, { recursive: true });
  const stamp = timestamp();
  const prefix = join(dir, `${stamp} (${opts.label})`);

  try {
    writeFileSync(`${prefix}.console.json`, JSON.stringify(opts.obs.consoleLog, null, 2));
  } catch { /* best-effort */ }
  try {
    const txt = opts.obs.consoleLog.map((e) => `${e.at} [${e.type}] ${e.text}`).join('\n');
    writeFileSync(`${prefix}.console.txt`, txt.length > 0 ? txt : '(no console output captured)\n');
  } catch { /* best-effort */ }
  try {
    writeFileSync(
      `${prefix}.network.json`,
      JSON.stringify({ dropped: opts.obs.dropped, entries: opts.obs.network }, null, 2),
    );
  } catch { /* best-effort */ }
  try {
    if (!opts.page.isClosed()) {
      // The accessibility tree — for "what did the page RENDER" questions a
      // text diff of this beats eyeballing a screenshot; element handles,
      // roles and names survive where pixels don't diff.
      writeFileSync(`${prefix}.aria-snapshot.yml`, await opts.page.locator('body').ariaSnapshot());
    }
  } catch { /* best-effort */ }
  try {
    const lines = [
      `# ${opts.titlePath.filter(Boolean).join(' > ')} — ${opts.label}`,
      '',
      `status: ${opts.status}`,
      `captured: ${stamp}`,
      `console entries: ${opts.obs.consoleLog.length}`,
      `network entries: ${opts.obs.network.length} (dropped by ring bound: ${opts.obs.dropped})`,
    ];
    if (opts.error) lines.push('', '## error', '', opts.error);
    lines.push('', 'Files: *.console.json/.txt, *.network.json, *.aria-snapshot.yml in this directory.');
    writeFileSync(`${prefix}.manifest.md`, lines.join('\n') + '\n');
  } catch { /* best-effort */ }

  return dir;
}

// The capture API exposed to every spec via the `capture` fixture.
export interface CaptureApi {
  // Full-page screenshot with a caller-chosen label, e.g.
  //   await capture.shot('after-2fa-gate')
  // Filename: "[ts] (<test title> — <label>).png"
  shot(label: string): Promise<string>;
  // Copy of the console/pageerror ring buffer so far.
  consoleLog(): ConsoleEntry[];
  // Copy of the network-response ring buffer so far (URLs secret-scrubbed).
  network(): NetworkEntry[];
  // Write a labeled bundle NOW (the passing-test counterpart of the automatic
  // failure bundle). Returns the directory written.
  bundle(label: string): Promise<string>;
  // Opt-in console-error gate: throws (failing the test, with the offending
  // entries in the message) if the buffer holds any 'error'/'pageerror'
  // entries not matched by the allowlist (RegExp tested / string substring).
  // Chrome logs 4xx/5xx resource loads as console errors, so a page whose
  // bootstrap expects a 401 (e.g. unauthenticated /auth/me) needs those
  // allowlisted explicitly — the noise stays visible in console.txt.
  expectCleanConsole(allow?: Array<RegExp | string>): void;
}

interface HarnessFixtures {
  capture: CaptureApi;
  _historicalTimeout: void;
}

export const test = base.extend<HarnessFixtures>({
  // Addendum-145 automatic timeout fixture. Missing/malformed history uses
  // the owner-selected 180-second cold start; eligible history uses the exact
  // latest-20 successful retry-0 average × 1.75. Both are multiplied by the
  // optional E2E_TIMEOUT_SCALE machine-speed factor, and E2E_NO_TIMEOUT=1
  // overrides everything with an unbounded budget (see playwrightTiming.ts) so
  // a much slower machine can run the suite to completion without the
  // committed timing histories being re-recorded on it.
  _historicalTimeout: [async ({}, use, testInfo) => {
    let history: TimingHistory | undefined;
    const path = timingLogPath(testInfo.file);
    if (existsSync(path)) {
      try { history = JSON.parse(readFileSync(path, 'utf8')) as TimingHistory; }
      catch { history = undefined; }
    }
    testInfo.setTimeout(resolveTestTimeoutMs(history, testInfo.testId, process.env));
    await use();
  }, { auto: true }],

  // Wrap the built-in page fixture: attaching observability listeners HERE
  // (instead of in the lazily-instantiated `capture` fixture) is what makes
  // capture universal — every test that touches a page is instrumented from
  // its first navigation, whether or not the spec names `capture`.
  page: async ({ page }, use) => {
    ensureObservability(page);
    await use(page);
  },

  capture: async ({ page }, use, testInfo) => {
    const obs = ensureObservability(page);
    const title = slugifyTitlePath(testInfo.titlePath);
    const api: CaptureApi = {
      async shot(label: string): Promise<string> {
        const path = join(SCREENSHOT_DIR, `${timestamp()} (${title} — ${label}).png`);
        await page.screenshot({ path, fullPage: true });
        // Also attach to the Playwright report so it shows in the HTML report.
        await testInfo.attach(label, { path, contentType: 'image/png' });
        return path;
      },
      consoleLog(): ConsoleEntry[] {
        return [...obs.consoleLog];
      },
      network(): NetworkEntry[] {
        return [...obs.network];
      },
      bundle(label: string): Promise<string> {
        return writeBundle({ title, titlePath: testInfo.titlePath, label, page, obs, status: 'labeled' });
      },
      expectCleanConsole(allow: Array<RegExp | string> = []): void {
        const allowed = (e: ConsoleEntry): boolean =>
          allow.some((a) => (typeof a === 'string' ? e.text.includes(a) : a.test(e.text)));
        const bad = obs.consoleLog.filter((e) => (e.type === 'error' || e.type === 'pageerror') && !allowed(e));
        if (bad.length > 0) {
          throw new Error(
            `expectCleanConsole: ${bad.length} console error(s) not in the allowlist:\n` +
              bad.map((e) => `  [${e.type}] ${truncate(e.text, 300)}`).join('\n'),
          );
        }
      },
    };
    await use(api);
  },
});

// Automatic end-of-test screenshot for EVERY test, pass or fail, so there's
// always a final-state image beside the video without each spec remembering
// to take one. Best-effort: a page already closed (or a test that never
// opened one) must not turn a passing test into a failure here.
test.afterEach(async ({ page }, testInfo) => {
  try {
    if (page.isClosed()) return;
    const title = slugifyTitlePath(testInfo.titlePath);
    const status = testInfo.status ?? 'unknown';
    const path = join(SCREENSHOT_DIR, `${timestamp()} (${title}).${status}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach('final', { path, contentType: 'image/png' });
  } catch {
    // Ignore — screenshotting is an artifact convenience, never a gate.
  }

  // Automatic FAILURE BUNDLE (addendum-105): same moment-of-failure philosophy
  // as the screenshot — console/pageerror log, scrubbed network log, aria
  // snapshot, manifest — plus report attachments so the HTML report is
  // self-contained. Best-effort throughout.
  try {
    if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
      const title = slugifyTitlePath(testInfo.titlePath);
      const obs = ensureObservability(page);
      const errorText = testInfo.errors.map((e) => e.message ?? String(e)).join('\n---\n');
      await writeBundle({
        title,
        titlePath: testInfo.titlePath,
        label: `failure.${testInfo.status ?? 'unknown'}`,
        page,
        obs,
        status: testInfo.status ?? 'unknown',
        error: errorText || undefined,
      });
      const consoleTxt = obs.consoleLog.map((e) => `${e.at} [${e.type}] ${e.text}`).join('\n');
      await testInfo.attach('console-log', { body: consoleTxt || '(no console output captured)', contentType: 'text/plain' });
    }
  } catch {
    // Ignore — artifacts never gate.
  }

  // E2E coverage (addendum-083, Phase 3): when E2E_COVERAGE=true the app is
  // served instrumented (VITE_COVERAGE=true) and each page carries
  // window.__coverage__ in Istanbul format. Dump it per-test into .nyc_output/
  // (nyc's default temp dir) so `nyc report` can merge across all tests.
  // Best-effort — a coverage dump must never fail a test.
  if (process.env['E2E_COVERAGE'] === 'true' && !page.isClosed()) {
    try {
      const cov = await page.evaluate(() => (window as any).__coverage__);
      if (cov && Object.keys(cov).length > 0) {
        const dir = join(process.cwd(), '.nyc_output');
        mkdirSync(dir, { recursive: true });
        const slug = slugifyTitlePath(testInfo.titlePath);
        writeFileSync(join(dir, `${slug}.json`), JSON.stringify(cov));
      }
    } catch {
      // Ignore — coverage is an artifact convenience, never a gate.
    }
  }
});

export { expect };
