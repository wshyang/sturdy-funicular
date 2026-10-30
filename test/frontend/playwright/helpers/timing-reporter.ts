// Addendum-145 reporter: one committed timing history beside every regression
// spec. It records all attempts for auditability; timeout arithmetic includes
// only successful retry-0 attempts (src/app/lib/playwrightTiming.ts).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import type { FullResult, Reporter, TestCase, TestResult } from '@playwright/test/reporter';
import { timingLogPath, type TimingAttempt, type TimingHistory, type TimingSuiteRun } from '../../../../src/app/lib/playwrightTiming';

interface PendingSuite {
  file: string;
  attempts: TimingAttempt[];
  earliestStart: number;
  latestFinish: number;
}

function loadHistory(path: string, suiteFile: string): TimingHistory {
  if (!existsSync(path)) return { version: 1, suiteFile, runs: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as TimingHistory;
    if (parsed.version === 1 && Array.isArray(parsed.runs)) return parsed;
  } catch { /* malformed history is replaced only after a completed run */ }
  return { version: 1, suiteFile, runs: [] };
}

function atomicWrite(path: string, value: TimingHistory): void {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export default class TimingReporter implements Reporter {
  private readonly suites = new Map<string, PendingSuite>();
  private readonly runId = `${new Date().toISOString()}-${process.pid}`;

  onTestEnd(test: TestCase, result: TestResult): void {
    const file = isAbsolute(test.location.file) ? test.location.file : join(process.cwd(), test.location.file);
    const start = result.startTime.getTime();
    const finish = start + result.duration;
    const suite = this.suites.get(file) ?? { file, attempts: [], earliestStart: start, latestFinish: finish };
    suite.earliestStart = Math.min(suite.earliestStart, start);
    suite.latestFinish = Math.max(suite.latestFinish, finish);
    suite.attempts.push({
      testId: test.id,
      title: test.titlePath().slice(1).join(' › '),
      durationSeconds: result.duration / 1000,
      status: result.status,
      retry: result.retry,
      startedAt: result.startTime.toISOString(),
    });
    this.suites.set(file, suite);
  }

  onEnd(result: FullResult): void {
    const finishedAt = new Date().toISOString();
    for (const suite of this.suites.values()) {
      const suiteFile = relative(process.cwd(), suite.file).replaceAll('\\', '/');
      const path = timingLogPath(suite.file);
      const history = loadHistory(path, suiteFile);
      const failed = suite.attempts.some((attempt) => attempt.status === 'failed' || attempt.status === 'timedOut');
      const interrupted = result.status === 'interrupted' || suite.attempts.some((attempt) => attempt.status === 'interrupted');
      const run: TimingSuiteRun = {
        runId: this.runId,
        startedAt: new Date(suite.earliestStart).toISOString(),
        finishedAt,
        totalSeconds: suite.attempts.reduce((sum, attempt) => sum + attempt.durationSeconds, 0),
        status: interrupted ? 'interrupted' : failed ? 'failed' : 'passed',
        tests: suite.attempts,
      };
      history.runs.push(run);
      atomicWrite(path, history);
    }
  }
}
