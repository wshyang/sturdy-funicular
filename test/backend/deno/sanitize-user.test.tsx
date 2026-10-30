// Guards the single secret-strip point for User (server/utils.tsx sanitizeUser).
// Before consolidation, several route handlers hand-rolled the destructure and
// a few omitted totpSecret entirely — a real leak on GET /admin/users (pending),
// GET /teams/:id/eligible-members, and GET /teams/:id/members. These assertions
// pin the invariant: NO secret field ever survives, and totpEnrolled is always
// derived. See plan_refactor.md audit 2026-07-28.
import { assertEquals } from "jsr:@std/assert";
import { sanitizeUser } from "../../../server/utils.tsx";
import type { User } from "../../../server/types.tsx";

function fullUser(overrides: Partial<User> = {}): User {
  return {
    id: "00000000-0000-7000-8000-0000000000aa",
    fullName: "Test User",
    email: "test@example.gov",
    passwordHash: "SUPER_SECRET_HASH",
    passwordSalt: "SUPER_SECRET_SALT",
    role: null,
    affiliation: "vendor",
    status: "active",
    approvedBy: null,
    approvedAt: null,
    tombstonedBy: null,
    tombstonedAt: null,
    untombstonedBy: null,
    untombstonedAt: null,
    lastLoginAt: null,
    totpSecret: "BASE32SECRET",
    totpEnrolledAt: "2026-07-01T00:00:00.000Z",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

Deno.test("sanitizeUser strips all secret material", () => {
  const safe = sanitizeUser(fullUser());
  // The three secret fields must be gone entirely (not just undefined).
  assertEquals("passwordHash" in safe, false, "passwordHash must be stripped");
  assertEquals("passwordSalt" in safe, false, "passwordSalt must be stripped");
  assertEquals("totpSecret" in safe, false, "totpSecret must be stripped");
});

Deno.test("sanitizeUser derives totpEnrolled from an enrolled secret", () => {
  const safe = sanitizeUser(fullUser({ totpSecret: "BASE32SECRET" }));
  assertEquals(safe.totpEnrolled, true);
});

Deno.test("sanitizeUser derives totpEnrolled=false when no secret set", () => {
  assertEquals(sanitizeUser(fullUser({ totpSecret: null })).totpEnrolled, false);
  assertEquals(sanitizeUser(fullUser({ totpSecret: undefined })).totpEnrolled, false);
});

Deno.test("sanitizeUser preserves non-secret fields verbatim", () => {
  const safe = sanitizeUser(fullUser());
  assertEquals(safe.id, "00000000-0000-7000-8000-0000000000aa");
  assertEquals(safe.email, "test@example.gov");
  assertEquals(safe.affiliation, "vendor");
  assertEquals(safe.status, "active");
});
