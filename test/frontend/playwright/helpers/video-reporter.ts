// Custom Playwright reporter that relocates each test's recorded video out
// of Playwright's default test-results/<project>/<test>/video.webm location
// into a flat test_output/e2e/videos/ directory, beside
// test_output/e2e/screenshots/ — the user wants one place to look for both
// artifact types, not videos buried under test-results/ (which also holds
// traces/retries and gets wiped/rewritten per run). All run artifacts live
// under test_output/, out of the source tree — see addendum-016 (revised)
// and addendum-052-test-output-consolidation.md.
//
// Addendum-105: the same relocation now applies to TRACES (name: 'trace'
// attachment, present only when use.trace retains them — 'retain-on-failure'
// in every config here, i.e. failures only). A retained trace is the single
// most useful failure artifact Playwright produces (`npx playwright show-
// trace <file>`), and test-results/ gets wiped per run — so it is copied to
// test_output/e2e/traces/ with the same timestamp/status naming as videos.
//
// Playwright has no built-in "videos output directory" config option (only
// use.video's on/off/retain-on-failure mode) — copying out of the
// TestResult.attachments list in a reporter is the supported way to
// relocate artifacts after the fact.
import { copyFileSync, mkdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

function timestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}

// Mirrors test/frontend/playwright/helpers/ui.ts's screenshot filenames — "[timestamp] (id).ext"
// — using the test's own title as the id, since specs don't pass a separate
// testSuiteId for video (one video per test case, unlike the multiple
// before/after screenshot pairs a single test can generate).
function sanitize(title: string): string {
  return title.replace(/[\\/:*?"<>|]/g, '_');
}

export interface VideoReporterOptions {
  // Defaults to test_output/e2e/videos — overridden by
  // playwright.demo*.config.ts to test_output/e2e/demo/videos so demo
  // recordings never mix with regression-suite artifacts. Passed via the
  // config array's [path, options] tuple form. Callers pass a path already
  // rooted under test_output/ (see each config's `dir` value).
  dir?: string;
  // Defaults to test_output/e2e/traces. Traces exist only when the config
  // retains them (all configs here use 'retain-on-failure'), so a demo-suite
  // override is unnecessary — demo failures relocating here is correct.
  traceDir?: string;
}

export default class VideoReporter implements Reporter {
  private readonly videoDir: string;
  private readonly traceDir: string;

  constructor(options: VideoReporterOptions = {}) {
    this.videoDir = join(process.cwd(), options.dir ?? join('test_output', 'e2e', 'videos'));
    this.traceDir = join(process.cwd(), options.traceDir ?? join('test_output', 'e2e', 'traces'));
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    const id = sanitize(test.titlePath().slice(1).join(' › '));

    const video = result.attachments.find((a) => a.name === 'video' && a.path);
    if (video?.path) {
      mkdirSync(this.videoDir, { recursive: true });
      const ext = extname(video.path) || '.webm';
      const dest = join(this.videoDir, `${timestamp(result.startTime)} (${id}).${result.status}${ext}`);
      copyFileSync(video.path, dest);
    }

    // Retained traces (failures under 'retain-on-failure') — the addendum-105
    // relocation out of per-run-wiped test-results/.
    const trace = result.attachments.find((a) => a.name === 'trace' && a.path);
    if (trace?.path) {
      mkdirSync(this.traceDir, { recursive: true });
      const dest = join(this.traceDir, `${timestamp(result.startTime)} (${id}).${result.status}.zip`);
      copyFileSync(trace.path, dest);
    }
  }
}
