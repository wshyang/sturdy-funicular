// Coverage: the gated AWS integration's real AssumeRole -> SSM-discovery ->
// S3 publish/poll round trip, AND the real EventBridge -> Lambda trigger
// that automatically produces the encrypted response — run against
// LocalStack (a local AWS API emulator) instead of real AWS. See
// addendum-035-localstack-aws-integration-testing.md,
// addendum-036-eventbridge-lambda-localstack-round-trip.md, and
// addendum-025-gated-aws-integration.md (the pipeline this exercises for
// the first time against anything AWS-shaped).
//
// Transport attestation (addendum-087/088) is verified here in BOTH
// directions: the published request file must be signed by the app's private
// key (what the tenant's Lambda checks before processing), and the response
// file the Lambda writes must be signed by the tenant's private key (what the
// app checks before accepting). The Lambda's rejection of a file NOT signed
// by the app key is exercised by invoking the handler directly with a
// throwaway-key-signed request.
//
// Secret store (addendum-088): the delivered value is no longer hardcoded in
// the Lambda — the bootstrap provisions a Secrets Manager test secret
// ("ffs-e2e-test-secret" = "TEST VALUE"), which this suite asserts exists and
// which the Lambda reads on every invocation.
//
// Requires LocalStack running (`docker compose up -d`) and bootstrapped
// (`deno task localstack:bootstrap`) BEFORE this file runs — the bootstrap
// script provisions the bucket/SSM-parameters/roles/Lambda/EventBridge rule
// this file relies on already existing. Unlike every other file in this
// suite, this one is NOT part of the always-on regression gate — .env.test
// never sets AWS_ENDPOINT_URL, so this whole file self-skips (one "skipped"
// step, zero real assertions) when run via the normal `deno task test`,
// keeping the existing regression suite's step count unaffected.
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createSingleStepAgencySystem, addMember, addServingMember, createAsset, latestSentNotification, sentNotificationEmailSnapshots,
} from "./helpers.tsx";
import { requestKeyMaterial, systems } from "../../../server/db.tsx";
import { query } from "../../../server/pg.tsx";
import { clearAppSettingsCache } from "../../../server/app-settings.tsx";
import { publishRequestToS3 } from "../../../server/aws/secret-delivery.tsx";
import { sweepTenantChannel } from "../../../server/aws/tenant-sweep.tsx";
import { inboundObjectKey, outboundObjectKey } from "../../../server/aws/tenant-channel.tsx";
import {
  isTransportWrapped,
  bytesToB64,
  importRsaPublicKey,
  verifyEnvelope,
  wrapTransportFile,
  unwrapTransportFile,
} from "../../../server/aws/crypto.tsx";
import { assumeSystemRoleAndResolveDelivery } from "../../../server/aws/clients.tsx";
import { S3Client, PutObjectCommand, GetObjectCommand } from "npm:@aws-sdk/client-s3@3";
import { SecretsManagerClient, GetSecretValueCommand } from "npm:@aws-sdk/client-secrets-manager@3";
// Same fixture keypairs the LocalStack bootstrap provisions (tenant public key
// in SSM, tenant private key + app public key in the Lambda env) — the app
// side below seeds its own keypair from the same module so the three sides
// can interoperate (addendum-087).
import {
  APP_PRIVATE_KEY_PEM,
  APP_PRIVATE_KEY_PEM_B64,
  APP_PUBLIC_KEY_PEM,
  APP_PUBLIC_KEY_PEM_B64,
  TENANT_PRIVATE_KEY_PEM_B64,
  TENANT_PUBLIC_KEY_PEM,
  TENANT_PUBLIC_KEY_PEM_B64,
} from "../../fixtures/aws-transport-keys.ts";
// The fake Lambda itself, imported so the attestation-rejection path can be
// exercised directly (in-process) with a deliberately wrong-signed request
// file. node:crypto is available under Deno's Node-compat layer.
import { handler as fakeLambdaHandler } from "../../../setup/localstack-lambda/index.mjs";

// Mirrors infra/localstack/localstack-bootstrap.ts's fixed secret naming —
// the Secrets Manager secret this suite asserts on and hands the Lambda.
const SECRET_NAME = "ffs-e2e-test-secret";

// DER -> PEM for the throwaway signer key the wrong-signature step builds.
function derToPem(der: Uint8Array, label: string): string {
  const b64 = bytesToB64(der);
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

const _localstackPort = 4566 + Number(Deno.env.get("E2E_STACK_ID") ?? 0) * 10000;
const LOCALSTACK_ENDPOINT = Deno.env.get("AWS_ENDPOINT_URL") ?? `http://localhost:${_localstackPort}`;
// Matches infra/localstack/localstack-bootstrap.ts's fixed names exactly.
const ASSUME_ROLE_ARN = "arn:aws:iam::000000000000:role/ffs-e2e-assume-role";
const BUCKET = "ffs-e2e-bucket";
const FOLDER_PREFIX = "exchange";

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void> | void) {
  const prior: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) prior[key] = Deno.env.get(key);
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
    await fn();
  } finally {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}

async function isLocalStackUp(): Promise<boolean> {
  try {
    const res = await fetch(`${LOCALSTACK_ENDPOINT}/_localstack/health`);
    return res.ok;
  } catch {
    return false;
  }
}

// LocalStack Lambda cold start + EventBridge event propagation takes a few
// real seconds — polling with a generous retry budget rather than a fixed
// sleep avoids either a flaky too-short wait or an unnecessarily slow test.
async function waitFor<T>(fn: () => Promise<T | null>, attempts = 20, delayMs = 1000): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    const result = await fn();
    if (result !== null) return result;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

Deno.test("aws-localstack", async (t) => {
  const localStackUp = await isLocalStackUp();

  await t.step("setup", async () => {
    if (!localStackUp) {
      console.warn(
        "[aws-localstack] LocalStack not reachable at " + LOCALSTACK_ENDPOINT +
        " — skipping this file's real round-trip tests. Run `docker compose up -d` " +
        "then `deno task localstack:bootstrap` to enable it.",
      );
      return;
    }
    await wipeDatabase();
    // Seed the app-side RSA keypair (addendum-087) so the publish/poll round
    // trip below exercises the encrypted+signed transport — the LocalStack
    // bootstrap provisions the tenant key + Lambda env from the same fixture
    // module by default.
    await query(
      `UPDATE app_settings SET value = $1 WHERE key = 'aws_encrypt_private_key_pem_b64'`,
      [APP_PRIVATE_KEY_PEM_B64],
    );
    await query(
      `UPDATE app_settings SET value = $1 WHERE key = 'aws_encrypt_public_key_pem_b64'`,
      [APP_PUBLIC_KEY_PEM_B64],
    );
    clearAppSettingsCache();
  });

  if (!localStackUp) return;

  const envVars = {
    AWS_INTEGRATION_ENABLED: "true",
    AWS_CREDENTIAL_STRATEGY: "static",
    AWS_ACCESS_KEY_ID: "test",
    AWS_SECRET_ACCESS_KEY: "test",
    AWS_REGION: "us-east-1",
    AWS_ENDPOINT_URL: LOCALSTACK_ENDPOINT,
  };

  await t.step("assumeSystemRoleAndResolveDelivery: positive — real AssumeRole + SSM discovery against LocalStack", async () => {
    await withEnv(envVars, async () => {
      const { s3, bucket, folderPrefix, tenantPublicKeyB64 } = await assumeSystemRoleAndResolveDelivery(ASSUME_ROLE_ARN, "aws-localstack-test-direct");
      // Proves both halves: the AssumeRole call's temp credentials are
      // usable (reaching a real PutObjectCommand without throwing), AND the
      // SSM-discovered bucket/prefix match what infra/localstack/localstack-bootstrap.ts
      // actually provisioned — not just that SOME values came back.
      assertEquals(bucket, BUCKET);
      assertEquals(folderPrefix, FOLDER_PREFIX);
      // Transport-encryption enablement signal (addendum-087): the bootstrap
      // provisions the tenant public key parameter by default.
      assertEquals(tenantPublicKeyB64, TENANT_PUBLIC_KEY_PEM_B64);
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${folderPrefix}/direct-check.json`, Body: "{}" }));
    });
  });

  await t.step("publishRequestToS3 -> real EventBridge/Lambda trigger -> sweepTenantChannel: full centralized round trip against LocalStack", async () => {
    await withEnv(envVars, async () => {
      const admin = await createAdmin("AwsLsAdmin!2026");
      const owner = await createActiveUser({ fullName: "AwsLsOwner", email: uniqueEmail("awslsowner"), password: "OwnerPass!2026", affiliation: "agency" });
      const { system, vendorL1, agencyL1 } = await createSingleStepAgencySystem(admin.id, owner);
      await systems.update(system.id, { awsRoleArnNote: ASSUME_ROLE_ARN });
      const updatedSystem = (await systems.get(system.id))!;

      const submitter = await createActiveUser({ fullName: "AwsLsSubmitter", email: uniqueEmail("awslssub"), password: "SubmitPass!2026", affiliation: "vendor" });
      await addServingMember(vendorL1, submitter, admin.id);
      const agencyApprover = await createActiveUser({ fullName: "AwsLsApprover", email: uniqueEmail("awslsappr"), password: "ApprPass!2026", affiliation: "agency" });
      await addMember(agencyL1, agencyApprover, admin.id);

      const submitterLogin = await loginAs(submitter.email, "SubmitPass!2026") as any;
      const agencyApproverLogin = await loginAs(agencyApprover.email, "ApprPass!2026") as any;
      const ownerLogin = await loginAs(owner.email, "OwnerPass!2026") as any;

      const asset = await createAsset(updatedSystem.id, { hostname: "host-awsls" });
      const submitRes = await req("/requests", {
        method: "POST", headers: authHeaders(submitterLogin.session),
        body: {
          systemId: updatedSystem.id,
          justification: "Investigate a production incident requiring elevated access.",
          srNumber: "SR-AWSLS-001",
          activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
          credentialItems: [{ assetId: asset.id }],
        },
      });
      assertEquals(submitRes.status, 201);
      const { request } = await submitRes.json();

      const stepRes = await req(`/requests/${request.id}/step-decision`, {
        method: "POST", headers: authHeaders(agencyApproverLogin.session), body: { decision: "approve" },
      });
      assertEquals(stepRes.status, 200);

      // The real publish fires as a non-fatal hook inside ownerDecision — a
      // real AssumeRoleCommand + SSM discovery + PutObjectCommand against
      // LocalStack, not a mock. This PutObjectCommand is ALSO what triggers
      // the real EventBridge rule -> real Lambda invocation, entirely
      // outside this app's control — nothing here simulates that step.
      const ownerRes = await req(`/requests/${request.id}/owner-decision`, {
        method: "POST", headers: authHeaders(ownerLogin.session), body: { decision: "approve" },
      });
      assertEquals(ownerRes.status, 200);

      // The published request object on S3 must now be the signed+encrypted
      // transport envelope (addendum-087) — never the plaintext JSON. Read it
      // back with the assumed role's own credentials.
      const { s3: readS3, bucket: readBucket, folderPrefix: readPrefix } = await assumeSystemRoleAndResolveDelivery(ASSUME_ROLE_ARN, "aws-localstack-readback");
      // Canonical v1 outbound path (addendum-09x).
      const outKey = outboundObjectKey(readPrefix, "credential_request", request.id);
      const obj = await readS3.send(new GetObjectCommand({
        Bucket: readBucket,
        Key: outKey,
      }));
      const publishedBody = await obj.Body!.transformToString();
      assertEquals(isTransportWrapped(publishedBody), true, "published request object must be a schema-2.0 transport envelope, not plaintext");

      // INBOUND ATTESTATION (addendum-088): the published request file must
      // be signed with the APP private key — verifiable with the app public
      // key. This is exactly the check the tenant's Lambda performs before
      // processing the file, so attesting the artifact here proves what the
      // Lambda will attest.
      const reqParsed = JSON.parse(publishedBody);
      const appPubKey = await importRsaPublicKey(APP_PUBLIC_KEY_PEM);
      assertEquals(
        await verifyEnvelope(appPubKey.pkcs1, reqParsed.envelope, reqParsed.signature.value),
        true,
        "published request file must be signed by the app private key",
      );

      // SECRET STORE (addendum-088): the value the Lambda delivers is not
      // hardcoded — it lives in the Secrets Manager test secret the bootstrap
      // provisions. Assert the secret exists (the Lambda reads it on every
      // invocation). Read with a direct static-credential client, NOT the
      // assumed role — the app's assumed role must never have access to the
      // tenant's secret store (permission separation the harness models).
      const secretReadClient = new SecretsManagerClient({
        endpoint: LOCALSTACK_ENDPOINT,
        credentials: { accessKeyId: "test", secretAccessKey: "test" },
        region: "us-east-1",
      });
      const secretRes = await secretReadClient.send(new GetSecretValueCommand({ SecretId: SECRET_NAME }));
      assertEquals(secretRes.SecretString, "TEST VALUE");

      const keyMaterial = await requestKeyMaterial.findByRequest(request.id);
      assertExists(keyMaterial);
      assertEquals(keyMaterial!.encryptedSecretPayload, null); // not delivered yet — Lambda hasn't run yet at this instant

      // Wait for the REAL Lambda (triggered by the REAL EventBridge rule
      // matching the PutObjectCommand above) to actually produce the
      // canonical v1 inbound response object — no manual PUT standing in for
      // it anywhere in this test.
      const respKey = inboundObjectKey(readPrefix, "credential_response", request.id);
      const waitForResp = await waitFor(async () => {
        try {
          const { s3: wS3, bucket: wBucket } = await assumeSystemRoleAndResolveDelivery(ASSUME_ROLE_ARN, "aws-localstack-response-wait");
          return await wS3.send(new GetObjectCommand({ Bucket: wBucket, Key: respKey }));
        } catch (e) {
          if ((e as { name?: string })?.name === "NoSuchKey") return null;
          throw e;
        }
      });
      assertExists(waitForResp, "expected the real EventBridge-triggered Lambda to have produced a response within the retry budget");
      const respText = await waitForResp!.Body!.transformToString();
      // OUTBOUND ATTESTATION (addendum-088): the response file the Lambda
      // wrote must be signed with the TENANT private key — verifiable with
      // the tenant public key. This is exactly the check the app's sweep
      // performs before accepting the payload; assert it on the raw artifact
      // AND that the inner payload unwraps cleanly.
      assertEquals(isTransportWrapped(respText), true, "response object must be a schema-2.0 transport envelope");
      const respParsed = JSON.parse(respText);
      const tenantPubKey = await importRsaPublicKey(TENANT_PUBLIC_KEY_PEM);
      assertEquals(
        await verifyEnvelope(tenantPubKey.pkcs1, respParsed.envelope, respParsed.signature.value),
        true,
        "response file must be signed by the tenant private key",
      );
      const respInner = await unwrapTransportFile(respText, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM) as any;
      assertEquals(respInner.requestId, request.id);
      assertEquals(respInner.status, "success");
      assertExists(respInner.encryptedPayload);
      // Cannot decrypt this — addendum-025's whole design point is that the
      // real private key is generated and immediately discarded server-side,
      // never persisted.

      // sweepTenantChannel is the centralized inbound sweep entry point —
      // running it directly (as the real cron / /health trigger would) proves
      // the whole chain end-to-end: one ListObjectsV2 -> match the awaiting
      // exchange -> GetObject -> verify/decrypt -> reconcile (writes
      // encryptedSecretPayload + notifies the requester).
      await sweepTenantChannel(updatedSystem);
      const updatedKeyMaterial = await requestKeyMaterial.findByRequest(request.id);
      assertExists(updatedKeyMaterial!.encryptedSecretPayload);
      // encrypted_secret_payload is `text` (JSON string), not JSONB — see the
      // "no JSONB for business data" standing rule — so it must be parsed
      // before property access, same as delivery.tsx already does.
      assertEquals(JSON.parse(updatedKeyMaterial!.encryptedSecretPayload as string).requestId, request.id);

      // Email notification (addendum-044) #27 — replaces the former
      // console.log stub addendum-025 called out as the placeholder to
      // replace, now exercised by the real cron entry point above.
      const deliveredEmail = await latestSentNotification("request.aws_secret_delivery_received");
      assertExists(deliveredEmail);
      assertEquals(sentNotificationEmailSnapshots(deliveredEmail), [submitter.email]);
    });
  });

  await t.step("Lambda inbound attestation: a request file NOT signed by the app's private key is rejected (error response, nothing delivered)", async () => {
    await withEnv({
      ...envVars,
      // The in-process handler invocation reads these from the test process
      // env (the deployed LocalStack Lambda gets them from its own
      // Environment config — see the bootstrap). The wrong-signed file fails
      // attestation BEFORE the secret read, so SECRET_ID is never actually
      // resolved on this path — it is set anyway to mirror the deployed
      // Lambda's real env.
      TENANT_PRIVATE_KEY_PEM_B64,
      APP_PUBLIC_KEY_PEM_B64,
      SECRET_ID: SECRET_NAME,
    }, async () => {
      const { s3 } = await assumeSystemRoleAndResolveDelivery(ASSUME_ROLE_ARN, "aws-localstack-wrong-sig");

      // A throwaway keypair — NOT the app key — signs this request file.
      const other = await crypto.subtle.generateKey(
        { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true,
        ["sign"],
      );
      const otherPrivDer = new Uint8Array(await crypto.subtle.exportKey("pkcs8", other.privateKey));
      const otherPrivPem = derToPem(otherPrivDer, "PRIVATE KEY");
      const badWrapped = await wrapTransportFile(
        {
          schemaVersion: "1.0",
          requestId: "wrong-signed",
          publicKey: bytesToB64(new TextEncoder().encode("irrelevant")),
          credentialItems: [],
        },
        otherPrivPem,
        TENANT_PUBLIC_KEY_PEM,
        "request",
      );

      // PUT under the canonical v1 OUTBOUND credential-request path so the
      // Lambda reaches its transport-attestation step. Direct invocation (not
      // EventBridge) — no retrigger risk from using the real marker path.
      const badKey = "exchange/v1/outbound/credential-request/wrong-signed.json";
      await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: badKey, Body: badWrapped, ContentType: "application/json" }));

      // Invoke the handler directly (in-process) with the event shape
      // EventBridge would deliver. It must NOT throw — attestation failure
      // becomes an error response object (a throwing Lambda would be retried
      // by EventBridge for 24h — the anti-pattern this harness avoids).
      await fakeLambdaHandler({ detail: { bucket: { name: BUCKET }, object: { key: badKey } } });

      // The error response is itself a transport envelope (signed with the
      // tenant key) whose inner payload reports the verification failure.
      const errObj = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "exchange/v1/inbound/credential-response/invalid/wrong-signed.json" }));
      const errText = await errObj.Body!.transformToString();
      assertEquals(isTransportWrapped(errText), true, "error response must still be a schema-2.0 transport envelope");
      const errInner = await unwrapTransportFile(errText, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM) as any;
      assertEquals(errInner.status, "error");
      assert(
        String(errInner.errorMessage).includes("verification FAILED"),
        `errorMessage should mention signature verification failure, got: ${errInner.errorMessage}`,
      );

      // And nothing was written to the app's valid inbound response path for
      // that request id — a rejected file is observable (credential-response/
      // invalid/) but never delivered as if it were a real response.
      let delivered = true;
      try {
        await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: "exchange/v1/inbound/credential-response/wrong-signed.json" }));
      } catch (e) {
        if ((e as { name?: string })?.name === "NoSuchKey") delivered = false;
      }
      assertEquals(delivered, false, "a rejected request file must never produce a delivery response");
    });
  });
});
