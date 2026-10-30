// Tests for server/identity-change.tsx — the Entra identity-guard state
// machine (addendum-132). At 7% line coverage this was the single largest
// untested module in server/, and it is the code that decides whether an
// Entra Object ID may be re-pointed at an existing account.
//
// The rules that carry real risk, and are pinned below:
//   * An Object ID already linked to ANOTHER user must never be adopted —
//     that is the account-takeover path. Both change types check it.
//   * Every failure must be recorded, not swallowed: the catch arm flips the
//     request to 'failed' with the reason and writes an audit row, so a
//     blocked takeover attempt is visible afterwards.
//   * A request is single-use and time-boxed: applying a non-pending or an
//     expired request must fail, and expiry must transition it to 'expired'.
//   * local_to_entra_upgrade REACTIVATES a decommissioned identity belonging
//     to the same user rather than inserting a duplicate row.
//   * The `entra_disable_password_after_link` setting decides whether the
//     password path is closed once the link completes.
import { assert, assertEquals } from "jsr:@std/assert";
import { createActiveUser, uniqueEmail, wipeDatabase } from "./helpers.tsx";
import {
  applyIdentityChange,
  createIdentityChangeRequest,
  disablePasswordLogin,
  enablePasswordLogin,
  getActiveEntraIdentityForUser,
  getIdentityStateForUser,
  getPendingIdentityChangeForSession,
  hasTotpEnrolled,
  isPasswordLoginAllowed,
  canProceedWithPasswordLogin,
  rejectIdentityChange,
  resolveEntraLoginWithIdentityGuard,
  sweepExpiredIdentityChangeRequests,
} from "../../../server/identity-change.tsx";
import { externalIdentities, generateId, identityChangeRequests, now, users } from "../../../server/db.tsx";
import { query } from "../../../server/db/drizzle.ts";
import { PROVIDER_ENTRA_ID } from "../../../server/entra/config.tsx";

// external_identities has a UNIQUE(provider, external_id): an Object ID is
// globally unique, so every fixture needs its own.
let oidSeq = 0;
const newOid = () => `00000000-0000-4000-8000-${String(++oidSeq).padStart(12, "0")}`;

let seq = 0;
const newUser = async (label: string) =>
  await createActiveUser({
    fullName: `Identity ${label} ${++seq}`,
    email: uniqueEmail(`identity${label}${seq}`),
    password: "IdentityPass!2026",
    affiliation: "agency",
  });

// identity_change_requests.session_id is a real FK, so a request fixture
// needs a live session row for its user.
const newSession = async (userId: string): Promise<string> => {
  const id = generateId();
  await query(
    `INSERT INTO sessions (id, user_id, created_at, last_activity_at, twofa_failed_attempts, expires_at, auth_method, entra_mfa_performed)
     VALUES ($1, $2, now(), now(), 0, now() + interval '1 hour', 'password', false)`,
    [id, userId],
  );
  return id;
};

const linkIdentity = async (
  userId: string,
  externalId: string,
  status: "active" | "decommissioned" = "active",
) =>
  await externalIdentities.create({
    id: generateId(),
    userId,
    provider: PROVIDER_ENTRA_ID,
    externalId,
    externalUpn: `${externalId}@tenant.example`,
    status,
    linkedAt: now(),
    decommissionedAt: status === "decommissioned" ? now() : null,
    createdAt: now(),
    updatedAt: now(),
  } as never);

// createIdentityChangeRequest() stamps expiresAt from the configured TTL, so
// an expired fixture has to be aged directly in the row.
const makeRequest = async (
  userId: string,
  changeType: "entra_object_id_mismatch" | "local_to_entra_upgrade",
  opts: { oldIdentityId?: string | null; oldExternalId?: string | null; newExternalId: string },
) =>
  await createIdentityChangeRequest(
    userId,
    await newSession(userId),
    PROVIDER_ENTRA_ID,
    changeType,
    "entra_callback",
    opts.oldIdentityId ?? null,
    opts.oldExternalId ?? null,
    opts.newExternalId,
    `${opts.newExternalId}@tenant.example`,
    `user-${userId.slice(0, 8)}@tenant.example`,
  );

const auditActions = async (userId: string): Promise<string[]> => {
  const rows = await query<{ action: string }>(
    `SELECT action FROM audit_log WHERE target_id = $1 ORDER BY created_at ASC`,
    [userId],
  );
  return rows.map((r) => r.action);
};

Deno.test("identity change — Entra identity guard", async (t) => {
  await wipeDatabase();

  // ── identity state ───────────────────────────────────────────────────────

  await t.step("state: a user with no external identity is 'local'", async () => {
    const user = await newUser("local");
    assertEquals(await getIdentityStateForUser(user.id), "local");
    assertEquals(await getActiveEntraIdentityForUser(user.id), null);
  });

  await t.step("state: an active Entra link reports 'entra_managed'", async () => {
    const oidA = newOid();
    const user = await newUser("managed");
    await linkIdentity(user.id, oidA);
    assertEquals(await getIdentityStateForUser(user.id), "entra_managed");
    const active = await getActiveEntraIdentityForUser(user.id);
    assertEquals(active?.externalId, oidA);
  });

  await t.step("state: a decommissioned link falls back to 'local', not 'entra_managed'", async () => {
    const oidA = newOid();
    // Documents that 'pending_entra' is currently unreachable: both lookups in
    // getIdentityStateForUser filter status='active', so a non-active identity
    // reads as 'local'. Pinned so the dead branch is noticed if it is ever
    // wired up to a real pending state.
    const user = await newUser("decomm");
    await linkIdentity(user.id, oidA, "decommissioned");
    assertEquals(await getIdentityStateForUser(user.id), "local");
  });

  // ── password gate ────────────────────────────────────────────────────────

  await t.step("password gate: allowed for a plain local user", async () => {
    const user = await newUser("pwlocal");
    assertEquals(await isPasswordLoginAllowed(user), true);
  });

  await t.step("password gate: an active Entra link closes the password path", async () => {
    const oidB = newOid();
    const user = await newUser("pwentra");
    await linkIdentity(user.id, oidB);
    const reloaded = (await users.get(user.id))!;
    assertEquals(await isPasswordLoginAllowed(reloaded), false);
  });

  await t.step("password gate: disable then re-enable, both audited", async () => {
    const user = await newUser("pwtoggle");
    await disablePasswordLogin(user.id, "entra_link_completed", user.id);

    const disabled = (await users.get(user.id))!;
    assert(disabled.passwordLoginDisabledAt, "expected a disabled-at stamp");
    assertEquals(disabled.passwordLoginDisabledReason, "entra_link_completed");
    assertEquals(await isPasswordLoginAllowed(disabled), false);

    await enablePasswordLogin(user.id, "admin recovery after lockout", user.id);
    const enabled = (await users.get(user.id))!;
    assertEquals(enabled.passwordLoginDisabledAt, null);
    assertEquals(enabled.passwordLoginDisabledReason, null);
    assertEquals(await isPasswordLoginAllowed(enabled), true);

    const actions = await auditActions(user.id);
    assert(actions.includes("user.password_path_disabled_after_entra_link"), actions.join(","));
    assert(actions.includes("user.password_path_enabled_admin_recovery"), actions.join(","));
  });

  await t.step("hasTotpEnrolled: requires BOTH a secret and an enrolment stamp", () => {
    const base = { totpSecret: null, totpEnrolledAt: null } as never;
    assertEquals(hasTotpEnrolled(base), false);
    assertEquals(hasTotpEnrolled({ totpSecret: "S", totpEnrolledAt: null } as never), false);
    assertEquals(hasTotpEnrolled({ totpSecret: null, totpEnrolledAt: now() } as never), false);
    assertEquals(hasTotpEnrolled({ totpSecret: "S", totpEnrolledAt: now() } as never), true);
  });

  // ── request lifecycle ────────────────────────────────────────────────────

  await t.step("create: a request is pending, TTL-stamped, and findable by session", async () => {
    const oidA = newOid();
    const user = await newUser("create");
    const request = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidA });

    assertEquals(request.status, "pending");
    assert(new Date(request.expiresAt).getTime() > Date.now(), "expiresAt must be in the future");

    const found = await getPendingIdentityChangeForSession(request.sessionId);
    assertEquals(found?.id, request.id);
    assert((await auditActions(user.id)).includes("user.local_to_entra_upgrade_initiated"));
  });

  await t.step("create: a mismatch request audits under its own action", async () => {
    const oidA = newOid();
    const oidB = newOid();
    const user = await newUser("mismatch");
    const identity = await linkIdentity(user.id, oidA);
    await makeRequest(user.id, "entra_object_id_mismatch", {
      oldIdentityId: identity.id,
      oldExternalId: oidA,
      newExternalId: oidB,
    });
    assert((await auditActions(user.id)).includes("user.entra_object_id_mismatch_detected"));
  });

  // ── apply: happy paths ───────────────────────────────────────────────────

  await t.step("apply: local_to_entra_upgrade creates the active identity", async () => {
    const oidA = newOid();
    const user = await newUser("upgrade");
    const request = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidA });

    const result = await applyIdentityChange(request, user.id, user.id);
    assertEquals(result.success, true);
    assertEquals(result.newIdentity?.externalId, oidA);
    assertEquals(await getIdentityStateForUser(user.id), "entra_managed");

    const settled = await identityChangeRequests.get(request.id);
    assertEquals(settled?.status, "completed");
    assert(settled?.completedAt, "completedAt must be stamped");
    assert((await auditActions(user.id)).includes("user.local_to_entra_upgrade_completed_after_2fa"));
  });

  await t.step("apply: an upgrade REACTIVATES the user's own decommissioned identity", async () => {
    const oidB = newOid();
    const user = await newUser("reactivate");
    const dead = await linkIdentity(user.id, oidB, "decommissioned");
    const request = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidB });

    const result = await applyIdentityChange(request, user.id, user.id);
    assertEquals(result.success, true);
    assertEquals(result.newIdentity?.id, dead.id, "the existing row must be reused, not duplicated");

    const rows = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM external_identities WHERE user_id = $1`,
      [user.id],
    );
    assertEquals(rows[0]!.n, "1", "no duplicate identity row");

    const revived = await externalIdentities.get(dead.id);
    assertEquals(revived?.status, "active");
    assertEquals(revived?.decommissionedAt, null);
  });

  await t.step("apply: object_id_mismatch re-points the existing identity", async () => {
    const oidA = newOid();
    const oidB = newOid();
    const user = await newUser("repoint");
    const identity = await linkIdentity(user.id, oidA);
    const request = await makeRequest(user.id, "entra_object_id_mismatch", {
      oldIdentityId: identity.id,
      oldExternalId: oidA,
      newExternalId: oidB,
    });

    const result = await applyIdentityChange(request, user.id, user.id);
    assertEquals(result.success, true);
    assertEquals(result.newIdentity?.externalId, oidB);

    const updated = await externalIdentities.get(identity.id);
    assertEquals(updated?.externalId, oidB, "the same row is re-pointed");
    assert((await auditActions(user.id)).includes("user.entra_object_id_updated_after_2fa"));
  });

  // ── apply: the takeover guards ───────────────────────────────────────────

  await t.step("apply: NEGATIVE — an upgrade cannot adopt an OID owned by another user", async () => {
    const oidA = newOid();
    const victim = await newUser("victim");
    const attacker = await newUser("attacker");
    await linkIdentity(victim.id, oidA);

    const request = await makeRequest(attacker.id, "local_to_entra_upgrade", { newExternalId: oidA });
    const result = await applyIdentityChange(request, attacker.id, attacker.id);

    assertEquals(result.success, false);
    assertEquals(result.error, "New Object ID is already linked to another user");
    // The attacker gains nothing, and the victim's link is untouched.
    assertEquals(await getIdentityStateForUser(attacker.id), "local");
    assertEquals((await getActiveEntraIdentityForUser(victim.id))?.userId, victim.id);
    // The blocked attempt is durably recorded.
    const settled = await identityChangeRequests.get(request.id);
    assertEquals(settled?.status, "failed");
    assertEquals(settled?.failureReason, "New Object ID is already linked to another user");
    assert((await auditActions(attacker.id)).includes("user.identity_change_2fa_failed"));
  });

  await t.step("apply: NEGATIVE — a mismatch cannot adopt an OID owned by another user", async () => {
    const oidA = newOid();
    const oidB = newOid();
    const victim = await newUser("victim2");
    const attacker = await newUser("attacker2");
    await linkIdentity(victim.id, oidB);
    const attackerIdentity = await linkIdentity(attacker.id, oidA);

    const request = await makeRequest(attacker.id, "entra_object_id_mismatch", {
      oldIdentityId: attackerIdentity.id,
      oldExternalId: oidA,
      newExternalId: oidB,
    });
    const result = await applyIdentityChange(request, attacker.id, attacker.id);

    assertEquals(result.success, false);
    assertEquals(result.error, "New Object ID is already linked to another user");
    assertEquals((await externalIdentities.get(attackerIdentity.id))?.externalId, oidA);
  });

  await t.step("apply: NEGATIVE — a mismatch cannot re-point another user's identity row", async () => {
    const oidA = newOid();
    const oidB = newOid();
    const victim = await newUser("victim3");
    const attacker = await newUser("attacker3");
    const victimIdentity = await linkIdentity(victim.id, oidA);

    const request = await makeRequest(attacker.id, "entra_object_id_mismatch", {
      oldIdentityId: victimIdentity.id,
      oldExternalId: oidA,
      newExternalId: oidB,
    });
    const result = await applyIdentityChange(request, attacker.id, attacker.id);

    assertEquals(result.success, false);
    assertEquals(result.error, "Old external identity not found or does not belong to user");
    assertEquals((await externalIdentities.get(victimIdentity.id))?.externalId, oidA);
  });

  await t.step("apply: NEGATIVE — a mismatch without an old identity id is rejected", async () => {
    const oidB = newOid();
    const user = await newUser("noold");
    const request = await makeRequest(user.id, "entra_object_id_mismatch", {
      oldIdentityId: null,
      newExternalId: oidB,
    });
    const result = await applyIdentityChange(request, user.id, user.id);
    assertEquals(result.success, false);
    assertEquals(result.error, "Object ID mismatch requires old external identity ID");
  });

  await t.step("apply: NEGATIVE — an upgrade is refused when a link already exists", async () => {
    const oidA = newOid();
    const oidB = newOid();
    const user = await newUser("already");
    await linkIdentity(user.id, oidA);
    const request = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidB });

    const result = await applyIdentityChange(request, user.id, user.id);
    assertEquals(result.success, false);
    assertEquals(result.error, "User already has an active Entra identity");
  });

  // ── apply: lifecycle guards ──────────────────────────────────────────────

  await t.step("apply: NEGATIVE — a request is single-use", async () => {
    const oidA = newOid();
    const user = await newUser("replay");
    const request = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidA });
    assertEquals((await applyIdentityChange(request, user.id, user.id)).success, true);

    // Replaying the STALE in-memory object bypasses the status check (its copy
    // still reads 'pending'), so the defence that actually stops the replay is
    // the already-linked guard. Worth pinning: the status check alone is not
    // what makes this safe.
    const replay = await applyIdentityChange(request, user.id, user.id);
    assertEquals(replay.success, false);
    assertEquals(replay.error, "User already has an active Entra identity");

    // Re-read from the database and the status check refuses it outright.
    const fresh = (await identityChangeRequests.get(request.id))!;
    assertEquals(fresh.status, "failed", "the replay attempt was recorded as failed");
    const withStatus = await applyIdentityChange(fresh, user.id, user.id);
    assertEquals(withStatus.success, false);
    assertEquals(withStatus.error, "Identity change request is no longer pending");
  });

  await t.step("apply: NEGATIVE — an expired request transitions to 'expired'", async () => {
    const oidA = newOid();
    const user = await newUser("expired");
    const request = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidA });
    await query(`UPDATE identity_change_requests SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
      request.id,
    ]);
    const aged = (await identityChangeRequests.get(request.id))!;

    const result = await applyIdentityChange(aged, user.id, user.id);
    assertEquals(result.success, false);
    assertEquals(result.error, "Identity change request expired");
    assertEquals((await identityChangeRequests.get(request.id))?.status, "expired");
    assertEquals(await getIdentityStateForUser(user.id), "local", "no identity may be created");
    assert((await auditActions(user.id)).includes("user.identity_change_expired"));
  });

  await t.step("reject: marks the request failed with the supplied reason", async () => {
    const oidA = newOid();
    const user = await newUser("reject");
    const request = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidA });

    await rejectIdentityChange(request, "TOTP not enrolled", user.id);

    const settled = await identityChangeRequests.get(request.id);
    assertEquals(settled?.status, "failed");
    assertEquals(settled?.failureReason, "TOTP not enrolled");
    assert(settled?.failedAt, "failedAt must be stamped");
    assert((await auditActions(user.id)).includes("user.identity_change_blocked"));
    // A rejected request is no longer offered to the session.
    assertEquals(await getPendingIdentityChangeForSession(request.sessionId), null);
  });

  await t.step("sweep: expires overdue pending requests and leaves live ones alone", async () => {
    const oidA = newOid();
    const oidB = newOid();
    const user = await newUser("sweep");
    const stale = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidA });
    const live = await makeRequest(user.id, "local_to_entra_upgrade", { newExternalId: oidB });
    await query(`UPDATE identity_change_requests SET expires_at = now() - interval '1 hour' WHERE id = $1`, [
      stale.id,
    ]);

    await sweepExpiredIdentityChangeRequests();

    assertEquals((await identityChangeRequests.get(stale.id))?.status, "expired");
    assertEquals((await identityChangeRequests.get(live.id))?.status, "pending");
  });
});

// resolveEntraLoginWithIdentityGuard is CURRENTLY DEAD CODE: nothing in the
// repo calls it (the live callback in routes/auth-entra.tsx calls
// createIdentityChangeRequest directly, with a real session id). It is tested
// anyway because it is exported, non-trivial, and reads like the intended
// future home of this decision — and because doing so surfaced a latent
// defect, recorded in the two DEAD-CODE DEFECT steps below.
//
// Its four non-escalating outcomes are asserted normally. The two escalating
// arms cannot succeed as written: it passes sessionId '' to
// createIdentityChangeRequest, and identity_change_requests.session_id is a
// NOT NULL varchar with an FK to sessions(id), so the insert always violates
// the FK. Those two steps therefore assert the CURRENT broken behaviour with
// an explicit note, rather than pretending the path works.
Deno.test("resolveEntraLoginWithIdentityGuard — the Entra login decision matrix", async (t) => {
  await wipeDatabase();

  await t.step("unknown email → rejected(pending_approval), no request created", async () => {
    const before = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_change_requests`,
    );
    const out = await resolveEntraLoginWithIdentityGuard(
      newOid(),
      "nobody-here@tenant.example",
      undefined,
      undefined,
      "entra_callback",
    );
    assertEquals(out.kind, "rejected");
    assertEquals((out as { reason: string }).reason, "pending_approval");

    const after = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_change_requests`,
    );
    assertEquals(after[0].n, before[0].n, "an unknown email must not create a request");
  });

  await t.step("matching Object ID → ready (the normal login path)", async () => {
    const user = await newUser("guardready");
    const oid = newOid();
    await linkIdentity(user.id, oid);

    const out = await resolveEntraLoginWithIdentityGuard(
      oid,
      user.email,
      undefined,
      undefined,
      "entra_callback",
    );
    assertEquals(out.kind, "ready");
    assertEquals((out as { user: { id: string } }).user.id, user.id);
  });

  await t.step("DEAD-CODE DEFECT: the Object-ID-mismatch arm cannot create its request", async () => {
    // Intended behaviour: same email + different Entra OID must escalate to a
    // 2FA-gated identity change rather than silently re-pointing the link.
    // Actual behaviour: the helper passes sessionId '' into
    // createIdentityChangeRequest, and session_id is NOT NULL with an FK to
    // sessions(id), so the insert throws. Pinned as a throw so that wiring
    // this function up without fixing the session id fails loudly here first.
    const user = await newUser("guardmismatch");
    const oldOid = newOid();
    const identity = await linkIdentity(user.id, oldOid);

    let threw = false;
    try {
      await resolveEntraLoginWithIdentityGuard(
        newOid(),
        user.email,
        "changed@tenant.example",
        undefined,
        "entra_callback",
      );
    } catch (e) {
      threw = true;
      assert(
        String(e).includes("session_id") || String(e).includes("foreign key"),
        `expected the session_id FK violation, got: ${String(e).slice(0, 160)}`,
      );
    }
    assert(threw, "the mismatch arm is expected to throw until the sessionId is supplied");

    // Whatever happens, the existing link must be untouched.
    assertEquals((await externalIdentities.get(identity.id))?.externalId, oldOid);
  });

  await t.step("DEAD-CODE DEFECT: the local-to-Entra upgrade arm cannot create its request", async () => {
    // Same latent defect on the other escalating arm.
    const user = await newUser("guardupgrade");
    let threw = false;
    try {
      await resolveEntraLoginWithIdentityGuard(
        newOid(),
        user.email,
        "upgrade@tenant.example",
        undefined,
        "entra_callback",
      );
    } catch (e) {
      threw = true;
      assert(
        String(e).includes("session_id") || String(e).includes("foreign key"),
        `expected the session_id FK violation, got: ${String(e).slice(0, 160)}`,
      );
    }
    assert(threw, "the upgrade arm is expected to throw until the sessionId is supplied");
  });

  await t.step("local user WITHOUT TOTP → rejected(no_totp_for_identity_change)", async () => {
    // Without a second factor there is nothing to verify the change against,
    // so the upgrade must be refused rather than trusted on the OIDC assertion.
    const user = await createActiveUser({
      fullName: "No Totp User",
      email: uniqueEmail("guardnototp"),
      password: "NoTotpPass!2026",
      affiliation: "agency",
      enroll2fa: false,
    });

    const out = await resolveEntraLoginWithIdentityGuard(
      newOid(),
      user.email,
      undefined,
      undefined,
      "entra_callback",
    );
    assertEquals(out.kind, "rejected");
    assertEquals((out as { reason: string }).reason, "no_totp_for_identity_change");

    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM identity_change_requests WHERE user_id = $1`,
      [user.id],
    );
    assertEquals(rows[0].n, 0, "a refused upgrade must not leave a pending request");
  });

  await t.step("non-active user → rejected, and findActiveByEmail hides them entirely", async () => {
    const user = await newUser("guardinactive");
    await query(`UPDATE users SET status = 'tombstoned' WHERE id = $1`, [user.id]);

    const out = await resolveEntraLoginWithIdentityGuard(
      newOid(),
      user.email,
      undefined,
      undefined,
      "entra_callback",
    );
    assertEquals(out.kind, "rejected");
    // The lookup is findActiveByEmail, so a tombstoned user is indistinguishable
    // from an unknown one — no account-existence oracle via the Entra path.
    assertEquals((out as { reason: string }).reason, "pending_approval");
  });
});

Deno.test("canProceedWithPasswordLogin — the password-path gate", async (t) => {
  await wipeDatabase();

  const auditCount = async (userId: string) => {
    const rows = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log
        WHERE action = 'user.password_login_blocked_identity_managed' AND target_id = $1`,
      [userId],
    );
    return rows[0].n;
  };

  await t.step("positive: a plain local user may use the password path", async () => {
    const user = await newUser("pwgateok");
    assertEquals(await canProceedWithPasswordLogin(user), true);
    assertEquals(await auditCount(user.id), 0, "an allowed login must not be audited as blocked");
  });

  await t.step("NEGATIVE: an explicitly disabled password path is blocked AND audited", async () => {
    const user = await newUser("pwgatedisabled");
    await disablePasswordLogin(user.id, "entra_link_completed", user.id);
    const reloaded = (await users.get(user.id))!;

    assertEquals(await canProceedWithPasswordLogin(reloaded), false);
    assertEquals(await auditCount(user.id), 1, "the block must leave an audit trail");
  });

  await t.step("NEGATIVE: an Entra-managed account is blocked even without the flag", async () => {
    // Second, independent reason: the flag is unset, but a live Entra identity
    // exists. Both arms must block, and each must record why.
    const user = await newUser("pwgateentra");
    await linkIdentity(user.id, newOid());
    const reloaded = (await users.get(user.id))!;
    assertEquals(reloaded.passwordLoginDisabledAt ?? null, null, "precondition: flag unset");

    assertEquals(await canProceedWithPasswordLogin(reloaded), false);

    const rows = await query<{ details: string }>(
      `SELECT details::text AS details FROM audit_log
        WHERE action = 'user.password_login_blocked_identity_managed' AND target_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [user.id],
    );
    assert(rows[0].details.includes("entra_managed_account"), rows[0].details);
  });

  await t.step("a decommissioned Entra identity does NOT block the password path", async () => {
    const user = await newUser("pwgatedecomm");
    await linkIdentity(user.id, newOid(), "decommissioned");
    const reloaded = (await users.get(user.id))!;
    assertEquals(await canProceedWithPasswordLogin(reloaded), true);
    assertEquals(await auditCount(user.id), 0);
  });
});
