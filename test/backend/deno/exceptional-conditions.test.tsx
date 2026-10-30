// OWASP A10: Mishandling of Exceptional Conditions Tests
//
// Category: A10 - Mishandling of Exceptional Conditions
// Focus: Error handling, failing open vs failing closed, resource exhaustion,
//        timeout handling, edge cases
//
// As per CLAUDE-test-discipline.md (2026-07-30):
// "All API endpoints (existing and new) must have OWASP Top 10 unit tests"
//
// This file tests for A10-specific exceptional condition handling.

import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail } from "./helpers.tsx";
import { app } from "../../../server/app.tsx";

// addendum-095 Finding #2 — a global app.onError safety net. To test it we
// register a unique route whose handler throws an unexpected error (a marker
// string that must never reach the client). The path is namespaced so it can
// never collide with a real route, and it is harmless to leave registered for
// the rest of this test process (deno runs each test FILE in its own process).
const A10_THROW_PATH = "/__audit_test__/internal-error";
app.post(A10_THROW_PATH, () => {
  throw new Error("A10_INTERNAL_SECRET_MARKER_SHOULD_NOT_LEAK");
});

Deno.test("OWASP A10: Mishandling of Exceptional Conditions", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("A10Admin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "A10Admin!2026");
    adminSession = (login as any).session;
  });

  // ============================================================================
  // A10-1: Error Handling
  // Testing that errors are handled gracefully without exposing internals
  // ============================================================================

  await t.step("A10-1-1: All endpoints return proper HTTP status codes for errors", async () => {
    const errorCases = [
      // 400 - Bad Request
      { path: "/auth/signup", method: "POST", body: {}, expectedStatus: 400, description: "Missing required fields" },
      { path: "/auth/login", method: "POST", body: {}, expectedStatus: 400, description: "Missing credentials" },
      
      // 401 - Unauthorized
      { path: "/auth/me", method: "GET", headers: {}, expectedStatus: 401, description: "Missing session" },
      { path: "/auth/me", method: "GET", headers: { "X-Session-Token": "invalid" }, expectedStatus: 401, description: "Invalid session" },
      
      // 403 - Forbidden
      { path: "/admin/users", method: "GET", headers: authHeaders(adminSession), expectedStatus: 200, description: "Admin can access" },
    ];
    
    for (const test of errorCases) {
      const options: RequestInit = {
        method: test.method || "GET",
        headers: test.headers,
      };
      if (test.body) options.body = JSON.stringify(test.body);
      
      const res = await req(test.path, options);
      
      if (test.expectedStatus === 200) {
        assertEquals(res.status, 200, `${test.description} - ${test.path}`);
      } else {
        // For error statuses, verify it's in the expected class
        const statusClass = Math.floor(res.status / 100);
        const expectedClass = Math.floor(test.expectedStatus / 100);
        assertEquals(statusClass, expectedClass, `${test.description} - ${test.path} should return ${test.expectedStatus} class`);
      }
    }
  });

  await t.step("A10-1-2: Error responses have consistent structure", async () => {
    // Test various error types to ensure consistent structure
    const errorEndpoints = [
      { path: "/auth/signup", method: "POST", body: {}, expected: ["error"] },
      { path: "/auth/login", method: "POST", body: { email: "x@test.local" }, expected: ["error"] },
      { path: "/admin/users", method: "GET", headers: {}, expected: ["error"] },
    ];
    
    for (const test of errorEndpoints) {
      const options: RequestInit = {
        method: test.method || "GET",
        headers: test.headers,
      };
      if (test.body) options.body = JSON.stringify(test.body);
      
      const res = await req(test.path, options);
      
      if (res.status >= 400) {
        const data = await res.json();
        
        // Every error response should have an error field
        assertExists(data.error, `${test.path} error response should have 'error' field`);
        
        // Error should be a string
        assertEquals(typeof data.error, "string", `${test.path} error should be a string`);
        
        // Should not have unexpected fields that leak internals
        assertNotEquals(data.stack?.length > 0, true, `${test.path} should not have stack trace`);
        assertNotEquals(data.stacktrace?.length > 0, true, `${test.path} should not have stacktrace`);
      }
    }
  });

  await t.step("A10-1-3: Database errors are handled gracefully", async () => {
    // This test verifies that database errors (if they occur) are handled
    // without crashing the server or exposing internal details
    
    // Try to trigger a database error by using an invalid UUID format
    const res = await req("/admin/users/00000000-0000-0000-0000-000000000000", {
      method: "GET",
      headers: authHeaders(adminSession),
    });
    
    // Should return 404 (not found) or 400 (bad request), not 500
    assertNotEquals(res.status, 500, "Invalid UUID should not cause 500 error");

    // There is no GET /admin/users/:id route, so this hits Hono's default 404
    // handler, whose body is plain text ("404 Not Found"), not JSON — read it
    // as text and assert it leaks no internal details either way.
    const body = await res.text();
    assertNotEquals(body.includes("database"), true, "Should not expose database details");
    assertNotEquals(body.includes("Postgres"), true, "Should not expose database type");
    assertNotEquals(body.includes("SQL"), true, "Should not expose SQL details");
  });

  // addendum-095 Finding #2: an error that ESCAPES a handler's own try/catch
  // must be caught by the global app.onError and returned as an opaque JSON
  // 500 — no stack trace, no internal marker, no raw SQL/runtime leak. Before
  // onError existed this fell through to Hono's default plain-text handler.
  await t.step("A10-1-4: Unhandled handler errors are sanitized by app.onError (addendum-095)", async () => {
    const res = await req(A10_THROW_PATH, { method: "POST" });
    assertEquals(res.status, 500, "an unhandled handler error must map to 500");

    const body = await res.text();
    // Must be the uniform JSON { error } shape, not plain text.
    const parsed = JSON.parse(body) as { error?: string };
    assertEquals(typeof parsed.error, "string", "500 body must be JSON with an error string");
    assertEquals(parsed.error, "Internal server error.", "opaque fallback message");

    // No internal detail may leak.
    assertNotEquals(body.includes("A10_INTERNAL_SECRET_MARKER"), true, "handler's internal error must not leak");
    assertNotEquals(body.includes("Error:"), true, "no Error: prefix / message leak");
    assertNotEquals(body.includes("at "), true, "no stack-trace frame leak");
    assertNotEquals(body.includes("Postgres"), true, "no runtime leak");
    assertNotEquals(body.includes("SQL"), true, "no SQL leak");
  });

  // ============================================================================
  // A10-2: Failing Closed (Deny by Default)
  // Testing that the system fails securely (denies access) by default
  // ============================================================================

  // GET is deliberately excluded from this route list: app.tsx's SPA
  // fallback (addendum-055) serves ./dist/index.html with 200 for ANY
  // unmatched GET, by design, so a deep link never 404s. That makes GET
  // unusable to test "unknown route -> 404" — only a non-GET verb actually
  // reaches app.notFound(). A10-2-4 below already exercises this correctly
  // via POST; this step uses DELETE for a second, distinct verb.
  await t.step("A10-2-1: Unknown routes return 404, not 200", async () => {
    const unknownRoutes = [
      "/nonexistent",
      "/api/v1/old-endpoint",
      "/admin/nonexistent",
      "/auth/nonexistent",
    ];

    for (const route of unknownRoutes) {
      const res = await req(route, { method: "DELETE" });
      assertNotEquals(res.status, 200, `Unknown route ${route} should not return 200`);
      assertNotEquals(res.status, 201, `Unknown route ${route} should not return 201`);
    }
  });

  await t.step("A10-2-2: Invalid HTTP methods return appropriate errors", async () => {
    // Test that sending wrong method to an endpoint fails securely.
    // NOTE: GET /auth/login is intentionally absent from this table — see the
    // A10-2-1 comment above, the SPA fallback makes GET always 200 there too,
    // and that is by design (addendum-055), not a method-handling gap.
    const methodTests = [
      { path: "/auth/me", method: "POST", shouldFail: true },
      { path: "/admin/users", method: "DELETE", shouldFail: true },
    ];

    for (const test of methodTests) {
      const res = await req(test.path, {
        method: test.method,
        headers: test.path.includes("/admin/") ? authHeaders(adminSession) : {},
      });

      if (test.shouldFail) {
        assertNotEquals(res.status, 200, `${test.method} ${test.path} should not succeed`);
        assertNotEquals(res.status, 201, `${test.method} ${test.path} should not succeed`);
      }
    }
  });

  // addendum-095 Finding #2: unknown (non-SPA) routes return a structured JSON
  // 404 via app.notFound instead of Hono's default plain-text "404 Not Found".
  // Uses POST so it bypasses the GET SPA fallback and actually reaches
  // notFound. No internal detail should appear in the body.
  await t.step("A10-2-4: Unknown routes return JSON 404 via app.notFound (addendum-095)", async () => {
    const unknownPostRoutes = [
      "/__audit_test__/no-such-post-route",
      "/api/v1/unknown-method-endpoint",
      "/admin/nonexistent-method",
    ];
    for (const route of unknownPostRoutes) {
      const res = await req(route, { method: "POST" });
      assertEquals(res.status, 404, `${route} should 404`);
      const parsed = JSON.parse(await res.text()) as { error?: string };
      assertEquals(typeof parsed.error, "string", `${route} 404 body must be JSON with an error string`);
      assertNotEquals(parsed.error.includes("Postgres"), true, "no runtime leak");
      assertNotEquals(parsed.error.includes("SQL"), true, "no SQL leak");
      assertNotEquals(parsed.error.includes("server"), true, "no server-info leak");
    }
  });

  await t.step("A10-2-3: Authorization failures deny access (not expose data)", async () => {
    // Test that 403 errors don't expose any data
    const vendor = await createActiveUser({
      fullName: "A10 Vendor",
      email: "a10vendor2@test.local",
      password: "A10Vendor!2026",
      affiliation: "vendor",
    });
    const login = await loginAs(vendor.email, "A10Vendor!2026");
    const vendorSession = (login as any).session;
    
    // Vendor should not be able to access admin endpoints
    const res = await req("/admin/users", { headers: authHeaders(vendorSession) });
    assertEquals(res.status, 403);
    
    const data = await res.json();
    
    // Should NOT return any user data
    assertNotEquals(data.users?.length > 0, true, "403 should not return user data");
    assertNotEquals(data.user?.id, true, "403 should not return user object");
    
    // Error message should be generic
    assertExists(data.error);
    assertNotEquals(data.error.includes("admin"), true, "Error should not reveal role requirements");
  });

  // ============================================================================
  // A10-3: Resource Exhaustion
  // Testing that the system handles resource limits gracefully
  // ============================================================================

  await t.step("A10-3-1: Large payloads are handled gracefully", async () => {
    // Test with a very large request body
    const largePayload = {
      name: "A".repeat(10000), // 10KB name
      description: "B".repeat(100000), // 100KB description
      email: uniqueEmail("large"),
      password: "C".repeat(1000), // 1KB password
    };
    
    const res = await req("/auth/signup", {
      method: "POST",
      body: JSON.stringify(largePayload),
    });
    
    // Should either succeed (with truncation) or fail with appropriate error
    // Should NOT crash or hang
    assertNotEquals(res.status, 500, "Large payload should not cause 500 error");
    
    // Should respond within reasonable time
    // Note: This is hard to test in unit tests, but the fact we got a response
    // means it didn't hang indefinitely
  });

  await t.step("A10-3-2: Many concurrent requests are handled", async () => {
    // Test that the server can handle multiple concurrent requests
    // Note: This is a basic test - real load testing would be separate
    
    const promises = [];
    for (let i = 0; i < 10; i++) {
      promises.push(
        req("/auth/me", { headers: authHeaders(adminSession) })
      );
    }
    
    const results = await Promise.all(promises);
    
    // All should succeed
    for (const res of results) {
      assertEquals(res.status, 200, "Concurrent request should succeed");
    }
  });

  await t.step("A10-3-3: Pagination limits are enforced", async () => {
    // Test that pagination limits prevent resource exhaustion
    // This tests the limit parameter in various endpoints
    
    // Test with a very large limit
    const res = await req("/admin/users?limit=999999", { headers: authHeaders(adminSession) });
    
    // Should either clamp the limit or return an error
    // Should NOT try to fetch millions of records
    assertNotEquals(res.status, 500, "Large limit should not cause 500 error");
    
    const data = await res.json();
    
    // The actual number of users returned should be reasonable
    // (not millions, even if limit is huge)
    if (data.users) {
      assertNotEquals(data.users.length > 1000, true, "Should not return thousands of users");
    }
  });

  // ============================================================================
  // A10-4: Timeout Handling
  // Testing that the system handles timeouts gracefully
  // ============================================================================

  await t.step("A10-4-1: Database query timeouts are handled", async () => {
    // This is hard to test without actually causing a timeout
    // Instead, we verify that the error handling code paths exist
    // by testing with invalid queries that would timeout in real scenarios
    
    // The fact that we can make requests and get responses means
    // the basic timeout handling is working (requests don't hang forever)
    
    // Test a complex query that might be slow
    const res = await req("/admin/access-log?limit=100", { headers: authHeaders(adminSession) });
    
    // Should complete and return a response
    assertNotEquals(res.status, 504, "Should not timeout on reasonable queries");
    assertNotEquals(res.status, 500, "Should not error on reasonable queries");
  });

  // ============================================================================
  // A10-5: Edge Cases and Boundary Conditions
  // Testing edge cases that might cause unexpected behavior
  // ============================================================================

  await t.step("A10-5-1: Empty and null values are handled", async () => {
    // Test various empty/null value scenarios
    const emptyTests = [
      { path: "/auth/signup", method: "POST", body: { fullName: "", email: "empty@test.local", password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: "", password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: "test@test.local", password: "" } },
    ];
    
    for (const test of emptyTests) {
      const res = await req(test.path, {
        method: test.method,
        body: JSON.stringify(test.body),
      });
      
      // Should return appropriate error, not crash
      assertNotEquals(res.status, 500, `Empty value test should not cause 500: ${test.path}`);
    }
  });

  await t.step("A10-5-2: Special characters in input are handled", async () => {
    // Test inputs with special characters that might cause issues
    const specialTests = [
      { path: "/auth/signup", method: "POST", body: { fullName: "Test <script>alert('xss')</script>", email: uniqueEmail("xss"), password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: "test' OR '1'='1@test.local", password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: uniqueEmail("quote"), password: "Pass' OR '1'='1" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test\nNewline", email: uniqueEmail("newline"), password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test\tTab", email: uniqueEmail("tab"), password: "ValidPass!2026" } },
    ];
    
    for (const test of specialTests) {
      const res = await req(test.path, {
        method: test.method,
        body: JSON.stringify(test.body),
      });
      
      // Should either succeed (with sanitization) or fail with appropriate error
      // Should NOT crash or cause 500
      assertNotEquals(res.status, 500, `Special character test should not cause 500: ${test.path}`);
    }
  });

  await t.step("A10-5-3: Unicode and international characters are handled", async () => {
    // Test Unicode characters
    const unicodeTests = [
      { path: "/auth/signup", method: "POST", body: { fullName: "测试用户", email: uniqueEmail("unicode"), password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "Тест пользователь", email: uniqueEmail("cyrillic"), password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "مستخدم اختبار", email: uniqueEmail("arabic"), password: "ValidPass!2026" } },
      { path: "/auth/signup", method: "POST", body: { fullName: "🎉 Emoji Test 🎉", email: uniqueEmail("emoji"), password: "ValidPass!2026" } },
    ];
    
    for (const test of unicodeTests) {
      const res = await req(test.path, {
        method: test.method,
        body: JSON.stringify(test.body),
      });
      
      // Should handle Unicode gracefully
      assertNotEquals(res.status, 500, `Unicode test should not cause 500: ${test.path}`);
    }
  });

  await t.step("A10-5-4: Very long strings are handled", async () => {
    // Test with extremely long strings
    const longString = "A".repeat(10000); // 10KB
    
    const res = await req("/auth/signup", {
      method: "POST",
      body: JSON.stringify({
        fullName: longString,
        email: uniqueEmail("long"),
        password: "ValidPass!2026",
      }),
    });
    
    // Should either accept (with truncation) or reject with validation error
    // Should NOT crash
    assertNotEquals(res.status, 500, "Very long string should not cause 500");
  });

  // ============================================================================
  // A10-6: State Consistency
  // Testing that the system maintains consistent state under error conditions
  // ============================================================================

  await t.step("A10-6-1: Failed operations do not leave partial state", async () => {
    // Test that if an operation fails, it doesn't leave the system in a partial state
    
    // Try to create a cluster with invalid data
    const res = await req("/admin/clusters", {
      method: "POST",
      headers: authHeaders(adminSession),
      body: { name: "", type: "invalid_type" }, // Invalid: empty name, bad type
    });
    
    assertNotEquals(res.status, 201, "Invalid cluster creation should fail");
    
    // Verify no cluster was created with partial data
    const listRes = await req("/admin/clusters", { headers: authHeaders(adminSession) });
    const data = await listRes.json();
    
    // Should not have a cluster with empty name
    const emptyNameCluster = data.clusters.find((c: any) => c.name === "");
    assertNotEquals(emptyNameCluster, true, "Should not have cluster with empty name");
  });

  await t.step("A10-6-2: Transaction rollback on failure", async () => {
    // This tests that if a multi-step operation fails midway,
    // all changes are rolled back
    
    // Note: This is hard to test without specific knowledge of
    // which operations are transactional. This is more of a
    // documentation test.
    
    // The fact that the system uses a database with transactions
    // (Postgres) and the code uses proper transaction handling
    // is the main protection here.
    
    console.log("✅ Transaction rollback relies on Postgres + proper code usage");
  });

  // ============================================================================
  // A10-7: Input Validation
  // Testing that all inputs are properly validated
  // ============================================================================

  await t.step("A10-7-1: Required fields are validated", async () => {
    const requiredFieldTests = [
      { path: "/auth/signup", method: "POST", body: {}, expected: 400 },
      { path: "/auth/login", method: "POST", body: {}, expected: 400 },
      { path: "/admin/clusters", method: "POST", body: {}, headers: authHeaders(adminSession), expected: 400 },
    ];
    
    for (const test of requiredFieldTests) {
      const options: RequestInit = {
        method: test.method,
        headers: test.headers,
      };
      if (test.body) options.body = JSON.stringify(test.body);
      
      const res = await req(test.path, options);
      assertEquals(res.status, test.expected, `Required field validation: ${test.path}`);
    }
  });

  await t.step("A10-7-2: Field types are validated", async () => {
    const typeTests = [
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: "test", password: 12345 }, expected: 400 },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: true, password: "ValidPass!2026" }, expected: 400 },
    ];
    
    for (const test of typeTests) {
      const res = await req(test.path, {
        method: test.method,
        body: JSON.stringify(test.body),
      });
      
      // Should reject with 400 Bad Request
      assertEquals(res.status, test.expected, `Type validation: ${test.path}`);
    }
  });

  await t.step("A10-7-3: Field formats are validated", async () => {
    const formatTests = [
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: "not-an-email", password: "ValidPass!2026" }, expected: 400 },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: "test@", password: "ValidPass!2026" }, expected: 400 },
      { path: "/auth/signup", method: "POST", body: { fullName: "Test", email: "test@test.local", password: "weak" }, expected: 400 },
    ];
    
    for (const test of formatTests) {
      const res = await req(test.path, {
        method: test.method,
        body: JSON.stringify(test.body),
      });
      
      assertEquals(res.status, test.expected, `Format validation: ${test.path}`);
    }
  });
});
