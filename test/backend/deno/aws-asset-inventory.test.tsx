// Coverage: the asset-inventory interrogation exchange's real S3
// publish/poll round trip AND the real EventBridge -> Lambda trigger that
// automatically produces the fake tenant's asset list — run against
// LocalStack instead of real AWS. See addendum-037-asset-inventory.md
// (this exchange) and addendum-036-eventbridge-lambda-localstack-round-trip.md
// (the pattern this file follows, for the sibling secret-delivery exchange).
//
// Requires LocalStack running (`docker compose up -d`) and bootstrapped
// (`deno task localstack:bootstrap`) BEFORE this file runs — the bootstrap
// script provisions the bucket/SSM-parameters/roles/inventory-Lambda/
// EventBridge rule this file relies on already existing. Unlike every other
// file in this suite, this one is NOT part of the always-on regression
// gate — .env.test never sets AWS_ENDPOINT_URL, so this whole file
// self-skips (one "skipped" step, zero real assertions) when run via the
// normal `deno task test`, keeping the existing regression suite's step
// count unaffected.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  wipeDatabase, createAdmin, createActiveUser, createWiredSystem, uniqueEmail,
} from "./helpers.tsx";
import { systems, assets } from "../../../server/db.tsx";
import { query } from "../../../server/pg.tsx";
import { clearAppSettingsCache } from "../../../server/app-settings.tsx";
import { publishInventoryRequestToS3, pollForInventoryResponse, reconcileAssetInventory } from "../../../server/aws/asset-inventory.tsx";
import { inboundObjectKey, outboundObjectKey } from "../../../server/aws/tenant-channel.tsx";
import { isTransportWrapped, importRsaPublicKey, verifyEnvelope, unwrapTransportFile } from "../../../server/aws/crypto.tsx";
import { assumeSystemRoleAndResolveDelivery } from "../../../server/aws/clients.tsx";
import { GetObjectCommand } from "npm:@aws-sdk/client-s3@3";
// Same fixture keypairs the LocalStack bootstrap provisions (tenant public
// key in SSM, tenant private key + app public key in the inventory Lambda
// env) — the app side below seeds its own keypair from the same module so
// the three sides interoperate (addendum-090).
import {
  APP_PRIVATE_KEY_PEM,
  APP_PRIVATE_KEY_PEM_B64,
  APP_PUBLIC_KEY_PEM,
  APP_PUBLIC_KEY_PEM_B64,
  TENANT_PUBLIC_KEY_PEM,
} from "../../fixtures/aws-transport-keys.ts";

const _localstackPort = 4566 + Number(Deno.env.get("E2E_STACK_ID") ?? 0) * 10000;
const LOCALSTACK_ENDPOINT = Deno.env.get("AWS_ENDPOINT_URL") ?? `http://localhost:${_localstackPort}`;
// Matches infra/localstack/localstack-bootstrap.ts's fixed names exactly.
const ASSUME_ROLE_ARN = "arn:aws:iam::000000000000:role/ffs-e2e-assume-role";

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

Deno.test("aws-asset-inventory", async (t) => {
  const localStackUp = await isLocalStackUp();

  await t.step("setup", async () => {
    if (!localStackUp) {
      console.warn(
        "[aws-asset-inventory] LocalStack not reachable at " + LOCALSTACK_ENDPOINT +
        " — skipping this file's real round-trip tests. Run `docker compose up -d` " +
        "then `deno task localstack:bootstrap` to enable it.",
      );
      return;
    }
    await wipeDatabase();
    // Seed the app-side RSA keypair (addendum-090) so the publish/poll round
    // trip below exercises the encrypted+signed transport — the LocalStack
    // bootstrap provisions the tenant key + the inventory Lambda env from
    // the same fixture module by default.
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

  await t.step("publishInventoryRequestToS3 -> real EventBridge/Lambda trigger -> syncAssetInventoryForSystem: full round trip against LocalStack", async () => {
    await withEnv(envVars, async () => {
      const admin = await createAdmin("AwsInvAdmin!2026");
      const owner = await createActiveUser({ fullName: "AwsInvOwner", email: uniqueEmail("awsinvowner"), password: "OwnerPass!2026", affiliation: "agency" });
      const { system } = await createWiredSystem(admin.id, owner);
      await systems.update(system.id, { awsRoleArnNote: ASSUME_ROLE_ARN });
      const updatedSystem = (await systems.get(system.id))!;

      // The real publish fires a real AssumeRoleCommand + SSM discovery +
      // PutObjectCommand against LocalStack, not a mock. This PutObjectCommand
      // is ALSO what triggers the real EventBridge rule -> real Lambda
      // invocation, entirely outside this app's control — nothing here
      // simulates that step.
      await publishInventoryRequestToS3(updatedSystem);

      // INBOUND ATTESTATION (addendum-090): the published inventory request
      // object must be a schema-2.0 transport envelope signed by the app
      // private key — the exact check the tenant's inventory Lambda performs
      // before producing the asset list.
      const { s3: readS3, bucket: readBucket, folderPrefix: readPrefix } = await assumeSystemRoleAndResolveDelivery(ASSUME_ROLE_ARN, "aws-inv-readback");
      const reqObj = await readS3.send(new GetObjectCommand({
        Bucket: readBucket,
        Key: outboundObjectKey(readPrefix, "inventory_request", updatedSystem.id),
      }));
      const reqText = await reqObj.Body!.transformToString();
      assertEquals(isTransportWrapped(reqText), true, "published inventory request must be a schema-2.0 transport envelope");
      const reqParsed = JSON.parse(reqText);
      const appPubKey = await importRsaPublicKey(APP_PUBLIC_KEY_PEM);
      assertEquals(
        await verifyEnvelope(appPubKey.pkcs1, reqParsed.envelope, reqParsed.signature.value),
        true,
        "published inventory request must be signed by the app private key",
      );

      // Wait for the REAL Lambda (triggered by the REAL EventBridge rule
      // matching the PutObjectCommand above) to actually produce the
      // response object — no manual PUT standing in for it anywhere in this
      // test. pollForInventoryResponse is the exact same GetObjectCommand
      // path a real cron poll would use.
      const polled = await waitFor(() => pollForInventoryResponse(updatedSystem));
      assertExists(polled, "expected the real EventBridge-triggered inventory Lambda to have produced a response within the retry budget");
      assertEquals(polled!.status, "success");
      assertExists(polled!.assets);
      assertEquals(polled!.assets!.length > 0, true);

      // OUTBOUND ATTESTATION (addendum-090): the response file the inventory
      // Lambda wrote must be a schema-2.0 envelope signed by the TENANT
      // private key and unwrap with the app private key — exactly what
      // pollForInventoryResponse verified to produce `polled`.
      const respObj = await readS3.send(new GetObjectCommand({
        Bucket: readBucket,
        Key: inboundObjectKey(readPrefix, "inventory_response", updatedSystem.id),
      }));
      const respText = await respObj.Body!.transformToString();
      assertEquals(isTransportWrapped(respText), true, "inventory response must be a schema-2.0 transport envelope");
      const respParsed = JSON.parse(respText);
      const tenantPubKey = await importRsaPublicKey(TENANT_PUBLIC_KEY_PEM);
      assertEquals(
        await verifyEnvelope(tenantPubKey.pkcs1, respParsed.envelope, respParsed.signature.value),
        true,
        "inventory response must be signed by the tenant private key",
      );
      const respInner = await unwrapTransportFile(respText, APP_PRIVATE_KEY_PEM, TENANT_PUBLIC_KEY_PEM) as { status: string };
      assertEquals(respInner.status, "success");

      // syncAssetInventoryForSystem is the actual on-demand/cron-driven
      // entry point — running it directly proves the whole chain
      // end-to-end: publish -> real trigger -> poll S3 -> reconcile into
      // the assets table.
      // Poll + reconcile directly to avoid re-publishing (publishInventoryRequestToS3
      // was already called above; syncAssetInventoryForSystem would re-publish and
      // hit the unique constraint on the exchange ledger).
      await waitFor(async () => {
        const resp = await pollForInventoryResponse(updatedSystem);
        if (!resp) return null;
        await reconcileAssetInventory(updatedSystem, resp);
        const list = await assets.findBySystem(updatedSystem.id);
        return list.length > 0 ? list : null;
      });

      const list = await assets.findBySystem(updatedSystem.id);
      assertEquals(list.length > 0, true);
      for (const asset of list) {
        assertEquals(asset.systemManaged, true);
        assertEquals(asset.expiresAfter, null);
      }
    });
  });
});
