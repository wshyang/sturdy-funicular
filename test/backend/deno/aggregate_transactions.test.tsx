// Aggregate repository transaction contracts (addendum-153).
//
// Each negative case deliberately lets the root/base write succeed and then
// violates a child-table constraint. The public repository operation must
// reject and roll back BOTH the root/base write and every preceding child
// mutation. These calls are made directly, outside the HTTP middleware, so a
// green result proves the repository owns its transaction boundary.
import {
  assertEquals,
  assertExists,
  assertRejects,
} from "jsr:@std/assert";
import {
  assets,
  breakglassRequests,
  generateId,
  notificationTemplates,
  now,
  custodyRuns,
  requestCredentialItems,
  systems,
} from "../../../server/db.tsx";
import type {
  Asset,
  BreakglassRequest,
  AssetCustodyRun,
  System,
} from "../../../server/types.tsx";
import { isInTransaction, runInTransaction } from "../../../server/pg.tsx";
import {
  createActiveUser,
  createAdmin,
  createCluster,
  createSystemReturningWithOwnerEdge,
  wipeDatabase,
} from "./helpers.tsx";

function systemFixture(
  id: string,
  createdBy: string,
  agencyClusterId: string,
  vendorClusterIds: string[],
): System {
  const timestamp = now();
  return {
    id,
    shortCode: `TX${id.slice(-6)}`.toUpperCase(),
    name: `Transactional system ${id.slice(-6)}`,
    description: "aggregate transaction contract",
    vendorClusterIds,
    agencyClusterId,
    workflowDefinition: [],
    awsRoleArnNote: null,
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAfter: null,
  };
}

function assetFixture(
  id: string,
  systemId: string,
  tags: Asset["tags"],
): Asset {
  const timestamp = now();
  return {
    id,
    systemId,
    systemManaged: false,
    managementMode: "manual",
    credentialType: "password",
    hostname: `host-${id.slice(-6)}`,
    credentialName: "administrator",
    description: "original asset",
    service: null,
    tags,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAfter: null,
  };
}

function requestFixture(
  id: string,
  requestNumber: string,
  systemId: string,
  submittedBy: string,
  vendorClusterId: string,
): BreakglassRequest {
  const timestamp = now();
  return {
    id,
    requestNumber,
    systemId,
    submittedBy,
    vendorClusterId,
    justification: "Aggregate transaction rollback coverage.",
    srNumber: requestNumber,
    activityStartAt: new Date(Date.now() + 3_600_000).toISOString(),
    activityEndAt: new Date(Date.now() + 7_200_000).toISOString(),
    status: "submitted",
    currentStepOrdinal: 1,
    ownerDecisionBy: null,
    ownerDecisionNotes: null,
    ownerDecisionAt: null,
    credentialIssuedAt: null,
    credentialIssuedBy: null,
    closingNotes: null,
    closedBy: null,
    closedAt: null,
    returnCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function runFixture(
  id: string,
  requestId: string,
  systemId: string,
  custodyItemIds: string[],
): AssetCustodyRun {
  const timestamp = now();
  return {
    id,
    requestId,
    systemId,
    status: "in_progress",
    currentOrdinal: 1,
    custodyItemIds,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

Deno.test("aggregate repositories own their transaction boundaries", async (t) => {
  let adminId: string;
  let vendorClusterId: string;
  let agencyClusterId: string;
  let system: System;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AggregateTx!2026");
    adminId = admin.id;
    vendorClusterId = (await createCluster("vendor", adminId)).id;
    agencyClusterId = (await createCluster("agency", adminId)).id;
  });

  await t.step("systems.create rolls back a root when a child FK fails", async () => {
    const systemId = generateId();
    const missingClusterId = generateId();

    await assertRejects(() =>
      systems.create(
        systemFixture(
          systemId,
          adminId,
          agencyClusterId,
          [missingClusterId],
        ),
      )
    );

    assertEquals(await systems.get(systemId), null);
  });

  await t.step("systems.update rolls back base and child replacements", async () => {
    system = await createSystemReturningWithOwnerEdge(
      systemFixture(
        generateId(),
        adminId,
        agencyClusterId,
        [vendorClusterId],
      ),
      agencyClusterId,
      adminId,
    );
    const originalName = system.name;

    await assertRejects(() =>
      systems.update(system.id, {
        name: "must roll back",
        vendorClusterIds: [generateId()],
      })
    );

    const restored = await systems.get(system.id);
    assertExists(restored);
    assertEquals(restored.name, originalName);
    assertEquals(restored.vendorClusterIds, [vendorClusterId]);
  });

  await t.step("aggregate transactions reenter an existing business transaction", async () => {
    const assetId = generateId();
    let joinedOuterTransaction = false;
    await runInTransaction(async () => {
      joinedOuterTransaction = isInTransaction();
      await assets.create(assetFixture(assetId, system.id, []));
    });
    assertEquals(joinedOuterTransaction, true);
    assertExists(await assets.get(assetId));
  });

  await t.step("assets.create rolls back a root when duplicate child tags fail", async () => {
    const assetId = generateId();
    const duplicateTags = [
      { key: "environment", value: "prod" },
      { key: "environment", value: "uat" },
    ];

    await assertRejects(() =>
      assets.create(assetFixture(assetId, system.id, duplicateTags))
    );

    assertEquals(await assets.get(assetId), null);
  });

  await t.step("assets.update preserves base fields and prior tags on failure", async () => {
    const asset = await assets.create(
      assetFixture(
        generateId(),
        system.id,
        [{ key: "environment", value: "prod" }],
      ),
    );

    await assertRejects(() =>
      assets.update(asset.id, {
        description: "must roll back",
        tags: [
          { key: "owner", value: "one" },
          { key: "owner", value: "two" },
        ],
      })
    );

    const restored = await assets.get(asset.id);
    assertExists(restored);
    assertEquals(restored.description, "original asset");
    assertEquals(restored.tags, [{ key: "environment", value: "prod" }]);
  });

  await t.step("notification template update preserves base and variables", async () => {
    const original = await notificationTemplates.findByTriggerKey("user.approved");
    assertExists(original);

    await assertRejects(() =>
      notificationTemplates.update(original.id, {
        subject: "must roll back",
        variables: [
          { name: "duplicate", description: "first" },
          { name: "duplicate", description: "second" },
        ],
      })
    );

    const restored = await notificationTemplates.get(original.id);
    assertExists(restored);
    assertEquals(restored.subject, original.subject);
    assertEquals(restored.variables, original.variables);
  });

  await t.step("custody run creation rolls back on child mismatch", async () => {
    const submitter = await createActiveUser({
      email: `aggregate-${generateId()}@test.local`,
      password: "Submitter!2026",
      affiliation: "vendor",
    });
    const requestA = await breakglassRequests.create(
      requestFixture(
        generateId(),
        `TX-A-${generateId().slice(-8)}`,
        system.id,
        submitter.id,
        vendorClusterId,
      ),
    );
    const requestB = await breakglassRequests.create(
      requestFixture(
        generateId(),
        `TX-B-${generateId().slice(-8)}`,
        system.id,
        submitter.id,
        vendorClusterId,
      ),
    );
    const asset = await assets.create(
      assetFixture(generateId(), system.id, []),
    );
    const requestBItem = await requestCredentialItems.create({
      id: generateId(),
      requestId: requestB.id,
      credentialType: "password",
      userid: null,
      hostname: null,
      assetId: asset.id,
      hostnameDescription: "mismatched request item",
      managementMode: "manual",
      createdAt: now(),
      updatedAt: now(),
    });
    const runId = generateId();

    await assertRejects(() =>
      custodyRuns.create(
        runFixture(
          runId,
          requestA.id,
          system.id,
          [requestBItem.id],
        ),
      )
    );

    assertEquals(await custodyRuns.get(runId), null);
  });

});
