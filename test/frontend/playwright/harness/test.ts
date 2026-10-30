// The new Playwright harness — the unified `{ test, expect }` entry point
// for specs that want paced, camera-disciplined, captioned test actions with
// artifact capture, on TOP of everything the observable harness
// (test/frontend/playwright/helpers/harness.ts, addenda 063/105/145)
// already provides.
//
// `test` here EXTENDS helpers/harness's test object rather than
// '@playwright/test' directly, so specs importing from this module inherit
// all of it for free:
//   * per-test console/pageerror/network ring buffers + opt-in
//     expectCleanConsole gate,
//   * automatic end-of-test screenshot + failure bundles,
//   * historical-timeout auto fixture,
//   * trace retention + the reporters' live progress.
// and gain, via the `harness` fixture:
//   * per-action pacing (DEFAULT_DEMO_DELAY_MS, addendum-194: 750ms),
//   * center-in-viewport camera discipline before each action,
//   * burned-in video captions (harness/captions.ts),
//   * before/after screenshot capture (harness/artifacts.ts),
//   * deterministic demo-work division (divideDemoWork / harness.demoDivision).
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test as observableTest } from '../helpers/harness';
import type { CaptureApi } from '../helpers/harness';
import {
  applyPreDelay,
  applyPostDelay,
  centerInViewport,
  divideDemoWork,
  normalizeOptions,
  type ActionOptions,
} from './pacing';
import {
  captureBefore,
  captureAfter,
  captureElement as captureElementArtifact,
  captureFullPage as captureFullPageArtifact,
} from './artifacts';
import { setCaption } from './captions';
import {
  backendEnvFor,
  frontendEnvFor,
  getCombinedEnv,
  type BackendEnvConfig,
  type FrontendEnvConfig,
  type TestDbMode,
} from './dbMode';

interface HarnessFixtures {
  harness: TestHarness;
}

/**
 * Test harness providing paced, centered, captioned action utilities plus
 * artifact capture, with the observable harness's CaptureApi available
 * through captured()/expectCleanConsole().
 */
export class TestHarness {
  private readonly page: Page;
  private readonly testInfo: TestInfo;
  private readonly dbMode: TestDbMode;
  private readonly captured: CaptureApi | null;
  private testSuiteId: string;

  constructor(page: Page, testInfo: TestInfo, dbMode: TestDbMode = 'postgres', captured: CaptureApi | null = null) {
    this.page = page;
    this.testInfo = testInfo;
    this.dbMode = dbMode;
    this.captured = captured;
    this.testSuiteId = testInfo.title;
  }

  /** Set the test suite ID for artifact naming. */
  setTestSuiteId(id: string): void {
    this.testSuiteId = id;
  }

  /** Get the current page. */
  getPage(): Page {
    return this.page;
  }

  /** Get the current test info. */
  getTestInfo(): TestInfo {
    return this.testInfo;
  }

  /** Get the current database mode. */
  getDbMode(): TestDbMode {
    return this.dbMode;
  }

  /** Backend environment for the current mode. */
  getBackendEnv(): BackendEnvConfig {
    return backendEnvFor(this.dbMode);
  }

  /** Frontend environment for the current mode. */
  getFrontendEnv(): FrontendEnvConfig {
    return frontendEnvFor(this.dbMode);
  }

  /** Combined environment for both backend and frontend. */
  getCombinedEnv(): Record<string, string> {
    return getCombinedEnv(this.dbMode);
  }

  /**
   * Deterministic share (item indices) of a repeated demo action for THIS
   * worker — see pacing.ts's divideDemoWork. Keyed by workerIndex so two
   * concurrently-recorded sessions each take their own half of e.g. the 9
   * demo signups without overlap and without drops.
   */
  demoDivision(total: number, workers: number): number[] {
    return divideDemoWork(total, workers, this.testInfo.workerIndex);
  }

  /**
   * Shared camera+choreography prelude every action runs: center the target
   * in the viewport (unless opted out), update the burned-in caption (unless
   * opted out), then hold the pre-action pacing delay.
   */
  private async prelude(locator: Locator | null, opts: ReturnType<typeof normalizeOptions>): Promise<void> {
    if (opts.center && locator) {
      await centerInViewport(locator);
    }
    if (opts.caption) {
      await setCaption(this.page, opts.caption);
    }
    await applyPreDelay(this.page, opts.preDelayMs, opts.caption);
  }

  /** Click an element with optional pacing, centering and artifact capture. */
  async click(testId: string, locator: Locator, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);

    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }

    await this.prelude(locator, opts);
    await locator.click();
    await applyPostDelay(this.page, opts.postDelayMs);

    if (opts.waitForNetworkIdle) {
      await this.page.waitForLoadState('networkidle');
    }
    if (opts.waitForLocator) {
      await opts.waitForLocator.waitFor();
    }
    if (opts.settleMs > 0) {
      await this.page.waitForTimeout(opts.settleMs);
    }

    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Double click an element. */
  async doubleClick(testId: string, locator: Locator, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.dblclick();
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Hover over an element. */
  async hover(testId: string, locator: Locator, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.hover();
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Focus an element. */
  async focus(testId: string, locator: Locator, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.focus();
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Fill text into an input. */
  async fillText(testId: string, locator: Locator, value: string, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.fill(value);
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Type text into an input (with per-key keyboard events). */
  async typeText(testId: string, locator: Locator, value: string, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.pressSequentially(value, { delay: opts.fast ? 0 : 50 });
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Press a key. */
  async pressKey(testId: string, locator: Locator, key: string, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.press(key);
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Select an option from a native dropdown. */
  async selectOption(
    testId: string,
    locator: Locator,
    valueOrLabel: string | { label?: string; value?: string; index?: number },
    options?: ActionOptions,
  ): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.selectOption(valueOrLabel);
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Check a checkbox. */
  async check(testId: string, locator: Locator, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.check();
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Uncheck a checkbox. */
  async uncheck(testId: string, locator: Locator, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.uncheck();
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Submit a form (click + optional network settle). */
  async submit(testId: string, locator: Locator, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(locator, opts);
    await locator.click();
    if (opts.waitForNetworkIdle) {
      await this.page.waitForLoadState('networkidle');
    }
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, testId, { testSuiteId: this.testSuiteId });
    }
  }

  /** Execute a step with pacing and artifact capture. */
  async step(name: string, fn: () => Promise<void>, options?: ActionOptions): Promise<void> {
    const opts = normalizeOptions(options);
    if (opts.capture) {
      await captureBefore(this.page, this.testInfo, name, { testSuiteId: this.testSuiteId });
    }
    await this.prelude(null, opts);
    await fn();
    await applyPostDelay(this.page, opts.postDelayMs);
    if (opts.capture) {
      await captureAfter(this.page, this.testInfo, name, { testSuiteId: this.testSuiteId });
    }
  }

  /** Wait for a duration, with an optional burned-in caption update. */
  async dwell(testId: string, ms: number, caption?: string): Promise<void> {
    if (caption) {
      await setCaption(this.page, caption);
    }
    // eslint-disable-next-line no-console -- how long the runner intentionally idles
    console.log(`[Dwell ${ms}ms] ${caption ?? testId}`);
    await this.page.waitForTimeout(ms);
  }

  /** Capture element-only screenshot. */
  async captureElementShot(testId: string, locator: Locator): Promise<string | null> {
    return captureElementArtifact(locator, testId, { testSuiteId: this.testSuiteId });
  }

  /** Capture full page screenshot. */
  async captureFullPageShot(testId: string): Promise<string | null> {
    return captureFullPageArtifact(this.page, testId, { testSuiteId: this.testSuiteId });
  }

  /** Full-page labeled screenshot via the observable harness fixture. */
  async shot(label: string): Promise<string> {
    if (!this.captured) {
      throw new Error('TestHarness.shot() requires the capture fixture — construct via the harness test fixture');
    }
    return this.captured.shot(label);
  }

  /**
   * Opt-in console-error gate delegated to the observable harness's CaptureApi
   * — fails the test if the page logged any error/pageerror not matched by
   * the allowlist. Addendum-194 demo hygiene: both recorded showcases call
   * this before finishing, so console regressions cannot ship in a recording.
   */
  expectCleanConsole(allow: Array<RegExp | string> = []): void {
    if (!this.captured) {
      throw new Error('TestHarness.expectCleanConsole() requires the capture fixture');
    }
    this.captured.expectCleanConsole(allow);
  }

  /** Copy of the console/pageerror ring buffer so far. */
  consoleLog(): ReturnType<CaptureApi['consoleLog']> {
    if (!this.captured) {
      throw new Error('TestHarness.consoleLog() requires the capture fixture');
    }
    return this.captured.consoleLog();
  }

  /** Copy of the network-response ring buffer so far (URLs secret-scrubbed). */
  network(): ReturnType<CaptureApi['network']> {
    if (!this.captured) {
      throw new Error('TestHarness.network() requires the capture fixture');
    }
    return this.captured.network();
  }

  /** Write a labeled observability bundle NOW. */
  bundle(label: string): Promise<string> {
    if (!this.captured) {
      return Promise.reject(new Error('TestHarness.bundle() requires the capture fixture'));
    }
    return this.captured.bundle(label);
  }
}

// The unified test object: everything from the observable harness
// (helpers/harness.ts) PLUS the `harness` fixture. Specs gaining the new
// harness by changing ONE import line:
//   import { test, expect } from '../harness/test';
export const test = observableTest.extend<HarnessFixtures>({
  harness: async ({ page, capture }, use, testInfo) => {
    const dbMode: TestDbMode = (process.env['TEST_DB_MODE'] as TestDbMode) ?? 'postgres';
    const harness = new TestHarness(page, testInfo, dbMode, capture);
    await use(harness);
  },
});

export { expect } from '@playwright/test';
