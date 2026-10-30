import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from '@playwright/test/reporter';

interface LiveReporterOptions {
  statusPath?: string;
  heartbeatMs?: number;
  quiet?: boolean;
}

interface LiveStatus {
  version: 1;
  phase: 'suite' | 'test' | 'step' | 'heartbeat' | 'step-complete' | 'test-complete' | 'error' | 'suite-complete';
  updatedAt: string;
  elapsedSeconds: number;
  test?: string;
  file?: string;
  step?: string;
  category?: string;
  outcome?: string;
  error?: string;
  retry?: number;
  worker?: number;
  totalTests?: number;
}

const DEFAULT_STATUS_PATH = join('test_output', 'e2e', 'live-status.json');
const DEFAULT_HEARTBEAT_MS = 15_000;

function title(test: TestCase): string {
  return test.titlePath().filter(Boolean).join(' › ');
}

function errorText(error: TestError | Error | undefined): string | undefined {
  if (!error) return undefined;
  const message = 'message' in error && error.message ? error.message : String(error);
  return message.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').slice(0, 2_000);
}

/**
 * Streams the exact active test/step and writes the same data atomically to
 * test_output/e2e/live-status.json. A periodic heartbeat makes a genuinely
 * running-but-stuck action distinguishable from a dead Playwright process.
 */
export default class LiveReporter implements Reporter {
  private readonly statusPath: string;
  private readonly heartbeatMs: number;
  private readonly quiet: boolean;
  private startedAt = Date.now();
  private heartbeat: ReturnType<typeof setInterval> | undefined;
  private current: Partial<LiveStatus> = {};

  constructor(options: LiveReporterOptions = {}) {
    this.statusPath = isAbsolute(options.statusPath ?? '')
      ? options.statusPath!
      : join(process.cwd(), options.statusPath ?? DEFAULT_STATUS_PATH);
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.quiet = options.quiet ?? false;
  }

  onBegin(_config: FullConfig, suite: Suite): void {
    this.startedAt = Date.now();
    this.publish({ phase: 'suite', totalTests: suite.allTests().length }, `suite started (${suite.allTests().length} tests)`);
  }

  onTestBegin(test: TestCase, result: TestResult): void {
    this.publish(
      {
        phase: 'test',
        test: title(test),
        file: test.location.file,
        retry: result.retry,
        worker: result.workerIndex,
      },
      `START ${title(test)}`,
    );
    this.startHeartbeat();
  }

  onStepBegin(test: TestCase, _result: TestResult, step: TestStep): void {
    this.publish(
      {
        phase: 'step',
        test: title(test),
        file: test.location.file,
        step: step.title,
        category: step.category,
      },
      `STEP ${title(test)} :: ${step.title}`,
    );
  }

  onStepEnd(test: TestCase, _result: TestResult, step: TestStep): void {
    const outcome = step.error ? 'failed' : 'passed';
    this.publish(
      {
        phase: 'step-complete',
        test: title(test),
        file: test.location.file,
        step: step.title,
        category: step.category,
        outcome,
        ...(errorText(step.error) ? { error: errorText(step.error)! } : {}),
      },
      `${step.error ? 'FAIL' : 'DONE'} ${title(test)} :: ${step.title} (${step.duration}ms)`,
    );
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    this.stopHeartbeat();
    this.publish(
      {
        phase: 'test-complete',
        test: title(test),
        file: test.location.file,
        outcome: result.status,
        ...(errorText(result.error) ? { error: errorText(result.error)! } : {}),
        retry: result.retry,
        worker: result.workerIndex,
      },
      `${result.status.toUpperCase()} ${title(test)} (${result.duration}ms)`,
    );
  }

  onError(error: TestError): void {
    const detail = errorText(error);
    this.publish(
      { phase: 'error', ...(detail ? { error: detail } : {}) },
      `ERROR ${detail ?? 'unknown Playwright error'}`,
    );
  }

  onEnd(result: FullResult): void {
    this.stopHeartbeat();
    this.publish({ phase: 'suite-complete', outcome: result.status }, `suite ${result.status}`);
  }

  async onExit(): Promise<void> {
    this.stopHeartbeat();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeat = setInterval(() => {
      this.publish({ ...this.current, phase: 'heartbeat' } as LiveStatus, `HEARTBEAT ${this.describeCurrent()}`);
    }, this.heartbeatMs);
    this.heartbeat.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private describeCurrent(): string {
    const context = [this.current.test, this.current.step].filter(Boolean).join(' :: ');
    return `${context || 'Playwright'} (${Math.round((Date.now() - this.startedAt) / 1000)}s elapsed)`;
  }

  private publish(update: Partial<LiveStatus> & Pick<LiveStatus, 'phase'>, message: string): void {
    this.current = { ...this.current, ...update };
    const status: LiveStatus = {
      version: 1,
      ...this.current,
      phase: update.phase,
      updatedAt: new Date().toISOString(),
      elapsedSeconds: Math.round((Date.now() - this.startedAt) / 100) / 10,
    } as LiveStatus;
    this.current = status;

    mkdirSync(dirname(this.statusPath), { recursive: true });
    const temporary = join(dirname(this.statusPath), `.${basename(this.statusPath)}.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
    renameSync(temporary, this.statusPath);
    if (!this.quiet) process.stdout.write(`[e2e-live ${status.updatedAt}] ${message}\n`);
  }
}
