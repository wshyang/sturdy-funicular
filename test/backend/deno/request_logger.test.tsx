// Regression tests for the query-stripping request logger (addendum-095
// Finding #10). Hono's built-in logger middleware printed the FULL request URL
// including the query string into container logs, which would leak OAuth
// codes/state tokens and secret-material query params. The replacement logger
// in server/app.tsx logs `c.req.path` (pathname only — Hono strips the query in
// getPath), so sensitive query data never reaches stdout.
import { assertEquals } from "jsr:@std/assert";
import { app } from "../../../server/app.tsx";

// Capture console.log output around a request so we can assert on what the
// request-logger middleware actually emitted.
async function requestWithCapturedLogs(path: string, init?: RequestInit): Promise<string[]> {
  const captured: string[] = [];
  const originalLog = console.log;
  // deno-lint-ignore no-explicit-any
  console.log = (...args: any[]) => { captured.push(args.join(" ")); };
  try {
    await app.request(path, init);
  } finally {
    console.log = originalLog;
  }
  return captured;
}

Deno.test("request-logger: query string is NOT written to the request log", async () => {
  const sensitive = "SECRET_OAUTH_CODE_123";
  const logs = await requestWithCapturedLogs(`/health?code=${sensitive}&state=abc`);

  // The logger must have emitted a line for this request.
  const line = logs.find((l) => l.includes("/health"));
  assertEquals(typeof line, "string", "expected a log line for /health");

  // The sensitive query value must never appear in any logged line.
  for (const l of logs) {
    assertEquals(l.includes(sensitive), false, `query value leaked into log: ${l}`);
  }
  // The path (without query) should still be logged.
  assertEquals(line!.includes("/health"), true);
  // The query string itself must be stripped.
  assertEquals(line!.includes("code="), false);
});

Deno.test("request-logger: route still resolves when a query string is present", async () => {
  const res = await app.request("/health?from=2026-01-01&to=2026-02-01");
  assertEquals(res.status, 200);
});
