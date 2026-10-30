//! Admin user lifecycle routes (legacy server/routes/admin/users.tsx).
//! Importers/callers: main.rs registers pending/reject/tombstone/untombstone/affiliation.
//! Affected API: GET /admin/users/pending, POST /admin/users/:id/{reject,tombstone,untombstone},
//!   PUT /admin/users/:id/affiliation.
//! Data schemas: users, team_memberships, system_owners, breakglass_requests, audit_log,
//!   sent_notifications, user_admin_role_grants.
//! User instruction: continue the staged Rust port (Stage 2D).

use std::sync::Arc;

use axum::{extract::{Extension, Path, State}, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    audit::write_audit_log,
    auth::session::Session,
    config::Config,
    db::admin_roles::{
        get_users_with_role, list_admin_role_grants, resolve_admin_capability_scope,
        set_user_roles, user_has_any_admin_role, DesiredRoleGrant, ScopeKind,
    },
    errors::{AppError, RouteResult},
    notifications::notify_trigger,
};

type RouteState = State<(Config, DatabaseConnection)>;
const SYSTEM_USER_ID: Uuid = Uuid::from_u128(0x00000000_0000_7000_8000_000000000001);

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("You do not have admin access.".into()));
    }
    Ok(())
}
async fn scope(db: &DatabaseConnection, user_id: Uuid, cap: &str) -> Result<ScopeKind, AppError> {
    let s = resolve_admin_capability_scope(db, user_id, cap).await?;
    if matches!(s, ScopeKind::None) {
        return Err(AppError::Authorization(format!("User lacks required admin capability: {cap}")));
    }
    Ok(s)
}
struct UserRow { id: Uuid, email: String, full_name: String, status: String, affiliation: String, is_system: bool, is_protected: bool }
async fn load_user(db: &DatabaseConnection, id: Uuid) -> Result<UserRow, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, email, full_name, status::text AS status, affiliation::text AS affiliation, is_system, is_protected FROM users WHERE id=$1", [id.into()])).await?;
    let r = rows.first().ok_or_else(|| AppError::NotFound("User not found.".into()))?;
    Ok(UserRow { id: r.try_get("", "id")?, email: r.try_get("", "email")?, full_name: r.try_get("", "full_name")?, status: r.try_get("", "status")?, affiliation: r.try_get("", "affiliation")?, is_system: r.try_get("", "is_system")?, is_protected: r.try_get("", "is_protected")? })
}
fn guard_protected(u: &UserRow) -> Result<(), AppError> {
    if u.is_system || u.is_protected { return Err(AppError::Validation("System-managed users cannot be modified.".into())); }
    Ok(())
}
async fn org_ids_of(db: &DatabaseConnection, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT organization_id FROM organization_memberships WHERE user_id=$1 AND expires_after IS NULL", [user_id.into()])).await?;
    rows.iter().map(|r| r.try_get("", "organization_id").map_err(AppError::from)).collect()
}
fn identity_subset(target: &[Uuid], granted: &[Uuid]) -> bool {
    !target.is_empty() && target.iter().all(|o| granted.contains(o))
}

pub async fn list_pending_users(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    let sc = scope(&db, session.user_id, "UserRead").await?;
    let rows = db.query_all(Statement::from_string(DbBackend::Postgres, "SELECT id, full_name, email, affiliation::text AS affiliation, status::text AS status, created_at FROM users WHERE status='pending_approval' ORDER BY created_at".to_string())).await?;
    let mut users = Vec::new();
    for r in rows {
        let id: Uuid = r.try_get("", "id")?;
        if let ScopeKind::Scoped(granted) = &sc {
            let orgs = org_ids_of(&db, id).await?;
            if !identity_subset(&orgs, granted) { continue; }
        }
        users.push(json!({"id":id,"fullName":r.try_get::<String>("","full_name")?,"email":r.try_get::<String>("","email")?,"affiliation":r.try_get::<String>("","affiliation")?,"status":r.try_get::<String>("","status")?,"createdAt":r.try_get::<chrono::DateTime<chrono::FixedOffset>>("","created_at")?.to_rfc3339()}));
    }
    Ok(Json(json!({"users":users})))
}

pub async fn reject_user(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    crate::auth::privileges::require_admin_privilege(&db, session.user_id, "UserReject").await?;
    let u = load_user(&db, id).await?;
    guard_protected(&u)?;
    if u.status != "pending_approval" { return Err(AppError::Validation("User is not pending approval.".into())); }
    let reason = body["reason"].as_str().unwrap_or("No reason provided");
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE users SET status='rejected', updated_at=now() WHERE id=$1", [id.into()])).await?;
    write_audit_log(&db, session.user_id, "user.signup_rejected", "user", &id.to_string(), None, json!({"rejected_by":session.user_id,"reason":reason}), None).await?;
    notify_trigger(&db, "user.rejected", &[u.email], "user", id).await?;
    Ok(Json(json!({"message":"User rejected successfully."})))
}

pub async fn tombstone_user(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    let sc = scope(&db, session.user_id, "UserTombstone").await?;
    let u = load_user(&db, id).await?;
    if let ScopeKind::Scoped(granted) = &sc {
        if !identity_subset(&org_ids_of(&db, id).await?, granted) { return Err(AppError::NotFound("User not found.".into())); }
    }
    guard_protected(&u)?;
    if u.status != "active" { return Err(AppError::Validation("Only active users can be tombstoned.".into())); }
    if id == session.user_id { return Err(AppError::Validation("You cannot tombstone your own account.".into())); }
    let admins = get_users_with_role(&db, "full_admin", false).await?;
    if admins.contains(&id) {
        let mut others = 0;
        for a in admins.iter().filter(|a| **a != id) {
            if let Ok(au) = load_user(&db, *a).await { if au.status == "active" { others += 1; } }
        }
        if others == 0 { return Err(AppError::Validation("Cannot deactivate the last active admin.".into())); }
    }
    // Sole primary owner guard.
    let own = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT so.id, so.system_id, so.kind::text AS kind, s.name AS system_name FROM system_owners so JOIN systems s ON s.id=so.system_id WHERE so.user_id=$1 AND so.expires_after IS NULL", [id.into()])).await?;
    let mut problematic = Vec::new();
    for r in &own {
        if r.try_get::<String>("", "kind")? == "primary" {
            let sid: Uuid = r.try_get("", "system_id")?;
            let backup = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
                "SELECT 1 FROM system_owners WHERE system_id=$1 AND kind='backup' AND expires_after IS NULL LIMIT 1", [sid.into()])).await?;
            if backup.is_empty() { problematic.push(r.try_get::<String>("", "system_name")?); }
        }
    }
    if !problematic.is_empty() {
        return Err(AppError::Validation(format!("Cannot deactivate this user — they are the sole owner of the following systems with no backup: {}. Assign a backup owner first.", problematic.join(", "))));
    }
    // Auto-cancel in-flight requests.
    let reqs = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT r.id, r.request_number, s.name AS system_name FROM breakglass_requests r JOIN systems s ON s.id=r.system_id WHERE r.submitted_by=$1 AND r.status::text IN ('submitted','under_review','returned_to_vendor')", [id.into()])).await?;
    for r in reqs {
        let rid: Uuid = r.try_get("", "id")?;
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE breakglass_requests SET status='rejected', updated_at=now() WHERE id=$1", [rid.into()])).await?;
        write_audit_log(&db, SYSTEM_USER_ID, "request.auto_cancelled", "breakglass_request", &rid.to_string(), None, json!({"trigger":"submitter_tombstoned"}), None).await?;
        notify_trigger(&db, "user.tombstoned_auto_cancelled_request", &[u.email.clone()], "breakglass_request", rid).await?;
    }
    // Remove backup ownerships + PA mappings + team memberships.
    for r in &own {
        let oid: Uuid = r.try_get("", "id")?;
        let kind: String = r.try_get("", "kind")?;
        if kind == "backup" {
            db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owners SET expires_after=now() WHERE id=$1", [oid.into()])).await?;
            write_audit_log(&db, session.user_id, "system_owner.auto_removed", "system_owner", &oid.to_string(), None, json!({"trigger":"owner_tombstoned"}), None).await?;
        }
        let pa = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT id FROM system_owner_pa_mappings WHERE system_owner_id=$1 AND expires_after IS NULL", [oid.into()])).await?;
        for p in pa {
            let pid: Uuid = p.try_get("", "id")?;
            db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owner_pa_mappings SET expires_after=now() WHERE id=$1", [pid.into()])).await?;
            write_audit_log(&db, session.user_id, "system_owner_pa_mapping.auto_removed", "system_owner_pa_mapping", &pid.to_string(), None, json!({"trigger":"owner_tombstoned"}), None).await?;
        }
    }
    let mem = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT id, team_id FROM team_memberships WHERE user_id=$1 AND expires_after IS NULL", [id.into()])).await?;
    for m in mem {
        let mid: Uuid = m.try_get("", "id")?;
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE team_memberships SET expires_after=now() WHERE id=$1", [mid.into()])).await?;
        write_audit_log(&db, session.user_id, "team_membership.auto_removed", "team_membership", &mid.to_string(), None, json!({"userId":id,"trigger":"user_tombstoned"}), None).await?;
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE users SET status='tombstoned', tombstoned_by=$1, tombstoned_at=now(), updated_at=now() WHERE id=$2", [session.user_id.into(), id.into()])).await?;
    write_audit_log(&db, session.user_id, "user.tombstoned", "user", &id.to_string(), None, json!({"tombstoned_by":session.user_id}), None).await?;
    notify_trigger(&db, "user.tombstoned", &[u.email], "user", id).await?;
    Ok(Json(json!({"message":"User tombstoned successfully."})))
}

pub async fn untombstone_user(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    let sc = scope(&db, session.user_id, "UserUntombstone").await?;
    let u = load_user(&db, id).await?;
    if let ScopeKind::Scoped(granted) = &sc {
        if !identity_subset(&org_ids_of(&db, id).await?, granted) { return Err(AppError::NotFound("User not found.".into())); }
    }
    guard_protected(&u)?;
    if u.status != "tombstoned" { return Err(AppError::Validation("User is not tombstoned.".into())); }
    let affiliation = body["affiliation"].as_str().ok_or_else(|| AppError::Validation("Affiliation is required.".into()))?;
    if !["agency", "vendor"].contains(&affiliation) { return Err(AppError::Validation("Invalid affiliation.".into())); }
    let active = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id FROM users WHERE lower(email)=lower($1) AND status='active' AND id<>$2 LIMIT 1", [u.email.clone().into(), id.into()])).await?;
    if !active.is_empty() { return Err(AppError::Validation("Cannot reactivate — email is in use by another active account.".into())); }
    let reason = body["reason"].as_str().unwrap_or("No reason provided");
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE users SET status='active', affiliation=$1::user_affiliation, untombstoned_by=$2, untombstoned_at=now(), updated_at=now() WHERE id=$3",
        [affiliation.into(), session.user_id.into(), id.into()])).await?;
    write_audit_log(&db, session.user_id, "user.untombstoned", "user", &id.to_string(), None, json!({"untombstoned_by":session.user_id,"assigned_affiliation":affiliation,"reason":reason}), None).await?;
    notify_trigger(&db, "user.untombstoned", &[u.email], "user", id).await?;
    Ok(Json(json!({"message":"User un-tombstoned successfully."})))
}

pub async fn change_affiliation(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    let sc = scope(&db, session.user_id, "UserAffiliationChange").await?;
    let u = load_user(&db, id).await?;
    if let ScopeKind::Scoped(granted) = &sc {
        if !identity_subset(&org_ids_of(&db, id).await?, granted) { return Err(AppError::NotFound("User not found.".into())); }
    }
    guard_protected(&u)?;
    if u.status != "active" { return Err(AppError::Validation("Only active users can change affiliation.".into())); }
    let affiliation = body["affiliation"].as_str().ok_or_else(|| AppError::Validation("Affiliation is required.".into()))?;
    if !["agency", "vendor"].contains(&affiliation) { return Err(AppError::Validation("Invalid affiliation.".into())); }
    let settle = !matches!(sc, ScopeKind::Scoped(_));
    // Addendum-204 F2: scoped callers may not request any role settlement.
    if !settle && (body.get("grantFullAdmin").is_some() || body.get("roleKeys").is_some() || body.get("grants").is_some()) {
        return Err(AppError::Validation("Changing admin roles requires a global UserAffiliationChange grant.".into()));
    }
    let desired: Option<Vec<DesiredRoleGrant>> = if settle {
        if affiliation != "agency" { Some(vec![]) }
        else {
            let mut d = Vec::new();
            if body["grantFullAdmin"].as_bool() == Some(true) { d.push(DesiredRoleGrant { role_key: "full_admin".into(), organization_id: None }); }
            if let Some(keys) = body["roleKeys"].as_array() {
                for k in keys { if let Some(k) = k.as_str() { if k != "full_admin" { d.push(DesiredRoleGrant { role_key: k.into(), organization_id: None }); } } }
            }
            Some(d)
        }
    } else { None };
    let admins = get_users_with_role(&db, "full_admin", false).await?;
    let was_full = admins.contains(&id);
    let will_full = desired.as_ref().map(|d| d.iter().any(|g| g.role_key == "full_admin")).unwrap_or(was_full);
    if was_full && !will_full {
        let mut others = 0;
        for a in admins.iter().filter(|a| **a != id) { if let Ok(au) = load_user(&db, *a).await { if au.status == "active" { others += 1; } } }
        if others == 0 { return Err(AppError::Validation("Cannot deactivate the last active admin.".into())); }
    }
    if !settle && affiliation != "agency" {
        let grants = list_admin_role_grants(&db, id, false).await?;
        if !grants.is_empty() { return Err(AppError::Validation("A global administrator must remove this user's admin roles before moving them off agency.".into())); }
    }
    if affiliation != "agency" {
        let own = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT s.name FROM system_owners so JOIN systems s ON s.id=so.system_id WHERE so.user_id=$1 AND so.kind='primary' AND so.expires_after IS NULL", [id.into()])).await?;
        if !own.is_empty() {
            let names: Vec<String> = own.iter().map(|r| r.try_get("", "name").unwrap_or_default()).collect();
            return Err(AppError::Validation(format!("This user is the primary owner of: {}. Reassign primary ownership before changing their affiliation.", names.join(", "))));
        }
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE users SET affiliation=$1::user_affiliation, updated_at=now() WHERE id=$2", [affiliation.into(), id.into()])).await?;
    write_audit_log(&db, session.user_id, "user.affiliation_changed", "user", &id.to_string(), None,
        json!({"changed_by":session.user_id,"old_affiliation":u.affiliation,"new_affiliation":affiliation}), None).await?;
    if let Some(d) = desired { set_user_roles(&db, id, d, session.user_id, "Updated via affiliation change").await?; }
    Ok(Json(json!({"message":"User affiliation updated successfully."})))
}

// ── Credential recovery (addendum-076) ──────────────────────────────────────

fn generate_temp_password() -> String {
    use rand::{seq::SliceRandom, Rng};
    const UPPER: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
    const LOWER: &[u8] = b"abcdefghijkmnopqrstuvwxyz";
    const DIGITS: &[u8] = b"23456789";
    const SPECIAL: &[u8] = b"!@#$%^&*(),.?\":{}|<>";
    let all: Vec<u8> = [UPPER, LOWER, DIGITS, SPECIAL].concat();
    let mut rng = rand::thread_rng();
    let mut chars = vec![
        UPPER[rng.gen_range(0..UPPER.len())], LOWER[rng.gen_range(0..LOWER.len())],
        DIGITS[rng.gen_range(0..DIGITS.len())], SPECIAL[rng.gen_range(0..SPECIAL.len())],
    ];
    for _ in 4..16 { chars.push(all[rng.gen_range(0..all.len())]); }
    chars.shuffle(&mut rng);
    String::from_utf8(chars).unwrap()
}

/// POST /admin/users/:id/reset-2fa — clear enrollment and revoke every session.
pub async fn reset_user_twofa(
    State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>,
) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    let sc = scope(&db, session.user_id, "UserResetTwofa").await?;
    let u = load_user(&db, id).await?;
    if let ScopeKind::Scoped(granted) = &sc {
        if !identity_subset(&org_ids_of(&db, id).await?, granted) { return Err(AppError::not_found("User not found.")); }
    }
    if u.is_system { return Err(AppError::validation("System-managed users cannot be modified.")); }
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT totp_secret, totp_enrolled_at FROM users WHERE id=$1", [id.into()])).await?
        .ok_or_else(|| AppError::not_found("User not found."))?;
    let secret: Option<String> = row.try_get("", "totp_secret")?;
    let enrolled: Option<chrono::DateTime<chrono::FixedOffset>> = row.try_get("", "totp_enrolled_at")?;
    if secret.is_none() && enrolled.is_none() {
        return Err(AppError::validation("This user has no 2FA enrollment to reset."));
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE users SET totp_secret=NULL,totp_enrolled_at=NULL,updated_at=now() WHERE id=$1", [id.into()])).await?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "DELETE FROM sessions WHERE user_id=$1", [id.into()])).await?;
    write_audit_log(&db, session.user_id, "user.twofa_reset", "user", &id.to_string(), None,
        json!({"reset_by":session.user_id}), None).await?;
    Ok(Json(json!({"message":"Two-factor authentication reset. The user will be asked to re-enroll on next login."})))
}

/// POST /admin/users/:id/reset-password — issue a one-time temp password.
pub async fn reset_user_password(
    State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>,
) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    let sc = scope(&db, session.user_id, "UserResetPassword").await?;
    let u = load_user(&db, id).await?;
    if let ScopeKind::Scoped(granted) = &sc {
        if !identity_subset(&org_ids_of(&db, id).await?, granted) { return Err(AppError::not_found("User not found.")); }
    }
    if u.is_system { return Err(AppError::validation("System-managed users cannot be modified.")); }
    let temp = generate_temp_password();
    let salt = crate::auth::password::generate_salt();
    let hash = crate::auth::password::hash_password(&temp, &salt)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Hash error: {e}")))?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE users SET password_hash=$1,password_salt=$2,force_password_rotation=true,updated_at=now() WHERE id=$3",
        [hash.into(), salt.into(), id.into()])).await?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "DELETE FROM sessions WHERE user_id=$1", [id.into()])).await?;
    write_audit_log(&db, session.user_id, "user.password_reset", "user", &id.to_string(), None,
        json!({"reset_by":session.user_id,"tempPasswordIssued":true}), None).await?;
    Ok(Json(json!({"message":"Password reset. Share the temporary password out-of-band; the user will be forced to change it on next login.","tempPassword":temp})))
}
