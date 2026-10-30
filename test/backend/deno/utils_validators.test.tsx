// Pure-function contracts for server/utils.tsx's validation + formatting
// helpers, and server/route-helpers.tsx's routeError.
//
// These are high fan-in helpers that were previously only exercised
// INDIRECTLY, through routes that happened to call them:
//   * routeError sits in ~67 route catch-blocks and maps error CLASSES to
//     status codes — a regression there silently converts a 400 into a 500
//     (or worse, a 403 into a 200-shaped 500) across the whole API.
//   * isSafeIdentifier is the single SQL-identifier guard (addendum-095
//     Finding #13); it is called at every identifier-interpolation site, so
//     it needs direct adversarial cases, not incidental coverage.
//   * The validate*/generate* helpers encode boundary rules (1-100 chars,
//     <=500 chars, zero-padding widths) that no route test pins exactly.
//
// No database, no HTTP fixtures — these run in milliseconds and stay green
// even when Postgres is unavailable.
import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import {
  AuthorizationError,
  NotFoundError,
  ValidationError,
  generateRequestNumber,
  generateTempPassword,
  isAffiliationTeamTypeCompatible,
  isProtectedUser,
  isSafeIdentifier,
  passwordHashNeedsUpgrade,
  validateEmail,
  validateName,
  validateOptionalText,
  validateStringField,
} from "../../../server/utils.tsx";
import { routeError } from "../../../server/route-helpers.tsx";

// Minimal Hono-Context stand-in: routeError only ever calls c.json(body, status).
function fakeContext() {
  return {
    json(body: unknown, status = 200) {
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    },
  } as never;
}

async function readError(res: Response): Promise<string> {
  return ((await res.json()) as { error: string }).error;
}

Deno.test("routeError maps error classes to status codes", async (t) => {
  // Silence the intentional console.error from the 500 branch so the test
  // output stays readable; restored in the final step.
  const realError = console.error;

  await t.step("AuthorizationError -> 403 with its own message", async () => {
    const res = routeError(fakeContext(), new AuthorizationError("Admin access required."), "ctx:");
    assertEquals(res.status, 403);
    assertEquals(await readError(res), "Admin access required.");
  });

  await t.step("ValidationError -> 400 with its own message", async () => {
    const res = routeError(fakeContext(), new ValidationError("Name is required."), "ctx:");
    assertEquals(res.status, 400);
    assertEquals(await readError(res), "Name is required.");
  });

  await t.step("NotFoundError -> 404 with its own message (org-scope disguise)", async () => {
    const res = routeError(fakeContext(), new NotFoundError("System not found."), "ctx:");
    assertEquals(res.status, 404);
    assertEquals(await readError(res), "System not found.");
  });

  await t.step("negative: an unexpected error -> 500 and NEVER leaks its message", async () => {
    console.error = () => {};
    try {
      const leaky = new Error("connection string postgres://user:hunter2@db/prod");
      const res = routeError(fakeContext(), leaky, "ctx:");
      assertEquals(res.status, 500);
      const body = await readError(res);
      assertEquals(body, "An error occurred.");
      assert(!body.includes("hunter2"), "internal detail must not reach the client");
    } finally {
      console.error = realError;
    }
  });

  await t.step("negative: a custom fallback replaces the opaque default", async () => {
    console.error = () => {};
    try {
      const res = routeError(fakeContext(), new Error("boom"), "ctx:", "Reset-seed failed.");
      assertEquals(res.status, 500);
      assertEquals(await readError(res), "Reset-seed failed.");
    } finally {
      console.error = realError;
    }
  });

  await t.step("negative: a non-Error throw still yields the opaque 500", async () => {
    console.error = () => {};
    try {
      const res = routeError(fakeContext(), "a bare string throw", "ctx:");
      assertEquals(res.status, 500);
      assertEquals(await readError(res), "An error occurred.");
    } finally {
      console.error = realError;
    }
  });

  await t.step("name-based matching: a look-alike name is honoured, a look-alike message is not", async () => {
    // routeError matches on error.name (deliberately, not instanceof — the
    // throw sites cross module boundaries). Pin both halves of that contract.
    const impostor = new Error("nope");
    impostor.name = "AuthorizationError";
    assertEquals(routeError(fakeContext(), impostor, "ctx:").status, 403);

    console.error = () => {};
    try {
      const plain = new Error("AuthorizationError");
      assertEquals(routeError(fakeContext(), plain, "ctx:").status, 500);
    } finally {
      console.error = realError;
    }
  });
});

Deno.test("isSafeIdentifier — the single SQL identifier guard", async (t) => {
  await t.step("positive: plain lowercase snake_case identifiers pass", () => {
    for (const ok of ["id", "user_id", "_private", "a1", "created_at", "x_9_y"]) {
      assertEquals(isSafeIdentifier(ok), true, `${ok} should be accepted`);
    }
  });

  await t.step("negative: injection-shaped and out-of-charset values are rejected", () => {
    const bad = [
      "id) VALUES (1); DROP TABLE users; --", // the documented attack shape
      "user id",         // whitespace
      "User_Id",         // uppercase
      "1col",            // leading digit
      "col-name",        // hyphen
      "col;",            // statement terminator
      "col--",
      "",                // empty
      "täble",           // non-ASCII
      "col\n",           // trailing newline (regex is anchored, so this fails)
      "*",
    ];
    for (const value of bad) {
      assertEquals(isSafeIdentifier(value), false, `${JSON.stringify(value)} must be rejected`);
    }
  });
});

Deno.test("generateRequestNumber — zero-padded, UTC-based, overflow-safe", async (t) => {
  await t.step("positive: pads the sequence to 3 digits", () => {
    assertEquals(
      generateRequestNumber("HRIS", new Date(Date.UTC(2026, 7, 24)), 7),
      "BG-HRIS-20260824-007",
    );
  });

  await t.step("positive: single-digit month/day are zero-padded", () => {
    assertEquals(
      generateRequestNumber("X", new Date(Date.UTC(2026, 0, 5)), 42),
      "BG-X-20260105-042",
    );
  });

  await t.step("boundary: sequence >= 1000 is NOT truncated, it widens", () => {
    assertEquals(
      generateRequestNumber("HRIS", new Date(Date.UTC(2026, 11, 31)), 1000),
      "BG-HRIS-20261231-1000",
    );
    assertEquals(
      generateRequestNumber("HRIS", new Date(Date.UTC(2026, 11, 31)), 999),
      "BG-HRIS-20261231-999",
    );
  });

  await t.step("uses UTC, not local time — a late-UTC instant keeps its own date", () => {
    // 2026-08-24T23:30Z must render as 20260824 regardless of the host TZ.
    assertEquals(
      generateRequestNumber("S", new Date("2026-08-24T23:30:00.000Z"), 1),
      "BG-S-20260824-001",
    );
  });
});

Deno.test("validateName / validateOptionalText / validateStringField boundaries", async (t) => {
  await t.step("validateName: positive — trims, accepts 1..100 chars", () => {
    assertEquals(validateName("Ada", "Name").valid, true);
    assertEquals(validateName("  Ada  ", "Name").valid, true);
    assertEquals(validateName("x".repeat(100), "Name").valid, true);
  });

  await t.step("validateName: negative — empty, whitespace-only, >100, non-string", () => {
    for (const bad of ["", "   ", "x".repeat(101), 42, null, undefined, {}]) {
      const out = validateName(bad as never, "Name");
      assertEquals(out.valid, false, `${JSON.stringify(bad)} must fail`);
      assertEquals(out.error, "Name is required and must be 1-100 characters.");
    }
  });

  await t.step("validateOptionalText: positive — absent/empty/at-limit pass", () => {
    assertEquals(validateOptionalText(null, "Notes").valid, true);
    assertEquals(validateOptionalText(undefined, "Notes").valid, true);
    assertEquals(validateOptionalText("", "Notes").valid, true);
    assertEquals(validateOptionalText("x".repeat(500), "Notes").valid, true);
  });

  await t.step("validateOptionalText: negative — one past the limit fails, message names it", () => {
    const out = validateOptionalText("x".repeat(501), "Notes");
    assertEquals(out.valid, false);
    assertEquals(out.error, "Notes must be 500 characters or fewer.");
  });

  await t.step("validateOptionalText: a custom maxLength is honoured", () => {
    assertEquals(validateOptionalText("abcd", "Short", 4).valid, true);
    const out = validateOptionalText("abcde", "Short", 4);
    assertEquals(out.valid, false);
    assertEquals(out.error, "Short must be 4 characters or fewer.");
  });

  await t.step("validateStringField: required vs optional behaviour", () => {
    assertEquals(validateStringField("ok", "Field", 1, 10).valid, true);
    assertEquals(validateStringField("", "Field", 1, 10).valid, false);
    assertEquals(validateStringField("x".repeat(11), "Field", 1, 10).valid, false);
  });
});

Deno.test("validateEmail", async (t) => {
  await t.step("positive", () => {
    for (const ok of ["a@b.co", "first.last@sub.example.com", "x+tag@y.io"]) {
      assertEquals(validateEmail(ok), true, ok);
    }
  });

  await t.step("negative: missing parts, spaces, no dot in the domain", () => {
    for (const bad of ["", "a", "a@", "@b.co", "a@b", "a b@c.co", "a@b .co", "a@@b.co"]) {
      assertEquals(validateEmail(bad), false, JSON.stringify(bad));
    }
  });
});

Deno.test("isAffiliationTeamTypeCompatible — PA teams are agency-only", async (t) => {
  await t.step("positive: agency -> agency and pa; vendor -> vendor", () => {
    assertEquals(isAffiliationTeamTypeCompatible("agency", "agency"), true);
    assertEquals(isAffiliationTeamTypeCompatible("agency", "pa"), true);
    assertEquals(isAffiliationTeamTypeCompatible("vendor", "vendor"), true);
  });

  await t.step("negative: vendor may never join an agency or PA team", () => {
    assertEquals(isAffiliationTeamTypeCompatible("vendor", "agency"), false);
    assertEquals(isAffiliationTeamTypeCompatible("vendor", "pa"), false);
  });

  await t.step("negative: agency may not join a vendor team", () => {
    assertEquals(isAffiliationTeamTypeCompatible("agency", "vendor"), false);
  });

  await t.step("negative: a null affiliation is compatible with nothing", () => {
    // Matches the DB guard (migration 095): a user without an affiliation is
    // pending/rejected/tombstoned and must not be team-placed.
    for (const teamType of ["agency", "vendor", "pa"] as const) {
      assertEquals(isAffiliationTeamTypeCompatible(null, teamType), false, teamType);
    }
  });
});

Deno.test("isProtectedUser — system and protected rows are immutable", async (t) => {
  await t.step("positive: is_system or is_protected", () => {
    assertEquals(isProtectedUser({ isSystem: true, isProtected: false }), true);
    assertEquals(isProtectedUser({ isSystem: false, isProtected: true }), true);
    assertEquals(isProtectedUser({ isSystem: true, isProtected: true }), true);
  });

  await t.step("negative: an ordinary user, and absent input", () => {
    assertEquals(isProtectedUser({ isSystem: false, isProtected: false }), false);
    assertEquals(isProtectedUser(null), false);
    assertEquals(isProtectedUser(undefined), false);
  });
});

Deno.test("passwordHashNeedsUpgrade — KDF/iteration migration trigger", async (t) => {
  await t.step("negative (no upgrade): a current pbkdf2 hash at the current cost", () => {
    assertEquals(passwordHashNeedsUpgrade("pbkdf2-sha256$600000$abc"), false);
  });

  await t.step("positive (upgrade): a weaker iteration count", () => {
    assertEquals(passwordHashNeedsUpgrade("pbkdf2-sha256$1000$abc"), true);
  });

  await t.step("positive (upgrade): a legacy bare-SHA256 hash with no $ markers", () => {
    assertEquals(passwordHashNeedsUpgrade("deadbeefcafe"), true);
  });

  await t.step("positive (upgrade): a different algorithm at the same cost", () => {
    assertEquals(passwordHashNeedsUpgrade("scrypt$600000$abc"), true);
  });
});

Deno.test("generateTempPassword — length, character classes, randomness", async (t) => {
  await t.step("positive: honours the requested length (default 16)", () => {
    assertEquals(generateTempPassword().length, 16);
    assertEquals(generateTempPassword(24).length, 24);
  });

  await t.step("positive: always contains upper, lower, digit and special", () => {
    // The shuffle means the guaranteed classes are not at fixed positions,
    // so assert over the whole string, many times.
    for (let i = 0; i < 50; i++) {
      const pw = generateTempPassword();
      assertMatch(pw, /[A-Z]/, `no uppercase in ${pw}`);
      assertMatch(pw, /[a-z]/, `no lowercase in ${pw}`);
      assertMatch(pw, /[0-9]/, `no digit in ${pw}`);
      assertMatch(pw, /[!@#$%^&*(),.?":{}|<>]/, `no special in ${pw}`);
    }
  });

  await t.step("positive: excludes visually ambiguous characters (I, O, l, 0, 1)", () => {
    for (let i = 0; i < 50; i++) {
      const pw = generateTempPassword(32);
      for (const ch of ["I", "O", "l", "0", "1"]) {
        assert(!pw.includes(ch), `ambiguous character ${ch} present in ${pw}`);
      }
    }
  });

  await t.step("positive: successive calls differ (not a fixed seed)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 25; i++) seen.add(generateTempPassword());
    assertEquals(seen.size, 25);
  });
});
