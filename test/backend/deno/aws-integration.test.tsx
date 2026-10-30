// Coverage: the gated AWS integration's pure/env-parsing logic
// (server/aws-config.tsx), the outbound JSON payload builder
// (server/aws-secret-delivery.tsx's buildOutboundPayload), and — most
// importantly, given the whole point of this feature — that
// publishRequestToS3/pollForEncryptedSecret/sweepPendingSecretDeliveries
// genuinely no-op (zero AWS calls) while AWS_INTEGRATION_ENABLED is unset,
// which is exactly the state .env.test leaves it in. See
// addendum-025-gated-aws-integration.md.
//
// Deliberately NOT tested here: any real AssumeRole/S3 call. There is no
// AWS account wired to this project, and the entire purpose of the gate is
// that nothing should need one yet. Every env var this file sets is
// restored in a `finally` block since `deno test` runs test files in the
// same process — an unrestored Deno.env.set here would leak into whichever
// test file runs next.
import { assert, assertEquals, assertExists, assertThrows } from "jsr:@std/assert";
import { isAwsIntegrationEnabled, getAwsCredentialStrategy } from "../../../server/aws/config.tsx";
import { resolveBaseCredentials } from "../../../server/aws/credentials.tsx";
import {
  buildOutboundPayload,
  buildRequestCloseNotification,
  publishRequestToS3,
  publishRequestCloseToS3,
} from "../../../server/aws/secret-delivery.tsx";
import { sweepTenantInboundDirectories } from "../../../server/aws/tenant-sweep.tsx";
import { openTenantChannel } from "../../../server/aws/tenant-channel.tsx";
import { wipeDatabase, createAdmin, createActiveUser, uniqueEmail, createSingleStepAgencySystem, addMember, addServingMember, loginAs, req, authHeaders, createAsset } from "./helpers.tsx";
import { requestKeyMaterial, generateId, now } from "../../../server/db.tsx";
import type { BreakglassRequest, System, RequestKeyMaterial, RequestCredentialItem } from "../../../server/types.tsx";

// Runs `fn` with the given env vars set, restoring their PRIOR value (or
// deleting the key if it was previously unset) afterward — protects other
// test files sharing this process from leaking env state.
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

function fixtureRequest(overrides: Partial<BreakglassRequest> = {}): BreakglassRequest {
  return {
    id: generateId(),
    requestNumber: "BG-SYS-20260721-001",
    systemId: generateId(),
    submittedBy: generateId(),
    vendorClusterId: generateId(),
    justification: "Investigate a production incident.",
    srNumber: "SR-1001",
    activityStartAt: "2026-07-21T06:00:00.000Z",
    activityEndAt: "2026-07-21T10:00:00.000Z",
    status: "approved",
    currentStepOrdinal: 0,
    ownerDecisionBy: generateId(),
    ownerDecisionNotes: null,
    ownerDecisionAt: "2026-07-21T05:30:00.000Z",
    credentialIssuedAt: null,
    credentialIssuedBy: null,
    closingNotes: null,
    closedBy: null,
    closedAt: null,
    returnCount: 0,
    createdAt: "2026-07-21T04:00:00.000Z",
    updatedAt: "2026-07-21T05:30:00.000Z",
    ...overrides,
  };
}

function fixtureSystem(overrides: Partial<System> = {}): System {
  return {
    id: generateId(),
    shortCode: "SYS",
    name: "Fixture System",
    description: null,
    vendorClusterIds: [],
    agencyClusterId: generateId(),
    workflowDefinition: [],
    awsRoleArnNote: "arn:aws:iam::123456789012:role/fixture-role",
    createdBy: generateId(),
    createdAt: now(),
    updatedAt: now(),
    ...overrides,
  };
}

function fixtureKeyMaterial(overrides: Partial<RequestKeyMaterial> = {}): RequestKeyMaterial {
  return {
    id: generateId(),
    requestId: generateId(),
    publicKey: "ZmFrZS1wdWJsaWMta2V5", // base64, arbitrary — not real DER for this pure-function test
    keyAlgorithm: "RSA-OAEP-2048-SHA256",
    privateKeyWrapKey: "ZmFrZS1ub25jZQ==",
    encryptedSecretPayload: null,
    createdAt: now(),
    ...overrides,
  };
}

function fixtureItems(): RequestCredentialItem[] {
  return [{
    id: generateId(),
    requestId: generateId(),
    credentialType: "password",
    userid: "svc_account",
    hostname: "host-01",
    hostnameDescription: "test host",
    createdAt: now(),
    updatedAt: now(),
  }];
}

Deno.test("aws-integration", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  // isAwsIntegrationEnabled is async now that the flag can also come from
  // app_settings (addendum-049); the env var still takes precedence when set.
  // With the env var UNSET it falls through to the seeded app_settings value
  // (aws_integration_enabled = 'false' by default), so the observable result
  // for these cases is unchanged.
  await t.step("isAwsIntegrationEnabled: negative — unset defaults to disabled", async () => {
    await withEnv({ AWS_INTEGRATION_ENABLED: undefined }, async () => {
      assertEquals(await isAwsIntegrationEnabled(), false);
    });
  });

  await t.step("isAwsIntegrationEnabled: negative — any value other than the literal string 'true' is disabled", async () => {
    await withEnv({ AWS_INTEGRATION_ENABLED: "1" }, async () => {
      assertEquals(await isAwsIntegrationEnabled(), false);
    });
  });

  await t.step("isAwsIntegrationEnabled: positive — 'true' enables", async () => {
    await withEnv({ AWS_INTEGRATION_ENABLED: "true" }, async () => {
      assertEquals(await isAwsIntegrationEnabled(), true);
    });
  });

  await t.step("getAwsCredentialStrategy: defaults to 'ambient' when unset", async () => {
    await withEnv({ AWS_CREDENTIAL_STRATEGY: undefined }, () => {
      assertEquals(getAwsCredentialStrategy(), "ambient");
    });
  });

  await t.step("getAwsCredentialStrategy: positive — 'static' and 'x509' both parse", async () => {
    await withEnv({ AWS_CREDENTIAL_STRATEGY: "static" }, () => {
      assertEquals(getAwsCredentialStrategy(), "static");
    });
    await withEnv({ AWS_CREDENTIAL_STRATEGY: "x509" }, () => {
      assertEquals(getAwsCredentialStrategy(), "x509");
    });
  });

  await t.step("getAwsCredentialStrategy: negative — unknown strategy throws", async () => {
    await withEnv({ AWS_CREDENTIAL_STRATEGY: "carrier-pigeon" }, () => {
      let threw = false;
      try {
        getAwsCredentialStrategy();
      } catch {
        threw = true;
      }
      assert(threw, "expected an unknown strategy to throw");
    });
  });

  await t.step("buildOutboundPayload: matches addendum-023's documented contract shape", () => {
    const request = fixtureRequest();
    const system = fixtureSystem();
    const keyMaterial = fixtureKeyMaterial({ requestId: request.id });
    const items = fixtureItems();

    const payload = buildOutboundPayload(request, system, keyMaterial, items);

    assertEquals(payload.schemaVersion, "1.0");
    assertEquals(payload.requestId, request.id);
    assertEquals(payload.requestNumber, request.requestNumber);
    assertEquals(payload.systemId, system.id);
    assertEquals(payload.systemShortCode, system.shortCode);
    assertEquals(payload.awsRoleArnNote, system.awsRoleArnNote);
    assertEquals(payload.publicKey, keyMaterial.publicKey);
    assertEquals(payload.keyAlgorithm, keyMaterial.keyAlgorithm);
    assertEquals((payload.credentialItems as unknown[]).length, 1);
    assertEquals((payload.credentialItems as any[])[0], {
      userid: "svc_account", hostname: "host-01", credentialType: "password",
    });
    // The fields addendum-023 added specifically so the receiving side can
    // enforce its own rotation/lockout policy independent of whether
    // Firefighter Station has separately marked the credential issued.
    assertEquals(payload.requestedAt, request.createdAt);
    assertEquals(payload.approvedAt, request.ownerDecisionAt);
    assertEquals(payload.activityStartAt, request.activityStartAt);
    assertEquals(payload.activityEndAt, request.activityEndAt);
  });

  await t.step("publishRequestToS3: no-op (no throw, no AWS call) when integration disabled", async () => {
    await withEnv({ AWS_INTEGRATION_ENABLED: undefined }, async () => {
      const request = fixtureRequest();
      const system = fixtureSystem();
      const keyMaterial = fixtureKeyMaterial({ requestId: request.id });
      // Would throw on any real AWS call attempt (bogus bucket env vars are
      // unset) — reaching the end without throwing IS the assertion.
      await publishRequestToS3(request, system, keyMaterial, fixtureItems());
    });
  });

  await t.step("buildRequestCloseNotification: matches the close-notification contract shape (addendum-092)", () => {
    const request = fixtureRequest({ closedAt: "2026-07-21T12:00:00.000Z", closedBy: generateId() });
    const system = fixtureSystem();
    const items = fixtureItems();

    const payload = buildRequestCloseNotification(request, system, items);

    assertEquals(payload.schemaVersion, "1.0");
    assertEquals(payload.kind, "request_close");
    assertEquals(payload.requestId, request.id);
    assertEquals(payload.requestNumber, request.requestNumber);
    assertEquals(payload.systemId, system.id);
    assertEquals(payload.systemShortCode, system.shortCode);
    assertEquals(payload.awsRoleArnNote, system.awsRoleArnNote);
    assertEquals((payload.credentialItems as unknown[]).length, 1);
    assertEquals((payload.credentialItems as any[])[0], {
      userid: "svc_account", hostname: "host-01", credentialType: "password",
    });
    assertEquals(payload.activityStartAt, request.activityStartAt);
    assertEquals(payload.activityEndAt, request.activityEndAt);
    assertEquals(payload.closedAt, "2026-07-21T12:00:00.000Z");
    assertEquals(payload.closedByUserId, request.closedBy);
  });

  await t.step("publishRequestCloseToS3: no-op (no throw, no AWS call) when integration disabled", async () => {
    await withEnv({ AWS_INTEGRATION_ENABLED: undefined }, async () => {
      const request = fixtureRequest({ closedAt: "2026-07-21T12:00:00.000Z", closedBy: generateId() });
      const system = fixtureSystem();
      await publishRequestCloseToS3(request, system, fixtureItems());
    });
  });

  await t.step("openTenantChannel: returns null (no AWS call) when integration disabled", async () => {
    await withEnv({ AWS_INTEGRATION_ENABLED: undefined }, async () => {
      // Would throw on any real AssumeRole attempt (bogus role/env unset) —
      // reaching here without throwing AND getting null IS the assertion.
      const channel = await openTenantChannel(fixtureSystem(), "ffs-test-noop");
      assertEquals(channel, null);
    });
  });

  await t.step("sweepTenantInboundDirectories: no-op (zero AWS/query fan-out) when integration disabled", async () => {
    await withEnv({ AWS_INTEGRATION_ENABLED: undefined }, async () => {
      // The early-return gate fires before any systems.list()/AWS call;
      // completing without throwing against a freshly-wiped database is the
      // meaningful assertion here.
      await sweepTenantInboundDirectories();
    });
  });

  await t.step("owner-decision: positive — approving a request with real key material does not fail or throw when AWS integration is disabled", async () => {
    const admin = await createAdmin("AwsIntAdmin!2026");
    const owner = await createActiveUser({ fullName: "Owner", email: uniqueEmail("awsintowner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system, vendorL1, agencyL1 } = await createSingleStepAgencySystem(admin.id, owner);

    const submitter = await createActiveUser({ fullName: "Submitter", email: uniqueEmail("awsintsub"), password: "SubmitPass!2026", affiliation: "vendor" });
    await addServingMember(vendorL1, submitter, admin.id);
    const agencyApprover = await createActiveUser({ fullName: "AgencyApprover", email: uniqueEmail("awsintagencyappr"), password: "AgencyApprPass!2026", affiliation: "agency" });
    await addMember(agencyL1, agencyApprover, admin.id);

    const submitterLogin = await loginAs(submitter.email, "SubmitPass!2026") as any;
    const agencyApproverLogin = await loginAs(agencyApprover.email, "AgencyApprPass!2026") as any;
    const ownerLogin = await loginAs(owner.email, "OwnerPass!2026") as any;

    const asset = await createAsset(system.id, { hostname: "host-awsint" });
    const submitRes = await req("/requests", {
      method: "POST", headers: authHeaders(submitterLogin.session),
      body: {
        systemId: system.id,
        justification: "Investigate a production incident requiring elevated access.",
        srNumber: "SR-2001",
        activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        credentialItems: [{ assetId: asset.id }],
      },
    });
    assertEquals(submitRes.status, 201);
    const { request } = await submitRes.json();

    const keyMaterialBefore = await requestKeyMaterial.findByRequest(request.id);
    assertExists(keyMaterialBefore);

    // system's single agency step must be approved first before reaching
    // ordinal 0 (owner terminal) — createSingleStepAgencySystem still has one
    // approval hop, just no vendor-side approval tier.
    const stepRes = await req(`/requests/${request.id}/step-decision`, {
      method: "POST", headers: authHeaders(agencyApproverLogin.session), body: { decision: "approve" },
    });
    assertEquals(stepRes.status, 200);

    const ownerRes = await req(`/requests/${request.id}/owner-decision`, {
      method: "POST", headers: authHeaders(ownerLogin.session), body: { decision: "approve" },
    });
    assertEquals(ownerRes.status, 200);

    // No exception propagated to the HTTP response, and the request's own
    // state is exactly what a normal approval produces — proving the gated
    // publish hook (which ran and no-op'd, since .env.test never sets
    // AWS_INTEGRATION_ENABLED) did not interfere with the real business logic.
    const detail = await req(`/requests/${request.id}`, { headers: authHeaders(ownerLogin.session) }).then((r) => r.json());
    assertEquals(detail.request.status, "approved");
  });
});

// G5 (addendum-140, executed addendum-141): resolveBaseCredentials'
// strategy branches were the one un-pinned branch of the AWS identity stack
// (the real-AWS path stays best-effort per addendum-024/025 — but the
// SELECTION logic is pure env dispatch and pins cleanly). Env is
// save/restored so the mutation can't leak (the runtime_mode pattern).
function withAwsCredStrategy(value: string | undefined, fn: () => void) {
  const prev = Deno.env.get("AWS_CREDENTIAL_STRATEGY");
  try {
    if (value === undefined) Deno.env.delete("AWS_CREDENTIAL_STRATEGY");
    else Deno.env.set("AWS_CREDENTIAL_STRATEGY", value);
    fn();
  } finally {
    if (prev === undefined) Deno.env.delete("AWS_CREDENTIAL_STRATEGY");
    else Deno.env.set("AWS_CREDENTIAL_STRATEGY", prev);
  }
}

Deno.test("aws credentials: provider-chain branches resolve deterministically (G5)", () => {
  withAwsCredStrategy("static", () => {
    assertEquals(typeof resolveBaseCredentials(), "function", "static strategy returns the env-credentials provider");
  });
  withAwsCredStrategy("ambient", () => {
    assertEquals(typeof resolveBaseCredentials(), "function", "ambient strategy returns the node default provider chain");
  });
  withAwsCredStrategy("x509", () => {
    assertThrows(
      () => resolveBaseCredentials(),
      Error,
      "not yet implemented",
      "x509 stays a loud stub until aws_signing_helper/--allow-run are decided (addendum-024/025)",
    );
  });
  withAwsCredStrategy("bogus", () => {
    assertThrows(
      () => getAwsCredentialStrategy(),
      Error,
      'Unknown AWS_CREDENTIAL_STRATEGY "bogus"',
      "unknown strategies fail closed at parse time",
    );
  });
});
