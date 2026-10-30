// Coverage: the AWS transport-encryption layer (addendum-087) — the pure Web
// Crypto primitives (server/aws-crypto.tsx), the wrap/unwrap helpers and the
// enablement resolver (server/aws-secret-delivery.tsx). The crypto and
// wrap/unwrap halves are pure (fixture PEMs, no DB, no AWS); only the
// resolveTransportKeys enablement half reads app_settings, so that half wipes
// the DB like every other file in this suite.
//
// Uses the committed test-only keypairs from test/fixtures/aws-transport-keys.ts —
// the SAME keys the LocalStack bootstrap provisions into SSM + the fake
// Lambda's env vars, so these unit tests and the LocalStack e2e always agree.
import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import { wipeDatabase, resetAwsAppKeySettings } from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";
import { clearAppSettingsCache } from "../../../server/app-settings.tsx";
import {
  pemToDer,
  bytesToB64,
  isValidPublicKey,
  isValidPrivateKey,
  importRsaPublicKey,
  importRsaPrivateKey,
  encryptEnvelope,
  decryptEnvelope,
  signEnvelope,
  verifyEnvelope,
  isTransportWrapped,
  wrapTransportFile,
  unwrapTransportFile,
} from "../../../server/aws/crypto.tsx";
import { resolveTransportKeys } from "../../../server/aws/secret-delivery.tsx";
import {
  TENANT_PRIVATE_KEY_PEM,
  TENANT_PUBLIC_KEY_PEM,
  APP_PRIVATE_KEY_PEM,
  APP_PUBLIC_KEY_PEM,
  TENANT_PUBLIC_KEY_PEM_B64,
  APP_PRIVATE_KEY_PEM_B64,
  APP_PUBLIC_KEY_PEM_B64,
} from "../../fixtures/aws-transport-keys.ts";

const PAYLOAD = {
  schemaVersion: "1.0",
  requestId: "req-123",
  publicKey: "cGF5bG9hZHM=",
  credentialItems: [{ userid: "svc", hostname: "host-1", credentialType: "password" }],
};

Deno.test("aws transport crypto — PEM parsing + key validity", async (t) => {
  await t.step("pemToDer accepts PEM text, base64-of-PEM, and bare DER base64 identically", () => {
    const fromPem = pemToDer(TENANT_PUBLIC_KEY_PEM);
    const fromB64OfPem = pemToDer(TENANT_PUBLIC_KEY_PEM_B64);
    const fromBareDer = pemToDer(bytesToB64(fromPem));
    assertEquals(fromB64OfPem, fromPem);
    assertEquals(fromBareDer, fromPem);
    // 2048-bit SPKI = 294 DER bytes.
    assertEquals(fromPem.length, 294);
  });

  await t.step("isValidPublicKey accepts real public keys, rejects garbage and private-key material", async () => {
    assertEquals(await isValidPublicKey(TENANT_PUBLIC_KEY_PEM), true);
    assertEquals(await isValidPublicKey(APP_PUBLIC_KEY_PEM_B64), true);
    assertEquals(await isValidPublicKey("not a key"), false);
    assertEquals(await isValidPublicKey(TENANT_PRIVATE_KEY_PEM), false);
  });

  await t.step("isValidPrivateKey accepts real private keys, rejects garbage", async () => {
    assertEquals(await isValidPrivateKey(APP_PRIVATE_KEY_PEM), true);
    assertEquals(await isValidPrivateKey(APP_PRIVATE_KEY_PEM_B64), true);
    assertEquals(await isValidPrivateKey("not a key"), false);
  });
});

Deno.test("aws transport crypto — envelope + signature primitives", async (t) => {
  const tenantPub = await importRsaPublicKey(TENANT_PUBLIC_KEY_PEM);
  const tenantPriv = await importRsaPrivateKey(TENANT_PRIVATE_KEY_PEM);
  const appPub = await importRsaPublicKey(APP_PUBLIC_KEY_PEM);
  const appPriv = await importRsaPrivateKey(APP_PRIVATE_KEY_PEM);
  const message = new TextEncoder().encode(JSON.stringify(PAYLOAD));

  await t.step("envelope round-trips with the matching private key", async () => {
    const env = await encryptEnvelope(tenantPub.oaep, message);
    assertEquals(env.algorithm, "RSA-OAEP-2048-SHA256+AES-256-GCM");
    const plain = await decryptEnvelope(tenantPriv.oaep, env);
    assertEquals(new TextDecoder().decode(plain), JSON.stringify(PAYLOAD));
  });

  await t.step("decrypting with the WRONG private key throws", async () => {
    const env = await encryptEnvelope(tenantPub.oaep, message);
    await assertRejects(() => decryptEnvelope(appPriv.oaep, env));
  });

  await t.step("signature verifies for the right signer, fails for the wrong signer and for tampered envelopes", async () => {
    const env = await encryptEnvelope(tenantPub.oaep, message);
    const sig = await signEnvelope(appPriv.pkcs1, env);
    assertEquals(await verifyEnvelope(appPub.pkcs1, env, sig), true);
    assertEquals(await verifyEnvelope(tenantPub.pkcs1, env, sig), false, "tenant key must not verify an app signature");
    const tampered = { ...env, ciphertext: env.ciphertext.slice(0, -2) + "AA" };
    assertEquals(await verifyEnvelope(appPub.pkcs1, tampered, sig), false);
  });

  await t.step("outbound direction: app signs + encrypts, tenant verifies + decrypts", async () => {
    const env = await encryptEnvelope(tenantPub.oaep, message);
    const sig = await signEnvelope(appPriv.pkcs1, env);
    assertEquals(await verifyEnvelope(appPub.pkcs1, env, sig), true);
    assertEquals(new TextDecoder().decode(await decryptEnvelope(tenantPriv.oaep, env)), JSON.stringify(PAYLOAD));
  });

  await t.step("inbound direction: tenant signs + encrypts, app verifies + decrypts", async () => {
    const env = await encryptEnvelope(appPub.oaep, message);
    const sig = await signEnvelope(tenantPriv.pkcs1, env);
    assertEquals(await verifyEnvelope(tenantPub.pkcs1, env, sig), true);
    assertEquals(new TextDecoder().decode(await decryptEnvelope(appPriv.oaep, env)), JSON.stringify(PAYLOAD));
  });
});

Deno.test("aws transport — wrap/unwrap helpers", async (t) => {
  await t.step("outbound direction: app wraps, the TENANT unwraps (verify with app pub, decrypt with tenant priv)", async () => {
    const wrapped = await wrapTransportFile(PAYLOAD, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM, "request");
    assertEquals(isTransportWrapped(wrapped), true);
    const parsed = JSON.parse(wrapped);
    assertEquals(parsed.schemaVersion, "2.0");
    assertEquals(parsed.kind, "request");
    assertEquals(parsed.signature.algorithm, "RSASSA-PKCS1-v1_5-SHA256");
    assertExists(parsed.envelope.ciphertext);
    assertExists(parsed.signedAt);

    // What the tenant's Lambda does (setup/localstack-lambda/index.mjs).
    const unwrapped = await unwrapTransportFile(wrapped, TENANT_PRIVATE_KEY_PEM, APP_PUBLIC_KEY_PEM);
    assertEquals(unwrapped, PAYLOAD);
  });

  await t.step("inbound direction: tenant wraps, the APP unwraps (verify with tenant pub, decrypt with app priv)", async () => {
    const wrapped = await wrapTransportFile(PAYLOAD, TENANT_PRIVATE_KEY_PEM, APP_PUBLIC_KEY_PEM, "response");
    assertEquals(isTransportWrapped(wrapped), true);
    const parsed = JSON.parse(wrapped);
    assertEquals(parsed.kind, "response");

    // What the app's poll path does (pollForEncryptedSecret).
    const unwrapped = await unwrapTransportFile(wrapped, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM);
    assertEquals(unwrapped, PAYLOAD);
  });

  await t.step("the app cannot unwrap its own OUTBOUND file (it is not the recipient)", async () => {
    const wrapped = await wrapTransportFile(PAYLOAD, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM, "request");
    await assertRejects(
      () => unwrapTransportFile(wrapped, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM),
      Error,
      /verification FAILED/,
    );
  });

  await t.step("isTransportWrapped is false for legacy plaintext JSON", () => {
    assertEquals(isTransportWrapped(JSON.stringify(PAYLOAD)), false);
  });

  await t.step("unwrapping a legacy plaintext object passes it through unchanged", async () => {
    const plain = JSON.stringify({ schemaVersion: "1.0", requestId: "legacy" });
    assertEquals(await unwrapTransportFile(plain, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM), { schemaVersion: "1.0", requestId: "legacy" });
  });

  await t.step("a tampered ciphertext fails signature verification and throws", async () => {
    const wrapped = await wrapTransportFile(PAYLOAD, TENANT_PRIVATE_KEY_PEM, APP_PUBLIC_KEY_PEM, "response");
    const parsed = JSON.parse(wrapped);
    parsed.envelope.ciphertext = parsed.envelope.ciphertext.slice(0, -2) + "AA";
    await assertRejects(
      () => unwrapTransportFile(JSON.stringify(parsed), APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM),
      Error,
      /verification FAILED/,
    );
  });

  await t.step("unwrapping with the wrong sender public key throws (wrong-signer rejection)", async () => {
    const wrapped = await wrapTransportFile(PAYLOAD, TENANT_PRIVATE_KEY_PEM, APP_PUBLIC_KEY_PEM, "response");
    // A throwaway keypair stands in for the WRONG tenant — its public key
    // cannot verify a signature made by the real tenant's private key.
    // Both usages: an RSASSA keypair's private half needs "sign" — Deno rejects
    // a generateKey call whose usages leave either half empty ("Usages cannot
    // be empty"). We only use the public half below, but both must be listed.
    const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
    const otherPubSpki = new Uint8Array(await crypto.subtle.exportKey("spki", other.publicKey));
    const otherPubPem =
      "-----BEGIN PUBLIC KEY-----\n" +
      bytesToB64(otherPubSpki).match(/.{1,64}/g)!.join("\n") +
      "\n-----END PUBLIC KEY-----\n";
    await assertRejects(
      () => unwrapTransportFile(wrapped, APP_PRIVATE_KEY_PEM, otherPubPem),
      Error,
      /verification FAILED/,
    );
  });
});

Deno.test("aws transport — enablement (resolveTransportKeys)", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
    // app_settings survives wipeDatabase (seeded config). An earlier aws-* file
    // in the same `deno test dir/` run may have left the app keypair SET; this
    // enablement suite asserts the "keys unset" branch, so reset them here to be
    // order-independent rather than assuming a pristine global state.
    await resetAwsAppKeySettings();
    clearAppSettingsCache();
  });

  await t.step("tenant parameter absent -> null (plaintext mode, pre-addendum-087 behavior)", async () => {
    assertEquals(await resolveTransportKeys(null), null);
    assertEquals(await resolveTransportKeys(""), null);
  });

  await t.step("tenant parameter present but invalid -> throws (never silently downgrades)", async () => {
    await assertRejects(() => resolveTransportKeys("not a key"), Error, /not a valid RSA public key/);
  });

  await t.step("tenant parameter present but app keys unset -> throws (config error, not plaintext fallback)", async () => {
    await assertRejects(() => resolveTransportKeys(TENANT_PUBLIC_KEY_PEM_B64), Error, /app's own key settings/);
  });

  await t.step("all three sides configured -> returns the decoded PEM trio", async () => {
    await query(
      `UPDATE app_settings SET value = $1 WHERE key = 'aws_encrypt_private_key_pem_b64'`,
      [APP_PRIVATE_KEY_PEM_B64],
    );
    await query(
      `UPDATE app_settings SET value = $1 WHERE key = 'aws_encrypt_public_key_pem_b64'`,
      [APP_PUBLIC_KEY_PEM_B64],
    );
    clearAppSettingsCache();

    const keys = await resolveTransportKeys(TENANT_PUBLIC_KEY_PEM_B64);
    assertExists(keys);
    assertEquals(keys!.appPrivPem, APP_PRIVATE_KEY_PEM);
    assertEquals(keys!.appPubPem, APP_PUBLIC_KEY_PEM);
    assertEquals(keys!.tenantPubPem, TENANT_PUBLIC_KEY_PEM);

    // And the full pipeline composes: the app wraps with the resolved keys
    // (outbound direction), the tenant-side unwraps with the tenant private
    // key + the app public key, and the payload comes back.
    const wrapped = await wrapTransportFile(PAYLOAD, keys!.appPrivPem, keys!.tenantPubPem, "request");
    assertEquals(await unwrapTransportFile(wrapped, TENANT_PRIVATE_KEY_PEM, keys!.appPubPem), PAYLOAD);
  });
});
