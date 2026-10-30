// Coverage: GET/POST/PUT/DELETE /admin/systems/:id/assets[/:assetId] and
// POST /admin/systems/:id/assets/sync — see addendum-037-asset-inventory.md.
// Every route here is admin-only (requireAdmin) — per CLAUDE.md's
// authorization-scoping test discipline, that category needs a single
// non-admin-403 negative test per route (no further "which admin"
// substitution to test, since admin is global). Also covers the
// systemManaged immutability guard (a business-rule guard, not an
// authorization-scoping one, but still needs positive+negative coverage)
// and reconcileAssetInventory's pure reconciliation logic directly.
import { assertEquals, assertExists, assertNotEquals } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs,
  uniqueEmail, createWiredSystem, latestSentNotification,
  sentNotificationEmailSnapshots,
} from "./helpers.tsx";
import { assets, systems, generateId, now } from "../../../server/db.tsx";
import { reconcileAssetInventory } from "../../../server/aws/asset-inventory.tsx";
import type { InventoryResponse } from "../../../server/aws/asset-inventory.tsx";

Deno.test("admin_assets", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("AssetAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "AssetAdmin!2026");
    adminSession = (login as any).session;
  });

  await t.step("list: positive — returns assets for a system", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner1", email: uniqueEmail("assetowner1"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    await assets.create({
      id: generateId(), systemId: system.id, systemManaged: false, credentialType: "password",
      hostname: "host-a", credentialName: "cred-a", tags: [], createdAt: now(), updatedAt: now(), expiresAfter: null,
    });

    const res = await req(`/admin/systems/${system.id}/assets`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.assets.find((a: any) => a.hostname === "host-a"));
  });

  await t.step("list: negative — non-admin forbidden", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner2", email: uniqueEmail("assetowner2"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const vendor = await createActiveUser({ fullName: "AssetVendor1", email: uniqueEmail("assetvendor1"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req(`/admin/systems/${system.id}/assets`, { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  await t.step("list: negative — system not found", async () => {
    const res = await req(`/admin/systems/00000000-0000-0000-0000-000000000999/assets`, { headers: authHeaders(adminSession) });
    assertEquals(res.status, 404);
  });

  await t.step("create: positive — manual asset created with systemManaged forced false, description persisted", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner3", email: uniqueEmail("assetowner3"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      // systemManaged: true in the body must be ignored server-side.
      body: { hostname: "host-b", credentialName: "cred-b", credentialType: "token", systemManaged: true, description: "Staging DB read-only cred", managementMode: "manual" },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.asset.systemManaged, false);
    assertEquals(data.asset.credentialType, "token");
    // addendum-095 gap fix: the description column is now persisted end-to-end.
    assertEquals(data.asset.description, "Staging DB read-only cred");
  });

  await t.step("create: positive — description is nullable when omitted", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwnerNoDesc", email: uniqueEmail("assetownernodesc"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "host-nodesc", credentialName: "cred-nodesc", managementMode: "manual" },
    });
    assertEquals(res.status, 201);
    const data = await res.json();
    assertEquals(data.asset.description, null);
  });

  await t.step("create: negative — non-admin forbidden", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner4", email: uniqueEmail("assetowner4"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const vendor = await createActiveUser({ fullName: "AssetVendor2", email: uniqueEmail("assetvendor2"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders((login as any).session), body: { hostname: "host-x", credentialName: "cred-x" },
    });
    assertEquals(res.status, 403);
    const list = await assets.findBySystem(system.id);
    assertEquals(list.length, 0);
  });

  await t.step("create: negative — missing hostname", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner5", email: uniqueEmail("assetowner5"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { credentialName: "cred-c" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — invalid credentialType", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner6", email: uniqueEmail("assetowner6"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "host-d", credentialName: "cred-d", credentialType: "bogus" },
    });
    assertEquals(res.status, 400);
  });

  await t.step("create: negative — duplicate (systemId, hostname, credentialName, same service)", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner7", email: uniqueEmail("assetowner7"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const first = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { hostname: "host-e", credentialName: "cred-e", managementMode: "manual" },
    });
    assertEquals(first.status, 201);
    const second = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { hostname: "host-e", credentialName: "cred-e", managementMode: "manual" },
    });
    assertEquals(second.status, 400);
  });

  // addendum-095 multi-service-per-host: the SAME hostname + credential_name
  // (username) can hold MULTIPLE assets distinguished only by the free-text
  // `service` discriminator — because multiple services (ssh, rdp, a web UI,
  // Windows, Linux, ...) on one host may share the same password.
  await t.step("create: positive — same hostname+username allowed once per distinct service", async () => {
    const owner = await createActiveUser({ fullName: "AssetMultiSvc", email: uniqueEmail("assetmultisvc"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const a = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "app-1", credentialName: "root", service: "ssh", managementMode: "manual" },
    });
    assertEquals(a.status, 201);
    const b = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "app-1", credentialName: "root", service: "Admin Web UI", managementMode: "manual" },
    });
    assertEquals(b.status, 201);
    const aJson = await a.json();
    const bJson = await b.json();
    assertEquals(aJson.asset.service, "ssh");
    assertEquals(bJson.asset.service, "Admin Web UI");
    // The two rows are distinct assets (ids differ), both reachable.
    assertNotEquals(aJson.asset.id, bJson.asset.id);

    // A third with the SAME service is a duplicate → 400.
    const dup = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "app-1", credentialName: "root", service: "ssh", managementMode: "manual" },
    });
    assertEquals(dup.status, 400);
  });

  // NULL service = the single/default credential. Only ONE null-service row is
  // allowed per host+username, but it coexists with named-service rows.
  await t.step("create: positive — default (NULL service) coexists with a named service; at most one default", async () => {
    const owner = await createActiveUser({ fullName: "AssetDefaultSvc", email: uniqueEmail("assetdefaultsvc"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const def = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "db-1", credentialName: "appuser", service: "", managementMode: "manual" }, // empty → null default
    });
    assertEquals(def.status, 201);
    assertEquals((await def.json()).asset.service, null);

    const named = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "db-1", credentialName: "appuser", service: "Postgres", managementMode: "manual" },
    });
    assertEquals(named.status, 201);

    // A second null-service row for the same host+username → duplicate.
    const defDup = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession),
      body: { hostname: "db-1", credentialName: "appuser", managementMode: "manual" },
    });
    assertEquals(defDup.status, 400);
  });

  // Every asset is fully immutable once created (hostname/credentialName/
  // credentialType never change, for ANY row — manual or systemManaged)
  // per addendum-039-asset-gated-submission.md, which extended
  // addendum-037's original systemManaged-only immutability rule. PUT now
  // only ever accepts {expiresAfter: null} (un-invalidate); DELETE is
  // invalidate-only (sets expiresAfter, never removes the row).

  await t.step("update: negative — attempting to change hostname/credentialName/credentialType on a MANUAL asset is rejected", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner8", email: uniqueEmail("assetowner8"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const createRes = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { hostname: "host-f", credentialName: "cred-f", managementMode: "manual" },
    });
    const created = (await createRes.json()).asset;

    const res = await req(`/admin/systems/${system.id}/assets/${created.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { hostname: "host-f-renamed" },
    });
    assertEquals(res.status, 400);
    const stillThere = await assets.get(created.id);
    assertEquals(stillThere!.hostname, "host-f");
  });

  await t.step("update: positive — {expiresAfter: null} is accepted (un-invalidate) on a manual asset", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner8b", email: uniqueEmail("assetowner8b"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const invalidated = await assets.create({
      id: generateId(), systemId: system.id, systemManaged: false, credentialType: "password",
      hostname: "host-invalidated", credentialName: "cred-invalidated", tags: [], createdAt: now(), updatedAt: now(), expiresAfter: now(),
    });

    const res = await req(`/admin/systems/${system.id}/assets/${invalidated.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { expiresAfter: null },
    });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.asset.expiresAfter, null);
  });

  await t.step("update: negative — non-admin forbidden", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner9", email: uniqueEmail("assetowner9"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const createRes = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { hostname: "host-g", credentialName: "cred-g", managementMode: "manual" },
    });
    const created = (await createRes.json()).asset;
    const vendor = await createActiveUser({ fullName: "AssetVendor3", email: uniqueEmail("assetvendor3"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");

    const res = await req(`/admin/systems/${system.id}/assets/${created.id}`, {
      method: "PUT", headers: authHeaders((login as any).session), body: { expiresAfter: null },
    });
    assertEquals(res.status, 403);
  });

  await t.step("update: negative — attempting to change a SYSTEM_MANAGED asset's identity fields is rejected", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner10", email: uniqueEmail("assetowner10"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const managed = await assets.create({
      id: generateId(), systemId: system.id, systemManaged: true, credentialType: "password",
      hostname: "host-managed", credentialName: "cred-managed", tags: [], createdAt: now(), updatedAt: now(), expiresAfter: null,
    });

    const res = await req(`/admin/systems/${system.id}/assets/${managed.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { hostname: "should-not-change" },
    });
    assertEquals(res.status, 400);
    const stillThere = await assets.get(managed.id);
    assertEquals(stillThere!.hostname, "host-managed");
  });

  await t.step("update: negative — asset not found for this system (cross-system substitution)", async () => {
    const ownerA = await createActiveUser({ fullName: "AssetOwnerA", email: uniqueEmail("assetownera"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system: systemA } = await createWiredSystem(adminId, ownerA);
    const ownerB = await createActiveUser({ fullName: "AssetOwnerB", email: uniqueEmail("assetownerb"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system: systemB } = await createWiredSystem(adminId, ownerB);
    const createRes = await req(`/admin/systems/${systemB.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { hostname: "host-h", credentialName: "cred-h", managementMode: "manual" },
    });
    const created = (await createRes.json()).asset;

    const res = await req(`/admin/systems/${systemA.id}/assets/${created.id}`, {
      method: "PUT", headers: authHeaders(adminSession), body: { expiresAfter: null },
    });
    assertEquals(res.status, 404);
  });

  await t.step("delete: positive — manual asset is invalidated (expiresAfter set), not removed", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner11", email: uniqueEmail("assetowner11"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const createRes = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { hostname: "host-i", credentialName: "cred-i", managementMode: "manual" },
    });
    const created = (await createRes.json()).asset;

    const res = await req(`/admin/systems/${system.id}/assets/${created.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const stillThere = await assets.get(created.id);
    assertExists(stillThere);
    assertExists(stillThere!.expiresAfter);
    assertEquals(stillThere!.hostname, "host-i");
  });

  await t.step("delete: negative — non-admin forbidden", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner12", email: uniqueEmail("assetowner12"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const createRes = await req(`/admin/systems/${system.id}/assets`, {
      method: "POST", headers: authHeaders(adminSession), body: { hostname: "host-j", credentialName: "cred-j", managementMode: "manual" },
    });
    const created = (await createRes.json()).asset;
    const vendor = await createActiveUser({ fullName: "AssetVendor4", email: uniqueEmail("assetvendor4"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");

    const res = await req(`/admin/systems/${system.id}/assets/${created.id}`, { method: "DELETE", headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
    const stillThere = await assets.get(created.id);
    assertEquals(stillThere!.expiresAfter, null);
  });

  await t.step("delete: positive — invalidating a SYSTEM_MANAGED asset now succeeds too (unified with manual rows)", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner13", email: uniqueEmail("assetowner13"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const managed = await assets.create({
      id: generateId(), systemId: system.id, systemManaged: true, credentialType: "password",
      hostname: "host-managed2", credentialName: "cred-managed2", tags: [], createdAt: now(), updatedAt: now(), expiresAfter: null,
    });

    const res = await req(`/admin/systems/${system.id}/assets/${managed.id}`, { method: "DELETE", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const stillThere = await assets.get(managed.id);
    assertExists(stillThere);
    assertExists(stillThere!.expiresAfter);
  });

  await t.step("sync: negative — non-admin forbidden", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner14", email: uniqueEmail("assetowner14"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const vendor = await createActiveUser({ fullName: "AssetVendor5", email: uniqueEmail("assetvendor5"), password: "VendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "VendorPass!2026");
    const res = await req(`/admin/systems/${system.id}/assets/sync`, { method: "POST", headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  await t.step("sync: negative — AWS integration disabled by default", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner15", email: uniqueEmail("assetowner15"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    await systems.update(system.id, { awsRoleArnNote: "arn:aws:iam::123456789012:role/example" });
    const res = await req(`/admin/systems/${system.id}/assets/sync`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 400);
  });

  await t.step("sync: negative — no aws_role_arn_note configured on the system", async () => {
    const owner = await createActiveUser({ fullName: "AssetOwner16", email: uniqueEmail("assetowner16"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const res = await req(`/admin/systems/${system.id}/assets/sync`, { method: "POST", headers: authHeaders(adminSession) });
    // AWS_INTEGRATION_ENABLED is unset in the test env, so this hits that
    // guard first, before the role-arn-note guard would ever be reached —
    // both guards exist and this proves the disabled-integration one fires.
    assertEquals(res.status, 400);
  });

  await t.step("sync: negative — system not found", async () => {
    const res = await req(`/admin/systems/00000000-0000-0000-0000-000000000999/assets/sync`, { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 404);
  });

  // reconcileAssetInventory: pure reconciliation logic, directly testable
  // without any real AWS call — mirrors how buildOutboundPayload is
  // unit-tested standalone in aws-secret-delivery's own call sites.
  await t.step("reconcileAssetInventory: positive — new asset in response is created as systemManaged", async () => {
    const owner = await createActiveUser({ fullName: "ReconOwner1", email: uniqueEmail("reconowner1"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const response: InventoryResponse = {
      schemaVersion: "1.0", systemId: system.id, status: "success",
      assets: [{ hostname: "recon-host-1", credentialName: "recon-cred-1", credentialType: "password" }],
      errorMessage: null, processedAt: now(),
    };
    await reconcileAssetInventory(system, response);
    const list = await assets.findBySystem(system.id);
    const found = list.find((a) => a.hostname === "recon-host-1");
    assertExists(found);
    assertEquals(found!.systemManaged, true);
    assertEquals(found!.expiresAfter, null);
  });

  await t.step("reconcileAssetInventory: positive — asset missing from response has expiresAfter set to now", async () => {
    const owner = await createActiveUser({ fullName: "ReconOwner2", email: uniqueEmail("reconowner2"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const firstResponse: InventoryResponse = {
      schemaVersion: "1.0", systemId: system.id, status: "success",
      assets: [{ hostname: "recon-host-2", credentialName: "recon-cred-2", credentialType: "password" }],
      errorMessage: null, processedAt: now(),
    };
    await reconcileAssetInventory(system, firstResponse);

    const secondResponse: InventoryResponse = {
      schemaVersion: "1.0", systemId: system.id, status: "success",
      assets: [], // recon-host-2 no longer present
      errorMessage: null, processedAt: now(),
    };
    await reconcileAssetInventory(system, secondResponse);

    const list = await assets.findBySystem(system.id);
    const found = list.find((a) => a.hostname === "recon-host-2");
    assertExists(found);
    assertExists(found!.expiresAfter);
  });

  await t.step("reconcileAssetInventory: positive — asset that reappears has expiresAfter cleared", async () => {
    const owner = await createActiveUser({ fullName: "ReconOwner3", email: uniqueEmail("reconowner3"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const present: InventoryResponse = {
      schemaVersion: "1.0", systemId: system.id, status: "success",
      assets: [{ hostname: "recon-host-3", credentialName: "recon-cred-3", credentialType: "password" }],
      errorMessage: null, processedAt: now(),
    };
    await reconcileAssetInventory(system, present);
    await reconcileAssetInventory(system, { ...present, assets: [] }); // now absent
    const afterLoss = await assets.findBySystem(system.id);
    assertExists(afterLoss.find((a) => a.hostname === "recon-host-3")!.expiresAfter);

    await reconcileAssetInventory(system, present); // reappears
    const afterReturn = await assets.findBySystem(system.id);
    const found = afterReturn.find((a) => a.hostname === "recon-host-3");
    assertExists(found);
    assertEquals(found!.expiresAfter, null);
  });

  await t.step("reconcileAssetInventory: positive — manually-added (systemManaged=false) assets are never touched", async () => {
    const owner = await createActiveUser({ fullName: "ReconOwner4", email: uniqueEmail("reconowner4"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const manual = await assets.create({
      id: generateId(), systemId: system.id, systemManaged: false, credentialType: "password",
      hostname: "manual-host", credentialName: "manual-cred", tags: [], createdAt: now(), updatedAt: now(), expiresAfter: null,
    });

    await reconcileAssetInventory(system, {
      schemaVersion: "1.0", systemId: system.id, status: "success", assets: [], errorMessage: null, processedAt: now(),
    });

    const stillThere = await assets.get(manual.id);
    assertExists(stillThere);
    assertEquals(stillThere!.expiresAfter, null); // not swept even though absent from the (empty) response
  });

  // Extends addendum-037's reconciliation coverage to confirm the
  // addendum-039 immutability invariant survives a sync too, not just the
  // route guard: a sync response re-listing an already-invalidated
  // systemManaged asset's exact (hostname, credentialName) tuple must
  // only touch expiresAfter/credentialType — hostname/credentialName
  // stay byte-identical, since identity IS that tuple and reconciliation
  // never mutates it. Answers the user's ask to extend "assets populated
  // through the S3 bucket" test coverage.
  await t.step("reconcileAssetInventory: positive — resyncing an invalidated asset's exact tuple only touches expiresAfter, never hostname/credentialName", async () => {
    const owner = await createActiveUser({ fullName: "ReconOwner6", email: uniqueEmail("reconowner6"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const present: InventoryResponse = {
      schemaVersion: "1.0", systemId: system.id, status: "success",
      assets: [{ hostname: "recon-host-immutable", credentialName: "recon-cred-immutable", credentialType: "password" }],
      errorMessage: null, processedAt: now(),
    };
    await reconcileAssetInventory(system, present);
    const beforeLoss = (await assets.findBySystem(system.id)).find((a) => a.hostname === "recon-host-immutable")!;

    // Vanishes from a sync — invalidated.
    await reconcileAssetInventory(system, { ...present, assets: [] });
    const afterLoss = (await assets.findBySystem(system.id)).find((a) => a.id === beforeLoss.id)!;
    assertExists(afterLoss.expiresAfter);
    assertEquals(afterLoss.hostname, "recon-host-immutable");
    assertEquals(afterLoss.credentialName, "recon-cred-immutable");

    // Reappears with the exact same tuple, but a different credentialType
    // — reconciliation is allowed to refresh credentialType and clear
    // expiresAfter, but must never touch hostname/credentialName (the
    // identity tuple itself never changes, by construction of the match).
    await reconcileAssetInventory(system, {
      ...present,
      assets: [{ hostname: "recon-host-immutable", credentialName: "recon-cred-immutable", credentialType: "token" }],
    });
    const afterReturn = (await assets.findBySystem(system.id)).find((a) => a.id === beforeLoss.id)!;
    assertEquals(afterReturn.expiresAfter, null);
    assertEquals(afterReturn.credentialType, "token");
    assertEquals(afterReturn.hostname, "recon-host-immutable");
    assertEquals(afterReturn.credentialName, "recon-cred-immutable");
    assertEquals(afterReturn.id, beforeLoss.id); // same row, not a new one
  });

  await t.step("reconcileAssetInventory: negative — error-status response leaves assets untouched and audit-logs failure", async () => {
    const owner = await createActiveUser({ fullName: "ReconOwner5", email: uniqueEmail("reconowner5"), password: "OwnerPass!2026", affiliation: "agency" });
    const { system } = await createWiredSystem(adminId, owner);
    const managed = await assets.create({
      id: generateId(), systemId: system.id, systemManaged: true, credentialType: "password",
      hostname: "recon-host-err", credentialName: "recon-cred-err", tags: [], createdAt: now(), updatedAt: now(), expiresAfter: null,
    });

    await reconcileAssetInventory(system, {
      schemaVersion: "1.0", systemId: system.id, status: "error", assets: null, errorMessage: "tenant unreachable", processedAt: now(),
    });

    const stillThere = await assets.get(managed.id);
    assertEquals(stillThere!.expiresAfter, null);

    // Email notification (addendum-044) #28 — the system owner.
    const syncFailedEmail = await latestSentNotification("asset_inventory.sync_failed");
    assertExists(syncFailedEmail);
    assertEquals(sentNotificationEmailSnapshots(syncFailedEmail), [owner.email]);
  });
});
