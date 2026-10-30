// Coverage: the centralized AWS tenant S3 exchange architecture (addendum-09x)
// — the aws_tenant_exchanges ledger, canonical v1 object-key construction, the
// correlation-bound awaiting-exchange lookup the sweep relies on, and the
// request-close acknowledgement reconciliation. This file exercises the pure
// channel helpers + the ledger entity against real Postgres (no AWS call — the
// S3 plumbing is covered by the LocalStack-gated aws-localstack.test.tsx /
// aws-asset-inventory.test.tsx round trips).
//
// No AWS env vars are set here, so none of the publish functions are invoked
// against a real endpoint; the ledger rows are created directly through the
// awsTenantExchanges entity (the same entity the publish path uses) so the
// matching + reconciliation logic is testable without S3.
import { assertEquals, assertExists, assertRejects } from "jsr:@std/assert";
import {
  wipeDatabase, createAdmin, createActiveUser, createSingleStepAgencySystem, uniqueEmail,
} from "./helpers.tsx";
import { awsTenantExchanges, breakglassRequests, generateId, now } from "../../../server/db.tsx";
import { inboundObjectKey, outboundObjectKey } from "../../../server/aws/tenant-channel.tsx";
import { reconcileCloseAcknowledgement } from "../../../server/aws/secret-delivery.tsx";
import { query } from "../../../server/pg.tsx";
import type { AwsTenantExchange } from "../../../server/types.tsx";

function exchangeRow(partial: Partial<AwsTenantExchange> = {}): AwsTenantExchange {
  const publishedAt = now();
  return {
    id: generateId(),
    systemId: partial.systemId ?? generateId(),
    correlationId: partial.correlationId ?? generateId(),
    outboundType: partial.outboundType ?? "credential_request",
    expectsInbound: partial.expectsInbound ?? true,
    expectedInboundType: "expectedInboundType" in partial ? partial.expectedInboundType! : "credential_response",
    outboundObjectKey: partial.outboundObjectKey ?? "exchange/v1/outbound/credential-request/x.json",
    outboundStatus: "published",
    outboundPublishedAt: publishedAt,
    inboundObjectKey: partial.inboundObjectKey ?? null,
    inboundStatus: partial.inboundStatus ?? "awaiting",
    inboundPublishedAt: partial.inboundPublishedAt ?? null,
    inboundReceivedAt: partial.inboundReceivedAt ?? null,
    inboundProcessedAt: partial.inboundProcessedAt ?? null,
    inboundEtag: partial.inboundEtag ?? null,
    failureCode: partial.failureCode ?? null,
    failureMessage: partial.failureMessage ?? null,
    createdAt: publishedAt,
    updatedAt: publishedAt,
  };
}

Deno.test("aws-tenant-exchange", async (t) => {
  await t.step("setup", async () => {
    await wipeDatabase();
  });

  await t.step("canonical v1 object keys (direction-first naming contract)", () => {
    assertEquals(
      outboundObjectKey("exchange", "credential_request", "req-1"),
      "exchange/v1/outbound/credential-request/req-1.json",
    );
    assertEquals(
      outboundObjectKey("exchange", "request_close", "req-1"),
      "exchange/v1/outbound/request-close/req-1.json",
    );
    assertEquals(
      outboundObjectKey("exchange", "inventory_request", "sys-1"),
      "exchange/v1/outbound/inventory-request/sys-1.json",
    );
    assertEquals(
      inboundObjectKey("exchange", "credential_response", "req-1"),
      "exchange/v1/inbound/credential-response/req-1.json",
    );
    assertEquals(
      inboundObjectKey("exchange", "request_close_ack", "req-1"),
      "exchange/v1/inbound/request-close-ack/req-1.json",
    );
    assertEquals(
      inboundObjectKey("exchange", "inventory_response", "sys-1"),
      "exchange/v1/inbound/inventory-response/sys-1.json",
    );
  });

  await t.step("ledger: create + findAwaitingForInbound correlation-bound match", async () => {
    const admin = await createAdmin("AwsExAdmin!2026");
    const owner = await createActiveUser({ fullName: "AwsExOwner", email: uniqueEmail("awsexowner"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createSingleStepAgencySystem(admin.id, owner);
    const correlationId = generateId();

    const exchange = await awsTenantExchanges.create(exchangeRow({
      systemId: system.id,
      correlationId,
      outboundType: "credential_request",
      expectedInboundType: "credential_response",
    }));
    assertExists(exchange.id);

    // The awaiting lookup (the sweep's eligibility match) resolves it.
    const matched = await awsTenantExchanges.findAwaitingForInbound(system.id, correlationId, "credential_response");
    assertExists(matched);
    assertEquals(matched!.id, exchange.id);

    // A WRONG expected inbound type does not match (an inventory_response
    // object must never be accepted for a credential_request exchange).
    assertEquals(
      await awsTenantExchanges.findAwaitingForInbound(system.id, correlationId, "inventory_response"),
      null,
    );
    // A wrong system does not match.
    assertEquals(
      await awsTenantExchanges.findAwaitingForInbound(generateId(), correlationId, "credential_response"),
      null,
    );

    // Transition through received -> processed preserves the S3 metadata.
    const received = await awsTenantExchanges.markInboundReceived(exchange.id, {
      inboundObjectKey: inboundObjectKey("exchange", "credential_response", correlationId),
      inboundPublishedAt: "2026-07-21T06:00:00.000Z",
      inboundReceivedAt: "2026-07-21T06:00:01.000Z",
      inboundEtag: "\"abc123\"",
    });
    assertEquals(received!.inboundStatus, "received");
    assertEquals(received!.inboundPublishedAt, "2026-07-21T06:00:00.000Z");
    assertEquals(received!.inboundEtag, "\"abc123\"");

    const processed = await awsTenantExchanges.markInboundProcessed(exchange.id, "2026-07-21T06:00:02.000Z");
    assertEquals(processed!.inboundStatus, "processed");
    assertEquals(processed!.inboundProcessedAt, "2026-07-21T06:00:02.000Z");

    // Once processed it is no longer "awaiting" and is never re-matched.
    assertEquals(
      await awsTenantExchanges.findAwaitingForInbound(system.id, correlationId, "credential_response"),
      null,
    );
  });

  await t.step("DB CHECK: expects_inbound=false requires expected_inbound_type IS NULL (and vice-versa)", async () => {
    const admin = await createAdmin("AwsExAdmin2!2026");
    const owner = await createActiveUser({ fullName: "AwsExOwner2", email: uniqueEmail("awsexowner2"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createSingleStepAgencySystem(admin.id, owner);

    // One-way notification must NOT carry an expected inbound type.
    await assertRejects(
      () => awsTenantExchanges.create(exchangeRow({
        systemId: system.id,
        outboundType: "request_close",
        expectsInbound: false,
        expectedInboundType: "request_close_ack",
      })),
      Error,
      "aws_tenant_exchanges_expects_inbound_consistency",
    );

    // A request/response exchange must carry an expected inbound type.
    await assertRejects(
      () => awsTenantExchanges.create(exchangeRow({
        systemId: system.id,
        outboundType: "credential_request",
        expectsInbound: true,
        expectedInboundType: null,
      })),
      Error,
      "aws_tenant_exchanges_expects_inbound_consistency",
    );
  });

  await t.step("reconcileCloseAcknowledgement records the tenant ack and does NOT alter the closed request", async () => {
    const admin = await createAdmin("AwsExAdmin3!2026");
    const owner = await createActiveUser({ fullName: "AwsExOwner3", email: uniqueEmail("awsexowner3"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createSingleStepAgencySystem(admin.id, owner);
    const request = await breakglassRequests.create({
      id: generateId(),
      requestNumber: "BG-CLOSEACK-001",
      systemId: system.id,
      submittedBy: owner.id,
      vendorClusterId: system.agencyClusterId,
      justification: "Close ack test.",
      srNumber: "SR-CA-1",
      activityStartAt: new Date(Date.now() - 60_000).toISOString(),
      activityEndAt: new Date(Date.now() + 60_000).toISOString(),
      status: "closed",
      currentStepOrdinal: 0,
      returnCount: 0,
      // owner_decision_at and _by are set together — a closed request was
      // decided by someone. The DB enforces the pairing
      // (breakglass_requests_owner_decision_paired, migration 091); this
      // fixture previously set the timestamp with a null decider.
      ownerDecisionBy: owner.id,
      ownerDecisionNotes: null,
      ownerDecisionAt: new Date(Date.now() - 30_000).toISOString(),
      credentialIssuedAt: new Date(Date.now() - 20_000).toISOString(),
      credentialIssuedBy: owner.id,
      closedBy: owner.id,
      closingNotes: "done",
      closedAt: new Date(Date.now() - 10_000).toISOString(),
      createdAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      updatedAt: new Date(Date.now() - 10_000).toISOString(),
    });

    const exchange = await awsTenantExchanges.create(exchangeRow({
      systemId: system.id,
      correlationId: request.id,
      outboundType: "request_close",
      expectedInboundType: "request_close_ack",
      outboundObjectKey: outboundObjectKey("exchange", "request_close", request.id),
    }));

    await reconcileCloseAcknowledgement(exchange, {
      schemaVersion: "1.0",
      kind: "request_close_ack",
      requestId: request.id,
      systemId: system.id,
      status: "success",
      processedAt: "2026-07-21T12:05:00.000Z",
      actionSummary: "rotation_requested",
      errorMessage: null,
    });

    // The acknowledgement is recorded as an operational audit event...
    const auditRows = await query<{ action: string; details: { status?: string; actionSummary?: string } }>(
      `SELECT action, details FROM audit_log WHERE target_type = 'breakglass_request' AND target_id = $1 AND action = 'request.aws_close_acknowledged'`,
      [request.id],
    );
    assertEquals(auditRows.length, 1);
    assertEquals(auditRows[0].details?.status, "success");
    assertEquals(auditRows[0].details?.actionSummary, "rotation_requested");

    // ...and the local request closure remains final regardless of the ack.
    const after = await breakglassRequests.get(request.id);
    assertEquals(after!.status, "closed");
    assertExists(after!.closedAt);
  });

  await t.step("ledger: markInboundFailed clears an awaiting exchange so it is never re-matched", async () => {
    const admin = await createAdmin("AwsExAdmin4!2026");
    const owner = await createActiveUser({ fullName: "AwsExOwner4", email: uniqueEmail("awsexowner4"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createSingleStepAgencySystem(admin.id, owner);
    const correlationId = generateId();

    const exchange = await awsTenantExchanges.create(exchangeRow({
      systemId: system.id,
      correlationId,
      outboundType: "inventory_request",
      expectedInboundType: "inventory_response",
    }));

    await awsTenantExchanges.markInboundFailed(exchange.id, {
      failureCode: "correlation_mismatch",
      failureMessage: "decoded system id did not match exchange",
    });
    const after = await awsTenantExchanges.get(exchange.id);
    assertEquals(after!.inboundStatus, "failed");
    assertEquals(after!.failureCode, "correlation_mismatch");

    // A failed exchange is no longer awaiting, so the sweep can never match it.
    assertEquals(
      await awsTenantExchanges.findAwaitingForInbound(system.id, correlationId, "inventory_response"),
      null,
    );
  });
});
