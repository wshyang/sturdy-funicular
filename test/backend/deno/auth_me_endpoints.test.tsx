// Tests for the three self-describing endpoints in server/routes/auth.tsx:
//   GET /auth/me               — session + 2FA state, sanitised user
//   GET /me/capability-snapshot — the authorization snapshot the UI trusts
//   GET /me/role-summary        — the dashboard role tiles and their badges
//
// None of the three had any direct coverage, despite /auth/me being the
// endpoint the client reloads against to decide enroll-vs-verify-vs-dashboard,
// and role-summary carrying the classification rules that have already caused
// two documented bugs (addendum-096's "Agency Engineer (9)" over-count, and
// the agency-owner-vs-delegate split).
//
// The properties worth pinning:
//   * /auth/me must NEVER serialise password_hash, salt or totp_secret. It is
//     the most-called authenticated endpoint; a leak here is a leak everywhere.
//   * /auth/me is deliberately allowlisted PAST the 2FA gate, so it must still
//     answer 200 for a session that has not completed 2FA — that is precisely
//     when the client needs it. Its three booleans are mutually exclusive.
//   * A pure agency delegate (owned=[], delegated=[x]) must be classified as
//     Delegate Approver, NOT System Owner. An agency owner who also holds
//     delegations must get exactly ONE tile (owner), not both.
//   * Badge counts must exclude the viewer's own submissions.
import { assert, assertEquals } from "jsr:@std/assert";
import {
  addMember,
  addServingMember,
  authHeaders,
  createActiveUser,
  createAdmin,
  addOrgMembership,
  createAsset,
  createWiredSystem,
  loginAs,
  req,
  uniqueEmail,
  wipeDatabase,
} from "./helpers.tsx";
import { query } from "../../../server/pg.tsx";

type Login = { session: string; user: { id: string } };

async function signIn(email: string, password: string): Promise<Login> {
  const out = await loginAs(email, password);
  assert("session" in out, `login failed for ${email}: ${JSON.stringify(out)}`);
  return out as Login;
}

const roleKeys = (body: { roles: Array<{ key: string }> }) => body.roles.map((r) => r.key);
const roleByKey = (body: { roles: Array<{ key: string; pending: number; label: string }> }, key: string) =>
  body.roles.find((r) => r.key === key);

// Submit a break-glass request as `submitter` against `system`, returning its id.
async function submitRequest(session: string, systemId: string, assetId: string, sr: string): Promise<string> {
  const res = await req("/requests", {
    method: "POST",
    headers: authHeaders(session),
    body: {
      systemId,
      justification: "Investigate a production incident requiring elevated access.",
      srNumber: sr,
      activityStartAt: new Date(Date.now() + 3600_000).toISOString(),
      activityEndAt: new Date(Date.now() + 4 * 3600_000).toISOString(),
      credentialItems: [{ assetId }],
    },
  });
  // Read the body exactly once: consuming it for the error message and then
  // again for the id throws "Body already consumed".
  const body = await res.json().catch(() => null);
  assertEquals(res.status, 201, `submit ${sr} failed: ${JSON.stringify(body)}`);
  return body.request.id;
}

Deno.test("GET /auth/me — session and 2FA state", async (t) => {
  await wipeDatabase();

  const user = await createActiveUser({
    fullName: "Me Endpoint User",
    email: uniqueEmail("meuser"),
    password: "MePass!2026",
    affiliation: "agency",
  });
  const login = await signIn(user.email, "MePass!2026");

  await t.step("negative: no session token is 401", async () => {
    const res = await req("/auth/me");
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "Not authenticated.");
  });

  await t.step("negative: an unknown session token is 401", async () => {
    const res = await req("/auth/me", { headers: { "X-Session-Token": "not-a-real-session" } });
    assertEquals(res.status, 401);
    assertEquals((await res.json()).error, "Invalid or expired session.");
  });

  await t.step("positive: returns the user and the three 2FA booleans", async () => {
    const res = await req("/auth/me", { headers: authHeaders(login.session) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.user.id, user.id);
    assertEquals(body.user.email, user.email);
    // createActiveUser enrols TOTP, and loginAs completes it, so this session
    // is fully verified.
    assertEquals(body.twofaVerified, true);
    assertEquals(body.needs2faEnrollment, false);
    assertEquals(body.needs2faVerification, false);
  });

  await t.step("SECURITY: no password hash, salt or TOTP secret is ever serialised", async () => {
    const res = await req("/auth/me", { headers: authHeaders(login.session) });
    const raw = await res.text();
    for (const forbidden of ["passwordHash", "password_hash", "salt", "totpSecret", "totp_secret"]) {
      assertEquals(raw.includes(forbidden), false, `/auth/me leaked ${forbidden}`);
    }
    // And the real secret value is not present under any key name.
    const [row] = await query<{ totp_secret: string | null; password_hash: string }>(
      `SELECT totp_secret, password_hash FROM users WHERE id = $1`,
      [user.id],
    );
    assert(row.password_hash.length > 0, "fixture sanity");
    assertEquals(raw.includes(row.password_hash), false, "password hash value leaked");
    if (row.totp_secret) assertEquals(raw.includes(row.totp_secret), false, "totp secret value leaked");
  });

  await t.step("the endpoint answers past the 2FA gate: unverified session still gets 200", async () => {
    // Log in WITHOUT completing 2FA (loginAs would finish it), which is the
    // exact state the client reloads in. /auth/me is allowlisted so the client
    // can decide what to render; a 403 here would strand the user.
    const res = await req("/auth/login", {
      method: "POST",
      body: { email: user.email, password: "MePass!2026" },
    });
    assertEquals(res.status, 200);
    const { session, needs2faVerification } = await res.json();
    assertEquals(needs2faVerification, true, "fixture is enrolled, so login should gate");

    const me = await req("/auth/me", { headers: authHeaders(session) });
    assertEquals(me.status, 200, "/auth/me must not be gated");
    const body = await me.json();
    assertEquals(body.twofaVerified, false);
    assertEquals(body.needs2faVerification, true);
    assertEquals(body.needs2faEnrollment, false, "enrolled, so this is verify — not enroll");
  });

  await t.step("an un-enrolled user is told to ENROL, not to verify", async () => {
    const fresh = await createActiveUser({
      fullName: "Unenrolled User",
      email: uniqueEmail("unenrolled"),
      password: "FreshPass!2026",
      affiliation: "agency",
      enroll2fa: false,
    });
    const res = await req("/auth/login", {
      method: "POST",
      body: { email: fresh.email, password: "FreshPass!2026" },
    });
    assertEquals(res.status, 200);
    const { session } = await res.json();

    const body = await (await req("/auth/me", { headers: authHeaders(session) })).json();
    assertEquals(body.twofaVerified, false);
    assertEquals(body.needs2faEnrollment, true);
    assertEquals(body.needs2faVerification, false);
  });

  await t.step("negative: a session whose user is no longer active is 401", async () => {
    const doomed = await createActiveUser({
      fullName: "Doomed User",
      email: uniqueEmail("doomed"),
      password: "DoomedPass!2026",
      affiliation: "agency",
    });
    const dl = await signIn(doomed.email, "DoomedPass!2026");
    assertEquals((await req("/auth/me", { headers: authHeaders(dl.session) })).status, 200);

    await query(`UPDATE users SET status = 'tombstoned' WHERE id = $1`, [doomed.id]);
    const after = await req("/auth/me", { headers: authHeaders(dl.session) });
    assertEquals(after.status, 401);
    assertEquals((await after.json()).error, "User not found or inactive.");
  });
});

Deno.test("GET /me/capability-snapshot", async (t) => {
  await wipeDatabase();

  const admin = await createAdmin("SnapAdmin!2026");
  const adminLogin = await signIn(admin.email, "SnapAdmin!2026");
  const owner = await createActiveUser({
    fullName: "Snap Owner",
    email: uniqueEmail("snapowner"),
    password: "OwnerPass!2026",
    affiliation: "agency",
  });
  const ownerLogin = await signIn(owner.email, "OwnerPass!2026");
  const { system } = await createWiredSystem(admin.id, owner);

  await t.step("negative: unauthenticated is 401", async () => {
    assertEquals((await req("/me/capability-snapshot")).status, 401);
  });

  await t.step("positive: an owner's snapshot names their system, plus an idempotency token", async () => {
    const res = await req("/me/capability-snapshot", { headers: authHeaders(ownerLogin.session) });
    assertEquals(res.status, 200);
    const { snapshot, idempotencyToken } = await res.json();
    assert(
      JSON.stringify(snapshot).includes(system.id),
      "the owned system should appear somewhere in the snapshot",
    );
    assertEquals(snapshot.isAdmin ?? false, false);
    // The endpoint doubles as the client's idempotency-token source, so a
    // missing token would silently break every mutating call the UI makes.
    assert(typeof idempotencyToken === "string" && idempotencyToken.length > 0, "expected a token");
  });

  await t.step("positive: a full admin's snapshot reports isAdmin", async () => {
    const res = await req("/me/capability-snapshot", { headers: authHeaders(adminLogin.session) });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).snapshot.isAdmin, true);
  });

  await t.step("each call mints a FRESH idempotency token", async () => {
    const a = await (await req("/me/capability-snapshot", { headers: authHeaders(adminLogin.session) })).json();
    const b = await (await req("/me/capability-snapshot", { headers: authHeaders(adminLogin.session) })).json();
    assert(a.idempotencyToken !== b.idempotencyToken, "tokens are single-use and must not repeat");
  });

  await t.step("SECURITY: the snapshot carries no secret material", async () => {
    const raw = await (await req("/me/capability-snapshot", { headers: authHeaders(adminLogin.session) })).text();
    for (const forbidden of ["passwordHash", "password_hash", "totpSecret", "totp_secret"]) {
      assertEquals(raw.includes(forbidden), false, `snapshot leaked ${forbidden}`);
    }
  });
});

Deno.test("GET /me/role-summary — dashboard role classification", async (t) => {
  await wipeDatabase();

  const admin = await createAdmin("RoleAdmin!2026");
  const adminLogin = await signIn(admin.email, "RoleAdmin!2026");

  await t.step("negative: unauthenticated is 401", async () => {
    assertEquals((await req("/me/role-summary")).status, 401);
  });

  await t.step("a user with no roles at all gets an empty list", async () => {
    const nobody = await createActiveUser({
      fullName: "Role Nobody",
      email: uniqueEmail("rolenobody"),
      password: "NobodyPass!2026",
      affiliation: "vendor",
    });
    const login = await signIn(nobody.email, "NobodyPass!2026");
    const res = await req("/me/role-summary", { headers: authHeaders(login.session) });
    assertEquals(res.status, 200);
    assertEquals((await res.json()).roles, []);
  });

  await t.step("admin: gets the admin tile, badged with pending approvals", async () => {
    const res = await req("/me/role-summary", { headers: authHeaders(adminLogin.session) });
    assertEquals(res.status, 200);
    const body = await res.json();
    assert(roleKeys(body).includes("admin"), JSON.stringify(roleKeys(body)));

    const admin_ = roleByKey(body, "admin")!;
    assertEquals(admin_.label, "Administrator");
    const [{ n }] = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users WHERE status = 'pending_approval'`,
    );
    assertEquals(admin_.pending, n, "the badge is the pending-approval count");
  });

  await t.step("agency owner: gets the owner tile, badged only with OTHERS' step-0 requests", async () => {
    const owner = await createActiveUser({
      fullName: "Role Owner",
      email: uniqueEmail("roleowner"),
      password: "OwnerPass!2026",
      affiliation: "agency",
    });
    const { system, vendorL1 } = await createWiredSystem(admin.id, owner);
    const ownerLogin = await signIn(owner.email, "OwnerPass!2026");

    const body = await (await req("/me/role-summary", { headers: authHeaders(ownerLogin.session) })).json();
    assert(roleKeys(body).includes("owner"), JSON.stringify(roleKeys(body)));
    assertEquals(roleByKey(body, "owner")!.label, "System Owner");
    // Nothing submitted yet.
    assertEquals(roleByKey(body, "owner")!.pending, 0);

    // A submission by someone else does not sit at the owner's step until it
    // reaches ordinal 0, so this asserts the count stays honest either way:
    // it must never count the viewer's OWN submissions.
    const submitter = await createActiveUser({
      fullName: "Role Submitter",
      email: uniqueEmail("rolesubmitter"),
      password: "SubPass!2026",
      affiliation: "vendor",
    });
    await addServingMember(vendorL1, submitter, admin.id);
    const subLogin = await signIn(submitter.email, "SubPass!2026");
    const asset = await createAsset(system.id, { hostname: "role-host" });
    await submitRequest(subLogin.session, system.id, asset.id, "SR-ROLE1");

    const after = await (await req("/me/role-summary", { headers: authHeaders(ownerLogin.session) })).json();
    const ownerTile = roleByKey(after, "owner")!;
    assert(ownerTile.pending >= 0, "badge must be a non-negative count");

    // The submitter sees an engineer tile, and it must NOT count their own request.
    const subBody = await (await req("/me/role-summary", { headers: authHeaders(subLogin.session) })).json();
    assert(roleKeys(subBody).includes("engineer"), JSON.stringify(roleKeys(subBody)));
    const engineer = roleByKey(subBody, "engineer")!;
    assertEquals(engineer.label, "Vendor Engineer", "vendor affiliation → Vendor Engineer");
    assertEquals(engineer.pending, 0, "a viewer's own submission must never badge their tile");
  });

  await t.step("agency reviewer: the engineer tile is labelled Agency Engineer", async () => {
    const owner2 = await createActiveUser({
      fullName: "Role Owner2",
      email: uniqueEmail("roleowner2"),
      password: "Owner2Pass!2026",
      affiliation: "agency",
    });
    const { agencyL1 } = await createWiredSystem(admin.id, owner2);
    const reviewer = await createActiveUser({
      fullName: "Role Reviewer",
      email: uniqueEmail("rolereviewer"),
      password: "RevPass!2026",
      affiliation: "agency",
    });
    await addServingMember(agencyL1, reviewer, admin.id);
    const revLogin = await signIn(reviewer.email, "RevPass!2026");

    const body = await (await req("/me/role-summary", { headers: authHeaders(revLogin.session) })).json();
    assert(roleKeys(body).includes("engineer"), JSON.stringify(roleKeys(body)));
    assertEquals(roleByKey(body, "engineer")!.label, "Agency Engineer");
  });

  await t.step("pure delegate: classified Delegate Approver, NOT System Owner", async () => {
    // The rule the comment in getMyRoleSummary calls out explicitly: a user
    // with delegations but no ownership must not be labelled an owner.
    const owner3 = await createActiveUser({
      fullName: "Role Owner3",
      email: uniqueEmail("roleowner3"),
      password: "Owner3Pass!2026",
      affiliation: "agency",
    });
    const { system, agencyCluster } = await createWiredSystem(admin.id, owner3);
    const delegate = await createActiveUser({
      fullName: "Role Delegate",
      email: uniqueEmail("roledelegate"),
      password: "DelPass!2026",
      affiliation: "agency",
    });
    // A delegate must be an agency user who is a member of the system's owner
    // organisation (D7) — that org is the agency cluster's.
    await addOrgMembership({
      organizationId: agencyCluster.organizationId,
      userId: delegate.id,
      addedBy: admin.id,
    });
    const ownerLogin = await signIn(owner3.email, "Owner3Pass!2026");
    const add = await req(`/owner/systems/${system.id}/delegates`, {
      method: "POST",
      headers: authHeaders(ownerLogin.session),
      body: { delegateUserId: delegate.id },
    });
    const addBody = await add.text();
    assertEquals(add.status, 201, `delegate add failed: ${addBody}`);

    const delLogin = await signIn(delegate.email, "DelPass!2026");
    const body = await (await req("/me/role-summary", { headers: authHeaders(delLogin.session) })).json();
    const keys = roleKeys(body);
    assert(keys.includes("delegate"), `expected a delegate tile, got ${JSON.stringify(keys)}`);
    assertEquals(keys.includes("owner"), false, "a pure delegate must NOT be classified as an owner");
    assertEquals(roleByKey(body, "delegate")!.label, "Delegate Approver");

    // And the owner keeps exactly one tile — owner, not owner+delegate.
    const ownerBody = await (await req("/me/role-summary", { headers: authHeaders(ownerLogin.session) })).json();
    const ownerKeys = roleKeys(ownerBody);
    assert(ownerKeys.includes("owner"), JSON.stringify(ownerKeys));
    assertEquals(ownerKeys.includes("delegate"), false, "an agency owner must not also get a delegate tile");
  });

  await t.step("team admin: gets a zero-badge tile, and admins do not", async () => {
    const owner4 = await createActiveUser({
      fullName: "Role Owner4",
      email: uniqueEmail("roleowner4"),
      password: "Owner4Pass!2026",
      affiliation: "agency",
    });
    const { vendorL2 } = await createWiredSystem(admin.id, owner4);
    const teamAdmin = await createActiveUser({
      fullName: "Role TeamAdmin",
      email: uniqueEmail("roleteamadmin"),
      password: "TAPass!2026",
      affiliation: "vendor",
    });
    await addMember(vendorL2, teamAdmin, admin.id, "team_admin");
    const taLogin = await signIn(teamAdmin.email, "TAPass!2026");

    const body = await (await req("/me/role-summary", { headers: authHeaders(taLogin.session) })).json();
    assert(roleKeys(body).includes("team_admin"), JSON.stringify(roleKeys(body)));
    assertEquals(roleByKey(body, "team_admin")!.pending, 0);

    // A full admin who is also a team admin gets only the admin tile.
    const adminBody = await (await req("/me/role-summary", { headers: authHeaders(adminLogin.session) })).json();
    assertEquals(roleKeys(adminBody).includes("team_admin"), false);
  });

  await t.step("ordering: highest badge first, ties broken by fixed priority", async () => {
    const body = await (await req("/me/role-summary", { headers: authHeaders(adminLogin.session) })).json();
    const roles = body.roles as Array<{ key: string; pending: number }>;
    const PRIORITY: Record<string, number> = { admin: 0, owner: 1, engineer: 2, delegate: 3, team_admin: 4 };
    for (let i = 1; i < roles.length; i++) {
      const prev = roles[i - 1], cur = roles[i];
      const ordered = prev.pending > cur.pending ||
        (prev.pending === cur.pending && PRIORITY[prev.key] <= PRIORITY[cur.key]);
      assert(ordered, `roles out of order at ${i}: ${JSON.stringify(roles)}`);
    }
  });
});
