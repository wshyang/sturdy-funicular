// Red-regiment ledger row 7 — non-API-manageable assets, phase A: outbound
// payload partition (assessment
// docs/assessments/2026-08-04-non-api-manageable-assets-workflow-deviation.md).
//
// PURE-FUNCTION contract on buildOutboundPayload
// (server/aws-secret-delivery.tsx:44). RED BY DESIGN, NO GATES (owner
// direction 2026-08-05): today the builder maps EVERY credential item into
// `credentialItems` wholesale. Desired: items whose per-item `managementMode`
// is 'manual' never ship to the AWS tenant as tenant-manageable credentials
// (they are fulfilled through physical custody — the
// physical custody flow); the payload
// partitions them into a separate `manualCredentialItems` array so the
// receiving ledger and the owner UI can see what was deliberately withheld.
//
// `as any` casts are deliberate: the managementMode field does not exist on
// RequestCredentialItem yet — the fixtures here pin the desired shape.
import { assertEquals } from "jsr:@std/assert";
import { buildOutboundPayload } from "../../../server/aws/secret-delivery.tsx";

function fakeRequest() {
  return {
    id: "req-partition-1",
    requestNumber: "BG-001",
    createdAt: "2026-08-05T01:00:00.000Z",
    ownerDecisionAt: "2026-08-05T02:00:00.000Z",
    activityStartAt: "2026-08-05T03:00:00.000Z",
    activityEndAt: "2026-08-05T04:00:00.000Z",
  };
}

function fakeSystem() {
  return { id: "sys-partition-1", shortCode: "BGSYS", awsRoleArnNote: null };
}

function fakeKeyMaterial() {
  return { publicKey: "ssh-rsa AAAA-partition-test", keyAlgorithm: "rsa-4096" };
}

function buildWith(items: unknown[]): Record<string, unknown> {
  return buildOutboundPayload(
    fakeRequest() as never,
    fakeSystem() as never,
    fakeKeyMaterial() as never,
    items as never,
  );
}

Deno.test("outbound payload partition: manual-mode items never ship as tenant-manageable credentials", () => {
  const items = [
    { userid: "svc_app", hostname: "prod-db-01", credentialType: "password", managementMode: "api_managed" },
    { userid: "svc_legacy", hostname: "prod-mainframe-01", credentialType: "password", managementMode: "manual" },
  ];

  const payload = buildWith(items);

  // RED today: credentialItems contains BOTH items wholesale.
  const shipped = payload.credentialItems as Array<{ userid: string; hostname: string; credentialType: string }>;
  assertEquals(shipped.map((i) => i.userid), ["svc_app"]);
  assertEquals(shipped[0], { userid: "svc_app", hostname: "prod-db-01", credentialType: "password" });

  // RED today: the partition array does not exist on the payload at all.
  const withheld = payload.manualCredentialItems as Array<{ userid: string }>;
  assertEquals(withheld.map((i) => i.userid), ["svc_legacy"]);
});

Deno.test("outbound payload partition: an all-API-managed payload keeps manualCredentialItems present but empty", () => {
  const items = [
    { userid: "svc_app", hostname: "prod-db-01", credentialType: "password", managementMode: "api_managed" },
  ];

  const payload = buildWith(items);

  assertEquals((payload.credentialItems as unknown[]).length, 1);
  assertEquals(payload.manualCredentialItems, []);
});
