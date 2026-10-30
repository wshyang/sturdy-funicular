// Per-action pacing helpers for the new Playwright harness.
//
// Two video-facing knobs live here so every suite (recorded demos AND any
// future story-oriented spec under test/frontend/playwright/stories/) shares
// ONE source of truth:
//
//   * DEFAULT_DEMO_DELAY_MS — the human-pacing delay between simulated user
//     actions while a repeated interaction is still inside its "first
//     occurrences at full pace" window. Raised 300 -> 750ms (2026-08-16)
//     because recordings at 300/350ms played too fast for a human viewer to
//     follow the focused element; 750ms keeps each action readable without
//     dragging the total runtime (only the first FULL_PACE_REPS occurrences
//     of each interaction shape pay it — see demo/helpers/index.ts's
//     paceSequence).
//   * centerInViewport — camera discipline for recordings: bring the action
//     target (roughly) into the viewport CENTER before acting, so the
//     viewer's eye is never hunting for a control pinned to the top/bottom
//     edge by Playwright's built-in minimal auto-scroll. "Roughly" matters:
//     an element already inside the central band is left alone, avoiding a
//     disorienting re-center jump on every single click.
import type { Locator, Page } from '@playwright/test';

/**
 * Default per-action pacing delay for demo recordings — the pause a human
 * viewer needs in order to see WHICH element is about to be acted on.
 */
export const DEFAULT_DEMO_DELAY_MS = 750;

/** Options controlling action pacing and artifacts. */
export interface ActionOptions {
  /** Delay before the action (for choreography). */
  preDelayMs?: number;
  /** Delay after the action (for choreography). */
  postDelayMs?: number;
  /** Legacy alias for preDelayMs. */
  delayMs?: number;
  /** Whether to capture screenshots (default: true). */
  capture?: boolean;
  /** Wait for network idle after action. */
  waitForNetworkIdle?: boolean;
  /** Locator to wait for after action. */
  waitForLocator?: Locator;
  /** Additional settlement time in ms. */
  settleMs?: number;
  /** Shorthand for capture=false + all delays 0 + no centering. */
  fast?: boolean;
  /**
   * Camera behaviour: scroll the action target into the viewport center
   * before acting (default: true). Pass false only for targets whose scroll
   * container must not move (e.g. an option inside an already-open combobox
   * popover).
   */
  center?: boolean;
  /** Optional caption overlay text for video narration. */
  caption?: string;
  /** Whether to keep the caption visible after the action completes. */
  keepCaption?: boolean;
}

/**
 * Fully-defaulted view of ActionOptions used internally. NOT
 * Required<ActionOptions> — under exactOptionalPropertyTypes a Required<>
 * projection would make waitForLocator/caption/keepCaption non-undefined
 * while their real defaults are legitimately absent.
 */
export interface NormalizedActionOptions {
  preDelayMs: number;
  postDelayMs: number;
  delayMs: number;
  capture: boolean;
  waitForNetworkIdle: boolean;
  waitForLocator: Locator | undefined;
  settleMs: number;
  fast: boolean;
  center: boolean;
  caption: string | undefined;
  keepCaption: boolean;
}

/** Normalize action options with defaults. */
export function normalizeOptions(options?: ActionOptions): NormalizedActionOptions {
  const delayMs = options?.delayMs ?? options?.preDelayMs ?? 0;
  const postDelayMs = options?.postDelayMs ?? 0;
  const fast = options?.fast ?? false;

  return {
    preDelayMs: fast ? 0 : delayMs,
    postDelayMs: fast ? 0 : postDelayMs,
    delayMs,
    capture: fast ? false : (options?.capture ?? true),
    waitForNetworkIdle: options?.waitForNetworkIdle ?? false,
    waitForLocator: options?.waitForLocator,
    settleMs: options?.settleMs ?? 0,
    fast,
    center: fast ? false : (options?.center ?? true),
    caption: options?.caption,
    keepCaption: options?.keepCaption ?? false,
  };
}

// Portion of the viewport considered "already centered": if the target's
// whole bounding box falls inside this central band, no scroll is issued.
// Band edges are fractions of the viewport size per axis.
const CENTER_BAND_FRACTION = 0.3;

/**
 * Scroll `locator` toward the viewport center — camera discipline for
 * recorded/demo runs so the action target is never clipped against a
 * viewport edge. Playwright's own actionability scroll only guarantees
 * MINIMAL visibility (often top- or bottom-justified), which reads badly on
 * video; this helper centers BLOCK and INLINE with an instant (motion-free)
 * scroll, and is deliberately a no-op when the element already sits inside
 * the central band, so consecutive actions on adjacent rows don't produce a
 * constant scroll wobble. Never elects smooth scrolling: an animated scroll
 * would race the immediately-following click.
 */
export async function centerInViewport(locator: Locator): Promise<void> {
  await locator.evaluate((el: Element, band: number) => {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const fullyInside =
      rect.top >= vh * band &&
      rect.bottom <= vh * (1 - band) &&
      rect.left >= vw * band &&
      rect.right <= vw * (1 - band);
    if (fullyInside) return;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
  }, CENTER_BAND_FRACTION);
}

/**
 * Apply pre-action delay (and emit a caption marker, if provided). The
 * caption OVERLAY itself is installed/displayed by harness/captions.ts —
 * callers wanting burned-in video captions use TestHarness/TestDemoHelpers
 * which wire setCaption; this console marker remains as the machine-readable
 * trace line for plain logs.
 */
export async function applyPreDelay(page: Page, ms: number, caption?: string): Promise<void> {
  if (caption) {
    // eslint-disable-next-line no-console -- intentional reporter-side trace
    console.log(`[Caption] ${caption}`);
  }
  if (ms > 0) {
    await page.waitForTimeout(ms);
  }
}

/** Apply post-action delay. */
export async function applyPostDelay(page: Page, ms: number): Promise<void> {
  if (ms > 0) {
    await page.waitForTimeout(ms);
  }
}

/** Wait for network idle. */
export async function waitForNetworkIdle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle');
}

/** Wait for a specific locator to be ready. */
export async function waitForReady(locator?: Locator, settleMs?: number): Promise<void> {
  if (locator) {
    await locator.waitFor();
  }
  if (settleMs && settleMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, settleMs));
  }
}

/**
 * Compute a deterministic demo-work split for `total` repeated same-shape
 * actions across `workers` parallel contexts, e.g. 9 demo signups across 2
 * concurrently-recorded browser sessions. Throws on invalid inputs so a
 * misconfigured plan fails fast during setup instead of silently dropping
 * work. `key` selects which worker's share is returned (0-based index into
 * the range [0, workers)).
 */
export function divideDemoWork(total: number, workers: number, key: number): number[] {
  if (!Number.isInteger(total) || total < 0) {
    throw new Error(`demo division: total must be a non-negative integer (got ${total})`);
  }
  if (!Number.isInteger(workers) || workers < 1) {
    throw new Error(`demo division: workers must be a positive integer (got ${workers})`);
  }
  if (!Number.isInteger(key) || key < 0 || key >= workers) {
    throw new Error(`demo division: key ${key} is outside [0, ${workers})`);
  }
  const base = Math.floor(total / workers);
  const remainder = total % workers;
  // First `remainder` workers absorb one extra item each so the split sums
  // exactly to `total`.
  const mine = base + (key < remainder ? 1 : 0);
  const offset = key * base + Math.min(key, remainder);
  return Array.from({ length: mine }, (_, i) => offset + i);
}
