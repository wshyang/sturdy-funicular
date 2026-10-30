// Time control for the backend harness (addendum-081, F6) — the backend's
// analog of Playwright's pacing, but for DETERMINISM instead of choreography:
// freeze/advance the single timestamp source (server/db.tsx now()) via the
// test-only setTestNow seam, and run exported cron sweeps under the frozen
// clock. Every harness test gets one via ctx.time; reset() runs in teardown
// so a frozen clock can never leak into another file.
import { setTestNow, now } from "../../../../server/db.tsx";

export class TimeControl {
  private frozen: string | null = null;

  // Freeze the clock at a specific ISO instant (default: the current real
  // instant, captured at call time).
  freeze(iso?: string): void {
    this.frozen = iso ?? new Date().toISOString();
    setTestNow(this.frozen);
  }

  // Advance the frozen clock by ms (throws if not frozen yet).
  advance(ms: number): void {
    if (!this.frozen) throw new Error("ctx.time.advance() requires ctx.time.freeze() first");
    this.frozen = new Date(new Date(this.frozen).getTime() + ms).toISOString();
    setTestNow(this.frozen);
  }

  // The current (frozen or real) timestamp — same source the app uses.
  current(): string {
    return now();
  }

  reset(): void {
    this.frozen = null;
    setTestNow(null);
  }

  // Run an exported cron sweep function under the current clock.
  async runSweep(fn: () => Promise<void>): Promise<void> {
    await fn();
  }
}
