// Unit tests for buildAuthorizeUrl's OIDC claims-request construction
// (server/entra-oidc.tsx). Pure function, no network / no DB.
//
// Covers the authorize-request states the function can express:
//   * plain SSO      — neither requireMfa nor authContextId → NO claims param
//   * soft amr       — requireMfa only → essential/non-essential amr block
//   * hard acrs       — authContextId only → essential acrs block
//   * amr + acrs      — both → one claims param carrying both id_token blocks
// Plus prompt=login gating on forceReauth.
//
// Route-level note (2026-08-20): GET /auth/entra/login now ALWAYS passes
// requireMfa: true — "plain SSO sends no claims param" is no longer a state
// the app drives, because the v2 id_token omits amr unless it is requested
// (seen live: amr=null after a number-matching MFA prompt). The force toggle
// only flips the request to essential; the cases below remain the full
// function-level truth.
import { assertEquals } from "jsr:@std/assert";
import { buildAuthorizeUrl } from "../../../server/entra/oidc.tsx";
import type { EntraConfig } from "../../../server/entra/config.tsx";

const CONFIG: EntraConfig = {
  tenantId: "tenant-abc",
  clientId: "client-xyz",
  redirectUri: "https://app.example.com/auth/entra/callback",
  certPath: "",
  keyPath: "",
};

const PARAMS = { state: "st", codeChallenge: "cc", nonce: "no" };

// Parse the `claims` query param (if present) back into an object.
function claimsOf(url: string): Record<string, unknown> | null {
  const raw = new URL(url).searchParams.get("claims");
  return raw === null ? null : JSON.parse(raw);
}

Deno.test("buildAuthorizeUrl", async (t) => {
  await t.step("plain SSO: no claims param when neither requireMfa nor authContextId", () => {
    const url = buildAuthorizeUrl(CONFIG, PARAMS, {});
    assertEquals(claimsOf(url), null);
  });

  await t.step("plain SSO: authContextId empty string is treated as off", () => {
    const url = buildAuthorizeUrl(CONFIG, PARAMS, { authContextId: "" });
    assertEquals(claimsOf(url), null);
  });

  await t.step("soft amr: non-essential amr when requireMfa without essential", () => {
    const url = buildAuthorizeUrl(CONFIG, PARAMS, { requireMfa: true });
    const claims = claimsOf(url) as { id_token: { amr: { essential: boolean; values: string[] } } };
    assertEquals(claims.id_token.amr, { essential: false, values: ["mfa"] });
    assertEquals("acrs" in claims.id_token, false);
  });

  await t.step("soft amr: essential amr when requireMfaEssential", () => {
    const url = buildAuthorizeUrl(CONFIG, PARAMS, { requireMfa: true, requireMfaEssential: true });
    const claims = claimsOf(url) as { id_token: { amr: { essential: boolean } } };
    assertEquals(claims.id_token.amr.essential, true);
  });

  await t.step("hard acrs: essential acrs present when authContextId set, amr absent", () => {
    const url = buildAuthorizeUrl(CONFIG, PARAMS, { authContextId: "c1" });
    const claims = claimsOf(url) as { id_token: { acrs: { essential: boolean; values: string[] } } };
    assertEquals(claims.id_token.acrs, { essential: true, values: ["c1"] });
    assertEquals("amr" in claims.id_token, false);
  });

  await t.step("amr + acrs coexist in one claims param when both requested", () => {
    const url = buildAuthorizeUrl(CONFIG, PARAMS, {
      requireMfa: true,
      requireMfaEssential: true,
      authContextId: "c1",
    });
    const claims = claimsOf(url) as {
      id_token: { amr: { values: string[] }; acrs: { values: string[] } };
    };
    assertEquals(claims.id_token.amr.values, ["mfa"]);
    assertEquals(claims.id_token.acrs.values, ["c1"]);
  });

  await t.step("prompt=login only when forceReauth", () => {
    const without = new URL(buildAuthorizeUrl(CONFIG, PARAMS, {}));
    assertEquals(without.searchParams.get("prompt"), null);
    const withReauth = new URL(buildAuthorizeUrl(CONFIG, PARAMS, { forceReauth: true }));
    assertEquals(withReauth.searchParams.get("prompt"), "login");
  });
});
