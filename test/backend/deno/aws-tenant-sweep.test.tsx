// Coverage: the centralized inbound sweep (addendum-09x) processing a single
// tenant channel directory in ONE pass — the core Section N contract that one
// `sweepTenantChannel()` invocation reconciles ALL three inbound types
// (credential-response, inventory-response, request-close-ack), strictly
// rejects an unknown inbound object (never retrieved, never processed, never
// recorded), and persists S3 metadata (LastModified -> inbound_published_at,
// ETag) captured from a real GetObject.
//
// The three inbound objects are planted by THIS test at their canonical v1
// paths, wrapped in the addendum-087 transport envelope exactly as the tenant
// Lambda would (tenant private key signs + app public key encrypts) — so the
// sweep's transport verification/decryption + correlation binding are
// exercised for real. Each maps to an awaiting aws_tenant_exchanges row; the
// unknown object maps to nothing.
//
// Requires LocalStack running (`docker compose up -d`) and bootstrapped
// (`deno task localstack:bootstrap`) — self-skips (zero real assertions) when
// not reachable, like the other LocalStack-gated files.
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import {
  wipeDatabase, createAdmin, createActiveUser, createWiredSystem, uniqueEmail,
} from "./helpers.tsx";
import {
  breakglassRequests, requestKeyMaterial, assets, awsTenantExchanges, systems, generateId, now,
} from "../../../server/db.tsx";
import type { AwsTenantExchange, AwsTenantInboundType, AwsTenantOutboundType } from "../../../server/types.tsx";
import { query } from "../../../server/pg.tsx";
import { clearAppSettingsCache } from "../../../server/app-settings.tsx";
import { sweepTenantChannel } from "../../../server/aws/tenant-sweep.tsx";
import { inboundObjectKey, outboundObjectKey } from "../../../server/aws/tenant-channel.tsx";
import { wrapTransportFile } from "../../../server/aws/crypto.tsx";
import { assumeSystemRoleAndResolveDelivery } from "../../../server/aws/clients.tsx";
import { PutObjectCommand } from "npm:@aws-sdk/client-s3@3";
import {
  APP_PRIVATE_KEY_PEM_B64,
  APP_PUBLIC_KEY_PEM_B64,
  APP_PUBLIC_KEY_PEM,
  TENANT_PRIVATE_KEY_PEM,
} from "../../fixtures/aws-transport-keys.ts";

const _localstackPort = 4566 + Number(Deno.env.get("E2E_STACK_ID") ?? 0) * 10000;
const LOCALSTACK_ENDPOINT = Deno.env.get("AWS_ENDPOINT_URL") ?? `http://localhost:${_localstackPort}`;
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

// An awaiting exchange row with sensible defaults (Section E contract).
function awaitingExchange(
  systemId: string,
  correlationId: string,
  outboundType: AwsTenantOutboundType,
  expectedInboundType: AwsTenantInboundType,
): AwsTenantExchange {
  const publishedAt = now();
  return {
    id: generateId(),
    systemId,
    correlationId,
    outboundType,
    expectsInbound: true,
    expectedInboundType,
    outboundObjectKey: outboundObjectKey(FOLDER_PREFIX, outboundType, correlationId),
    outboundStatus: "published",
    outboundPublishedAt: publishedAt,
    inboundObjectKey: null,
    inboundStatus: "awaiting",
    inboundPublishedAt: null,
    inboundReceivedAt: null,
    inboundProcessedAt: null,
    inboundEtag: null,
    failureCode: null,
    failureMessage: null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  };
}

Deno.test("aws-tenant-sweep", async (t) => {
  const localStackUp = await isLocalStackUp();

  await t.step("setup", async () => {
    if (!localStackUp) {
      console.warn(
        "[aws-tenant-sweep] LocalStack not reachable at " + LOCALSTACK_ENDPOINT +
        " — skipping this file's sweep tests. Run `docker compose up -d` then `deno task localstack:bootstrap` to enable it.",
      );
      return;
    }
    await wipeDatabase();
    // Seed the app-side RSA keypair so the sweep's transport verification/
    // decryption path is exercised (the bootstrap provisions the tenant key in
    // SSM + the tenant-private/app-public keys in the Lambda env).
    await query(`UPDATE app_settings SET value = $1 WHERE key = 'aws_encrypt_private_key_pem_b64'`, [APP_PRIVATE_KEY_PEM_B64]);
    await query(`UPDATE app_settings SET value = $1 WHERE key = 'aws_encrypt_public_key_pem_b64'`, [APP_PUBLIC_KEY_PEM_B64]);
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

  await t.step("ONE sweepTenantChannel processes all three inbound types; unknown inbound is skipped; S3 metadata persists", async () => {
    await withEnv(envVars, async () => {
      const admin = await createAdmin("AwsSweepAdmin!2026");
      const owner = await createActiveUser({ fullName: "AwsSweepOwner", email: uniqueEmail("awssweepowner"), password: "OwnerPass!2026", affiliation: "agency" });
      const { system, vendorCluster } = await createWiredSystem(admin.id, owner);
      await systems.update(system.id, { awsRoleArnNote: ASSUME_ROLE_ARN });
      const updatedSystem = (await systems.get(system.id))!;

      // A real submitter user (breakglass_requests.submitted_by is an FK).
      const submitter = await createActiveUser({ fullName: "AwsSweepSub", email: uniqueEmail("awssweepsub"), password: "SubPass!2026", affiliation: "vendor" });

      // A real approved request + key material so reconcileCredentialResponse
      // succeeds (writes encryptedSecretPayload + notifies the requester).
      const requestId = generateId();
      await breakglassRequests.create({
        id: requestId,
        requestNumber: "BG-SWEEP-001",
        systemId: system.id,
        submittedBy: submitter.id,
        vendorClusterId: vendorCluster.id,
        justification: "Sweep coverage request.",
        srNumber: "SR-SWEEP-1",
        activityStartAt: new Date(Date.now() - 60_000).toISOString(),
        activityEndAt: new Date(Date.now() + 60_000).toISOString(),
        status: "approved",
        currentStepOrdinal: 0,
        returnCount: 0,
        ownerDecisionBy: owner.id,
        ownerDecisionNotes: null,
        ownerDecisionAt: new Date(Date.now() - 30_000).toISOString(),
        credentialIssuedBy: null,
        credentialIssuedAt: null,
        closedBy: null,
        closingNotes: null,
        closedAt: null,
        createdAt: new Date(Date.now() - 120_000).toISOString(),
        updatedAt: new Date(Date.now() - 30_000).toISOString(),
      });
      await requestKeyMaterial.create({
        id: generateId(),
        requestId,
        publicKey: "ZmFrZS1zd2VlcC1wdWJsaWMta2V5",
        keyAlgorithm: "RSA-OAEP-2048-SHA256",
        privateKeyWrapKey: "ZmFrZS1ub25jZQ==",
        encryptedSecretPayload: null,
        createdAt: now(),
      });

      const closeReqId = generateId();
      // Three awaiting exchanges, one per outbound/inbound type.
      const credEx = awaitingExchange(system.id, requestId, "credential_request", "credential_response");
      const closeEx = awaitingExchange(system.id, closeReqId, "request_close", "request_close_ack");
      const invEx = awaitingExchange(system.id, system.id, "inventory_request", "inventory_response");
      await awsTenantExchanges.create(credEx);
      await awsTenantExchanges.create(closeEx);
      await awsTenantExchanges.create(invEx);

      // Plant the three canonical v1 inbound objects + one unknown object,
      // all transport-wrapped exactly as the tenant Lambda would write them.
      const { s3, bucket, folderPrefix } = await assumeSystemRoleAndResolveDelivery(ASSUME_ROLE_ARN, "aws-sweep-plant");
      async function plant(key: string, payload: Record<string, unknown>): Promise<void> {
        const body = await wrapTransportFile(payload, TENANT_PRIVATE_KEY_PEM, APP_PUBLIC_KEY_PEM, "response");
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: "application/json" }));
      }
      await plant(inboundObjectKey(folderPrefix, "credential_response", requestId), {
        schemaVersion: "1.0", requestId, status: "success",
        encryptedPayload: { algorithm: "RSA-OAEP-2048-SHA256+AES-256-GCM", encryptedKey: "x", iv: "y", ciphertext: "z", authTag: "w" },
        errorMessage: null, processedAt: new Date().toISOString(),
      });
      await plant(inboundObjectKey(folderPrefix, "request_close_ack", closeReqId), {
        schemaVersion: "1.0", kind: "request_close_ack", requestId: closeReqId, systemId: system.id,
        status: "success", processedAt: new Date().toISOString(), actionSummary: "rotation_requested", errorMessage: null,
      });
      await plant(inboundObjectKey(folderPrefix, "inventory_response", system.id), {
        schemaVersion: "1.0", systemId: system.id, status: "success",
        assets: [{ hostname: "host-sweep-01", credentialName: "svc_sweep", credentialType: "password" }],
        errorMessage: null, processedAt: new Date().toISOString(),
      });
      // An UNKNOWN inbound object — not a recognized type, no awaiting exchange.
      await plant(`${folderPrefix}/v1/inbound/unknown-slug/whatever.json`, {
        schemaVersion: "1.0", requestId: "no-one-awaiting-this", status: "success",
      });

      // ONE sweep invocation for this channel directory.
      await sweepTenantChannel(updatedSystem);

      // All three recognized exchanges are now processed.
      const credAfter = await awsTenantExchanges.get(credEx.id);
      assertEquals(credAfter!.inboundStatus, "processed");
      assertExists(credAfter!.inboundProcessedAt);
      // S3 metadata persists: LastModified -> inbound_published_at, ETag.
      assertExists(credAfter!.inboundPublishedAt, "inbound_published_at must come from GetObject.LastModified");
      assertExists(credAfter!.inboundEtag, "inbound_etag must come from GetObject.ETag");

      const closeAfter = await awsTenantExchanges.get(closeEx.id);
      assertEquals(closeAfter!.inboundStatus, "processed");
      assertExists(closeAfter!.inboundProcessedAt);

      const invAfter = await awsTenantExchanges.get(invEx.id);
      assertEquals(invAfter!.inboundStatus, "processed");
      assertExists(invAfter!.inboundProcessedAt);

      // Domain reconcile effects:
      //  - credential response persisted into request_key_material.
      const km = await requestKeyMaterial.findByRequest(requestId);
      assertExists(km!.encryptedSecretPayload);
      // encrypted_secret_payload is `text` (JSON string), not JSONB — see the
      // "no JSONB for business data" standing rule — so it must be parsed
      // before property access, same as delivery.tsx already does.
      assertEquals(JSON.parse(km!.encryptedSecretPayload as string).requestId, requestId);
      //  - inventory response reconciled into the assets table.
      const reconciled = await assets.findBySystem(system.id);
      assert(reconciled.some((a) => a.hostname === "host-sweep-01" && a.systemManaged), "inventory response should have been reconciled into system-managed assets");
      //  - close ack recorded as an audit event (request remains un-touched).
      const ackRows = await query<{ action: string; details: { status?: string; actionSummary?: string } }>(
        `SELECT action, details FROM audit_log WHERE target_type = 'breakglass_request' AND target_id = $1 AND action = 'request.aws_close_acknowledged'`,
        [closeReqId],
      );
      assertEquals(ackRows.length, 1);
      assertEquals(ackRows[0].details?.status, "success");
      assertEquals(ackRows[0].details?.actionSummary, "rotation_requested");

      // The UNKNOWN inbound object was never processed: no exchange was created
      // for its correlation id, and the three known exchanges are the only ones
      // for this system (no stray failed/processed row appeared).
      const all = await awsTenantExchanges.listBySystem(system.id);
      assertEquals(all.length, 3);
      assert(!all.some((e) => e.correlationId === "no-one-awaiting-this"), "unknown inbound object must never create an exchange row");
    });
  });
});
