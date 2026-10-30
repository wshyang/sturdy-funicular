// Coverage: GET /admin/clusters, POST /admin/clusters, PUT /admin/clusters/:id,
// DELETE /admin/clusters/:id.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail, uniqueName,
  createCluster, createTeam, ensureDefaultOrganization, createOrganization,
} from "./helpers.tsx";

Deno.test("admin_clusters", async (t) => {
  let adminSession: string;
  let adminId: string;
  // addendum-206 (D2): every cluster is org-anchored (create route requires
  // organizationId), so the positive paths below need one.
  let defaultOrgId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("ClusterAdmin!2026");
    adminId = admin.id;
    defaultOrgId = (await ensureDefaultOrganization(adminId)).id;
    const login = await loginAs(admin.email, "ClusterAdmin!2026");
    adminSession = (login as any).session;
  });

  await t.step("list: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "V", email: uniqueEmail("v"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req("/admin/clusters", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  // addendum-033-authorization-scoping-test-discipline.md: create/update/
  // delete are all admin-only but, until this pass, only the GET/list route
  // above had a non-admin-403 regression test.
  await t.step("create/update/delete: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "ClusterMutNonAdmin", email: uniqueEmail("clustermutnonadmin"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const session = (login as any).session;
    const cluster = await createCluster("vendor", adminId);

    const createRes = await req("/admin/clusters", {
      method: "POST", headers: authHeaders(session), body: { name: uniqueName("ShouldNotCreate"), type: "vendor" },
    });
    assertEquals(createRes.status, 403);

    const updateRes = await req(`/admin/clusters/${cluster.id}`, { method: "PUT", headers: authHeaders(session), body: { name: "Hijacked" } });
    assertEquals(updateRes.status, 403);

    const deleteRes = await req(`/admin/clusters/${cluster.id}`, { method: "DELETE", headers: authHeaders(session) });
    assertEquals(deleteRes.status, 403);

    const listRes = await req("/admin/clusters", { headers: authHeaders(adminSession) });
    const listData = await listRes.json();
    const stillThere = listData.clusters.find((c: any) => c.id === cluster.id);
    assertExists(stillThere);
    assertEquals(stillThere.name, cluster.name);
  });

  await t.step("create: positive — vendor cluster created with team_count 0", async () => {
    const name = uniqueName("Vendor Cluster");
    const res = await req("/admin/clusters", {
      method: "POST", headers: authHeaders(adminSession), body: { name, type: "vendor", description: "desc", organizationId: defaultOrgId },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.cluster.type, "vendor");

    const listRes = await req("/admin/clusters", { headers: authHeaders(adminSession) });
    const listData = await listRes.json();
    const found = listData.clusters.find((c: any) => c.id === data.cluster.id);
    assertExists(found);
    assertEquals(found.teamCount, 0);
  });

  await t.step("create: negative — missing name/type", async () => {
    const res = await req("/admin/clusters", { method: "POST", headers: authHeaders(adminSession), body: { type: "vendor" } });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — invalid type", async () => {
    const res = await req("/admin/clusters", {
      method: "POST", headers: authHeaders(adminSession), body: { name: uniqueName("Bad"), type: "not-a-type" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — duplicate name within same type rejected", async () => {
    const name = uniqueName("DupCluster");
    const first = await req("/admin/clusters", { method: "POST", headers: authHeaders(adminSession), body: { name, type: "agency", organizationId: defaultOrgId } });
    assertEquals(first.status, 201);
    const second = await req("/admin/clusters", { method: "POST", headers: authHeaders(adminSession), body: { name, type: "agency", organizationId: defaultOrgId } });
    assertEquals(second.status, 400);
  });

  await t.step("create: positive — same name allowed across different types", async () => {
    const name = uniqueName("CrossTypeCluster");
    const first = await req("/admin/clusters", { method: "POST", headers: authHeaders(adminSession), body: { name, type: "vendor", organizationId: defaultOrgId } });
    assertEquals(first.status, 201);
    const second = await req("/admin/clusters", { method: "POST", headers: authHeaders(adminSession), body: { name, type: "agency", organizationId: defaultOrgId } });
    assertEquals(second.status, 201);
  });

  // Organisation-dimension contract for THIS route: organizationId is
  // REQUIRED at create and moves ride the update route's move guard
  // (addendum-206 — un-anchored clusters no longer exist; the previous
  // "assign-after-create" shape is now create-anchored + re-anchor).
  await t.step("organisation dimension: create requires organizationId; re-anchor via update", async () => {
    const org = await ensureDefaultOrganization(adminId);

    // Absent org ⇒ caller fault 400 (addendum-206 D2: no NULL-org objects).
    const noOrg = await req("/admin/clusters", {
      method: "POST", headers: authHeaders(adminSession), body: { name: uniqueName("No Org Cluster"), type: "agency" },
    });
    assertEquals(noOrg.status, 400);

    const name = uniqueName("Org Cluster");
    const res = await req("/admin/clusters", {
      method: "POST", headers: authHeaders(adminSession), body: { name, type: "agency", organizationId: org.id },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.cluster.organizationId, org.id);

    // Re-anchor (move) after create via the update route.
    const src = await createOrganization({
      name: uniqueName("Move Src Org"),
      shortCode: `S${crypto.randomUUID().replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      createdBy: adminId,
    });
    const plain = await req("/admin/clusters", {
      method: "POST", headers: authHeaders(adminSession), body: { name: uniqueName("Org Late Cluster"), type: "vendor", organizationId: src.id },
    });
    assertEquals(plain.status, 201);
    const plainId = (await plain.json()).cluster.id;
    const put = await req(`/admin/clusters/${plainId}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { organizationId: org.id },
    });
    assertEquals(put.status, 200);

    const listRes = await req("/admin/clusters", { headers: authHeaders(adminSession) });
    const clusters = (await listRes.json()).clusters;
    assertEquals(clusters.find((c: { id: string }) => c.id === data.cluster.id).organizationId, org.id);
    assertEquals(clusters.find((c: { id: string }) => c.id === plainId).organizationId, org.id);
  });

  await t.step("update: positive — rename succeeds, type unchanged (type is immutable — no field for it in update payload)", async () => {
    const cluster = await createCluster("pa", adminId);
    const newName = uniqueName("Renamed");
    const res = await req(`/admin/clusters/${cluster.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { name: newName },
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.cluster.name, newName);
    assertEquals(data.cluster.type, "pa");
  });

  await t.step("update: negative — cluster not found", async () => {
    const res = await req(`/admin/clusters/00000000-0000-0000-0000-000000000999`, {
      method: "PUT", headers: authHeaders(adminSession), body: { name: "X" },
    });
    assertEquals(res.status, 404);
  });

  await t.step("update: negative — rename to a name already used by another cluster of the same type", async () => {
    const clusterA = await createCluster("vendor", adminId);
    const clusterB = await createCluster("vendor", adminId);
    const res = await req(`/admin/clusters/${clusterB.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { name: clusterA.name },
    });
    assertEquals(res.status, 400);
  });

  await t.step("update: negative — no fields provided", async () => {
    const cluster = await createCluster("agency", adminId);
    const res = await req(`/admin/clusters/${cluster.id}`, { method: "PUT", headers: authHeaders(adminSession), body: {} });
    assertEquals(res.status, 400);
  });

  await t.step("delete: positive — empty cluster deleted", async () => {
    const cluster = await createCluster("pa", adminId);
    const res = await req(`/admin/clusters/${cluster.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const listRes = await req("/admin/clusters", { headers: authHeaders(adminSession) });
    const listData = await listRes.json();
    assertEquals(listData.clusters.find((c: any) => c.id === cluster.id), undefined);
  });

  await t.step("delete: negative — cluster with teams blocked", async () => {
    const cluster = await createCluster("vendor", adminId);
    await createTeam(cluster, 1, adminId);
    const res = await req(`/admin/clusters/${cluster.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  await t.step("delete: negative — cluster not found", async () => {
    const res = await req(`/admin/clusters/00000000-0000-0000-0000-000000000999`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 404);
  });
});
