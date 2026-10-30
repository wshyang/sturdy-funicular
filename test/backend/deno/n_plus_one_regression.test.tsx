// Addendum-156 set-based hydration and admin pending-action query-count contracts.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  assets,
  generateId,
  notificationDeliveries,
  notificationRecipients,
  now,
  sentNotifications,
  systems,
} from "../../../server/db.tsx";
import { getQueryCount, resetQueryCount } from "../../../server/pg.tsx";
import type { Asset, System } from "../../../server/types.tsx";
import {
  authHeaders,
  addMember, addServingMember,
  createActiveUser,
  createAdmin,
  createAsset,
  createCluster,
  createSystemWithOwnerOrgEdgeById,
  createWiredSystem,
  loginAs,
  req,
  uniqueEmail,
  wipeDatabase,
} from "./helpers.tsx";

function systemFixture(
  id: string,
  createdBy: string,
  agencyClusterId: string,
  vendorClusterId: string,
): System {
  const timestamp = now();
  return {
    id,
    shortCode: `N${id.slice(-7)}`.toUpperCase(),
    name: `N plus one ${id.slice(-8)}`,
    description: null,
    vendorClusterIds: [vendorClusterId],
    agencyClusterId,
    workflowDefinition: [
      {
        ordinal: 1,
        clusterId: vendorClusterId,
        level: 1,
        stepKind: "hierarchical",
        notes: null,
      },
    ],
    awsRoleArnNote: null,
    createdBy,
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAfter: null,
  };
}

function assetFixture(id: string, systemId: string): Asset {
  const timestamp = now();
  return {
    id,
    systemId,
    systemManaged: false,
    managementMode: "manual",
    credentialType: "password",
    hostname: `host-${id.slice(-8)}`,
    credentialName: "admin",
    tags: [
      { key: "environment", value: "test" },
      { key: "owner", value: id.slice(-6) },
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAfter: null,
  };
}

async function createNotification(index: number): Promise<void> {
  const timestamp = now();
  const notificationId = generateId();
  const recipientId = generateId();
  await sentNotifications.create({
    id: notificationId,
    triggerKey: "user.approved",
    renderedSubject: `Notification ${index}`,
    renderedBodyHtml: `<p>${index}</p>`,
    renderedBodyText: String(index),
    relatedTargetType: null,
    relatedTargetId: null,
    createdAt: timestamp,
  });
  await notificationRecipients.create({
    id: recipientId,
    notificationId,
    ordinal: 1,
    recipientUserId: null,
    emailSnapshot: `recipient-${index}@test.local`,
    displayNameSnapshot: null,
    createdAt: timestamp,
  });
  await notificationDeliveries.create({
    id: generateId(),
    notificationRecipientId: recipientId,
    channel: "email",
    destination: `recipient-${index}@test.local`,
    status: "logged",
    errorReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

async function measuredQueries<T>(operation: () => Promise<T>): Promise<{
  count: number;
  value: T;
}> {
  resetQueryCount();
  const value = await operation();
  return { count: getQueryCount(), value };
}

Deno.test("set-based aggregate hydration keeps query counts constant", async (t) => {
  let adminId: string;
  let vendorClusterId: string;
  let agencyClusterId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("NPlusOne!2026");
    adminId = admin.id;
    vendorClusterId = (await createCluster("vendor", adminId)).id;
    agencyClusterId = (await createCluster("agency", adminId)).id;
  });

  await t.step("systems.list is root + three child queries regardless of N", async () => {
    await createSystemWithOwnerOrgEdgeById(
      systemFixture(generateId(), adminId, agencyClusterId, vendorClusterId),
      agencyClusterId,
      adminId,
    );
    const one = await measuredQueries(() => systems.list());
    for (let index = 0; index < 2; index += 1) {
      await createSystemWithOwnerOrgEdgeById(
        systemFixture(generateId(), adminId, agencyClusterId, vendorClusterId),
        agencyClusterId,
        adminId,
      );
    }
    const three = await measuredQueries(() => systems.list());
    assertEquals(one.count, 4);
    assertEquals(three.count, 4);
    assertEquals(three.value.length, 3);
    assertEquals(three.value.every((system) => system.workflowDefinition.length === 1), true);
  });

  await t.step("assets.list is root + one tag query regardless of N", async () => {
    const system = (await systems.list())[0]!;
    await assets.create(assetFixture(generateId(), system.id));
    const one = await measuredQueries(() => assets.list());
    for (let index = 0; index < 2; index += 1) {
      await assets.create(assetFixture(generateId(), system.id));
    }
    const three = await measuredQueries(() => assets.list());
    assertEquals(one.count, 2);
    assertEquals(three.count, 2);
    assertEquals(three.value.length, 3);
    assertEquals(three.value.every((asset) => asset.tags.length === 2), true);
  });

  await t.step("sentNotifications.list is four queries regardless of graph size", async () => {
    await createNotification(1);
    const one = await measuredQueries(() => sentNotifications.list(100));
    await createNotification(2);
    await createNotification(3);
    const three = await measuredQueries(() => sentNotifications.list(100));
    assertEquals(one.count, 4);
    assertEquals(three.count, 4);
    assertEquals(three.value.length, 3);
    assertEquals(three.value.every((row) => row.deliveries.length === 1), true);
  });
});

Deno.test("admin pending-actions query count does not scale per visible user", async () => {
  await wipeDatabase();
  const admin = await createAdmin("PendingQuery!2026");
  const login = await loginAs(admin.email, "PendingQuery!2026");
  if ("error" in login) throw new Error(login.error);

  const owner = await createActiveUser({
    email: uniqueEmail("pending-owner"),
    password: "PendingOwner!2026",
    affiliation: "agency",
  });
  const wired = await createWiredSystem(admin.id, owner);
  const submitter = await createActiveUser({
    email: uniqueEmail("pending-submitter"),
    password: "PendingSubmitter!2026",
    affiliation: "vendor",
  });
  const reviewer = await createActiveUser({
    email: uniqueEmail("pending-reviewer"),
    password: "PendingReviewer!2026",
    affiliation: "vendor",
  });
  await addServingMember(wired.vendorL1, submitter, admin.id);
  await addServingMember(wired.vendorL2, reviewer, admin.id);
  const submitterLogin = await loginAs(submitter.email, "PendingSubmitter!2026");
  if ("error" in submitterLogin) throw new Error(submitterLogin.error);
  const asset = await createAsset(wired.system.id);
  const submitted = await req("/requests", {
    method: "POST",
    headers: authHeaders(submitterLogin.session),
    body: {
      systemId: wired.system.id,
      justification: "Real pending-action query-count fixture.",
      srNumber: "SR-NPLUS-PENDING",
      activityStartAt: new Date(Date.now() + 3_600_000).toISOString(),
      activityEndAt: new Date(Date.now() + 7_200_000).toISOString(),
      credentialItems: [{ assetId: asset.id }],
    },
  });
  assertEquals(submitted.status, 201);

  const one = await measuredQueries(() =>
    req("/admin/pending-actions", { headers: authHeaders(login.session) })
  );
  assertEquals(one.value.status, 200);
  const baselineBody = await one.value.json();
  assert(
    baselineBody.debtors.some((debtor: any) =>
      debtor.user.id === reviewer.id &&
      debtor.pendingActions.some((action: any) => action.kind === "review_step")
    ),
    "real owing reviewer must be present before measuring scale",
  );

  for (let index = 0; index < 2; index += 1) {
    await createActiveUser({
      email: uniqueEmail(`pending-query-${index}`),
      password: "PendingUser!2026",
      affiliation: "vendor",
    });
  }
  const three = await measuredQueries(() =>
    req("/admin/pending-actions", { headers: authHeaders(login.session) })
  );
  assertEquals(three.value.status, 200);
  assert(
    three.count - one.count <= 2,
    `query count scaled with users: one=${one.count}, three=${three.count}`,
  );
});
