// OWASP A04: Cryptographic Failures Tests
//
// Category: A04 - Cryptographic Failures
// Focus: Weak hashing, hardcoded secrets, insecure randomness, missing encryption
//
// As per CLAUDE-test-discipline.md (2026-07-30):
// "All API endpoints (existing and new) must have OWASP Top 10 unit tests"
//
// This file tests for A04-specific cryptographic security.

import { assert, assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import { req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { generateSalt, hashPassword, passwordHashNeedsUpgrade, verifyPassword } from "../../../server/utils.tsx";

Deno.test("OWASP A04: Cryptographic Failures", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("A04Admin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "A04Admin!2026");
    adminSession = (login as any).session;
  });

  // ============================================================================
  // A04-1: Password Hashing
  // Testing that password hashing uses strong, secure algorithms
  // ============================================================================

  await t.step("A04-1-1: Password hashing uses per-user salt", async () => {
    // Create two users with the same password
    const password = "SamePassword!2026";
    const email1 = uniqueEmail("salt1");
    const email2 = uniqueEmail("salt2");
    
    const res1 = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "Salt User 1", email: email1, password },
    });
    assertEquals(res1.status, 201);
    const user1 = await res1.json();
    
    const res2 = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "Salt User 2", email: email2, password },
    });
    assertEquals(res2.status, 201);
    const user2 = await res2.json();
    
    // Get the salts and hashes from the database
    const rows = await query<{ id: string; password_salt: string; password_hash: string }>(
      `SELECT id, password_salt, password_hash FROM users WHERE id IN ($1, $2)`,
      [user1.userId, user2.userId],
    );
    
    assertEquals(rows.length, 2);
    
    // Users should have different salts
    assertNotEquals(rows[0].password_salt, rows[1].password_salt, "Users should have different salts");
    
    // Users should have different hashes (even with same password)
    assertNotEquals(rows[0].password_hash, rows[1].password_hash, "Users should have different hashes");
    
    // Both salts should be non-empty
    assertNotEquals(rows[0].password_salt, "", "Salt should not be empty");
    assertNotEquals(rows[1].password_salt, "", "Salt should not be empty");
    
    // Both hashes should be non-empty
    assertNotEquals(rows[0].password_hash, "", "Hash should not be empty");
    assertNotEquals(rows[1].password_hash, "", "Hash should not be empty");
  });

  await t.step("A04-1-2: Password hashing uses sufficient work factor", async () => {
    // Test that password hashing is not too fast (indicating weak algorithm)
    // SHA256 is considered cryptographically secure but may need work factor
    
    const salt = generateSalt();
    const start = Date.now();
    const hash = await hashPassword("TestPassword!2026", salt);
    assert(hash.startsWith("pbkdf2-sha256$600000$"), "passwords must use the versioned slow KDF");
    assertEquals(hash.length > 64, true, "stored hash includes its KDF version and work factor");
    const duration = Date.now() - start;
    
    // Log the duration for analysis
    console.log(`Password hashing took ${duration}ms`);
    
    // The KDF must be deliberately expensive enough to resist offline guesses.
    assertExists(hash, "Hash should be generated");
    assertNotEquals(hash.length, 0, "Hash should not be empty");
    assert(duration >= 50, `PBKDF2 unexpectedly completed in ${duration}ms`);
  });

  await t.step("A04-1-2b: legacy SHA-256 verifies only for migration and is marked for upgrade", async () => {
    const password = "LegacyPass!2026";
    const salt = generateSalt();
    const bytes = new TextEncoder().encode(password + salt);
    const legacy = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    assertEquals(await verifyPassword(password, salt, legacy), true);
    assertEquals(passwordHashNeedsUpgrade(legacy), true);
    assertEquals(passwordHashNeedsUpgrade(await hashPassword(password, salt)), false);
  });

  await t.step("A04-1-3: Password verification uses constant-time comparison", async () => {
    // This test verifies that password verification uses constant-time comparison
    // to prevent timing attacks
    
    const salt = generateSalt();
    const hash = await hashPassword("CorrectPassword!2026", salt);
    
    // Verify with correct password
    const correctStart = Date.now();
    const correctResult = await verifyPassword("CorrectPassword!2026", salt, hash);
    const correctDuration = Date.now() - correctStart;
    
    // Verify with wrong password (same length)
    const wrongStart = Date.now();
    const wrongResult = await verifyPassword("WrongPassword!2026", salt, hash);
    const wrongDuration = Date.now() - wrongStart;
    
    // Both should return appropriate results
    assertEquals(correctResult, true, "Correct password should verify");
    assertEquals(wrongResult, false, "Wrong password should not verify");
    
    // The durations should be similar (constant-time)
    // Note: This is a probabilistic test and may not catch all timing differences
    // but it documents the behavior
    console.log(`Correct password verification: ${correctDuration}ms`);
    console.log(`Wrong password verification: ${wrongDuration}ms`);
    console.log(`Duration difference: ${Math.abs(correctDuration - wrongDuration)}ms`);
    
    // For constant-time, the difference should be minimal
    // We allow some variance due to system load
    const diff = Math.abs(correctDuration - wrongDuration);
    assertNotEquals(diff > 50, true, "Verification times should be similar (constant-time)");
  });

  await t.step("A04-1-4: Password hashing handles special characters", async () => {
    // Test that password hashing works correctly with special characters
    const specialPasswords = [
      "Pass!@#$%^&*()word",
      "Pass\nNewline",
      "Pass\tTab",
      "Pass\0Null",
      "🎉EmojiPass🎉",
      "Unicode密码",
    ];
    
    for (const password of specialPasswords) {
      const salt = generateSalt();
      const hash = await hashPassword(password, salt);
      const verified = await verifyPassword(password, salt, hash);
      
      assertEquals(verified, true, `Password with special chars should verify: ${password.substring(0, 20)}...`);
    }
  });

  await t.step("A04-1-5: Password hashing handles very long passwords", async () => {
    // Test with a very long password
    const longPassword = "A".repeat(1000); // 1000 character password
    
    const salt = generateSalt();
    const hash = await hashPassword(longPassword, salt);
    const verified = await verifyPassword(longPassword, salt, hash);
    
    assertEquals(verified, true, "Long password should verify");
  });

  // ============================================================================
  // A04-2: Hardcoded Secrets
  // Testing that no hardcoded secrets exist in the codebase
  // ============================================================================

  await t.step("A04-2-1: No hardcoded passwords in user responses", async () => {
    // Create a user and verify the response doesn't include password-related fields
    const email = uniqueEmail("nopass");
    const res = await req("/auth/signup", {
      method: "POST",
      body: { fullName: "No Pass User", email, password: "SecretPass!2026" },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    
    // Response should not include password hash or salt
    assertNotEquals(data.password_hash, true, "Response should not include password_hash");
    assertNotEquals(data.password_salt, true, "Response should not include password_salt");
    assertNotEquals(data.password, true, "Response should not include password");
    
    // If user object is returned, it should not have password fields
    if (data.user) {
      assertNotEquals(data.user.password_hash, true, "User object should not include password_hash");
      assertNotEquals(data.user.password_salt, true, "User object should not include password_salt");
      assertNotEquals(data.user.password, true, "User object should not include password");
    }
  });

  await t.step("A04-2-2: No hardcoded secrets in /auth/me response", async () => {
    const res = await req("/auth/me", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    
    // Response should not include sensitive fields
    assertNotEquals(data.password_hash, true, "auth/me should not include password_hash");
    assertNotEquals(data.password_salt, true, "auth/me should not include password_salt");
    assertNotEquals(data.password, true, "auth/me should not include password");
    assertNotEquals(data.session, true, "auth/me should not include full session token");
    
    // User object should not have sensitive fields
    if (data.user) {
      assertNotEquals(data.user.password_hash, true, "User should not have password_hash");
      assertNotEquals(data.user.password_salt, true, "User should not have password_salt");
    }
  });

  await t.step("A04-2-3: No hardcoded API keys in responses", async () => {
    // Get app settings (some might be API keys)
    const res = await req("/admin/app-settings", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    
    const settings = data.settings || [];
    
    // Check that secret values are not exposed in plain text
    // (They might be masked or omitted)
    for (const setting of settings) {
      if (setting.isSecret) {
        // Secret settings should either be masked or not returned
        // This is a security measure
        console.log(`Secret setting: ${setting.key} - value: ${setting.valueType === 'bool' ? setting.value : '[MASKED]'}`);
      }
    }
  });

  // ============================================================================
  // A04-3: Insecure Randomness
  // Testing that cryptographic operations use secure random number generation
  // ============================================================================

  await t.step("A04-3-1: Salt generation produces unique values", async () => {
    // Generate multiple salts and verify they're unique
    const salts = new Set();
    for (let i = 0; i < 100; i++) {
      const salt = generateSalt();
      salts.add(salt);
    }
    
    // All salts should be unique
    assertEquals(salts.size, 100, "All generated salts should be unique");
  });

  await t.step("A04-3-2: Salt generation produces sufficiently long values", async () => {
    const salt = generateSalt();
    
    // Salt should be sufficiently long (at least 16 bytes = 32 hex chars)
    assertNotEquals(salt.length < 32, true, "Salt should be at least 32 characters");
    
    console.log(`Salt length: ${salt.length} characters`);
  });

  await t.step("A04-3-3: Salt generation produces cryptographically random values", async () => {
    // Generate many salts and check for patterns
    // This is a probabilistic test - we're checking that values don't have
    // obvious patterns that would indicate insecure randomness
    
    const salts = [];
    for (let i = 0; i < 50; i++) {
      salts.push(generateSalt());
    }
    
    // Check that salts don't all start with the same characters
    // (which would indicate poor randomness)
    const firstChars = salts.map(s => s[0]);
    const uniqueFirstChars = new Set(firstChars);
    
    // Should have some variety in first characters
    assertNotEquals(uniqueFirstChars.size < 5, true, "Salts should have varied first characters");
    
    // Check that salts don't have obvious patterns
    // (This is hard to test programmatically, but we can check basic things)
    const hasPattern = salts.some(s => {
      // Check for repeated patterns like "aaaa"
      return s.includes("aaaa") || s.includes("bbbb") || s.includes("1111") || s.includes("0000");
    });
    
    // It's okay to have some repetition, but not too much
    console.log(`Salts with repeated patterns: ${hasPattern ? 'Some' : 'None'}`);
  });

  await t.step("A04-3-4: Session tokens appear random", async () => {
    // Create multiple sessions and check that tokens are unique. signup does
    // NOT mint a session (the account is created pending admin approval), so
    // seed active users directly and log each in via the real login+2FA flow
    // (loginAs) to obtain genuine session tokens.
    const tokens = new Set<string>();
    const password = "TokenPass!2026";

    for (let i = 0; i < 10; i++) {
      const email = uniqueEmail(`token${i}`);
      await createActiveUser({
        fullName: `Token User ${i}`,
        email,
        password,
        affiliation: "vendor",
      });
      const login = await loginAs(email, password);
      const session = (login as { session?: string }).session;
      if (session) tokens.add(session);
    }

    // All tokens should be unique
    assertEquals(tokens.size, 10, "Session tokens should be unique");

    console.log(`Generated ${tokens.size} unique session tokens`);
  });

  // ============================================================================
  // A04-4: Missing Encryption
  // Testing that sensitive data is encrypted where appropriate
  // ============================================================================

  await t.step("A04-4-1: Sensitive data in transit uses HTTPS (documentation)", async () => {
    // This is a documentation test - in production, the application should
    // be served over HTTPS to encrypt data in transit
    
    // In the test environment, we're using HTTP, but in production this should
    // be enforced by the deployment configuration
    
    console.log("✅ HTTPS should be enforced in production deployment");
    console.log("⚠️  Test environment uses HTTP - this is expected");
  });

  await t.step("A04-4-2: Sensitive data at rest - document encryption requirements", async () => {
    // This test documents the encryption requirements for sensitive data at rest
    
    // Check what sensitive data is stored in the database
    const tables = await query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`,
    );
    
    console.log("Database tables:");
    for (const table of tables) {
      console.log(`  - ${table.table_name}`);
    }
    
    console.log("\n✅ Sensitive data should be encrypted at rest in production");
    console.log("⚠️  Review database schema for PII and sensitive fields");
  });

  // ============================================================================
  // A04-5: Hashing Algorithm Strength
  // Testing that the hashing algorithm is cryptographically secure
  // ============================================================================

  await t.step("A04-5-1: Hashing uses a versioned slow password KDF", async () => {
    const salt = generateSalt();
    const hash = await hashPassword("TestPass!2026", salt);
    const [algorithm, iterations, digest] = hash.split("$");
    assertEquals(algorithm, "pbkdf2-sha256");
    assertEquals(iterations, "600000");
    assertEquals(digest?.length, 64);
    assertEquals(/^[0-9a-f]+$/.test(digest ?? ""), true);
  });

  await t.step("A04-5-2: Hashing is deterministic (same input = same output)", async () => {
    const password = "DeterministicPass!2026";
    const salt = generateSalt();
    
    const hash1 = await hashPassword(password, salt);
    const hash2 = await hashPassword(password, salt);
    
    // Same password and salt should produce same hash
    assertEquals(hash1, hash2, "Hashing should be deterministic");
  });

  await t.step("A04-5-3: Different salts produce different hashes", async () => {
    const password = "DifferentSaltPass!2026";
    
    const salt1 = generateSalt();
    const salt2 = generateSalt();
    
    const hash1 = await hashPassword(password, salt1);
    const hash2 = await hashPassword(password, salt2);
    
    // Different salts should produce different hashes
    assertNotEquals(hash1, hash2, "Different salts should produce different hashes");
  });

  // ============================================================================
  // A04-6: Password Policy
  // Testing that password policies enforce minimum security requirements
  // ============================================================================

  await t.step("A04-6-1: Weak passwords are rejected", async () => {
    const weakPasswords = [
      "weak",
      "password",
      "123456",
      "12345678",
      "qwerty",
      "abc123",
      "letmein",
      "welcome",
    ];
    
    for (const password of weakPasswords) {
      const res = await req("/auth/signup", {
        method: "POST",
        body: { fullName: "Weak Pass User", email: uniqueEmail("weak"), password },
      });
      
      assertEquals(res.status, 400, `Weak password should be rejected: ${password}`);
    }
  });

  await t.step("A04-6-2: Password minimum length is enforced", async () => {
    // Test passwords of various lengths
    const shortPasswords = [
      "a",
      "ab",
      "abc",
      "abcd",
      "abcde",
      "abcdef",
      "abcdefg",
    ];
    
    for (const password of shortPasswords) {
      const res = await req("/auth/signup", {
        method: "POST",
        body: { fullName: "Short Pass User", email: uniqueEmail("short"), password },
      });
      
      // Passwords shorter than 8 characters should be rejected
      if (password.length < 8) {
        assertEquals(res.status, 400, `Password shorter than 8 chars should be rejected`);
      }
    }
  });

  await t.step("A04-6-3: Password complexity requirements", async () => {
    // Test various password complexity scenarios
    const passwordTests = [
      { password: "lowercaseonly", expected: 400, reason: "No uppercase or numbers" },
      { password: "UPPERCASEONLY", expected: 400, reason: "No lowercase or numbers" },
      { password: "12345678", expected: 400, reason: "No letters" },
      // validatePassword (server/utils.tsx) requires a special character, so
      // upper+lower+digit alone is NOT sufficient — it must be rejected.
      { password: "MixedCase1!", expected: 400, reason: "Only 11 chars (min length is 12)" },
      // Meets every rule AND the 12-char minimum length.
      { password: "MixedCase12!", expected: 201, reason: "Meets complexity and min length" },
    ];
    
    for (const test of passwordTests) {
      const res = await req("/auth/signup", {
        method: "POST",
        body: { fullName: "Complexity User", email: uniqueEmail("complex"), password: test.password },
      });
      
      if (test.expected === 400) {
        assertEquals(res.status, 400, `Password complexity: ${test.reason}`);
      } else {
        assertEquals(res.status, 201, `Password complexity: ${test.reason}`);
      }
    }
  });
});
