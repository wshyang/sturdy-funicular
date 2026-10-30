// Shared test helpers for the integration test suite under
// supabase/functions/server/tests/. These tests hit a REAL Postgres database
// (see NEW_DEV_README.md — `docker compose up -d` + DATABASE_URL) through
// the actual Hono app via app.request(), never via app.fetch()+a listening
// socket, and never by mocking db.tsx. This is deliberate: the whole point
// of this suite is to catch storage-layer bugs (bad SQL, wrong column names,
// JSONB round-tripping) that a mocked-repository test would hide. See
// CLAUDE.md's "Backend test discipline" section before adding new routes
// without matching tests.
import { app } from "../../../server/app.tsx";
import { query, runInTransaction } from "../../../server/pg.tsx";
import {
  users, clusters, teams, teamMemberships, systems, systemOwners, systemOrganizations,
  teamSystemMappings, systemOwnerPAMappings, assets, sentNotifications, generateId, now,
} from "../../../server/db.tsx";
import { generateSalt, hashPassword } from "../../../server/utils.tsx";
import { getSessionUser } from "../../../server/auth.tsx";
import { currentTotp } from "../../../server/twofa.tsx";
import * as OTPAuth from "npm:otpauth";
import { createIdempotencyToken } from "../../../server/idempotency.tsx";
import { grantAdminRole } from "../../../server/auth-admin-roles.tsx";
import { nameForAffiliation, singaporeanName, vendorName } from "./name-seeds.ts";
import { DEFAULT_ORG_NAME, DEFAULT_ORG_SHORT_CODE } from "../../org-dimension.ts";
import type {
  Affiliation,
  Cluster,
  ClusterType,
  CredentialType,
  SentNotification,
  System,
  SystemOwner,
  Team,
  User,
} from "../../../server/types.tsx";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Same child-before-parent order as seed.tsx's CLEAR_TABLES. idempotency_tokens
// has no children and no FK dependents, so it's safe to clear anywhere, but
// it's placed before users (its parent, ON DELETE CASCADE) for consistency
// with the rest of this child-before-parent ordering.
const CLEAR_TABLES = [
  "access_log",
  "audit_log",
  // Append-only outbox — no FK dependents. email_templates is deliberately
  // NOT wiped here (seeded config, like schema_migrations) — see
  // addendum-044-email-notifications.md. notification_deliveries (the
  // per-recipient × per-channel child of sent_notifications, addendum-073) IS wiped
  // so delivery rows from one test file never leak into the next.
  "notification_deliveries",
  "sent_notifications",
  // No FK dependents; references users ON DELETE SET NULL (not CASCADE), so
  // it must be cleared explicitly rather than relying on a users wipe to
  // clean it up — see addendum-032-entra-id-sso-login.md.
  "external_identities",
  // Identity change requests: CASCADE from sessions (session_id) and users
  // (user_id); old_external_identity_id is SET NULL so safe after external_identities
  // cleared. Listed explicitly so the wipe order is self-documenting.
  "identity_change_requests",
  // Addendum-144 custody history is FK-RESTRICT and must clear child-first.
  "asset_custody_exception_evidence_files",
  "asset_custody_event_evidence_files",
  "asset_custody_exception_checks",
  "asset_custody_exceptions",
  "asset_custody_handoffs",
  "asset_custody_events",
  "request_asset_custody_cases",
  "request_asset_custody_run_items",
  "system_custody_stage_configs",
  "request_credential_items",
  "request_approval_steps",
  "request_key_material",
  "breakglass_requests",
  // request_asset_custody_runs.system_id → systems RESTRICT; must clear runs
  // before systems. Steps CASCADE from runs (auto-handled). aws_tenant_exchanges
  // CASCADE from systems but listed explicitly.
  "request_asset_custody_runs",
  "aws_tenant_exchanges",
  "system_owner_pa_mappings",
  "team_system_mappings",
  "system_delegates",
  "system_owners",
  "systems",
  "team_memberships",
  "teams",
  "clusters",
  "idempotency_tokens",
  // Per-system-per-day request-number counters + Entra SSO in-flight tokens —
  // formerly request_seq:*/entra_*:* kv_store blobs, now typed tables
  // (addendum-048). No FK dependents; safe to clear anywhere.
  "request_number_sequences",
  "entra_auth_states",
  "entra_handoffs",
  // Slack link CSRF-state tokens (slack_plan.md). FK to users ON DELETE
  // CASCADE; cleared before the users wipe.
  "slack_auth_states",
  // Admin-invite signup tokens (addendum-051). FK to users; cleared before the
  // users wipe.
  "user_invites",
  // Opaque email direct-link mappings (addendum-059). FK to users (createdBy
  // RESTRICT, intended_user_id CASCADE); cleared before the users wipe.
  "link_mappings",
  // Bearer-token sessions (addendum-047). References users ON DELETE CASCADE,
  // but cleared explicitly (before users) since users is special-cased with
  // WHERE NOT is_system below.
  "sessions",
  "login_attempts",
  // Additive admin-role grants (addendum-066). FK to users ON DELETE CASCADE
  // and to admin_roles via roleKey. Cleared explicitly before the users wipe
  // so grants created by one test file (createAdmin auto-grants full_admin)
  // don't leak into the next file — admin_roles itself is seeded config and
  // deliberately NOT wiped, so only the grants are cleared here.
  "user_admin_role_grants",
  // job_runs: no FK parent; audit_log.job_run_id SET NULL so safe after
  // audit_log cleared.
  // organizations.created_by → users RESTRICT; must be after clusters and
  // user_admin_role_grants (both have RESTRICT FK to organizations).
  // CASCADE from organizations handles: org_memberships, org_app_settings,
  // org_notification_templates (so those tables need no explicit entry here).
  "job_runs",
  "organizations",
  "users",
];

// Wipes every typed table so each test file starts from a perfectly empty,
// hermetic database. (kv_store is gone — every former prefix now has its own
// typed table, all listed in CLEAR_TABLES above; see addendum-048.) Safe to
// call at the top of every test file's setup step.
//
// users is special-cased: the two reserved system-actor rows
// (SYSTEM_USER_ID/UNKNOWN_USER_ID — see server/types.tsx) are permanent,
// seeded once by migrations/011_add_uuidv7_and_system_actor_users.sql, and
// a DB-level trigger (block_system_user_mutation) rejects any DELETE
// against them — a wholesale `DELETE FROM users` would fail outright now
// that they exist. `WHERE NOT is_system` wipes every real test-fixture user
// while leaving the reserved rows (and every audit_log row created via
// createAuditLog() with a real access_log_id in THIS test run's own
// requests) untouched, exactly as intended — those rows are meant to
// outlive every wipe, in every database, forever.
export async function wipeDatabase(): Promise<void> {
  for (const table of CLEAR_TABLES) {
    if (table === "users") {
      await query(`DELETE FROM users WHERE NOT is_system`);
    } else {
      await query(`DELETE FROM ${table}`);
    }
  }
}

// app_settings and email_templates are deliberately NOT in CLEAR_TABLES — their
// seed rows outlive every wipe (see the note above). But a test that MUTATES
// them (setSetting, template activate/deactivate) can leak that state into a
// later file in the same `deno test dir/` process. These helpers let such a
// test restore the specific seed values it touched, in its own setup/cleanup,
// rather than a global wipe-time restore that fought the users-FK ordering.

// Resets the app_settings the AWS transport/inventory tests set, back to the
// seed's empty-string value (so "app keys unset" assertions hold). UPDATE (not
// delete+reinsert) so the updated_by FK to users is never touched.
export async function resetAwsAppKeySettings(): Promise<void> {
  await query(`UPDATE app_settings SET value = '' WHERE key IN ('aws_encrypt_private_key_pem_b64', 'aws_encrypt_public_key_pem_b64')`);
}

// Reactivates every seeded email template. Tests that deactivate one to
// exercise the inactive path restore it in a finally; this gives a later file a
// clean baseline even if a crash leaked an inactive row.
export async function reactivateEmailTemplates(): Promise<void> {
  await query(`UPDATE notification_templates SET is_active = true WHERE is_active = false`);
}

// Base URL for the Rust test binary (PORT-H.1). RUST_TEST_PORT matches
// docker-compose ffs-rust-test service (default 8788, mirrors .env.test).
const BASE = `http://127.0.0.1:${Deno.env.get("RUST_TEST_PORT") ?? "8788"}`;

// Thin wrapper around app.request() that JSON-encodes a body if given as a
// plain object. Returns the raw Response so callers can assert on both
// status and body.
//
// Auto-attaches a fresh idempotency token for authenticated mutating
// requests (X-Session-Token present, method is POST/PUT/PATCH/DELETE),
// UNLESS the caller already set X-Idempotency-Token explicitly — that's the
// escape hatch for the dedicated idempotency tests (missing/invalid/reused
// token) in requests.test.tsx / auth.test.tsx. This keeps every OTHER
// existing test's "authenticate, then call a mutating route" pattern working
// unchanged now that idempotency-enforcement middleware is live; see
// addendum-008-idempotency-tokens.md.
export async function req(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers || {}) };
  const method = (init.method || "GET").toUpperCase();
  if (["/auth/login", "/auth/accept-invite", "/auth/entra/exchange"].includes(path)) {
    headers["X-Session-Transport"] ??= "bearer";
  }

  if (MUTATING_METHODS.has(method) && !("X-Idempotency-Token" in headers)) {
    const sessionToken = headers["X-Session-Token"];
    if (sessionToken) {
      const session = await getSessionUser(sessionToken);
      if (session) {
        headers["X-Idempotency-Token"] = await createIdempotencyToken(session.userId);
      }
    }
  }

  const body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
}

// Multipart companion for one-to-many evidence upload tests. Do not set
// Content-Type: Request authors the boundary. The helper still mints the same
// single-use idempotency token as req().
export async function reqFormData(path: string, sessionToken: string, body: FormData, method = "POST"): Promise<Response> {
  const session = await getSessionUser(sessionToken);
  const headers: Record<string, string> = { "X-Session-Token": sessionToken };
  if (session) headers["X-Idempotency-Token"] = await createIdempotencyToken(session.userId);
  return fetch(`${BASE}${path}`, { method, headers, body, redirect: "manual" });
}

export function authHeaders(session: string): Record<string, string> {
  return { "X-Session-Token": session };
}

// Named wrapper (rather than re-exporting createIdempotencyToken directly)
// so tests reach for a fixture-builder-shaped name consistent with the rest
// of this file, per addendum-008-idempotency-tokens.md.
export async function mintIdempotencyToken(userId: string): Promise<string> {
  return createIdempotencyToken(userId);
}

// ── Fixture builders ────────────────────────────────────────────────────
// These write directly via db.tsx rather than through HTTP, so tests that
// exercise (say) the request-submission flow don't also have to re-drive
// the entire cluster/team/system provisioning flow through the API every
// time. The provisioning flow itself is covered by its own dedicated
// positive-path tests (admin_clusters/admin_teams/admin_systems .test.tsx).

let seq = 0;
function uniq(label: string): string {
  seq += 1;
  return `${label}-${Date.now()}-${seq}`;
}

// Short codes are VARCHAR(10) and must be unique — the counter has to survive
// truncation, so put it first, not last (uniq()'s suffix gets cut off by any
// slice(0, 10) applied afterward).
export function uniqueShortCode(): string {
  seq += 1;
  return `S${seq}`.toUpperCase();
}

// Creates an active user directly (skips the signup/approve HTTP dance).
// affiliation defaults derived from role for convenience.
//
// Since 2FA is now part of the system (addendum-046), every fixture user is
// seeded ALREADY ENROLLED with a known TOTP secret — so loginAs can complete
// the real /auth/2fa/verify step and hand back a fully-verified session that
// passes the gate. The one exception is `enroll2fa: true`, which leaves the
// user UN-enrolled (no totp_secret) — used only by the dedicated 2FA tests
// that exercise the first-login enrollment flow itself.
export async function createActiveUser(opts: {
  // Optional: when omitted, a realistic affiliation-appropriate name is
  // seeded (Singaporean names for agency, Indian/Filipino names for vendor).
  fullName?: string;
  email: string;
  password: string;
  affiliation: Affiliation;
  approvedBy?: string | null;
  enroll2fa?: boolean; // default true — set false to seed an un-enrolled user
}): Promise<User> {
  const password_salt = generateSalt();
  const password_hash = await hashPassword(opts.password, password_salt);
  const enrolled = opts.enroll2fa !== false;
  const totp_secret = enrolled ? new OTPAuth.Secret({ size: 20 }).base32 : null;
  const user: User = {
    id: generateId(),
    fullName: opts.fullName ?? nameForAffiliation(opts.affiliation),
    email: opts.email,
    passwordHash: password_hash,
    passwordSalt: password_salt,
    affiliation: opts.affiliation,
    status: "active",
    approvedBy: opts.approvedBy ?? null,
    approvedAt: now(),
    tombstonedBy: null,
    tombstonedAt: null,
    untombstonedBy: null,
    untombstonedAt: null,
    lastLoginAt: null,
    forcePasswordRotation: false,
    totpSecret: totp_secret,
    totpEnrolledAt: enrolled ? now() : null,
    createdAt: now(),
    updatedAt: now(),
  };
  await users.create(user);
  return user;
}

export async function createAdmin(password = "AdminPass!2026"): Promise<User> {
  const admin = await createActiveUser({
    fullName: "Test Admin",
    email: `admin-${uniq("t")}@test.local`,
    password,
    affiliation: "agency",
  });
  // Admin status is a capability grant, not an affiliation — grant full_admin
  // so the user has all admin capabilities (mirrors bootstrap).
  await grantAdminRole(admin.id, "full_admin", admin.id, "Test setup: auto-grant full_admin");
  return admin;
}

// Logs in via the real HTTP endpoint (this is itself the thing auth.test.tsx
// verifies in more depth), then — since a freshly-created session starts
// 2FA-UNVERIFIED and the gate rejects unverified sessions on operational
// routes — completes the REAL /auth/2fa/verify step using the user's seeded
// TOTP secret, returning a fully-verified session that passes the gate. No
// mocks: the code is computed live from the same secret the app validates
// against (addendum-046).
//
// The secret is read straight from the DB (createActiveUser seeded it there),
// so loginAs needs only the email/password the caller already has. A user
// with no totp_secret (the enroll2fa:false fixtures) skips the verify step —
// those sessions stay unverified on purpose, for the gate-rejection tests.
export async function loginAs(email: string, password: string): Promise<{ session: string; user: any } | { error: string; status: number }> {
  const res = await req("/auth/login", { method: "POST", body: { email, password } });
  const data = await res.json();
  if (!res.ok) return { error: data.error, status: res.status };

  if (data.needs2faVerification) {
    const rows = await query<{ totp_secret: string | null }>(
      `SELECT totp_secret FROM users WHERE email = $1 LIMIT 1`, [email],
    );
    const secret = rows[0]?.totp_secret;
    if (secret) {
      const verifyRes = await req("/auth/2fa/verify", {
        method: "POST",
        headers: { "X-Session-Token": data.session },
        body: { code: currentTotp(secret) },
      });
      if (!verifyRes.ok) {
        const vd = await verifyRes.json().catch(() => ({}));
        return { error: vd.error ?? "2FA verify failed in loginAs", status: verifyRes.status };
      }
    }
  }

  return data;
}

// addendum-206 (D2, migration 084): clusters.organization_id is NOT NULL —
// no NULL-org objects. Callers that care about WHICH org pass organizationId
// explicitly; everyone else falls back to one shared fixture org per DB
// (find-or-create), which keeps pre-206 fixtures one-line edits. Suites that
// assert org-scoped hiding keep working: the fallback org is an org no
// scoped grant ever reaches unless the test anchors into it explicitly.
const FALLBACK_ORG_NAME = "Fixture Fallback Org";
const FALLBACK_ORG_CODE = "FFA";

export async function fixtureFallbackOrgId(createdBy: string): Promise<string> {
  const existing = await findOrganizationByName(FALLBACK_ORG_NAME);
  if (existing) return existing.id;
  try {
    const org = await createOrganization({ name: FALLBACK_ORG_NAME, shortCode: FALLBACK_ORG_CODE, createdBy });
    return org.id;
  } catch {
    // Another worker won the find-or-create race — re-find.
    const again = await findOrganizationByName(FALLBACK_ORG_NAME);
    if (!again) throw new Error("fixture fallback org creation failed");
    return again.id;
  }
}

export async function createCluster(type: ClusterType, createdBy: string, name?: string, organizationId?: string): Promise<Cluster> {
  const cluster: Cluster = {
    id: generateId(),
    name: name ?? uniq(`${type}-cluster`),
    type,
    description: null,
    organizationId: organizationId ?? await fixtureFallbackOrgId(createdBy),
    expiresAfter: null,
    createdBy: createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await clusters.create(cluster);
  return cluster;
}

// addendum-206 (D5): every fixture system carries an explicit owner org edge
// — owner := the agency cluster's org, i.e. exactly the org orgOfSystem used
// to derive through cluster.organization_id pre-206.
export async function seedOwnerOrgEdge(system: System, agencyCluster: Cluster, createdBy: string): Promise<void> {
  await systemOrganizations.addEdge({
    systemId: system.id,
    organizationId: agencyCluster.organizationId,
    role: "owner",
    createdBy,
  });
}

// Create a fixture system AND its owner org edge as ONE transaction.
//
// Required by the H-5 guard (migration 092, addendum-211): the DB enforces
// ">=1 live owner org edge per live system" with a DEFERRED constraint
// trigger, so a system row and its owner edge must land in the SAME
// transaction. Production already satisfies this — the idempotency middleware
// wraps every authenticated non-GET request in one transaction — but fixtures
// call the entity layer directly, where each statement would otherwise
// autocommit and trip the guard at the first COMMIT.
// Same contract as createSystemWithOwnerOrgEdge, for callers that hold only
// the agency cluster's ID (not the Cluster object). Resolves the cluster's org
// and creates system + owner edge in ONE transaction.
// Returning variant: some suites assert on the created row.
export async function createSystemReturningWithOwnerEdge(
  system: System,
  agencyClusterId: string,
  createdBy: string,
): Promise<System> {
  const rows = await query<{ organization_id: string }>(
    `SELECT organization_id FROM clusters WHERE id = $1`,
    [agencyClusterId],
  );
  const organizationId = rows[0]!.organization_id;
  return await runInTransaction(async () => {
    const created = await systems.create(system);
    await systemOrganizations.addEdge({
      systemId: system.id,
      organizationId,
      role: "owner",
      createdBy,
    });
    return created;
  });
}

export async function createSystemWithOwnerOrgEdgeById(
  system: System,
  agencyClusterId: string,
  createdBy: string,
): Promise<void> {
  const rows = await query<{ organization_id: string }>(
    `SELECT organization_id FROM clusters WHERE id = $1`,
    [agencyClusterId],
  );
  const organizationId = rows[0]!.organization_id;
  await runInTransaction(async () => {
    await systems.create(system);
    await systemOrganizations.addEdge({
      systemId: system.id,
      organizationId,
      role: "owner",
      createdBy,
    });
  });
}

export async function createSystemWithOwnerOrgEdge(
  system: System,
  agencyCluster: Cluster,
  createdBy: string,
): Promise<void> {
  await runInTransaction(async () => {
    await systems.create(system);
    await seedOwnerOrgEdge(system, agencyCluster, createdBy);
  });
}

// Re-point a fixture system's owner edge to a different org (addendum-206 —
// the pre-206 trick of UPDATE-ing the cluster's organization_id no longer
// moves a system's org; the owner edge in system_organizations is the truth).
export async function repointOwnerOrgEdge(systemId: string, organizationId: string, createdBy: string): Promise<void> {
  // Both statements must share ONE transaction. Expiring the old edge leaves
  // the system momentarily without a live owner edge, which is exactly what
  // the deferred system_organizations_live_owner_required constraint trigger
  // (migration 092) forbids. The trigger is DEFERRABLE INITIALLY DEFERRED so
  // that a re-point is legal *within* a transaction; run autocommit, as this
  // helper previously did, and the UPDATE commits the ownerless state on its
  // own and the guard correctly rejects it. This mirrors how the production
  // path in routes/admin/systems/org-edges.tsx re-points an owner edge.
  await runInTransaction(async () => {
    await query(
      `UPDATE system_organizations SET expires_after = now()
       WHERE system_id = $1 AND role = 'owner' AND expires_after IS NULL`,
      [systemId],
    );
    await systemOrganizations.addEdge({ systemId, organizationId, role: "owner", createdBy });
  });
}

export async function createTeam(cluster: Cluster, level: number, createdBy: string, name?: string): Promise<Team> {
  const team: Team = {
    id: generateId(),
    clusterId: cluster.id,
    name: name ?? uniq(`${cluster.type}-l${level}-team`),
    level,
    description: null,
    expiresAfter: null,
    createdBy: createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await teams.create(team);
  return team;
}

export async function addMember(team: Team, user: User, addedBy: string, teamRole: "member" | "team_admin" = "member") {
  const membership = {
    id: generateId(),
    userId: user.id,
    teamId: team.id,
    teamRole: teamRole,
    addedBy: addedBy,
    expiresAfter: null,
    createdAt: now(),
  };
  await teamMemberships.create(membership);
  return membership;
}

// addendum-206 §3.3: vendor service lives at USER level via org memberships.
// Fixture twin of the real on-ramp (invite → org membership → team roster):
// adds the user to the team AND grants a live membership of the team's
// anchored cluster org (idempotent on the membership), so vendor runtime
// flows pass the D1 §4.2 service gate exactly the way seeded/demo users do.
// Tests pinning the gate's NEGATIVE arm deliberately keep plain addMember.
export async function addServingMember(team: Team, user: User, addedBy: string, teamRole: "member" | "team_admin" = "member") {
  const membership = await addMember(team, user, addedBy, teamRole);
  const cluster = await clusters.get(team.clusterId);
  if (!cluster?.organizationId) return membership;
  const existing = await query(
    `SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 AND expires_after IS NULL`,
    [cluster.organizationId, user.id],
  );
  if (existing.length === 0) {
    await addOrgMembership({ organizationId: cluster.organizationId, userId: user.id, addedBy });
  }
  return membership;
}

export async function mapTeamToSystem(team: Team, system: System, createdBy: string) {
  await teamSystemMappings.create({
    id: generateId(),
    teamId: team.id,
    systemId: system.id,
    expiresAfter: null,
    createdBy: createdBy,
    createdAt: now(),
  });
}

// Creates an active (non-invalidated) manual asset for a system — the
// fixture request submission now requires per addendum-039-asset-gated-
// submission.md, since credential_items reference a real assets row via
// asset_id instead of carrying free-text hostname/userid.
export async function createAsset(
  systemId: string,
  overrides: { hostname?: string; credentialName?: string; credentialType?: CredentialType; managementMode?: 'api_managed' | 'manual'; expiresAfter?: string | null } = {},
) {
  const asset = {
    id: generateId(),
    systemId,
    systemManaged: false,
    credentialType: overrides.credentialType ?? ('password' as CredentialType),
    // Fork key override (assessment 2026-08-05 §12 / addendum-116): 'manual'
    // assets feed the physical-custody suites.
    managementMode: overrides.managementMode ?? ('api_managed' as const),
    hostname: overrides.hostname ?? uniq("host"),
    credentialName: overrides.credentialName ?? uniq("svc"),
    tags: [],
    createdAt: now(),
    updatedAt: now(),
    expiresAfter: overrides.expiresAfter ?? null,
  };
  await assets.create(asset);
  return asset;
}

// Creates a system with an already-valid workflow (submitter vendor L1 ->
// vendor L2 -> agency L1 — see
// addendum-027-submitter-as-workflow-step-one.md), its vendor/agency
// clusters+teams, team-system mappings, and primary owner — a fully wired,
// submittable system in one call. Returns everything the caller might need
// to act as a submitter/approver/owner against it.
export async function createWiredSystem(createdBy: string, ownerUser: User): Promise<{
  system: System; vendorCluster: Cluster; agencyCluster: Cluster;
  vendorL1: Team; vendorL2: Team; agencyL1: Team; primaryOwner: SystemOwner;
}> {
  const vendorCluster = await createCluster("vendor", createdBy);
  const agencyCluster = await createCluster("agency", createdBy);
  const vendorL1 = await createTeam(vendorCluster, 1, createdBy);
  const vendorL2 = await createTeam(vendorCluster, 2, createdBy);
  const agencyL1 = await createTeam(agencyCluster, 1, createdBy);

  const system: System = {
    id: generateId(),
    shortCode: uniqueShortCode(),
    name: uniq("Test System"),
    description: null,
    vendorClusterIds: [vendorCluster.id],
    agencyClusterId: agencyCluster.id,
    workflowDefinition: [
      { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
      { ordinal: 2, clusterId: vendorCluster.id, level: 2, stepKind: "hierarchical", notes: null },
      { ordinal: 3, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
    ],
    awsRoleArnNote: null,
    expiresAfter: null,
    createdBy: createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await createSystemWithOwnerOrgEdge(system, agencyCluster, createdBy);

  await mapTeamToSystem(vendorL1, system, createdBy);
  await mapTeamToSystem(vendorL2, system, createdBy);
  await mapTeamToSystem(agencyL1, system, createdBy);

  const primaryOwner: SystemOwner = {
    id: generateId(), systemId: system.id, userId: ownerUser.id, kind: "primary", expiresAfter: null, createdBy: createdBy, createdAt: now(),
  };
  await systemOwners.create(primaryOwner);

  return { system, vendorCluster, agencyCluster, vendorL1, vendorL2, agencyL1, primaryOwner };
}

// Topology variety (Appendix K1/K5): submitter (vendor L1) + a single
// agency-only approval step, no vendor approval tier at all. Exercises the
// "one approval step beyond the submitter" and "current_step_ordinal goes
// 2 -> 0 in a single hop" paths that createWiredSystem's fixed 3-entry shape
// can't reach. See addendum-027-submitter-as-workflow-step-one.md.
export async function createSingleStepAgencySystem(createdBy: string, ownerUser: User): Promise<{
  system: System; vendorCluster: Cluster; agencyCluster: Cluster; vendorL1: Team; agencyL1: Team;
}> {
  const vendorCluster = await createCluster("vendor", createdBy);
  const agencyCluster = await createCluster("agency", createdBy);
  const vendorL1 = await createTeam(vendorCluster, 1, createdBy);
  const agencyL1 = await createTeam(agencyCluster, 1, createdBy);

  const system: System = {
    id: generateId(),
    shortCode: uniqueShortCode(),
    name: uniq("Single Step System"),
    description: null,
    vendorClusterIds: [vendorCluster.id],
    agencyClusterId: agencyCluster.id,
    workflowDefinition: [
      { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
      { ordinal: 2, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
    ],
    awsRoleArnNote: null,
    expiresAfter: null,
    createdBy: createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await createSystemWithOwnerOrgEdge(system, agencyCluster, createdBy);

  await mapTeamToSystem(vendorL1, system, createdBy);
  await mapTeamToSystem(agencyL1, system, createdBy);

  await systemOwners.create({
    id: generateId(), systemId: system.id, userId: ownerUser.id, kind: "primary", expiresAfter: null, createdBy: createdBy, createdAt: now(),
  });

  return { system, vendorCluster, agencyCluster, vendorL1, agencyL1 };
}

// Topology variety (Appendix K3): submitter (vendor L1) + a 4-step approval
// chain spanning both vendor approval tiers and both agency approval tiers
// (vendor L2 -> vendor L3 -> agency L1 -> agency L2) before the owner
// terminal — exercises multi-hop current_step_ordinal advancement and a
// vendor cluster with 3 mapped team levels (L1 submit, L2 + L3 approve),
// neither of which createWiredSystem's fixed shape reaches. See
// addendum-027-submitter-as-workflow-step-one.md.
export async function createFourStepSystem(createdBy: string, ownerUser: User): Promise<{
  system: System; vendorCluster: Cluster; agencyCluster: Cluster;
  vendorL1: Team; vendorL2: Team; vendorL3: Team; agencyL1: Team; agencyL2: Team;
}> {
  const vendorCluster = await createCluster("vendor", createdBy);
  const agencyCluster = await createCluster("agency", createdBy);
  const vendorL1 = await createTeam(vendorCluster, 1, createdBy);
  const vendorL2 = await createTeam(vendorCluster, 2, createdBy);
  const vendorL3 = await createTeam(vendorCluster, 3, createdBy);
  const agencyL1 = await createTeam(agencyCluster, 1, createdBy);
  const agencyL2 = await createTeam(agencyCluster, 2, createdBy);

  const system: System = {
    id: generateId(),
    shortCode: uniqueShortCode(),
    name: uniq("Four Step System"),
    description: null,
    vendorClusterIds: [vendorCluster.id],
    agencyClusterId: agencyCluster.id,
    workflowDefinition: [
      { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
      { ordinal: 2, clusterId: vendorCluster.id, level: 2, stepKind: "hierarchical", notes: null },
      { ordinal: 3, clusterId: vendorCluster.id, level: 3, stepKind: "hierarchical", notes: null },
      { ordinal: 4, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
      { ordinal: 5, clusterId: agencyCluster.id, level: 2, stepKind: "hierarchical", notes: null },
    ],
    awsRoleArnNote: null,
    expiresAfter: null,
    createdBy: createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await createSystemWithOwnerOrgEdge(system, agencyCluster, createdBy);

  await mapTeamToSystem(vendorL1, system, createdBy);
  await mapTeamToSystem(vendorL2, system, createdBy);
  await mapTeamToSystem(vendorL3, system, createdBy);
  await mapTeamToSystem(agencyL1, system, createdBy);
  await mapTeamToSystem(agencyL2, system, createdBy);

  await systemOwners.create({
    id: generateId(), systemId: system.id, userId: ownerUser.id, kind: "primary", expiresAfter: null, createdBy: createdBy, createdAt: now(),
  });

  return { system, vendorCluster, agencyCluster, vendorL1, vendorL2, vendorL3, agencyL1, agencyL2 };
}

export async function createWiredSystemWithAgencyL2(createdBy: string, ownerUser: User): Promise<{
  system: System; vendorCluster: Cluster; agencyCluster: Cluster;
  vendorL1: Team; vendorL2: Team; agencyL1: Team; agencyL2: Team;
}> {
  const vendorCluster = await createCluster("vendor", createdBy);
  const agencyCluster = await createCluster("agency", createdBy);
  const vendorL1 = await createTeam(vendorCluster, 1, createdBy);
  const vendorL2 = await createTeam(vendorCluster, 2, createdBy);
  const agencyL1 = await createTeam(agencyCluster, 1, createdBy);
  const agencyL2 = await createTeam(agencyCluster, 2, createdBy);

  const system: System = {
    id: generateId(),
    shortCode: uniqueShortCode(),
    name: uniq("Wired Dual Agency System"),
    description: null,
    vendorClusterIds: [vendorCluster.id],
    agencyClusterId: agencyCluster.id,
    workflowDefinition: [
      { ordinal: 1, clusterId: vendorCluster.id, level: 1, stepKind: "hierarchical", notes: null },
      { ordinal: 2, clusterId: vendorCluster.id, level: 2, stepKind: "hierarchical", notes: null },
      { ordinal: 3, clusterId: agencyCluster.id, level: 1, stepKind: "hierarchical", notes: null },
      { ordinal: 4, clusterId: agencyCluster.id, level: 2, stepKind: "hierarchical", notes: null },
    ],
    awsRoleArnNote: null,
    expiresAfter: null,
    createdBy: createdBy,
    createdAt: now(),
    updatedAt: now(),
  };
  await createSystemWithOwnerOrgEdge(system, agencyCluster, createdBy);

  await mapTeamToSystem(vendorL1, system, createdBy);
  await mapTeamToSystem(vendorL2, system, createdBy);
  await mapTeamToSystem(agencyL1, system, createdBy);
  await mapTeamToSystem(agencyL2, system, createdBy);

  await systemOwners.create({
    id: generateId(), systemId: system.id, userId: ownerUser.id, kind: "primary", expiresAfter: null, createdBy: createdBy, createdAt: now(),
  });

  return { system, vendorCluster, agencyCluster, vendorL1, vendorL2, agencyL1, agencyL2 };
}

export const uniqueEmail = (label = "user") => `${uniq(label)}@test.local`;
export const uniqueName = (label = "Name") => uniq(label);

// Fetches the most recent sent_notifications row for a given trigger_key, for
// tests asserting a workflow/lifecycle route wired up its
// notifyTrigger() call correctly. See addendum-044-email-notifications.md.
export async function latestSentNotification(
  triggerKey: string,
): Promise<SentNotification | null> {
  const rows = await sentNotifications.list(100);
  return rows.find((notification) => notification.triggerKey === triggerKey)
    ?? null;
}

export function sentNotificationEmailSnapshots(
  notification: Pick<SentNotification, "recipients">,
): string[] {
  return notification.recipients.flatMap((recipient) =>
    recipient.emailSnapshot ? [recipient.emailSnapshot] : []
  );
}

// ── Organisation dimension fixtures (addendum-109, test-first contract) ─────
//
// The organisations tables (organizations / organization_memberships) do NOT
// exist until the org-dimension migration lands with the addendum-110+
// implementation. These helpers therefore use RAW SQL via query() — never the
// drizzle entity layer — so this file keeps compiling and type-checking
// against the pre-organisation server. They are only CALLED from the
// org-dimension RED contract suite (org_dimension.test.tsx), which is
// EXPECTED to fail at runtime against the pre-organisation schema — that
// failure is the TDD-red signal, not a regression. Owner direction
// 2026-08-04: ONE "Default" organisation carries every fixture user, cluster,
// team (via its cluster) and system (via its agency cluster); no
// cross-organisation or global-access cases in the current regiment.

export interface OrganizationRow {
  id: string;
  name: string;
  shortCode: string;
}

// addendum-200: short_code is NOT NULL + live-unique + uppercase-alnum, so
// the helper requires it (a direct insert bypasses route normalization, so
// pass the codes pre-normalized or the live-unique index can reject `XA`/`xa`
// collisions the route would have folded). addendum-206 (D3): kind is gone —
// organisations are agencies only.
export async function createOrganization(opts: {
  name: string;
  shortCode: string;
  createdBy: string;
}): Promise<OrganizationRow> {
  const rows = await query<{ id: string }>(
    `INSERT INTO organizations (id, name, short_code, created_by, created_at, updated_at)
     VALUES ($1, $2, $3, $4, now(), now()) RETURNING id`,
    [generateId(), opts.name, opts.shortCode, opts.createdBy],
  );
  return { id: rows[0]!.id, name: opts.name, shortCode: opts.shortCode };
}

export async function findOrganizationByName(name: string): Promise<OrganizationRow | null> {
  const rows = await query<{ id: string; name: string; short_code: string }>(
    `SELECT id, name, short_code FROM organizations WHERE name = $1 AND expires_after IS NULL`,
    [name],
  );
  const r = rows[0];
  return r ? { id: r.id, name: r.name, shortCode: r.short_code } : null;
}

export async function addOrgMembership(opts: { organizationId: string; userId: string; addedBy: string }): Promise<void> {
  // Idempotent, matching the product's own contract: organizationMemberships.
  // createMany uses onConflictDoNothing against organization_memberships_live_
  // uniq ((organization_id, user_id) WHERE expires_after IS NULL), and several
  // product paths now create the row for you — POST /admin/teams/:id/members
  // adds a live org membership as of addendum-207 R4 ("being rostered implies
  // belonging to the hosting org"). Callers therefore cannot know whether the
  // row already exists, and a plain INSERT raises a duplicate-key error instead
  // of expressing "ensure this user is in this org". The arbiter must restate
  // the partial index's predicate or Postgres will not match it.
  await query(
    `INSERT INTO organization_memberships (id, organization_id, user_id, added_by, created_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (organization_id, user_id) WHERE expires_after IS NULL DO NOTHING`,
    [generateId(), opts.organizationId, opts.userId, opts.addedBy],
  );
}

export async function listOrgMemberIds(organizationId: string): Promise<string[]> {
  const rows = await query<{ user_id: string }>(
    `SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND expires_after IS NULL`,
    [organizationId],
  );
  return rows.map((r) => r.user_id);
}

export async function removeOrgMembership(organizationId: string, userId: string): Promise<void> {
  await query(
    `UPDATE organization_memberships SET expires_after = now()
     WHERE organization_id = $1 AND user_id = $2 AND expires_after IS NULL`,
    [organizationId, userId],
  );
}

// The approval-time default dimension (addendum-109): the single "Default"
// organisation the red contract suite hangs every fixture world off.
// Idempotent by live name so every share of it in one run resolves the row
// once.
export async function ensureDefaultOrganization(createdBy: string): Promise<OrganizationRow> {
  return (await findOrganizationByName(DEFAULT_ORG_NAME))
    ?? await createOrganization({ name: DEFAULT_ORG_NAME, shortCode: DEFAULT_ORG_SHORT_CODE, createdBy });
}
