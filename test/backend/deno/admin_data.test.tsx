// Coverage: GET /admin/data/export, POST /admin/data/import, POST /admin/data/reset-seed.
import { assertEquals, assertExists } from "jsr:@std/assert";
import {
  req, authHeaders, wipeDatabase, createAdmin, createActiveUser, loginAs, uniqueEmail,
  createCluster, createTeam, seedOwnerOrgEdge,
  createSystemWithOwnerOrgEdge,
} from "./helpers.tsx";
import { clusters, teams, systems, users, generateId, now } from "../../../server/db.tsx";

Deno.test("admin_data", async (t) => {
  let adminSession: string;
  let adminId: string;

  await t.step("setup", async () => {
    await wipeDatabase();
    const admin = await createAdmin("DataAdmin!2026");
    adminId = admin.id;
    const login = await loginAs(admin.email, "DataAdmin!2026");
    adminSession = (login as any).session;
  });

  await t.step("export: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "DataVendor", email: uniqueEmail("datavendor"), password: "DataVendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "DataVendorPass!2026");
    const res = await req("/admin/data/export", { headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  await t.step("export: positive — returns all typed tables with rows, entry_count matches", async () => {
    await createCluster("vendor", adminId);
    const res = await req("/admin/data/export", { headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertEquals(data.schema, "breakglass-export-v3");
    assertExists(data.tables);
    const usersTable = data.tables.find((t: any) => t.table === "users");
    assertExists(usersTable);
    assertEquals(usersTable.rows.length > 0, true);
    const totalRows = data.tables.reduce((sum: number, t: any) => sum + t.rows.length, 0);
    assertEquals(data.entryCount, totalRows);
  });

  await t.step("import: negative — invalid bundle shape rejected", async () => {
    const res = await req("/admin/data/import", { method: "POST", headers: authHeaders(adminSession), body: { bundle: { notTables: [] } } });
    assertEquals(res.status, 400);
  });

  // addendum-033-authorization-scoping-test-discipline.md: export and
  // reset-seed already had non-admin-403 tests; import did not, despite
  // being the most destructive of the three (wipeFirst: true wipes every
  // typed table).
  await t.step("import: negative — non-admin forbidden", async () => {
    const cluster = await createCluster("agency", adminId);
    const vendor = await createActiveUser({ fullName: "ImportVendor", email: uniqueEmail("importvendor"), password: "ImportVendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "ImportVendorPass!2026");

    const res = await req("/admin/data/import", {
      method: "POST", headers: authHeaders((login as any).session),
      body: { bundle: { tables: [{ table: "clusters", rows: [] }] }, wipeFirst: true },
    });
    assertEquals(res.status, 403);

    // Confirm the non-admin call did NOT wipe the database.
    const reloaded = await clusters.get(cluster.id);
    assertExists(reloaded);
  });

  await t.step("import: positive — round-trip export then re-import (wipe_first) preserves a cluster", async () => {
    const cluster = await createCluster("agency", adminId);
    const exportRes = await req("/admin/data/export", { headers: authHeaders(adminSession) });
    const bundle = await exportRes.json();

    const importRes = await req("/admin/data/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { bundle: { tables: bundle.tables }, wipeFirst: true },
    });
    assertEquals(importRes.status, 200);
    const importData = await importRes.json();
    assertExists(importData.entriesWritten);

    const reloaded = await clusters.get(cluster.id);
    assertExists(reloaded);
    assertEquals(reloaded!.name, cluster.name);
  });

  await t.step("import: positive — wipe_first survives a users row referencing an approver that appears LATER in the same bundle (self-referential FK ordering)", async () => {
    const approver = await createActiveUser({ fullName: "Approver", email: uniqueEmail("approver"), password: "ApproverPass!2026", affiliation: "agency" });
    const approvee = await createActiveUser({ fullName: "Approvee", email: uniqueEmail("approvee"), password: "ApproveePass!2026", affiliation: "vendor", approvedBy: approver.id });

    const exportRes = await req("/admin/data/export", { headers: authHeaders(adminSession) });
    const bundle = await exportRes.json();
    const usersTable = bundle.tables.find((t: any) => t.table === "users");
    // Force the exact ordering the FK-per-row-check bug depends on: the
    // approved user's row placed before its approver's row in the bundle,
    // regardless of what order the export actually produced.
    const approveeRow = usersTable.rows.find((r: any) => r.id === approvee.id);
    const approverRow = usersTable.rows.find((r: any) => r.id === approver.id);
    const others = usersTable.rows.filter((r: any) => r.id !== approvee.id && r.id !== approver.id);
    usersTable.rows = [approveeRow, ...others, approverRow];

    const importRes = await req("/admin/data/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { bundle: { tables: bundle.tables }, wipeFirst: true },
    });
    assertEquals(importRes.status, 200);
    const importData = await importRes.json();
    assertExists(importData.entriesWritten);

    const { users } = await import("../../../server/db.tsx");
    const reloadedApprovee = await users.get(approvee.id);
    assertExists(reloadedApprovee);
    assertEquals(reloadedApprovee!.approvedBy, approver.id);
  });

  await t.step("import: positive — full export/rename/restore round-trip, one object per named class (users, clusters, teams, systems)", async () => {
    // "Oddly unique" names — distinctive enough that a collision with any
    // other fixture in this file (or a stray demo-seed leftover) is
    // effectively impossible, and easy to eyeball in a failure diff.
    const ORIGINAL = {
      user: "Zzyzx Quokka-9931",
      cluster: "Flibbertigibbet-Cluster-4471",
      team: "Wobbling Narwhal Squad-2286",
      system: "Discombobulator-7734",
    };
    const RENAMED = {
      user: "RENAMED-Bumfuzzled-Yak-1123",
      cluster: "RENAMED-Kerfuffle-Cluster-5528",
      team: "RENAMED-Absquatulate-Team-8842",
      system: "RENAMED-Gobbledygook-6617",
    };

    const fixtureUser = await createActiveUser({
      fullName: ORIGINAL.user, email: uniqueEmail("quokka"), password: "QuokkaPass!2026", affiliation: "vendor",
    });
    const fixtureCluster = await createCluster("vendor", adminId, ORIGINAL.cluster);
    const fixtureTeam = await createTeam(fixtureCluster, 1, adminId, ORIGINAL.team);
    const fixtureSystem = {
      id: generateId(),
      shortCode: `SYS${Date.now()}`.slice(0, 10).toUpperCase(),
      name: ORIGINAL.system,
      description: null,
      vendorClusterIds: [] as string[],
      agencyClusterId: fixtureCluster.id,
      workflowDefinition: [] as unknown[],
      awsRoleArnNote: null,
      createdBy: adminId,
      createdAt: now(),
      updatedAt: now(),
    };
    await createSystemWithOwnerOrgEdge(fixtureSystem as never, fixtureCluster, adminId);

    // 1. Export (captures the ORIGINAL names).
    const exportRes = await req("/admin/data/export", { headers: authHeaders(adminSession) });
    assertEquals(exportRes.status, 200);
    const bundle = await exportRes.json();

    // 2. Rename every object.
    await users.update(fixtureUser.id, { fullName: RENAMED.user });
    await clusters.update(fixtureCluster.id, { name: RENAMED.cluster });
    await teams.update(fixtureTeam.id, { name: RENAMED.team });
    await systems.update(fixtureSystem.id, { name: RENAMED.system });

    // 3. Verify the renames landed in the DB before touching import at all.
    assertEquals((await users.get(fixtureUser.id))!.fullName, RENAMED.user);
    assertEquals((await clusters.get(fixtureCluster.id))!.name, RENAMED.cluster);
    assertEquals((await teams.get(fixtureTeam.id))!.name, RENAMED.team);
    assertEquals((await systems.get(fixtureSystem.id))!.name, RENAMED.system);

    // 4. Restore from the pre-rename export bundle, wiping first.
    const importRes = await req("/admin/data/import", {
      method: "POST", headers: authHeaders(adminSession),
      body: { bundle: { tables: bundle.tables }, wipeFirst: true },
    });
    assertEquals(importRes.status, 200);
    const importResult = await importRes.json();
    assertExists(importResult.entriesWritten);

    // 5. Verify the restore actually rolled every name back to ORIGINAL.
    assertEquals((await users.get(fixtureUser.id))!.fullName, ORIGINAL.user);
    assertEquals((await clusters.get(fixtureCluster.id))!.name, ORIGINAL.cluster);
    assertEquals((await teams.get(fixtureTeam.id))!.name, ORIGINAL.team);
    assertEquals((await systems.get(fixtureSystem.id))!.name, ORIGINAL.system);

    // The acting admin's own session survives the wipe+restore (same id
    // re-created via the bundle), matching the reset-seed test's precedent.
    const meRes = await req("/auth/me", { headers: authHeaders(adminSession) });
    assertEquals(meRes.status, 200);
  });

  await t.step("reset-seed: negative — non-admin forbidden", async () => {
    const vendor = await createActiveUser({ fullName: "SeedVendor", email: uniqueEmail("seedvendor"), password: "SeedVendorPass!2026", affiliation: "vendor" });
    const login = await loginAs(vendor.email, "SeedVendorPass!2026");
    const res = await req("/admin/data/reset-seed", { method: "POST", headers: authHeaders((login as any).session) });
    assertEquals(res.status, 403);
  });

  await t.step("reset-seed: positive — wipes and repopulates demo data, preserves acting admin's session", async () => {
    const res = await req("/admin/data/reset-seed", { method: "POST", headers: authHeaders(adminSession) });
    assertEquals(res.status, 200);
    const data = await res.json();
    assertExists(data.summary);
    assertEquals(data.summary.systems, 2);

    // Acting admin's session should still be valid after reset (same id re-created).
    const meRes = await req("/auth/me", { headers: authHeaders(adminSession) });
    assertEquals(meRes.status, 200);
  });

  // Addendum-097: reset-seed is environment-gated on BREAKGLASS_DEV (the
  // whole-database wipe must never exist on a real deployment, whatever the
  // caller's capabilities). .env.test pins BREAKGLASS_DEV=DEV for the suite;
  // this step flips the process env to PROD for the one request, in try/
  // finally so a failure can never poison the rest of the run.
  await t.step("reset-seed: negative — BREAKGLASS_DEV=PROD → 403 even for a capable admin", async () => {
    const previous = Deno.env.get("BREAKGLASS_DEV");
    Deno.env.set("BREAKGLASS_DEV", "PROD");
    try {
      const res = await req("/admin/data/reset-seed", { method: "POST", headers: authHeaders(adminSession) });
      assertEquals(res.status, 403);
      const body = await res.json();
      assertEquals(String(body.error).includes("BREAKGLASS_DEV"), true);
    } finally {
      if (previous === undefined) Deno.env.delete("BREAKGLASS_DEV");
      else Deno.env.set("BREAKGLASS_DEV", previous);
    }
  });
});
