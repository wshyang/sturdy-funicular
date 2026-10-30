// Unit tests for the env-driven bootstrap/seed password resolution
// (addendum-095 Finding #6). Both passwords were hardcoded plaintext in source;
// they are now read from env vars (BREAKGLASS_ADMIN_PASSWORD /
// DEMO_SEED_PASSWORD) with documented fallbacks, exposed as pure functions so
// the fallback and override behaviour is testable without a database.
import { assertEquals } from "jsr:@std/assert";
import { getBreakglassAdminPassword } from "../../../server/bootstrap.tsx";
import { getDemoSeedPassword } from "../../../server/seed.tsx";

// Save/restore the relevant env vars around each assertion so a parallel or
// later test process never inherits a leaked override.
function withEnv(name: string, value: string | null, fn: () => void): void {
  const prev = Deno.env.get(name);
  try {
    if (value === null) Deno.env.delete(name);
    else Deno.env.set(name, value);
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prev);
  }
}

Deno.test("getBreakglassAdminPassword: falls back to historical value when unset", () => {
  withEnv("BREAKGLASS_ADMIN_PASSWORD", null, () => {
    assertEquals(getBreakglassAdminPassword(), "BreakGlass@2026Admin");
  });
});

Deno.test("getBreakglassAdminPassword: honours the env override", () => {
  withEnv("BREAKGLASS_ADMIN_PASSWORD", "CustomAdminPass!2026", () => {
    assertEquals(getBreakglassAdminPassword(), "CustomAdminPass!2026");
  });
});

Deno.test("getDemoSeedPassword: falls back to historical value when unset", () => {
  withEnv("DEMO_SEED_PASSWORD", null, () => {
    assertEquals(getDemoSeedPassword(), "Password@2026");
  });
});

Deno.test("getDemoSeedPassword: honours the env override", () => {
  withEnv("DEMO_SEED_PASSWORD", "CustomDemoPass!2026", () => {
    assertEquals(getDemoSeedPassword(), "CustomDemoPass!2026");
  });
});
