// Coverage: GET /auth/entra/login (unconfigured-gating only — a real
// callback round-trip against a live Entra tenant is impossible in this
// suite, see addendum-032-entra-id-sso-login.md), and
// resolveOrProvisionUserForEntraIdentity()/validateClaims() as direct
// unit-style calls with fake claims/payloads, bypassing network/JWKS
// entirely.
import { assertEquals, assertExists, assertThrows } from "jsr:@std/assert";
import { req, wipeDatabase, createActiveUser, uniqueEmail, uniqueName } from "./helpers.tsx";
import { users, externalIdentities, generateId, now } from "../../../server/db.tsx";
import {
  resolveOrProvisionUserForEntraIdentity,
  EntraLoginRejectedError,
} from "../../../server/entra/provisioning.tsx";
import { exchangeCodeForTokens, validateClaims } from "../../../server/entra/oidc.tsx";
import { PROVIDER_ENTRA_ID } from "../../../server/entra/config.tsx";
import {
  isDirectoryLookupAvailable,
  queryEntraDirectoryForEmail,
} from "../../../server/entra/directory.tsx";
import { buildClientAssertion } from "../../../server/entra/cert-auth.tsx";
import { query } from "../../../server/pg.tsx";
import { clearAppSettingsCache } from "../../../server/app-settings.tsx";

// Checked-in, synthetic test-only cert/key fixtures (server/tests/fixtures/) —
// generated once via `openssl genpkey`/`openssl req -x509`, unrelated to any
// real Entra app registration. Reading them needs no extra Deno permission
// beyond the suite's existing --allow-read; a temp-file-based fixture would
// need --allow-write, which deno.json's `test` task deliberately doesn't grant.
// Named .pem.txt, not .pem — GitLab's server-side push rule blocks any
// filename matching \.(pem|key)$ regardless of content, and rejects the push
// outright rather than allowing an exception per-path.
const FIXTURE_CERT_PATH = decodeURIComponent(new URL("./fixtures/fake-cert.pem.txt", import.meta.url).pathname);
const FIXTURE_KEY_PATH = decodeURIComponent(new URL("./fixtures/fake-key.pem.txt", import.meta.url).pathname);

Deno.test("entra_auth", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  // ── HTTP gating (no live tenant needed) ──────────────────────────────────

  await t.step("GET /auth/entra/login: unconfigured — redirects with entra_error=not_configured", async () => {
    // ENTRA_TENANT_ID etc. are unset in .env.test by design (see .env.example).
    const res = await req("/auth/entra/login", { method: "GET" });
    assertEquals(res.status, 302);
    const location = res.headers.get("Location") || "";
    assertEquals(location.includes("entra_error=not_configured"), true);
  });

  await t.step("GET /auth/entra/callback: unconfigured — redirects with entra_error=not_configured", async () => {
    const res = await req("/auth/entra/callback?code=x&state=y", { method: "GET" });
    assertEquals(res.status, 302);
    const location = res.headers.get("Location") || "";
    assertEquals(location.includes("entra_error=not_configured"), true);
  });

  await t.step("POST /auth/entra/exchange: negative — missing code", async () => {
    const res = await req("/auth/entra/exchange", { method: "POST", body: {} });
    assertEquals(res.status, 400);
  });

  await t.step("POST /auth/entra/exchange: negative — unknown handoff code", async () => {
    const res = await req("/auth/entra/exchange", { method: "POST", body: { code: "not-a-real-code" } });
    assertEquals(res.status, 400);
    const data = await res.json();
    assertExists(data.error);
  });

  // ── validateClaims() — pure, no network ──────────────────────────────────

  const baseClaims = {
    iss: "https://login.microsoftonline.com/tenant-abc/v2.0",
    aud: "client-abc",
    exp: Math.floor(Date.now() / 1000) + 3600,
    nonce: "expected-nonce",
    oid: "oid-123",
    tid: "tenant-abc",
    email: "person@example.gov",
  };
  const expected = { issuer: baseClaims.iss, audience: baseClaims.aud, nonce: baseClaims.nonce };

  await t.step("validateClaims: positive — matching issuer/audience/nonce/unexpired passes", () => {
    validateClaims(baseClaims, expected);
  });

  await t.step("validateClaims: negative — nonce mismatch rejects", () => {
    assertThrows(() => validateClaims({ ...baseClaims, nonce: "wrong-nonce" }, expected));
  });

  await t.step("validateClaims: tenant verification (addendum-078) — tid mismatch rejects", () => {
    // Expected.tenantId present → the token's tid must match exactly.
    assertThrows(() =>
      validateClaims({ ...baseClaims, tid: "other-tenant" }, { ...expected, tenantId: "tenant-abc" })
    );
    assertThrows(() =>
      validateClaims({ ...baseClaims, tid: undefined }, { ...expected, tenantId: "tenant-abc" })
    );
    // Matching tid passes; tenantId omitted (offline unit path) skips the check.
    validateClaims({ ...baseClaims, tid: "tenant-abc" }, { ...expected, tenantId: "tenant-abc" });
    validateClaims(baseClaims, expected);
  });

  await t.step("validateClaims: negative — expired token rejects", () => {
    assertThrows(() =>
      validateClaims({ ...baseClaims, exp: Math.floor(Date.now() / 1000) - 10 }, expected)
    );
  });

  await t.step("validateClaims: negative — wrong issuer rejects", () => {
    assertThrows(() => validateClaims({ ...baseClaims, iss: "https://evil.example/v2.0" }, expected));
  });

  await t.step("validateClaims: negative — wrong audience rejects", () => {
    assertThrows(() => validateClaims({ ...baseClaims, aud: "someone-elses-client" }, expected));
  });

  await t.step("validateClaims: negative — missing oid rejects", () => {
    assertThrows(() => validateClaims({ ...baseClaims, oid: "" }, expected));
  });

  // ── resolveOrProvisionUserForEntraIdentity() — pure business logic ───────

  await t.step("provisioning: no matching identity or email — auto-provisions a new pending_approval user", async () => {
    const oid = generateId();
    const email = uniqueEmail("entra-new");
    const user = await resolveOrProvisionUserForEntraIdentity({
      oid,
      email,
      upn: email,
      fullName: "Brand New Person",
      tenantId: "tenant-abc",
    });

    assertEquals(user.status, "pending_approval");
    assertEquals(user.email, email);

    const identity = await externalIdentities.findByProviderAndExternalId(PROVIDER_ENTRA_ID, oid);
    assertExists(identity);
    assertEquals(identity!.userId, user.id);
    // Tenant id captured from the token's tid claim (addendum-078).
    assertEquals(identity!.tenantId, "tenant-abc");
  });

  await t.step("provisioning: existing active local account matched by email — links, does not duplicate", async () => {
    const email = uniqueEmail("entra-link");
    const existing = await createActiveUser({
      fullName: uniqueName("Existing"),
      email,
      password: "SomePassword!2026",
      affiliation: "agency",
    });

    const oid = generateId();
    const user = await resolveOrProvisionUserForEntraIdentity({ oid, email, fullName: "Existing", tenantId: "tenant-abc" });

    assertEquals(user.id, existing.id);
    assertEquals(user.status, "active");

    const identity = await externalIdentities.findByProviderAndExternalId(PROVIDER_ENTRA_ID, oid);
    assertExists(identity);
    assertEquals(identity!.userId, existing.id);
    assertEquals(identity!.tenantId, "tenant-abc");
  });

  await t.step("provisioning: identity already linked to an active user — returns that user, no new row", async () => {
    const email = uniqueEmail("entra-relogin");
    const existing = await createActiveUser({
      fullName: uniqueName("Repeat"),
      email,
      password: "SomePassword!2026",
      affiliation: "vendor",
    });
    const oid = generateId();
    await externalIdentities.create({
      id: generateId(),
      userId: existing.id,
      provider: PROVIDER_ENTRA_ID,
      externalId: oid,
      externalUpn: email,
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });

    const user = await resolveOrProvisionUserForEntraIdentity({ oid, email });
    assertEquals(user.id, existing.id);
  });

  await t.step("provisioning: pre-invited identity (user_id null) — links to the resolved user on first login", async () => {
    const email = uniqueEmail("entra-preinvited");
    const oid = generateId();
    const preInvited = await externalIdentities.create({
      id: generateId(),
      userId: null,
      provider: PROVIDER_ENTRA_ID,
      externalId: oid,
      externalUpn: null,
      status: "active",
      linkedAt: null,
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });

    const user = await resolveOrProvisionUserForEntraIdentity({ oid, email, fullName: "Pre Invited" });
    assertEquals(user.status, "pending_approval");

    const updatedIdentity = await externalIdentities.get(preInvited.id);
    assertEquals(updatedIdentity!.userId, user.id);
  });

  await t.step("provisioning: negative — identity linked to a tombstoned user is hard-rejected", async () => {
    const email = uniqueEmail("entra-tombstoned");
    const existing = await createActiveUser({
      fullName: uniqueName("Tombstoned"),
      email,
      password: "SomePassword!2026",
      affiliation: "agency",
    });
    await users.update(existing.id, { status: "tombstoned", tombstonedAt: now() });

    const oid = generateId();
    await externalIdentities.create({
      id: generateId(),
      userId: existing.id,
      provider: PROVIDER_ENTRA_ID,
      externalId: oid,
      externalUpn: email,
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });

    let threw = false;
    try {
      await resolveOrProvisionUserForEntraIdentity({ oid, email });
    } catch (err) {
      threw = err instanceof EntraLoginRejectedError;
    }
    assertEquals(threw, true);
  });

  // ── fullName sync from the IdP (addendum-077) ─────────────────────────────

  await t.step("provisioning: existing linked user — fullName synced from the IdP name claim when different", async () => {
    const email = uniqueEmail("entra-sync");
    const existing = await createActiveUser({
      fullName: "Old Local Name",
      email,
      password: "SomePassword!2026",
      affiliation: "agency",
    });
    const oid = generateId();
    await externalIdentities.create({
      id: generateId(),
      userId: existing.id,
      provider: PROVIDER_ENTRA_ID,
      externalId: oid,
      externalUpn: email,
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });

    const user = await resolveOrProvisionUserForEntraIdentity({ oid, email, fullName: "  New Name From Entra  " });
    assertEquals(user.id, existing.id);
    const after = await users.get(existing.id);
    assertEquals(after!.fullName, "New Name From Entra");
    // Email stays untouched.
    assertEquals(after!.email, email);
  });

  await t.step("provisioning: existing linked user — name unchanged when IdP name is blank or identical", async () => {
    const email = uniqueEmail("entra-nosync");
    const existing = await createActiveUser({
      fullName: "Stable Name",
      email,
      password: "SomePassword!2026",
      affiliation: "agency",
    });
    const oid = generateId();
    await externalIdentities.create({
      id: generateId(),
      userId: existing.id,
      provider: PROVIDER_ENTRA_ID,
      externalId: oid,
      externalUpn: email,
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });

    // Identical name → no change.
    await resolveOrProvisionUserForEntraIdentity({ oid, email, fullName: "Stable Name" });
    assertEquals((await users.get(existing.id))!.fullName, "Stable Name");
    // Blank name → no change.
    await resolveOrProvisionUserForEntraIdentity({ oid, email, fullName: "   " });
    assertEquals((await users.get(existing.id))!.fullName, "Stable Name");
  });

  await t.step("provisioning: PROTECTED user — fullName sync from IdP succeeds (migration 040 permits fullName)", async () => {
    const email = uniqueEmail("entra-protected-sync");
    const existing = await createActiveUser({
      fullName: "Protected Old Name",
      email,
      password: "SomePassword!2026",
      affiliation: "agency",
    });
    await users.update(existing.id, { isProtected: true });
    const oid = generateId();
    await externalIdentities.create({
      id: generateId(),
      userId: existing.id,
      provider: PROVIDER_ENTRA_ID,
      externalId: oid,
      externalUpn: email,
      status: "active",
      linkedAt: now(),
      decommissionedAt: null,
      createdAt: now(),
      updatedAt: now(),
    });

    // The protected trigger blocks email/affiliation/status but must allow
    // this fullName write — otherwise Entra sign-in would 500 for the
    // default admin once it holds an Entra link.
    const user = await resolveOrProvisionUserForEntraIdentity({ oid, email, fullName: "Protected Synced Name" });
    assertEquals(user.id, existing.id);
    assertEquals((await users.get(existing.id))!.fullName, "Protected Synced Name");
    // The rest of the protected identity remains locked.
    let blocked = false;
    try {
      await users.update(existing.id, { affiliation: "vendor" });
    } catch {
      blocked = true;
    }
    assertEquals(blocked, true);
  });

  // ── buildClientAssertion — DB-stored private key wins over config.keyPath ──
  // addendum-054-entra-key-in-db-and-dynamic-redirect.md

  await t.step("buildClientAssertion: prefers the DB-stored key over config.keyPath when both are present", async () => {
    const realKeyPem = await Deno.readTextFile(FIXTURE_KEY_PATH);
    const b64 = btoa(realKeyPem);
    await query(`UPDATE app_settings SET value = $1 WHERE key = 'entra_client_key_pem_base64'`, [b64]);
    clearAppSettingsCache();

    try {
      // keyPath deliberately points at a nonexistent file — if the DB value
      // weren't preferred, this call would throw on Deno.readTextFile.
      const jwt = await buildClientAssertion({
        tenantId: "tenant-abc",
        clientId: "client-abc",
        redirectUri: "https://example.test/auth/entra/callback",
        certPath: FIXTURE_CERT_PATH,
        keyPath: "/no/such/path/does-not-exist.pem",
      });
      assertEquals(typeof jwt, "string");
      assertEquals(jwt.split(".").length, 3);
    } finally {
      await query(`UPDATE app_settings SET value = '' WHERE key = 'entra_client_key_pem_base64'`);
      clearAppSettingsCache();
    }
  });

  await t.step("buildClientAssertion: falls back to config.keyPath when the DB value is unset", async () => {
    await query(`UPDATE app_settings SET value = '' WHERE key = 'entra_client_key_pem_base64'`);
    clearAppSettingsCache();

    const jwt = await buildClientAssertion({
      tenantId: "tenant-abc",
      clientId: "client-abc",
      redirectUri: "https://example.test/auth/entra/callback",
      certPath: FIXTURE_CERT_PATH,
      keyPath: FIXTURE_KEY_PATH,
    });
    assertEquals(typeof jwt, "string");
    assertEquals(jwt.split(".").length, 3);
  });

  // ── exchangeCodeForTokens — PKCE form encoding (RFC 7636 §4.5) ─────────
  // Regression: the body was built with the camelCase TypeScript variable
  // name (`codeVerifier`) instead of the spec's `code_verifier`, so Entra
  // received a PKCE-bound authorization code with NO verifier and answered
  // invalid_grant AADSTS50148 "The code_verifier does not match the
  // code_challenge supplied in the authorization request for PKCE". Stub the
  // global fetch (fetchWithTimeout calls it directly) and inspect the real
  // form body — no live tenant needed.
  await t.step("exchangeCodeForTokens: posts the PKCE verifier as code_verifier (snake_case)", async () => {
    const seen: Array<{ input: string; body: URLSearchParams }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ input: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return Promise.resolve(new Response(JSON.stringify({ id_token: "stub-id-token" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    }) as typeof fetch;

    try {
      const result = await exchangeCodeForTokens(
        {
          tenantId: "tenant-abc",
          clientId: "client-abc",
          redirectUri: "https://example.test/auth/entra/callback",
          certPath: FIXTURE_CERT_PATH,
          keyPath: FIXTURE_KEY_PATH,
        },
        "auth-code-123",
        "test-verifier-456",
      );

      assertEquals(result.id_token, "stub-id-token");
      assertEquals(seen.length, 1);
      const { input, body } = seen[0];
      assertEquals(input, "https://login.microsoftonline.com/tenant-abc/oauth2/v2.0/token");
      assertEquals(body.get("code_verifier"), "test-verifier-456");
      // The camelCase parameter name must NOT appear — unknown params are
      // ignored by Entra, which is why the bug surfaced as a missing verifier.
      assertEquals(body.get("codeVerifier"), null);
      assertEquals(body.get("grant_type"), "authorization_code");
      assertEquals(body.get("code"), "auth-code-123");
      assertEquals(body.get("client_id"), "client-abc");
      assertEquals(body.get("redirect_uri"), "https://example.test/auth/entra/callback");
      // Certificate credential: an RFC 7523 client assertion, never a secret.
      assertEquals(body.get("client_assertion_type"), "urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
      assertEquals((body.get("client_assertion") ?? "").split(".").length, 3);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

// G5 (addendum-140, executed addendum-141): the entra-directory Graph lookup
// (queryEntraDirectoryForEmail — the signup-time local-vs-Entra classifier)
// had zero direct pins. The contract that matters in this suite's sandbox is
// fail-CLOSED while unconfigured: predicate false, lookup 'unconfigured',
// never a network attempt.
Deno.test("entra-directory: unconfigured lookup fails closed (G5)", async (t) => {
  await t.step("setup: wipe + strip every entra_* setting", async () => {
    await wipeDatabase();
    await query(
      `UPDATE app_settings SET value = '' WHERE key IN
       ('entra_tenant_id','entra_client_id','entra_cert_pem_base64','entra_client_key_pem_base64')`,
    );
    clearAppSettingsCache();
  });

  await t.step("isDirectoryLookupAvailable() false and the classifier returns 'unconfigured' (no fetch)", async () => {
    assertEquals(await isDirectoryLookupAvailable(), false);
    const result = await queryEntraDirectoryForEmail("anyone@test.local");
    assertEquals(result.status, "unconfigured");
  });
});
