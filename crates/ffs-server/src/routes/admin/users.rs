// Admin users route handlers.
// Importers/callers: main.rs registers GET /admin/users using list_users.
// Affected API: GET /admin/users (UserRead capability, replaces stubs::admin_users).
// Data schemas: users(id, full_name, email, affiliation, status, is_system, is_protected,
//   force_password_rotation, totp_secret, totp_enrolled_at, last_login_at, created_at,
//   updated_at, password_login_disabled_at, pending_actions_digest_opt_in),
//   organization_memberships(organization_id, user_id, expires_after),
//   organizations(id, name, expires_after).
// User instruction: "fix the rust port to ensure API and PlayWright suites pass"

use std::sync::Arc;

use axum::{extract::{Path, State}, response::IntoResponse, Extension, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::{
        admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
        users,
    },
    errors::{AppError, RouteResult},
};

type RouteState = State<(Config, DatabaseConnection)>;

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization(
            "You do not have admin access.".to_string(),
        ));
    }
    Ok(())
}

/// Fetch a map of user_id → Vec<{id, name}> for live org memberships.
async fn org_memberships_by_user(
    db: &DatabaseConnection,
) -> Result<std::collections::HashMap<Uuid, Vec<JsonValue>>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT om.user_id, o.id AS org_id, o.name AS org_name
               FROM organization_memberships om
               JOIN organizations o ON o.id = om.organization_id
               WHERE om.expires_after IS NULL AND o.expires_after IS NULL"#,
            [],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("org memberships query: {}", e)))?;

    let mut map: std::collections::HashMap<Uuid, Vec<JsonValue>> = Default::default();
    for row in &rows {
        let user_id: Uuid = row
            .try_get("", "user_id")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("user_id: {}", e)))?;
        let org_id: Uuid = row
            .try_get("", "org_id")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("org_id: {}", e)))?;
        let org_name: String = row
            .try_get("", "org_name")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("org_name: {}", e)))?;
        map.entry(user_id)
            .or_default()
            .push(json!({ "id": org_id, "name": org_name }));
    }
    Ok(map)
}

// ── GET /admin/users ──────────────────────────────────────────────────────────

pub async fn list_users(
    State((_, db)): RouteState,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = resolve_admin_capability_scope(&db, session.user_id, "UserRead").await?;
    if let ScopeKind::None = scope {
        return Err(AppError::Authorization(
            "You do not have permission to view users.".to_string(),
        ));
    }

    let all = users::list_all_for_admin(&db).await?;
    let memberships = org_memberships_by_user(&db).await?;

    let enriched: Vec<JsonValue> = all
        .iter()
        .map(|u| {
            let orgs = memberships.get(&u.id).cloned().unwrap_or_default();
            let affiliation = u.affiliation.as_ref().map(|a| match a {
                crate::db::users::entity::UserAffiliation::Agency => "agency",
                crate::db::users::entity::UserAffiliation::Vendor => "vendor",
            });
            let status_str = match &u.status {
                crate::db::users::entity::UserStatus::PendingApproval => "pending_approval",
                crate::db::users::entity::UserStatus::Active => "active",
                crate::db::users::entity::UserStatus::Tombstoned => "tombstoned",
                crate::db::users::entity::UserStatus::Rejected => "rejected",
            };
            json!({
                "id": u.id,
                "fullName": u.full_name,
                "email": u.email,
                "affiliation": affiliation,
                "status": status_str,
                "isSystem": u.is_system,
                "isProtected": u.is_protected,
                "forcePasswordRotation": u.force_password_rotation,
                "totpEnrolled": u.totp_secret.is_some(),
                "lastLoginAt": u.last_login_at.map(|t| t.to_rfc3339()),
                "createdAt": u.created_at.to_rfc3339(),
                "updatedAt": u.updated_at.to_rfc3339(),
                "passwordLoginDisabledAt": u.password_login_disabled_at.map(|t| t.to_rfc3339()),
                "pendingActionsDigestOptIn": u.pending_actions_digest_opt_in,
                "organizations": orgs,
            })
        })
        .collect();

    let visible: Vec<JsonValue> = match &scope {
        ScopeKind::Global => enriched,
        ScopeKind::Scoped(org_ids) => enriched
            .into_iter()
            .filter(|u| {
                if u["status"].as_str() == Some("pending_approval") {
                    return false;
                }
                u["organizations"]
                    .as_array()
                    .map(|orgs| {
                        orgs.iter().any(|o| {
                            o["id"]
                                .as_str()
                                .and_then(|s| Uuid::parse_str(s).ok())
                                .map(|id| org_ids.contains(&id))
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            })
            .collect(),
        ScopeKind::None => vec![],
    };

    Ok(Json(json!({ "users": visible })))
}

// ── POST /admin/users/invite + /admin/users/:id/approve ──────────────────────

fn org_ids_from_body(body: &JsonValue) -> Result<Vec<Uuid>, AppError> {
    let arr = body.get("organizationIds").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    arr.iter().map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok())
        .ok_or_else(|| AppError::Validation("One or more organisations do not exist.".to_string())))
        .collect()
}

async fn validate_org_assignment(db: &DatabaseConnection, scope: &ScopeKind, org_ids: &[Uuid]) -> Result<(), AppError> {
    if org_ids.is_empty() { return Ok(()); }
    if let ScopeKind::Scoped(granted) = scope {
        if org_ids.iter().any(|id| !granted.contains(id)) {
            return Err(AppError::Validation("Organisation selection is outside your granted organisations.".to_string()));
        }
    }
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id FROM organizations WHERE id = ANY($1::uuid[]) AND expires_after IS NULL",
        [org_ids.to_vec().into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("org assignment: {}", e)))?;
    if rows.len() != org_ids.len() {
        return Err(AppError::Validation("One or more organisations do not exist.".to_string()));
    }
    Ok(())
}

async fn insert_memberships(db: &DatabaseConnection, actor: Uuid, user_id: Uuid, org_ids: &[Uuid]) -> Result<(), AppError> {
    for org_id in org_ids {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO organization_memberships (id, organization_id, user_id, added_by, created_at)
               VALUES ($1,$2,$3,$4,now())
               ON CONFLICT (organization_id, user_id) WHERE expires_after IS NULL DO NOTHING"#,
            [Uuid::now_v7().into(), (*org_id).into(), user_id.into(), actor.into()],
        )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("membership insert: {}", e)))?;
    }
    Ok(())
}

pub async fn invite_user(
    State((_, db)): RouteState,
    Extension(session): Extension<Arc<Session>>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = resolve_admin_capability_scope(&db, session.user_id, "UserInvite").await?;
    if let ScopeKind::None = scope {
        return Err(AppError::Authorization("User lacks required admin capability: UserInvite".to_string()));
    }
    let full_name = body["fullName"].as_str().unwrap_or("").trim().to_string();
    let email = body["email"].as_str().unwrap_or("").trim().to_lowercase();
    let affiliation = body["affiliation"].as_str().ok_or_else(|| AppError::Validation("Affiliation is required.".to_string()))?;
    if full_name.is_empty() { return Err(AppError::Validation("Full name is required.".to_string())); }
    if !email.contains('@') { return Err(AppError::Validation("A valid email address is required.".to_string())); }
    if !["agency", "vendor"].contains(&affiliation) { return Err(AppError::Validation("Invalid affiliation.".to_string())); }
    let org_ids = org_ids_from_body(&body)?;
    validate_org_assignment(&db, &scope, &org_ids).await?;
    let taken = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM users WHERE lower(email) = lower($1) AND status IN ('active','pending_approval') LIMIT 1",
        [email.clone().into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("email check: {}", e)))?;
    if !taken.is_empty() { return Err(AppError::Validation("An account with this email already exists.".to_string())); }
    let user_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO users (id, full_name, email, password_hash, password_salt, affiliation, status, approved_by, approved_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,'',$5::user_affiliation,'active',$6,now(),now(),now())"#,
        [user_id.into(), full_name.into(), email.into(), format!("invite-pending:{}", Uuid::now_v7()).into(), affiliation.to_string().into(), session.user_id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("invite insert: {}", e)))?;
    insert_memberships(&db, session.user_id, user_id, &org_ids).await?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "userId": user_id }))))
}

pub async fn approve_user(
    State((_, db)): RouteState,
    Extension(session): Extension<Arc<Session>>,
    Path(id): Path<Uuid>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = resolve_admin_capability_scope(&db, session.user_id, "UserApprove").await?;
    if let ScopeKind::None = scope {
        return Err(AppError::Authorization("User lacks required admin capability: UserApprove".to_string()));
    }
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT status::TEXT AS status, is_system, is_protected FROM users WHERE id = $1 LIMIT 1",
        [id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("approve lookup: {}", e)))?;
    if rows.is_empty() { return Err(AppError::NotFound("User not found.".to_string())); }
    let status: String = rows[0].try_get("", "status").unwrap_or_default();
    let is_system: bool = rows[0].try_get("", "is_system").unwrap_or(false);
    let is_protected: bool = rows[0].try_get("", "is_protected").unwrap_or(false);
    if is_system || is_protected { return Err(AppError::Validation("System-managed users cannot be modified.".to_string())); }
    if status != "pending_approval" { return Err(AppError::Validation("User is not pending approval.".to_string())); }
    let affiliation = body["affiliation"].as_str().ok_or_else(|| AppError::Validation("Affiliation is required.".to_string()))?;
    if !["agency", "vendor"].contains(&affiliation) { return Err(AppError::Validation("Invalid affiliation.".to_string())); }
    let org_ids = org_ids_from_body(&body)?;
    validate_org_assignment(&db, &scope, &org_ids).await?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE users SET status = 'active', affiliation = $1::user_affiliation, approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $3",
        [affiliation.to_string().into(), session.user_id.into(), id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("approve update: {}", e)))?;
    insert_memberships(&db, session.user_id, id, &org_ids).await?;
    let email: String = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT email FROM users WHERE id=$1", [id.into()])).await?
        .map(|r| r.try_get("", "email").unwrap_or_default()).unwrap_or_default();
    crate::notifications::notify_trigger(&db, "user.approved", &[email], "user", id).await?;
    Ok(Json(json!({ "message": "User approved successfully." })))
}
