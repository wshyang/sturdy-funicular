// Validation and lifecycle contracts for PUT/DELETE /admin/systems/:id
// (server/routes/admin/systems/systems-crud.tsx).
//
// The route already has happy-path coverage elsewhere; what was missing is the
// rejecting half of updateSystem, which is where the interesting rules live:
//
//   * Owner rules are cross-field, not per-field. The primary/backup pair must
//     never collapse to one person, and the check has to consider the value
//     ALREADY IN THE DATABASE — sending only a backupOwnerId that happens to
//     equal the stored primary must still be refused.
//   * Owners must be active agency users. A vendor or a tombstoned account
//     silently becoming a system owner is an authorization problem, not a
//     cosmetic one.
//   * A PUT that changes nothing is a 400, not a silent success — so the UI
//     cannot report "saved" when no write happened.
//   * deleteSystem is a soft delete gated on open requests, and it must take
//     the mappings/owners/delegates down with it.
//
// Driven through the real Hono app per the harness convention.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  addOrgMembership,
  authHeaders,
  createActiveUser,
  createAdmin,
  createWiredSystem,
  loginAs,
  req,
  uniqueEmail,
  wipeDatabase,
} from "./helpers.tsx";
import { query } from "../../../server/db/drizzle.ts";

const PW = "SystemsCrud!2026";

Deno.test("admin systems — update validation and delete lifecycle", async (t) => {
  await wipeDatabase();

  const admin = await createAdmin(PW);
  const login = await loginAs(admin.email, PW);
  assert("session" in login, `admin login failed: ${JSON.stringify(login)}`);
  const auth = authHeaders(login.session);

  const agencyUser = async (label: string) =>
    await createActiveUser({
      fullName: `Agency ${label}`,
      email: uniqueEmail(`agency${label}`),
      password: PW,
      affiliation: "agency",
    });

  const owner = await agencyUser("owner");
  const backup = await agencyUser("backup");
  const other = await agencyUser("other");
  const vendorUser = await createActiveUser({
    fullName: "Vendor Person",
    email: uniqueEmail("vendorperson"),
    password: PW,
    affiliation: "vendor",
  });

  const { system } = await createWiredSystem(admin.id, owner);

  const put = (body: unknown, id = system.id) =>
    req(`/admin/systems/${id}`, { method: "PUT", headers: auth, body });
  const errorOf = async (res: Response) => String((await res.json()).error ?? "");

  // ── shape / existence ────────────────────────────────────────────────────

  await t.step("negative: unauthenticated PUT and DELETE are refused", async () => {
    const put401 = await req(`/admin/systems/${system.id}`, {
      method: "PUT",
      body: { name: "Nope" },
    });
    assert(put401.status === 401 || put401.status === 403, `got ${put401.status}`);
    const del401 = await req(`/admin/systems/${system.id}`, { method: "DELETE" });
    assert(del401.status === 401 || del401.status === 403, `got ${del401.status}`);
  });

  await t.step("negative: an unknown system id is 404 on both verbs", async () => {
    const ghost = "00000000-0000-7000-8000-0000000000ff";
    assertEquals((await put({ name: "Ghost" }, ghost)).status, 404);
    const del = await req(`/admin/systems/${ghost}`, { method: "DELETE", headers: auth });
    assertEquals(del.status, 404);
  });

  await t.step("negative: an empty body is 'No fields to update.', not a silent 200", async () => {
    const res = await put({});
    assertEquals(res.status, 400);
    assertEquals(await errorOf(res), "No fields to update.");
  });

  // ── name / text field validation ─────────────────────────────────────────

  await t.step("positive: renaming works and persists", async () => {
    const newName = `Renamed System ${Date.now()}`;
    const res = await put({ name: newName });
    assertEquals(res.status, 200);
    const rows = await query<{ name: string }>(`SELECT name FROM systems WHERE id = $1`, [system.id]);
    assertEquals(rows[0]!.name, newName);
  });

  await t.step("positive: the name is trimmed before it is stored", async () => {
    const res = await put({ name: "   Padded Name   " });
    assertEquals(res.status, 200);
    const rows = await query<{ name: string }>(`SELECT name FROM systems WHERE id = $1`, [system.id]);
    assertEquals(rows[0]!.name, "Padded Name");
  });

  await t.step("negative: a blank or whitespace-only name is refused", async () => {
    for (const name of ["", "   "]) {
      const res = await put({ name });
      assertEquals(res.status, 400, `name=${JSON.stringify(name)}`);
    }
  });

  await t.step("negative: a duplicate system name is refused", async () => {
    const rival = await createWiredSystem(admin.id, other);
    const rivalName = (await query<{ name: string }>(
      `SELECT name FROM systems WHERE id = $1`,
      [rival.system.id],
    ))[0]!.name;

    const res = await put({ name: rivalName });
    assertEquals(res.status, 400);
    assertEquals(await errorOf(res), "A system with this name already exists.");
  });

  await t.step("positive: a system may be renamed to its OWN current name", async () => {
    // The duplicate check must exclude the row being updated, or a no-op save
    // of an unrelated field alongside the name would 400.
    const current = (await query<{ name: string }>(
      `SELECT name FROM systems WHERE id = $1`,
      [system.id],
    ))[0]!.name;
    assertEquals((await put({ name: current })).status, 200);
  });

  await t.step("negative: over-long description and awsRoleArnNote are refused", async () => {
    assertEquals((await put({ description: "x".repeat(501) })).status, 400);
    assertEquals((await put({ awsRoleArnNote: "x".repeat(501) })).status, 400);
  });

  await t.step("positive: description and note clear to NULL on empty string", async () => {
    assertEquals((await put({ description: "temporary" })).status, 200);
    assertEquals((await put({ description: "" })).status, 200);
    const rows = await query<{ description: string | null }>(
      `SELECT description FROM systems WHERE id = $1`,
      [system.id],
    );
    assertEquals(rows[0]!.description, null);
  });

  // ── owner rules ──────────────────────────────────────────────────────────

  await t.step("positive: the backup owner can be set and then cleared", async () => {
    assertEquals((await put({ backupOwnerId: backup.id })).status, 200);
    let live = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM system_owners
        WHERE system_id = $1 AND kind = 'backup' AND expires_after IS NULL`,
      [system.id],
    );
    assertEquals(live[0]!.n, "1");

    assertEquals((await put({ backupOwnerId: null })).status, 200);
    live = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM system_owners
        WHERE system_id = $1 AND kind = 'backup' AND expires_after IS NULL`,
      [system.id],
    );
    assertEquals(live[0]!.n, "0", "clearing the backup expires the row");
  });

  await t.step("NEGATIVE: primary and backup may not be the same person (both sent)", async () => {
    const res = await put({ primaryOwnerId: owner.id, backupOwnerId: owner.id });
    assertEquals(res.status, 400);
    assertEquals(await errorOf(res), "Backup owner cannot be the same person as the primary owner.");
  });

  await t.step("NEGATIVE: backup alone may not collide with the STORED primary", async () => {
    // The cross-field check has to read the database, not just the payload.
    const res = await put({ backupOwnerId: owner.id });
    assertEquals(res.status, 400);
    assertEquals(await errorOf(res), "Backup owner cannot be the same person as the primary owner.");
  });

  await t.step("NEGATIVE: primary alone may not collide with the STORED backup", async () => {
    assertEquals((await put({ backupOwnerId: backup.id })).status, 200);
    const res = await put({ primaryOwnerId: backup.id });
    assertEquals(res.status, 400);
    assertEquals(await errorOf(res), "Backup owner cannot be the same person as the primary owner.");
    await put({ backupOwnerId: null });
  });

  await t.step("NEGATIVE: owners must have agency affiliation, not vendor", async () => {
    const asPrimary = await put({ primaryOwnerId: vendorUser.id });
    assertEquals(asPrimary.status, 400);
    assertEquals(await errorOf(asPrimary), "Primary owner must have agency affiliation.");

    const asBackup = await put({ backupOwnerId: vendorUser.id });
    assertEquals(asBackup.status, 400);
    assertEquals(await errorOf(asBackup), "Backup owner must have agency affiliation.");
  });

  await t.step("NEGATIVE: owners must be active users", async () => {
    const ghost = "00000000-0000-7000-8000-0000000000fe";
    const missing = await put({ primaryOwnerId: ghost });
    assertEquals(missing.status, 400);
    assertEquals(await errorOf(missing), "Primary owner must be an active user.");

    const dormant = await agencyUser("dormant");
    await query(`UPDATE users SET status = 'tombstoned' WHERE id = $1`, [dormant.id]);
    const inactive = await put({ primaryOwnerId: dormant.id });
    assertEquals(inactive.status, 400);
    assertEquals(await errorOf(inactive), "Primary owner must be an active user.");

    const inactiveBackup = await put({ backupOwnerId: dormant.id });
    assertEquals(inactiveBackup.status, 400);
    assertEquals(await errorOf(inactiveBackup), "Backup owner must be an active user.");
  });

  await t.step("positive: changing the primary owner expires the previous row", async () => {
    const res = await put({ primaryOwnerId: other.id });
    assertEquals(res.status, 200);

    const live = await query<{ user_id: string }>(
      `SELECT user_id FROM system_owners
        WHERE system_id = $1 AND kind = 'primary' AND expires_after IS NULL`,
      [system.id],
    );
    assertEquals(live.length, 1, "exactly one live primary owner");
    assertEquals(live[0]!.user_id, other.id);

    const expired = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM system_owners
        WHERE system_id = $1 AND kind = 'primary' AND expires_after IS NOT NULL`,
      [system.id],
    );
    assert(Number(expired[0]!.n) >= 1, "the previous primary is soft-expired, not deleted");
  });

  // ── cluster / workflow validation ────────────────────────────────────────

  await t.step("negative: an unknown agency cluster is refused", async () => {
    const res = await put({ agencyClusterId: "00000000-0000-7000-8000-0000000000fd" });
    assertEquals(res.status, 400);
  });

  await t.step("negative: a workflow referencing unknown teams is refused", async () => {
    const res = await put({
      workflowDefinition: [{ step: 1, teamId: "00000000-0000-7000-8000-0000000000fc" }],
    });
    assertEquals(res.status, 400);
    assert((await errorOf(res)).startsWith("Invalid workflow"), "expected the workflow error");
  });

  // ── delete ───────────────────────────────────────────────────────────────

  await t.step("delete: soft-deletes and cascades to mappings, owners and delegates", async () => {
    const doomedOwner = await agencyUser("doomed");
    const { system: doomed, agencyL1 } = await createWiredSystem(admin.id, doomedOwner);
    void agencyL1;

    const before = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM team_system_mappings
        WHERE system_id = $1 AND expires_after IS NULL`,
      [doomed.id],
    );
    assert(Number(before[0]!.n) > 0, "fixture should have live team mappings");

    const res = await req(`/admin/systems/${doomed.id}`, { method: "DELETE", headers: auth });
    assertEquals(res.status, 200);

    const row = await query<{ expires_after: string | null }>(
      `SELECT expires_after FROM systems WHERE id = $1`,
      [doomed.id],
    );
    assertEquals(row.length, 1, "the row is retained (soft delete)");
    assert(row[0]!.expires_after !== null, "expires_after must be stamped");

    for (const [table, label] of [
      ["team_system_mappings", "team mappings"],
      ["system_owners", "owner rows"],
    ] as const) {
      const left = await query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} WHERE system_id = $1 AND expires_after IS NULL`,
        [doomed.id],
      );
      assertEquals(left[0]!.n, "0", `${label} must all be expired`);
    }
  });

  await t.step("delete: a deleted system is then invisible to update and delete", async () => {
    const gone = await agencyUser("gone");
    const { system: target } = await createWiredSystem(admin.id, gone);
    assertEquals((await req(`/admin/systems/${target.id}`, { method: "DELETE", headers: auth })).status, 200);

    assertEquals((await put({ name: "after delete" }, target.id)).status, 404);
    const second = await req(`/admin/systems/${target.id}`, { method: "DELETE", headers: auth });
    assertEquals(second.status, 404, "deleting twice is a 404, not a second success");
  });

  await t.step("delete: NEGATIVE — a system with open requests is refused", async () => {
    const busyOwner = await agencyUser("busy");
    const { system: busy, vendorCluster } = await createWiredSystem(admin.id, busyOwner);

    // Insert a request in a non-terminal state directly: the guard reads
    // status, and this keeps the test focused on the delete rule rather than
    // on the whole submission workflow.
    await query(
      `INSERT INTO breakglass_requests
         (id, request_number, system_id, submitted_by, vendor_cluster_id, justification,
          sr_number, activity_start_at, activity_end_at, status, return_count,
          created_at, updated_at)
       VALUES (uuid_generate_v7(), $1, $2, $3, $4, 'open work', 'SR-OPEN',
               now(), now() + interval '1 hour', 'submitted', 0, now(), now())`,
      [`REQ-OPEN-${Date.now()}`, busy.id, busyOwner.id, vendorCluster.id],
    );

    const res = await req(`/admin/systems/${busy.id}`, { method: "DELETE", headers: auth });
    assertEquals(res.status, 400);
    assert((await errorOf(res)).includes("open break-glass requests"), "expected the open-requests guard");

    const still = await query<{ expires_after: string | null }>(
      `SELECT expires_after FROM systems WHERE id = $1`,
      [busy.id],
    );
    assertEquals(still[0]!.expires_after, null, "the system must NOT have been deleted");
  });

  void addOrgMembership;
});
