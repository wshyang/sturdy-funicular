// TestContext for the backend harness (addendum-081, F2) — the one object
// every harness test gets: a recording ApiClient (with named actor sessions),
// the seeded world, state assertions, time control, and artifacts.
import { req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail } from "../helpers.tsx";
import { Assertions } from "./state.ts";
import { WorldBuilder } from "./fixtures.ts";
import { TimeControl } from "./time.ts";
import { writeSnapshot, writeFailureArtifacts, boundResponseBody, type RecordedRequest } from "./artifacts.ts";
import type { User } from "../../../../server/types.tsx";

export interface RequestResult {
  status: number;
  json: any;
  headers: Headers;
}

// Recording HTTP client: every call is appended to a shared request log (so
// the harness can dump it on failure) and, when bound to a session, uses the
// X-Session-Token header path (the backend suite's transport).
export class ApiClient {
  constructor(
    private readonly log: RecordedRequest[],
    private readonly sessionToken: string | null = null,
  ) {}

  bind(token: string): ApiClient {
    return new ApiClient(this.log, token);
  }

  async request(method: string, path: string, opts: { body?: unknown; session?: string } = {}): Promise<RequestResult> {
    const token = opts.session ?? this.sessionToken;
    const headers: Record<string, string> = {};
    if (token) Object.assign(headers, authHeaders(token));
    const res = await req(path, { method, headers, body: opts.body });
    const json = await res.json().catch(() => null);
    // Record the request WITH a bounded copy of the response (addendum-106,
    // B3) — status alone couldn't distinguish "correct 409" from "wrong 409".
    this.log.push({ method: method.toUpperCase(), path, body: opts.body, status: res.status, response: boundResponseBody(json), type: "request" });
    return { status: res.status, json, headers: res.headers };
  }

  get(path: string, opts?: { session?: string }) { return this.request("GET", path, opts); }
  post(path: string, opts?: { body?: unknown; session?: string }) { return this.request("POST", path, opts); }
  put(path: string, opts?: { body?: unknown; session?: string }) { return this.request("PUT", path, opts); }
  del(path: string, opts?: { session?: string }) { return this.request("DELETE", path, opts); }
}

export interface TestContext {
  // The current Deno.test context (for t.step-style subtests inside fn).
  t?: Deno.TestContext;
  // Seed world users.
  admin: User;
  vendor: User;
  // Unauthenticated client (records into the shared log).
  api: ApiClient;
  // Named actor clients (bound to the seeded admin/vendor sessions), plus a
  // way to bind any session token.
  actors: {
    admin: ApiClient;
    vendor: ApiClient;
    as: (token: string) => ApiClient;
  };
  world: WorldBuilder;
  assert: Assertions;
  time: TimeControl;
  // Records a labeled phase boundary into the request log (addendum-106, B4)
  // — the failure bundle's request-log.json then groups requests by step and
  // failure.md names the step the test died in. Cheaper than t.step for
  // non-Deno-test phases (loops, helper calls).
  markStep(label: string): void;
  artifacts: {
    // Labeled DB snapshot for a passing test (the capture.shot analog).
    snapshot(label: string): Promise<string>;
    // Full failure bundle (request log + DB snapshot + failure.md).
    captureFailure(error: unknown): Promise<string>;
  };
  // Resets time + wipes the DB so a thrown test can never bleed state into
  // the next file. Called automatically by defineTest.
  teardown(): Promise<void>;
}

export async function createTestContext(opts: { seed?: boolean; testName?: string } = {}): Promise<TestContext> {
  await wipeDatabase();

  const seed = opts.seed !== false;
  // The name artifacts are filed under (addendum-106, B4) — defineTest always
  // passes the Deno.test name; direct createTestContext callers should too,
  // instead of the addendum-081 hardcoded "ctx"/"ctx-snapshot".
  const testName = opts.testName ?? "unnamed-test";
  const requestLog: RecordedRequest[] = [];

  const admin = seed ? await createAdmin("HarnessAdmin!2026") : (null as unknown as User);
  const vendor = seed
    ? await createActiveUser({
        fullName: "Harness Vendor",
        email: uniqueEmail("hvendor"),
        password: "HarnessVendor!2026",
        affiliation: "vendor",
      })
    : (null as unknown as User);

  const adminLogin = seed ? await loginAs(admin.email, "HarnessAdmin!2026") : null;
  const vendorLogin = seed ? await loginAs(vendor.email, "HarnessVendor!2026") : null;
  const adminSession = seed && adminLogin && !("error" in adminLogin) ? adminLogin.session : null;
  const vendorSession = seed && vendorLogin && !("error" in vendorLogin) ? vendorLogin.session : null;

  const api = new ApiClient(requestLog);
  const time = new TimeControl();
  const world = new WorldBuilder();
  const assert = new Assertions();

  const ctx: TestContext = {
    admin,
    vendor,
    api,
    actors: {
      admin: adminSession ? api.bind(adminSession) : api,
      vendor: vendorSession ? api.bind(vendorSession) : api,
      as: (token: string) => api.bind(token),
    },
    world,
    assert,
    time,
    markStep: (label: string) => {
      requestLog.push({ type: "step", method: "", path: label, status: 0 });
    },
    artifacts: {
      snapshot: (label: string) => writeSnapshot(testName, label),
      captureFailure: (error: unknown) =>
        writeFailureArtifacts({ testName, requests: requestLog, error }),
    },
    teardown: async () => {
      time.reset();
      await wipeDatabase();
    },
  };
  return ctx;
}
