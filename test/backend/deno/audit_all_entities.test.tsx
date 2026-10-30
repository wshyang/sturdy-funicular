// Coverage: the audit trigger fires correctly for EVERY one of the 19 audited
// entity classes (addendum-092; the per-entity child tables collapsed into the
// single generic audit_log_changes by addendum-209 R8). The earlier suites
// (audit_inheritance, audit_context) proved the trigger mechanics on `asset`
// (+ the users secret exclusion); this file parametrizes ALL 19: for each
// entity we create a real fixture row, run ONE field-changing UPDATE inside
// runWithAuditContext (the Phase-2 production path), and assert exactly one
// parent + one generic child row with the real action/actor and a delta
// containing the changed field.
//
// app_setting's `value` column is a SENSITIVE column (addendum-092): the
// change is recorded but both values are masked to [hidden] (the registry is
// synced from config/audit_sensitive_columns.yaml in setup). The suite
// asserts the masked row AND that the masked payload never contains the
// plaintext value; the semantic parent-only audit row (masked details) still
// lands via createAuditLog.
import { assertEquals, assertExists, assert } from "jsr:@std/assert";
import { createAuditLog } from "../../../server/utils.tsx";
import { query } from "../../../server/pg.tsx";
import { runWithAuditContext } from "../../../server/audit-context.tsx";
import { syncAuditSensitiveColumns } from "../../../server/audit-column-sensitivity.tsx";
import {
  teamSystemMappings, systemOwnerPAMappings, systemOwners, systemDelegates,
  breakglassRequests, requestApprovalSteps, requestCredentialItems, notificationTemplates,
  sentNotifications, linkMappings, adminRoles, userAdminRoleGrants, generateId, now,
} from "../../../server/db.tsx";
import {
  wipeDatabase, createAdmin, createActiveUser, uniqueEmail, createCluster,
  createTeam, createWiredSystem, addMember, createAsset,
} from "./helpers.tsx";

interface EntityCase {
  label: string;          // = audit_target_type value
  table: string;          // the real entity table whose UPDATE fires the trigger
  idCol: string;          // 'id' or 'key' — how the entity row is matched in SQL
  expectRow: boolean;     // true for all 19; every entity now produces a trigger row
  changedField: string | null; // field that must appear in the delta
  masked?: boolean;       // true when the changed field is a sensitive column ([hidden])
}

const CASES: EntityCase[] = [
  { label: "user", table: "users", idCol: "id", expectRow: true, changedField: "full_name" },
  { label: "cluster", table: "clusters", idCol: "id", expectRow: true, changedField: "description" },
  { label: "team", table: "teams", idCol: "id", expectRow: true, changedField: "description" },
  { label: "team_membership", table: "team_memberships", idCol: "id", expectRow: true, changedField: "expires_after" },
  { label: "system", table: "systems", idCol: "id", expectRow: true, changedField: "description" },
  { label: "team_system_mapping", table: "team_system_mappings", idCol: "id", expectRow: true, changedField: "expires_after" },
  { label: "system_owner_pa_mapping", table: "system_owner_pa_mappings", idCol: "id", expectRow: true, changedField: "expires_after" },
  { label: "system_owner", table: "system_owners", idCol: "id", expectRow: true, changedField: "expires_after" },
  { label: "system_delegate", table: "system_delegates", idCol: "id", expectRow: true, changedField: "expires_after" },
  { label: "breakglass_request", table: "breakglass_requests", idCol: "id", expectRow: true, changedField: "justification" },
  { label: "request_approval_step", table: "request_approval_steps", idCol: "id", expectRow: true, changedField: "decision_notes" },
  { label: "request_credential_item", table: "request_credential_items", idCol: "id", expectRow: true, changedField: "hostname_description" },
  { label: "asset", table: "assets", idCol: "id", expectRow: true, changedField: "expires_after" },
  { label: "email_template", table: "notification_templates", idCol: "id", expectRow: true, changedField: "is_active" },
  { label: "sent_notification", table: "sent_notifications", idCol: "id", expectRow: true, changedField: "rendered_subject" },
  { label: "app_setting", table: "app_settings", idCol: "key", expectRow: true, changedField: "value", masked: true },
  { label: "link_mapping", table: "link_mappings", idCol: "key", expectRow: true, changedField: "expires_at" },
  { label: "admin_role", table: "admin_roles", idCol: "key", expectRow: true, changedField: "description" },
  { label: "admin_role_grant", table: "user_admin_role_grants", idCol: "id", expectRow: true, changedField: "revocation_reason" },
];

Deno.test("audit all 19 entity classes: UPDATE fires the trigger with the expected delta", async (t) => {
  let adminId: string;
  let ownerId: string;
  let memberId: string;

  // ── World fixtures (one of everything the 19 FKs point at) ───────────────
  const world: Record<string, { id: string; key?: string }> = {};
  let appSettingKey = "";

  await t.step("setup — create fixture rows for every entity class", async () => {
    await wipeDatabase();
    await syncAuditSensitiveColumns(); // seed the sensitive-column registry from the shipped YAML
    const admin = await createAdmin("AuditAllAdmin!2026");
    adminId = admin.id;
    const owner = await createActiveUser({ fullName: "AuditAllOwner", email: uniqueEmail("auditallowner"), password: "AuditAllOwner!2026", affiliation: "agency" });
    ownerId = owner.id;
    const member = await createActiveUser({ fullName: "AuditAllMember", email: uniqueEmail("auditallmember"), password: "AuditAllMember!2026", affiliation: "vendor" });
    memberId = member.id;

    world.user = { id: member.id };
    const cluster = await createCluster("agency", adminId, "AuditAllAgencyCluster");
    world.cluster = { id: cluster.id };
    const team = await createTeam(cluster, 1, adminId, "AuditAllTeam");
    world.team = { id: team.id };
    const membership = await addMember(team, member, adminId);
    world.team_membership = { id: membership.id };

    const { system, vendorL1 } = await createWiredSystem(adminId, owner);
    world.system = { id: system.id };
    // createWiredSystem already maps vendorL1/vendorL2/agencyL1 to `system`, so a
    // fresh (team, system) pair is needed here to avoid team_system_mappings_uniq.
    // `team` (created above, unmapped) supplies that unique pair.
    world.team_system_mapping = { id: (await teamSystemMappings.create({
      id: generateId(), teamId: team.id, systemId: system.id, createdBy: adminId, createdAt: now(), expiresAfter: null,
    })).id };
    const primaryOwner = (await systemOwners.findBySystemAndKind(system.id, "primary"))!;
    world.system_owner = { id: primaryOwner.id };
    const paCluster = await createCluster("pa", adminId, "AuditAllPaCluster");
    const paTeam = await createTeam(paCluster, 1, adminId, "AuditAllPaTeam");
    world.system_owner_pa_mapping = { id: (await systemOwnerPAMappings.create({
      id: generateId(), systemOwnerId: primaryOwner.id, paTeamId: paTeam.id, createdBy: adminId, createdAt: now(), expiresAfter: null,
    })).id };
    world.system_delegate = { id: (await systemDelegates.create({
      id: generateId(), systemId: system.id, ownerId: primaryOwner.userId, delegateUserId: member.id, createdAt: now(), expiresAfter: null,
    })).id };

    const request = await breakglassRequests.create({
      id: generateId(), requestNumber: "BG-AUDITALL-001", systemId: system.id,
      submittedBy: member.id, vendorClusterId: vendorL1.clusterId,
      justification: "audit-all request", srNumber: "SR-AUDITALL",
      activityStartAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      activityEndAt: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      status: "submitted", currentStepOrdinal: 1,
      ownerDecisionBy: null, ownerDecisionNotes: null, ownerDecisionAt: null,
      credentialIssuedAt: null, credentialIssuedBy: null,
      closingNotes: null, closedBy: null, closedAt: null,
      returnCount: 0, createdAt: now(), updatedAt: now(),
    });
    world.breakglass_request = { id: request.id };
    world.request_approval_step = { id: (await requestApprovalSteps.create({
      id: generateId(), requestId: request.id, stepOrdinal: 1,
      requiredClusterId: system.agencyClusterId, requiredTeamType: "agency",
      requiredLevel: 1, stepKind: "hierarchical", notes: null,
      stepStatus: "pending", assignedReviewerId: null, decisionNotes: null,
      decidedAt: null, decidedBy: null, decidedViaOverride: false, createdAt: now(),
    })).id };
    world.request_credential_item = { id: (await requestCredentialItems.create({
      id: generateId(), requestId: request.id, credentialType: "password",
      userid: "svc", hostname: "h1", assetId: null, hostnameDescription: "orig",
      createdAt: now(), updatedAt: now(),
    })).id };

    world.asset = { id: (await createAsset(system.id)).id };

    const templates = await notificationTemplates.list();
    assert(templates.length > 0, "seeded email templates must exist");
    world.email_template = { id: templates[0].id };

    world.sent_notification = { id: (await sentNotifications.create({
      id: generateId(),
      triggerKey: "request.submitted",
      renderedSubject: "audit-all",
      renderedBodyHtml: "<p>audit-all</p>",
      renderedBodyText: "audit-all",
      relatedTargetType: null,
      relatedTargetId: null,
      createdAt: now(),
    })).id };

    const settings = await query<{ key: string }>(`SELECT key FROM app_settings ORDER BY key LIMIT 1`);
    appSettingKey = settings[0].key;
    world.app_setting = { key: appSettingKey };
    // app_settings is seeded config and is NOT cleared by wipeDatabase, so on a
    // rerun its value may already equal the update target ('audit-all-value'),
    // making the UPDATE a no-op that fires no trigger. Reset to a distinct
    // baseline so the per-entity UPDATE below is always a real change.
    await query(`UPDATE app_settings SET value = 'audit-all-baseline' WHERE key = $1`, [appSettingKey]);

    // linkMappings.create returns void, so capture the key we generate rather
    // than reading it off a (non-existent) return value.
    const linkMappingKey = generateId().replace(/-/g, "");
    await linkMappings.create({
      key: linkMappingKey, targetType: "breakglass_request", targetId: request.id,
      createdBy: adminId, createdAt: now(), intendedUserId: memberId, expiresAt: null, usedAt: null, usedCount: 0,
    });
    world.link_mapping = { key: linkMappingKey };

    // admin_roles is seeded config and deliberately NOT wiped by wipeDatabase,
    // so a fixed key would collide across reruns. Use a unique key per run.
    const auditRoleKey = `audit_all_role_${generateId().replace(/-/g, "").slice(0, 12)}`;
    world.admin_role = { key: (await adminRoles.create({
      id: generateId(), key: auditRoleKey, name: "Audit All Role", description: "orig",
      isSystemRole: false, capabilities: [], createdAt: now(), updatedAt: now(),
    })).key };
    world.admin_role_grant = { id: (await userAdminRoleGrants.create({
      id: generateId(), userId: memberId, roleKey: auditRoleKey, grantedBy: adminId,
      grantedAt: now(), revokedAt: null, revokedBy: null, revocationReason: null,
      organizationId: null, // global grant (addendum-137 phase 2 column)
    })).id };
  });

  // The UPDATE to run per entity — each changes exactly ONE non-excluded column.
  function updateSql(label: string, idCol: string): string {
    switch (label) {
      case "user":                    return `UPDATE users SET full_name = 'AuditAll Renamed' WHERE id = $1`;
      case "cluster":                 return `UPDATE clusters SET description = 'audit-all-desc' WHERE id = $1`;
      case "team":                    return `UPDATE teams SET description = 'audit-all-desc' WHERE id = $1`;
      case "team_membership":         return `UPDATE team_memberships SET expires_after = now() WHERE id = $1`;
      case "system":                  return `UPDATE systems SET description = 'audit-all-desc' WHERE id = $1`;
      case "team_system_mapping":     return `UPDATE team_system_mappings SET expires_after = now() WHERE id = $1`;
      case "system_owner_pa_mapping": return `UPDATE system_owner_pa_mappings SET expires_after = now() WHERE id = $1`;
      case "system_owner":            return `UPDATE system_owners SET expires_after = now() WHERE id = $1`;
      case "system_delegate":         return `UPDATE system_delegates SET expires_after = now() WHERE id = $1`;
      case "breakglass_request":      return `UPDATE breakglass_requests SET justification = 'audit-all justification' WHERE id = $1`;
      case "request_approval_step":   return `UPDATE request_approval_steps SET decision_notes = 'audit-all notes' WHERE id = $1`;
      case "request_credential_item": return `UPDATE request_credential_items SET hostname_description = 'audit-all' WHERE id = $1`;
      case "asset":                   return `UPDATE assets SET expires_after = now() WHERE id = $1`;
      case "email_template":          return `UPDATE notification_templates SET is_active = NOT is_active WHERE id = $1`;
      case "sent_notification":              return `UPDATE sent_notifications SET rendered_subject = 'audit-all-updated' WHERE id = $1`;
      case "app_setting":             return `UPDATE app_settings SET value = 'audit-all-value' WHERE key = $1`;
      case "link_mapping":            return `UPDATE link_mappings SET expires_at = now() WHERE key = $1`;
      case "admin_role":              return `UPDATE admin_roles SET description = 'audit-all role desc' WHERE key = $1`;
      case "admin_role_grant":        return `UPDATE user_admin_role_grants SET revocation_reason = 'audit-all' WHERE id = $1`;
      default: throw new Error("no sql for " + label);
    }
  }

  for (const c of CASES) {
    await t.step(`trigger fires for ${c.label}`, async () => {
      const fixture = world[c.label];
      const entityId = (c.idCol === "key" ? fixture.key : fixture.id)!;
      const action = `test.all_entities_${c.label}`;

      // Capture the column's actual before-value via to_jsonb (the same shape
      // the trigger's OLD row carries) so `previous` can be asserted exactly.
      const beforeRows = await query<{ v: unknown }>(
        `SELECT to_jsonb(${c.changedField}) AS v FROM ${c.table} WHERE ${c.idCol} = $1`,
        [entityId],
      );
      assert(beforeRows.length === 1, `${c.label}: fixture row must exist`);
      const beforeVal = beforeRows[0].v;

      await runWithAuditContext(action, adminId, { marker: c.label }, () =>
        query(updateSql(c.label, c.idCol), [entityId]),
      );

      const rows = await query<{ action: string; actor: string; changes: Record<string, { previous: unknown; after: unknown }> }>(
        `SELECT b.action, b.actor_id::text AS actor, ch.changes
           FROM audit_log_changes ch JOIN audit_log b ON b.id = ch.id
          WHERE b.target_type = $1 AND b.target_id = $2 AND b.action = $3`,
        [c.label, entityId, action],
      );

      assertEquals(rows.length, 1, `${c.label}: exactly one trigger row for the GUC action`);
      assertEquals(rows[0].actor, adminId, `${c.label}: actor from the GUC`);
      assert(c.changedField, "changedField expected");
      const mutation = rows[0].changes[c.changedField!];
      assert(mutation, `${c.label}: delta must contain ${c.changedField}`);
      assert("previous" in mutation && "after" in mutation, `${c.label}: delta entry must carry previous/after`);
      if (c.masked) {
        // Sensitive column (e.g. app_settings.value): recorded as a change but
        // both values masked — the real value must never appear.
        assertEquals(mutation.previous, "[hidden]", `${c.label}: masked previous`);
        assertEquals(mutation.after, "[hidden]", `${c.label}: masked after`);
        assertEquals(mutation.masked, true, `${c.label}: masked flag`);
        assert(!JSON.stringify(rows[0].changes).includes("audit-all-value"),
          `${c.label}: masked delta must not contain the plaintext value`);
      } else {
        assertEquals(mutation.previous, beforeVal, `${c.label}: previous must equal the actual pre-update column value`);
      }
      // The trigger also wrote the parent's action + details (marker).
      assertEquals(rows[0].action, action);
    });
  }

  await t.step("app_setting: the semantic parent-only audit row still lands via createAuditLog", async () => {
    const key = world.app_setting!.key!;
    await createAuditLog(adminId, "test.app_setting_audited", "app_setting", key, {
      oldValue: "[hidden]", newValue: "[hidden]",
    });
    const parent = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log WHERE action = 'test.app_setting_audited' AND target_type = 'app_setting' AND target_id = $1`,
      [key],
    );
    assertEquals(parent[0].n, 1, "createAuditLog still writes the parent-only app_setting row");
    // createAuditLog writes ONLY the parent (semantic) row — never a child. The
    // trigger-produced masked child rows (from the loop above) share other
    // parent ids, so scope the child check to THIS createAuditLog's parent via
    // the id join rather than the whole key (which does carry loop child rows).
    const child = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log_changes ch
         JOIN audit_log b ON b.id = ch.id
        WHERE b.action = 'test.app_setting_audited' AND b.target_id = $1`,
      [key],
    );
    assertEquals(child[0].n, 0, "createAuditLog's semantic row has no child");
  });

  await t.step("the runWithAuditContext call for app_setting also writes no row with a different value", async () => {
    // Cross-check with a NON-secret app_setting column excluded too: any
    // app_settings UPDATE yields an empty diff (value + key + updated_* all
    // excluded), so the semantic createAuditLog row is the ONLY audit.
    const before = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log_changes ch
         JOIN audit_log b ON b.id = ch.id WHERE b.target_type = 'app_setting' AND b.target_id = $1`,
      [world.app_setting!.key!],
    );
    await runWithAuditContext("test.app_setting_again", adminId, null, () =>
      query(`UPDATE app_settings SET updated_by = $1 WHERE key = $2`, [ownerId, world.app_setting!.key!]),
    );
    const after = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_log_changes ch
         JOIN audit_log b ON b.id = ch.id WHERE b.target_type = 'app_setting' AND b.target_id = $1`,
      [world.app_setting!.key!],
    );
    assertEquals(after[0].n, before[0].n, "no app_settings UPDATE ever produces a trigger row");
  });
});
