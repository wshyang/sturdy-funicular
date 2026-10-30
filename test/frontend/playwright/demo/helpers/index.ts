// Demo-suite-scoped screenshot capture wrappers — mirror
// test/frontend/playwright/helpers/ui.ts's captureBefore/captureAfter/submitWithCapture/
// submitRequestWithCapture/clickWithCapture exactly, but write into
// test_output/e2e/demo/screenshots/ instead of test_output/e2e/screenshots/,
// so demo-run artifacts never mix with the regression suite's. Login/signup/
// provisioning helpers are NOT duplicated here — the demo spec imports those
// directly from test/frontend/playwright/helpers/ui.ts and test/frontend/playwright/helpers/scenario.ts, since
// login/signup behavior doesn't differ between the two suites.
//
// Addendum-194: the caption overlay implementation moved to
// ../../harness/captions.ts (re-exported below) and the pacing constants to
// ../../harness/pacing.ts, so the recorded demos and the new unified harness
// share one source of truth. The wrappers themselves stay demo-scoped
// because of their demo artifact directory.
import type { Locator, Page, TestType } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { centerInViewport, DEFAULT_DEMO_DELAY_MS } from '../../harness/pacing';
import { installCaptionOverlay, setCaption } from '../../harness/captions';

export { installCaptionOverlay, setCaption };

// Re-export the unified-harness test object so spec files can consume the
// new harness AND these demo helpers through ONE module — keeping the
// demo's './helpers' import set visually identical to its pre-migration
// shape. The demo SPECS still import `test` directly from '../harness/test'
// (the recordedDemoShowcaseContract asserts that migration explicitly).
export { test, expect } from '../../harness/test';

// Wraps test.step so every step's own title doubles as the on-screen
// caption, updated the instant the step starts — no separate caption string
// to keep in sync with the step's actual title. `test` is passed in (rather
// than imported here) since demo/helpers.ts is a plain helper module, not a
// spec file, and Playwright's `test` fixture must come from the spec that
// owns the running test.
export async function demoStep<T>(
  test: TestType<any, any>,
  page: Page,
  title: string,
  fn: () => Promise<T>,
): Promise<T> {
  return test.step(title, async () => {
    await setCaption(page, title);
    return fn();
  });
}

const SCREENSHOT_DIR = join(process.cwd(), 'test_output', 'e2e', 'demo', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

export async function captureBefore(page: Page, testSuiteId: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${timestamp()} (${testSuiteId}) - Before.png`) });
}

export async function captureAfter(page: Page, testSuiteId: string): Promise<void> {
  await page.screenshot({ path: join(SCREENSHOT_DIR, `${timestamp()} (${testSuiteId}) - After.png`) });
}

// `delayMs`, when nonzero, is awaited immediately before the action itself —
// this REPLACES config/playwright.demo.config.ts's old launchOptions.slowMo (a
// single value fixed for the whole browser session, unable to distinguish a
// sequence's first occurrence from its ninth). `fast`, when true, additionally
// skips the before/after screenshot pair. `center` (default true) scrolls the
// action target toward the viewport CENTER before the camera rolls — camera
// discipline for the recording (addendum-194); Playwright's built-in minimal
// auto-scroll would leave targets hugging the top/bottom edge. Pass
// `center: false` for targets whose scroll container must stay put. Every
// functionally-necessary wait (waitForLoadState, waitForResponse) still runs
// unconditionally regardless of any option — all three are pacing/camera
// levers, never correctness ones. See the sequence-pacer block below for how
// fast/delayMs get decided; callers that don't care about pacing can simply
// omit them (defaults = today's fast/no-frills behavior: 0 delay,
// screenshots on).
interface DemoActionOptions {
  fast?: boolean;
  delayMs?: number;
  center?: boolean;
}

export async function submitWithCapture(page: Page, testSuiteId: string, submitLocator: Locator, opts: DemoActionOptions = {}): Promise<void> {
  if (opts.center ?? true) await centerInViewport(submitLocator);
  if (!opts.fast) await captureBefore(page, testSuiteId);
  if (opts.delayMs) await page.waitForTimeout(opts.delayMs);
  await submitLocator.click();
  await page.waitForLoadState('networkidle');
  if (!opts.fast) await captureAfter(page, testSuiteId);
}

// Returns both the id AND the server-assigned request_number — the latter
// is what dashboard rows actually render as on-screen text (see
// happy-path-showcase.spec.ts's delegate-visibility assertions, which need a
// real anchor to search for: sr_number, the caller-chosen value, is NEVER
// rendered in any dashboard row, only in RequestDetailView/Search results).
export async function submitRequestWithCapture(
  page: Page, testSuiteId: string, submitLocator: Locator, opts: DemoActionOptions = {},
): Promise<{ id: string; requestNumber: string }> {
  if (opts.center ?? true) await centerInViewport(submitLocator);
  if (!opts.fast) await captureBefore(page, testSuiteId);
  if (opts.delayMs) await page.waitForTimeout(opts.delayMs);
  const [response] = await Promise.all([
    page.waitForResponse((res) => res.url().includes('/requests') && res.request().method() === 'POST'),
    submitLocator.click(),
  ]);
  await page.waitForLoadState('networkidle');
  if (!opts.fast) await captureAfter(page, testSuiteId);
  const body = await response.json();
  return { id: body.request.id as string, requestNumber: body.request.requestNumber as string };
}

export async function clickWithCapture(
  page: Page,
  testSuiteId: string,
  locator: Locator,
  opts: DemoActionOptions & { waitForNetworkIdle?: boolean; waitForLocator?: Locator } = {},
): Promise<void> {
  if (opts.center ?? true) await centerInViewport(locator);
  if (!opts.fast) await captureBefore(page, testSuiteId);
  if (opts.delayMs) await page.waitForTimeout(opts.delayMs);
  await locator.click();
  if (opts.waitForLocator) await opts.waitForLocator.waitFor({ state: 'visible' });
  else if (opts.waitForNetworkIdle) await page.waitForLoadState('networkidle');
  if (!opts.fast) await captureAfter(page, testSuiteId);
}

// ── Sequence pacer: full human pace (per-click delay + screenshots + a
// post-action dwell) for the first two times a given repeated ACTION KIND
// plays, then accelerated (zero delay, no screenshots, no added dwell) from
// the third occurrence onward. Demo videos narrate the same handful of
// interaction shapes many times over (submit a request, dashboard approval,
// approve-via-dashboard-row, sign up a user, approve a user) — showing each
// shape twice at human speed is enough for a viewer to understand it;
// replaying it identically a third/fourth/fifth+ time just makes the
// recording longer without teaching anything new.
//
// There is deliberately NO launchOptions.slowMo on this config (see
// config/playwright.demo.config.ts) — slowMo is fixed for an entire browser
// session, so it cannot express "slow for reps 1-2, instant after." Instead,
// HUMAN_ACTION_DELAY_MS is an explicit, code-controlled per-action delay
// that ONLY applies while a sequence is still in its human-paced window —
// every action's own correctness-relevant waits (network, visibility) still
// run regardless of pacing. Its value comes from harness/pacing.ts's
// DEFAULT_DEMO_DELAY_MS (750ms since addendum-194 — the 300/350ms era
// played too fast for a human viewer to track the focused element), shared
// with the new unified harness so demos and stories never drift apart.
const FULL_PACE_REPS = 2;
const HUMAN_ACTION_DELAY_MS = DEFAULT_DEMO_DELAY_MS;
const DWELL_MS = 900;
const sequenceCounts = new Map<string, number>();

export interface PaceContext {
  fast: boolean;
  delayMs: number;
}

// Call once per repeated sequence occurrence, BEFORE running its body.
// Returns whether this occurrence should run accelerated (and, for the
// human-paced occurrences, the per-action delay to thread into every
// *WithCapture call in that occurrence's body) — and, for the slow
// occurrences, dwellIfSlow below holds the frame briefly at the very end so
// the on-screen result is actually readable before the next step's caption
// replaces it.
export function paceSequence(kind: string): PaceContext {
  const seen = sequenceCounts.get(kind) ?? 0;
  sequenceCounts.set(kind, seen + 1);
  const fast = seen >= FULL_PACE_REPS;
  return { fast, delayMs: fast ? 0 : HUMAN_ACTION_DELAY_MS };
}

export async function dwellIfSlow(page: Page, pace: PaceContext): Promise<void> {
  if (!pace.fast) await page.waitForTimeout(DWELL_MS);
}

// For loops of many same-shape actions that DON'T go through *WithCapture at
// all — e.g. provisionActorsAndTeams()'s 9 signups + 9 approveUser() calls,
// each of which is a single call with no screenshot pair of its own. Returns
// HUMAN_ACTION_DELAY_MS for the first two 0-based indices, 0 after — same
// "twice at human pace, then instant" rule as paceSequence, but keyed by a
// plain index within one loop rather than a cross-call `kind` counter, since
// every signup in that loop is indisputably the same shape and the caller
// already has the loop index in hand.
export function actionPaceDelayMs(index: number): number {
  return index < FULL_PACE_REPS ? HUMAN_ACTION_DELAY_MS : 0;
}

// Close-up capture of a specific element (e.g. a chart container that sits
// below the fold in a full-page screenshot) — mirrors
// owner-statistics.spec.ts's captureChart, scoped to the demo screenshot dir.
export async function captureElement(locator: Locator, testSuiteId: string): Promise<void> {
  await locator.scrollIntoViewIfNeeded();
  await locator.screenshot({ path: join(SCREENSHOT_DIR, `[chart] ${testSuiteId}.png`) });
}

// Close-up capture of the golden-pulse status badge inside a pending
// dashboard row (addendum-194) — the visual "this row awaits MY decision"
// signal (step-scoped actionability, addendum-096). The whole row is
// centered first, then the glowing badge span itself is screenshotted so
// the recording (and the still) unmistakably shows WHAT the viewer's eye
// should be drawn to before the approve click lands.
export async function captureGlowElement(page: Page, requestNumber: string, testSuiteId: string): Promise<void> {
  const row = page.locator('tr', { hasText: requestNumber });
  await centerInViewport(row);
  const glow = row.locator('span.golden-pulse');
  await glow.waitFor({ state: 'visible' });
  await glow.screenshot({ path: join(SCREENSHOT_DIR, `[glow] ${testSuiteId}.png`) });
}
