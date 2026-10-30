// Coverage: BREAKGLASS_DEV runtime-mode resolution (server/runtime-mode.tsx,
// addendum-097). Pure env parsing — no DB. The rule that matters most is
// fail-CLOSED: unset, empty, or misspelled values resolve to PROD so the
// destructive demo controls (Reset & Seed) stay hidden on real deployments.
import { assertEquals } from "jsr:@std/assert";
import { getBreakglassDevMode, isDemoControlsEnabled } from "../../../server/runtime-mode.tsx";

// Serialize env mutation through save/restore so this file can never leak a
// changed BREAKGLASS_DEV/BREAKGLASS_ENV into the rest of the suite (deno test
// files share one process by default).
function withEnv(vars: { dev?: string; legacy?: string }, fn: () => void) {
  const prevDev = Deno.env.get("BREAKGLASS_DEV");
  const prevLegacy = Deno.env.get("BREAKGLASS_ENV");
  try {
    if (vars.dev === undefined) Deno.env.delete("BREAKGLASS_DEV");
    else Deno.env.set("BREAKGLASS_DEV", vars.dev);
    if (vars.legacy === undefined) Deno.env.delete("BREAKGLASS_ENV");
    else Deno.env.set("BREAKGLASS_ENV", vars.legacy);
    fn();
  } finally {
    if (prevDev === undefined) Deno.env.delete("BREAKGLASS_DEV");
    else Deno.env.set("BREAKGLASS_DEV", prevDev);
    if (prevLegacy === undefined) Deno.env.delete("BREAKGLASS_ENV");
    else Deno.env.set("BREAKGLASS_ENV", prevLegacy);
  }
}

Deno.test("runtime-mode: BREAKGLASS_DEV resolution (addendum-097)", async (t) => {
  await t.step("unset + no legacy alias → PROD (safe default)", () => {
    withEnv({}, () => {
      assertEquals(getBreakglassDevMode(), "PROD");
      assertEquals(isDemoControlsEnabled(), false);
    });
  });

  await t.step("explicit DEV / DEMO / PROD values resolve verbatim", () => {
    withEnv({ dev: "DEV" }, () => assertEquals(getBreakglassDevMode(), "DEV"));
    withEnv({ dev: "DEMO" }, () => assertEquals(getBreakglassDevMode(), "DEMO"));
    withEnv({ dev: "PROD" }, () => assertEquals(getBreakglassDevMode(), "PROD"));
    withEnv({ dev: "DEV" }, () => assertEquals(isDemoControlsEnabled(), true));
    withEnv({ dev: "DEMO" }, () => assertEquals(isDemoControlsEnabled(), true));
    withEnv({ dev: "PROD" }, () => assertEquals(isDemoControlsEnabled(), false));
  });

  await t.step("values are case-insensitive and whitespace-tolerant", () => {
    withEnv({ dev: "demo" }, () => assertEquals(getBreakglassDevMode(), "DEMO"));
    withEnv({ dev: " dev " }, () => assertEquals(getBreakglassDevMode(), "DEV"));
  });

  await t.step("unrecognized value → PROD + warning (fail CLOSED, never open)", () => {
    withEnv({ dev: "staging" }, () => assertEquals(getBreakglassDevMode(), "PROD"));
    withEnv({ dev: "DEVELOPMENT" }, () => assertEquals(getBreakglassDevMode(), "PROD"));
  });

  await t.step("legacy BREAKGLASS_ENV=DEMO honored only when BREAKGLASS_DEV is unset", () => {
    withEnv({ legacy: "DEMO" }, () => assertEquals(getBreakglassDevMode(), "DEMO"));
    // The new variable wins when both are present.
    withEnv({ dev: "PROD", legacy: "DEMO" }, () => {
      assertEquals(getBreakglassDevMode(), "PROD");
      assertEquals(isDemoControlsEnabled(), false);
    });
  });

  await t.step("empty string is treated as unset (falls through to legacy/PROD)", () => {
    withEnv({ dev: "" }, () => assertEquals(getBreakglassDevMode(), "PROD"));
    withEnv({ dev: "", legacy: "DEMO" }, () => assertEquals(getBreakglassDevMode(), "DEMO"));
  });
});
