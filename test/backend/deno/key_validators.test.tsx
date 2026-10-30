// Tests for server/key-validators.tsx — the validators behind the PEM-based
// admin app-settings (AWS transport keys, the Entra signing certificate).
//
// Why this module deserves direct tests: validation here is real Web Crypto
// import plus a hand-rolled X.509 DER walk, not string heuristics. That is a
// deliberate design choice (a truncated or mismatched key must be rejected at
// upload time rather than failing later at runtime), and it is only worth
// anything if the rejecting paths actually reject. The DER reader in
// particular — extractRsaSpki/tryParseSpki, including the multi-byte length
// decoding a 2048-bit certificate forces — had no direct coverage.
//
// The two properties that carry real weight:
//   * A PUBLIC key must not pass as a PRIVATE key, and vice versa. Accepting
//     the wrong half would mean an operator could paste a public key into the
//     private-key setting and only discover it when decryption failed.
//   * A structurally valid certificate whose SPKI is NOT rsaEncryption must be
//     rejected. That is the OID check; without it an EC certificate would be
//     accepted and then fail at import time.
//
// Pure: no database, no network, no AWS.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  isValidCertificate,
  isValidRsaPrivateKey,
  isValidRsaPublicKey,
  validateCertificateSetting,
  validateRsaPrivateKeySetting,
  validateRsaPublicKeySetting,
} from "../../../server/key-validators.tsx";
import {
  APP_PRIVATE_KEY_PEM,
  APP_PRIVATE_KEY_PEM_B64,
  APP_PUBLIC_KEY_PEM,
  APP_PUBLIC_KEY_PEM_B64,
  TENANT_PRIVATE_KEY_PEM,
  TENANT_PUBLIC_KEY_PEM,
} from "../../fixtures/aws-transport-keys.ts";
import { EC_CERT_PEM, RSA_CERT_PEM } from "../../fixtures/x509-certs.ts";

const b64 = (s: string) => btoa(s);

Deno.test("key validators — RSA private keys", async (t) => {
  await t.step("positive: literal PKCS#8 PEM text", async () => {
    assertEquals(await isValidRsaPrivateKey(APP_PRIVATE_KEY_PEM), true);
    assertEquals(await isValidRsaPrivateKey(TENANT_PRIVATE_KEY_PEM), true);
  });

  await t.step("positive: base64-of-PEM (the canonical stored form)", async () => {
    assertEquals(await isValidRsaPrivateKey(APP_PRIVATE_KEY_PEM_B64), true);
  });

  await t.step("positive: surrounding whitespace is tolerated", async () => {
    assertEquals(await isValidRsaPrivateKey(`\n  ${APP_PRIVATE_KEY_PEM}\n\n`), true);
  });

  await t.step("NEGATIVE: a PUBLIC key must not pass as a private key", async () => {
    assertEquals(await isValidRsaPublicKey(APP_PUBLIC_KEY_PEM), true, "sanity: it is a valid public key");
    assertEquals(await isValidRsaPrivateKey(APP_PUBLIC_KEY_PEM), false);
    assertEquals(await isValidRsaPrivateKey(APP_PUBLIC_KEY_PEM_B64), false);
  });

  await t.step("NEGATIVE: empty, whitespace, junk and non-base64 input", async () => {
    for (const bad of ["", "   ", "\n", "not-a-key", "!!!!", "hello world"]) {
      assertEquals(await isValidRsaPrivateKey(bad), false, JSON.stringify(bad));
    }
  });

  await t.step("NEGATIVE: a truncated PEM body is rejected", async () => {
    // The exact failure the cryptographic import exists to catch: it still
    // looks like a PEM, so a string heuristic would wave it through.
    const lines = APP_PRIVATE_KEY_PEM.split("\n");
    const truncated = [lines[0], ...lines.slice(1, 4), lines[lines.length - 1]].join("\n");
    assert(truncated.includes("-----BEGIN"), "fixture must still look like a PEM");
    assertEquals(await isValidRsaPrivateKey(truncated), false);
  });

  await t.step("LIMIT: a single swapped base64 character is NOT detected", async () => {
    // Honest boundary rather than an aspirational assertion. Web Crypto's
    // PKCS#8 import checks ASN.1 structure, not RSA parameter consistency, so
    // flipping one character inside a modulus still yields a structurally
    // valid key and imports fine. Validation here catches malformed/truncated
    // and wrong-type material — it is NOT an integrity check, and an operator
    // pasting a subtly mangled key will only find out at decryption time.
    const body = APP_PRIVATE_KEY_PEM.split("\n");
    const line = body[2];
    body[2] = (line[0] === "A" ? "B" : "A") + line.slice(1);
    assertEquals(await isValidRsaPrivateKey(body.join("\n")), true);
  });

  await t.step("NEGATIVE: dropping a character (shifting the DER) IS detected", async () => {
    // Length-changing damage breaks the ASN.1 framing, which import does check.
    const body = APP_PRIVATE_KEY_PEM.split("\n");
    body[2] = body[2].slice(1);
    assertEquals(await isValidRsaPrivateKey(body.join("\n")), false);
  });

  await t.step("LIMIT: even whole same-length lines of garbage are NOT detected", async () => {
    // Sharpens the boundary above: it is not about how MUCH of the base64
    // changes, only whether the decoded LENGTH changes. Replacing three whole
    // body lines with same-length filler still imports. Anything relying on
    // these validators to prove key integrity is mistaken — they prove
    // "parses as the right kind of object", nothing more.
    const body = APP_PRIVATE_KEY_PEM.split("\n");
    for (const i of [3, 4, 5]) body[i] = "A".repeat(body[i].length);
    assertEquals(await isValidRsaPrivateKey(body.join("\n")), true);
  });

  await t.step("NEGATIVE: shortening a line (changing the decoded length) is detected", async () => {
    const body = APP_PRIVATE_KEY_PEM.split("\n");
    body[3] = "A".repeat(40);
    assertEquals(await isValidRsaPrivateKey(body.join("\n")), false);
  });

  await t.step("NEGATIVE: a certificate is not a private key", async () => {
    assertEquals(await isValidRsaPrivateKey(RSA_CERT_PEM), false);
  });
});

Deno.test("key validators — RSA public keys", async (t) => {
  await t.step("positive: literal SPKI PEM, base64-of-PEM, and whitespace", async () => {
    assertEquals(await isValidRsaPublicKey(APP_PUBLIC_KEY_PEM), true);
    assertEquals(await isValidRsaPublicKey(APP_PUBLIC_KEY_PEM_B64), true);
    assertEquals(await isValidRsaPublicKey(TENANT_PUBLIC_KEY_PEM), true);
    assertEquals(await isValidRsaPublicKey(`  ${APP_PUBLIC_KEY_PEM}  `), true);
  });

  await t.step("NEGATIVE: a PRIVATE key must not pass as a public key", async () => {
    assertEquals(await isValidRsaPublicKey(APP_PRIVATE_KEY_PEM), false);
    assertEquals(await isValidRsaPublicKey(APP_PRIVATE_KEY_PEM_B64), false);
  });

  await t.step("NEGATIVE: empty and junk input", async () => {
    for (const bad of ["", "   ", "not-a-key", "!!!!"]) {
      assertEquals(await isValidRsaPublicKey(bad), false, JSON.stringify(bad));
    }
  });

  await t.step("NEGATIVE: a full X.509 certificate is not a bare SPKI", async () => {
    // A certificate WRAPS an SPKI; it is not one. isValidCertificate() is the
    // validator that knows how to unwrap it.
    assertEquals(await isValidRsaPublicKey(RSA_CERT_PEM), false);
    assertEquals(await isValidCertificate(RSA_CERT_PEM), true, "…and the cert validator does accept it");
  });
});

Deno.test("key validators — X.509 certificates (the DER walk)", async (t) => {
  await t.step("positive: a real 2048-bit RSA certificate", async () => {
    // Exercises extractRsaSpki end to end, including the multi-byte DER length
    // form that a 2048-bit certificate necessarily uses.
    assertEquals(await isValidCertificate(RSA_CERT_PEM), true);
  });

  await t.step("positive: base64-of-PEM certificate", async () => {
    assertEquals(await isValidCertificate(b64(RSA_CERT_PEM)), true);
  });

  await t.step("NEGATIVE: a valid EC certificate is rejected (SPKI is not rsaEncryption)", async () => {
    // Structurally a well-formed X.509 — the OID comparison is the only thing
    // standing between it and acceptance.
    assertEquals(await isValidCertificate(EC_CERT_PEM), false);
  });

  await t.step("NEGATIVE: a bare public key is not a certificate", async () => {
    assertEquals(await isValidCertificate(APP_PUBLIC_KEY_PEM), false);
  });

  await t.step("NEGATIVE: a private key is not a certificate", async () => {
    assertEquals(await isValidCertificate(APP_PRIVATE_KEY_PEM), false);
  });

  await t.step("NEGATIVE: empty and junk input", async () => {
    for (const bad of ["", "   ", "not-a-cert", "!!!!"]) {
      assertEquals(await isValidCertificate(bad), false, JSON.stringify(bad));
    }
  });

  await t.step("NEGATIVE: a truncated certificate body", async () => {
    const lines = RSA_CERT_PEM.split("\n");
    const truncated = [lines[0], lines[1], lines[lines.length - 1]].join("\n");
    assertEquals(await isValidCertificate(truncated), false);
  });

  await t.step("NEGATIVE: DER bytes that are not a SEQUENCE", async () => {
    // Hits the `certDer[0] !== 0x30` early return rather than throwing.
    assertEquals(await isValidCertificate(btoa("\x02\x01\x00")), false);
  });

  await t.step("NEGATIVE: a SEQUENCE containing no SPKI", async () => {
    // A well-formed outer SEQUENCE wrapping an inner SEQUENCE of integers:
    // the walk runs to completion and finds nothing importable.
    const inner = [0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02];
    const der = new Uint8Array([0x30, inner.length, ...inner]);
    assertEquals(await isValidCertificate(btoa(String.fromCharCode(...der))), false);
  });
});

Deno.test("key validators — the setting wrappers return operator-facing errors", async (t) => {
  await t.step("positive: each wrapper accepts its own key type", async () => {
    assertEquals(await validateRsaPrivateKeySetting(APP_PRIVATE_KEY_PEM), { ok: true });
    assertEquals(await validateRsaPublicKeySetting(APP_PUBLIC_KEY_PEM), { ok: true });
    assertEquals(await validateCertificateSetting(RSA_CERT_PEM), { ok: true });
  });

  await t.step("negative: each wrapper names the expected format in its message", async () => {
    const priv = await validateRsaPrivateKeySetting("nope");
    assertEquals(priv.ok, false);
    assert(!priv.ok && priv.error.includes("PKCS#8"), JSON.stringify(priv));

    const pub = await validateRsaPublicKeySetting("nope");
    assertEquals(pub.ok, false);
    assert(!pub.ok && pub.error.includes("SPKI"), JSON.stringify(pub));

    const cert = await validateCertificateSetting("nope");
    assertEquals(cert.ok, false);
    assert(!cert.ok && cert.error.includes("X.509"), JSON.stringify(cert));
  });

  await t.step("negative: the wrappers reject a swapped key pair", async () => {
    // The mistake an operator is most likely to make.
    assertEquals((await validateRsaPrivateKeySetting(APP_PUBLIC_KEY_PEM)).ok, false);
    assertEquals((await validateRsaPublicKeySetting(APP_PRIVATE_KEY_PEM)).ok, false);
    assertEquals((await validateCertificateSetting(EC_CERT_PEM)).ok, false);
  });
});
