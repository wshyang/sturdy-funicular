// Coverage: the automated password-release pipeline — the wrapped-private-key
// delivery on submit, the GET /requests/:id/secret-material retrieval route
// (submitter-only, eligibility-window-enforced), the request.secret_material_ready
// readiness signal, and the requester self-close path.
//
// Delivery is REAL-ONLY: encrypted_secret_payload is populated by the
// centralized S3 exchange sweep (server/aws-tenant-sweep.tsx), not by any
// fake-Lambda simulation. This file has no LocalStack/AWS, so it seeds the
// encrypted payload directly (buildTestEncryptedPayload below encrypts the
// fixed string "TEST VALUE" against the request's REAL public key — the same
// shape the tenant Lambda produces) to exercise the retrieval + decrypt chain
// and the readiness-gap logic without external infrastructure.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createWiredSystem, addMember, addServingMember, createAsset,
} from "./helpers.tsx";
import { requestKeyMaterial } from "../../../server/db.tsx";

function b64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function bytesToB64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

// Builds an addendum-023 encrypted-payload envelope holding the literal string
// "TEST VALUE", encrypted against the request's REAL public key (base64 SPKI).
// Mirrors what the tenant Lambda / sweep reconciles into
// request_key_material.encrypted_secret_payload — used to seed delivery in this
// no-LocalStack unit test.
async function buildTestEncryptedPayload(publicKeyB64: string, requestId: string): Promise<Record<string, unknown>> {
  const spki = b64ToBytes(publicKeyB64);
  const publicKey = await crypto.subtle.importKey(
    "spki", spki.buffer as ArrayBuffer, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"],
  );
  const sessionKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, sessionKey, new TextEncoder().encode("TEST VALUE")),
  );
  const ciphertext = encrypted.slice(0, encrypted.length - 16);
  const authTag = encrypted.slice(encrypted.length - 16);
  const rawSessionKey = new Uint8Array(await crypto.subtle.exportKey("raw", sessionKey));
  const wrappedSessionKey = new Uint8Array(await crypto.subtle.encrypt({ name: "RSA-OAEP" }, publicKey, rawSessionKey));
  return {
    schemaVersion: "1.0",
    requestId,
    status: "success",
    encryptedPayload: {
      algorithm: "RSA-OAEP-2048-SHA256+AES-256-GCM",
      encryptedKey: bytesToB64(wrappedSessionKey),
      iv: bytesToB64(iv),
      ciphertext: bytesToB64(ciphertext),
      authTag: bytesToB64(authTag),
    },
    errorMessage: null,
    processedAt: new Date().toISOString(),
  };
}

// Seeds encryptedSecretPayload for a request as the sweep would, given the
// request's stored public key. Returns the seeded payload.
async function seedDelivery(requestId: string): Promise<Record<string, unknown>> {
  const keyMaterial = await requestKeyMaterial.findByRequest(requestId);
  assertExists(keyMaterial);
  const payload = await buildTestEncryptedPayload(keyMaterial!.publicKey, requestId);
  await requestKeyMaterial.update(keyMaterial!.id, { encryptedSecretPayload: payload });
  return payload;
}

async function setupScenario(adminId: string) {
  const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("sarowner"), password: "OwnerPass!2026", affiliation: "agency" });
  const { system, vendorL1, vendorL2, agencyL1 } = await createWiredSystem(adminId, owner);

  const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("sarsub"), password: "SubmitPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL1, submitter, adminId);
  const vendorApprover = await createActiveUser({ fullName: "VendorApprover", email: uniqueEmail("sarvendorappr"), password: "VendorApprPass!2026", affiliation: "vendor" });
  await addServingMember(vendorL2, vendorApprover, adminId);
  const agencyApprover = await createActiveUser({ fullName: "AgencyApprover", email: uniqueEmail("saragencyappr"), password: "AgencyApprPass!2026", affiliation: "agency" });
  await addMember(agencyL1, agencyApprover, adminId);

  const otherUser = await createActiveUser({ fullName: "OtherUser", email: uniqueEmail("sarother"), password: "OtherPass!2026", affiliation: "vendor" });

  const submitterLogin = await loginAs(submitter.email, "SubmitPass!2026") as any;
  const vendorApproverLogin = await loginAs(vendorApprover.email, "VendorApprPass!2026") as any;
  const agencyApproverLogin = await loginAs(agencyApprover.email, "AgencyApprPass!2026") as any;
  const ownerLogin = await loginAs(owner.email, "OwnerPass!2026") as any;
  const otherLogin = await loginAs(otherUser.email, "OtherPass!2026") as any;

  return {
    system, owner, submitter, vendorApprover, agencyApprover,
    submitterSession: submitterLogin.session,
    vendorApproverSession: vendorApproverLogin.session,
    agencyApproverSession: agencyApproverLogin.session,
    ownerSession: ownerLogin.session,
    otherSession: otherLogin.session,
  };
}

async function validSubmission(systemId: string, overrides: Record<string, unknown> = {}) {
  const defaultCredentialItems = overrides.credentialItems ?? [{ assetId: (await createAsset(systemId, { hostname: "host-01" })).id }];
  return {
    systemId: systemId,
    justification: "Investigate a production incident requiring elevated access.",
    srNumber: "SR-9001",
    activityStartAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    ...overrides,
    credentialItems: defaultCredentialItems,
  };
}

// Decodes base64 PKCS8 from the wrapped-private-key file's own base64
// envelope, AES-GCM-unwraps it using the private_key_wrap_key, and RSA-OAEP-decrypts the
// delivered payload — the exact chain a real browser would run.
async function decryptViaDownloadedFile(wrappedPrivateKeyFile: string, wrapKeyB64: string, encryptedPayload: any): Promise<string> {
  const envelope = JSON.parse(atob(wrappedPrivateKeyFile));
  const wrapKeyBytes = b64ToBytes(wrapKeyB64);
  const wrapKey = await crypto.subtle.importKey("raw", wrapKeyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const ivBytes = b64ToBytes(envelope.iv);
  const wrappedBytes = b64ToBytes(envelope.wrappedPrivateKey);
  const pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ivBytes }, wrapKey, wrappedBytes);
  const privateKey = await crypto.subtle.importKey(
    "pkcs8", pkcs8, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"],
  );

  const wrappedSessionKey = b64ToBytes(encryptedPayload.encryptedKey);
  const rawSessionKey = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, privateKey, wrappedSessionKey);
  const sessionKey = await crypto.subtle.importKey("raw", rawSessionKey, { name: "AES-GCM" }, false, ["decrypt"]);

  const ciphertext = b64ToBytes(encryptedPayload.ciphertext);
  const authTag = b64ToBytes(encryptedPayload.authTag);
  const combined = new Uint8Array(ciphertext.length + authTag.length);
  combined.set(ciphertext, 0);
  combined.set(authTag, ciphertext.length);
  const payloadIv = b64ToBytes(encryptedPayload.iv);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: payloadIv }, sessionKey, combined);
  return new TextDecoder().decode(plaintext);
}

async function approveThroughOwner(s: Awaited<ReturnType<typeof setupScenario>>, requestId: string): Promise<void> {
  await req(`/requests/${requestId}/step-decision`, { method: "POST", headers: authHeaders(s.vendorApproverSession), body: { decision: "approve" } });
  await req(`/requests/${requestId}/step-decision`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: { decision: "approve" } });
  await req(`/requests/${requestId}/owner-decision`, { method: "POST", headers: authHeaders(s.ownerSession), body: { decision: "approve" } });
}

Deno.test("test-secret-autorelease", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("SarAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "SarAdmin!2026") as any;
    adminSession = login.session;
  });

  await t.step("submit: positive — wrappedPrivateKeyFile is always present and shaped correctly", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertExists(data.wrappedPrivateKeyFile);

    const envelope = JSON.parse(atob(data.wrappedPrivateKeyFile));
    assertEquals(envelope.keyAlgorithm, "RSA-OAEP-2048-SHA256");
    assertEquals(envelope.wrapAlgorithm, "AES-256-GCM");
    assertExists(envelope.iv);
    assertExists(envelope.wrappedPrivateKey);

    const keyMaterial = await requestKeyMaterial.findByRequest(data.request.id);
    assertExists(keyMaterial);
    assertEquals(keyMaterial!.keyAlgorithm, "RSA-OAEP-2048-SHA256");
  });

  await t.step("submit with client-supplied public key (Variant B): stores the public key + a server-minted wrap key, returns the wrap key, no wrapped file", async () => {
    const s = await setupScenario(adminId);
    // Generate a keypair the way the browser would, and send only the SPKI public key.
    const kp = await crypto.subtle.generateKey(
      { name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true, ["encrypt", "decrypt"],
    );
    const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
    const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(spki)));

    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { publicKey: publicKeyB64 }),
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    // No wrapped file is produced on the client-key path (the browser wraps its
    // own private key with the returned wrap key).
    assertEquals(data.wrappedPrivateKeyFile, undefined);

    const keyMaterial = await requestKeyMaterial.findByRequest(data.request.id);
    assertExists(keyMaterial);
    assertEquals(keyMaterial!.publicKey, publicKeyB64);
    // The server mints + stores a wrap key (so getSecretMaterial can return it
    // at retrieval), but never sees the private key.
    assertExists(keyMaterial!.privateKeyWrapKey);
    assertEquals(data.privateKeyWrapKey, keyMaterial!.privateKeyWrapKey);

    // getSecretMaterial returns the same wrap key for a client-key row.
    await approveThroughOwner(s, data.request.id);
    await seedDelivery(data.request.id);
    const materialRes = await req(`/requests/${data.request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    const material = await materialRes.json();
    assertEquals(material.privateKeyWrapKey, keyMaterial!.privateKeyWrapKey);
  });

  await t.step("submit with an invalid client public key is rejected (400)", async () => {
    const s = await setupScenario(adminId);
    const res = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { publicKey: "bm90LWEta2V5" }), // "not-a-key"
    });
    assertEquals(res.status, 400);
  });

  await t.step("owner-decision -> secret-material (seeded delivery): full round trip decrypts to TEST VALUE", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const submitData = await submitRes.json();
    const { request, wrappedPrivateKeyFile } = submitData;

    await approveThroughOwner(s, request.id);
    // Delivery is asynchronous — seed it as the sweep would, then retrieve.
    await seedDelivery(request.id);

    const materialRes = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(materialRes.status, 200);
    const material = await materialRes.json();
    assertExists(material.encryptedSecretPayload);
    assertEquals(material.passwordCredentialItems.length, 1);
    assertEquals(material.passwordCredentialItems[0].credentialType, "password");

    const plaintext = await decryptViaDownloadedFile(wrappedPrivateKeyFile, material.privateKeyWrapKey, material.encryptedSecretPayload.encryptedPayload);
    assertEquals(plaintext, "TEST VALUE");
  });

  await t.step("secret-material: positive — a request with multiple password items returns all of them, sharing one decrypted secret", async () => {
    const s = await setupScenario(adminId);
    const assetOne = await createAsset(s.system.id, { hostname: "host-one", credentialName: "svc_one", credentialType: "password" });
    const assetTwo = await createAsset(s.system.id, { hostname: "host-two", credentialName: "svc_two", credentialType: "password" });
    const assetTok = await createAsset(s.system.id, { hostname: "issuer-1", credentialName: "tok_1", credentialType: "token" });
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, {
        credentialItems: [{ assetId: assetOne.id }, { assetId: assetTwo.id }, { assetId: assetTok.id }],
      }),
    });
    const submitData = await submitRes.json();
    const { request, wrappedPrivateKeyFile } = submitData;

    await approveThroughOwner(s, request.id);
    await seedDelivery(request.id);

    const materialRes = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(materialRes.status, 200);
    const material = await materialRes.json();
    assertEquals(material.passwordCredentialItems.length, 2);
    const useridsAndHosts = material.passwordCredentialItems.map((i: any) => [i.credentialName, i.hostname]).sort();
    assertEquals(useridsAndHosts, [["svc_one", "host-one"], ["svc_two", "host-two"]]);

    const plaintext = await decryptViaDownloadedFile(wrappedPrivateKeyFile, material.privateKeyWrapKey, material.encryptedSecretPayload.encryptedPayload);
    assertEquals(plaintext, "TEST VALUE");
  });

  await t.step("getRequest: secret_material_ready reflects the real gap between approval and the secret landing", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const beforeDetail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then((r) => r.json());
    assertEquals(beforeDetail.request.secretMaterialReady, false);

    await approveThroughOwner(s, request.id);
    // After approval but BEFORE delivery lands, secretMaterialReady is still
    // false (the async gap a real pipeline leaves open).
    const gapDetail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then((r) => r.json());
    assertEquals(gapDetail.request.status, "approved");
    assertEquals(gapDetail.request.secretMaterialReady, false);

    // Once the sweep lands the payload, it flips true.
    await seedDelivery(request.id);
    const readyDetail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then((r) => r.json());
    assertEquals(readyDetail.request.secretMaterialReady, true);
  });

  await t.step("secret-material: negative — not yet approved (still submitted)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();

    const res = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 403);
  });

  await t.step("secret-material: negative — approved but not yet delivered returns 409 (wrap key NOT yielded until the AWS response is back)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);

    // Approved, within the window, but encryptedSecretPayload is still null
    // (the async delivery gap before the sweep lands the response). The API
    // must NOT yield the private-key wrap key here — it returns 409.
    const res = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 409);
    const body = await res.json();
    assertExists(body.error);

    // After the sweep lands the payload, the same call succeeds and yields the key.
    await seedDelivery(request.id);
    const after = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(after.status, 200);
    const material = await after.json();
    assertExists(material.privateKeyWrapKey);
  });

  await t.step("secret-material: negative — closed request", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);
    await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
    await req(`/requests/${request.id}/close`, { method: "POST", headers: authHeaders(s.agencyApproverSession), body: {} });

    const res = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 403);
  });

  await t.step("secret-material: positive — still available in credential_issued status (independent of the physical-custody route)", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);
    await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });
    await seedDelivery(request.id);

    const res = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 200);
  });

  await t.step("secret-material: negative — outside the activity window", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, {
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
      }),
    });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);
    await seedDelivery(request.id);

    const res = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 403);
  });

  await t.step("secret-material: negative — only the submitter can retrieve; every non-submitter (unrelated user, admin, AND reviewers/owner who can view the request) gets 404, no wrap key leaked", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);
    // Even once delivery has landed (wrap key present), the key must not be
    // retrievable by anyone other than the submitter.
    await seedDelivery(request.id);

    // A fully unrelated user.
    const otherRes = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.otherSession) });
    assertEquals(otherRes.status, 404);
    // An admin.
    const adminRes = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(adminSession) });
    assertEquals(adminRes.status, 404);
    // Reviewers who can VIEW the request (step approvals + owner) are NOT the
    // submitter — retrieval is submitter-only, so they must also be 404'd and
    // never see the wrap key.
    for (const session of [s.vendorApproverSession, s.agencyApproverSession, s.ownerSession]) {
      const res = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(session) });
      assertEquals(res.status, 404, "a non-submitter reviewer/owner must be 404'd");
      const body = await res.json();
      assertEquals(body.privateKeyWrapKey, undefined, "no wrap key may be yielded to a non-submitter");
    }

    // The submitter still retrieves it.
    const submitterRes = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(submitterRes.status, 200);
    const material = await submitterRes.json();
    assertExists(material.privateKeyWrapKey);
  });

  await t.step("secret-material: positive — token/device-only request returns empty password_credential_items, not 404", async () => {
    const s = await setupScenario(adminId);
    const tokenAsset = await createAsset(s.system.id, { hostname: "issuer-1", credentialName: "tok_1", credentialType: "token" });
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(s.submitterSession),
      body: await validSubmission(s.system.id, { credentialItems: [{ assetId: tokenAsset.id }] }),
    });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);
    // Delivery must have landed for the API to yield the material (409
    // otherwise); seed it as the sweep would. A token/device-only request still
    // reaches 200 but returns empty password_credential_items.
    await seedDelivery(request.id);

    const res = await req(`/requests/${request.id}/secret-material`, { headers: authHeaders(s.submitterSession) });
    assertEquals(res.status, 200);
    const material = await res.json();
    assertEquals(material.passwordCredentialItems.length, 0);
  });

  await t.step("close: positive — the requester can self-close their own request once the credential is issued", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);
    await req(`/requests/${request.id}/issue-credential`, { method: "POST", headers: authHeaders(s.agencyApproverSession) });

    const res = await req(`/requests/${request.id}/close`, { method: "POST", headers: authHeaders(s.submitterSession), body: {} });
    assertEquals(res.status, 200);
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(s.submitterSession) }).then(r => r.json());
    assertEquals(detail.request.status, "closed");
  });

  await t.step("close: negative — the requester cannot self-close before the credential is issued", async () => {
    const s = await setupScenario(adminId);
    const submitRes = await req("/requests", { method: "POST", headers: authHeaders(s.submitterSession), body: await validSubmission(s.system.id) });
    const { request } = await submitRes.json();
    await approveThroughOwner(s, request.id);

    const res = await req(`/requests/${request.id}/close`, { method: "POST", headers: authHeaders(s.submitterSession), body: {} });
    assertEquals(res.status, 400);
  });
});
