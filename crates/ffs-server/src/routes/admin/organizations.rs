// Admin organization route handlers.
// Importers/callers: main.rs registers GET/POST /admin/organizations, DELETE/GET/POST :id endpoints.
// Affected API: GET /admin/organizations (OrgRead), POST /admin/organizations (OrgCreate),
//   DELETE /admin/organizations/:id (OrgDelete), GET /admin/organizations/:id/members (OrgRead),
//   POST /admin/organizations/:id/members (OrgUpdate).
// Data schemas: organizations(id, name, short_code, created_by, created_at, updated_at, expires_after),
//   organization_memberships(id, organization_id, user_id, added_by, created_at, expires_after),
//   users(id, full_name, email, status, affiliation).
// User instruction: "fix the rust port to ensure API and PlayWright suites pass."

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::{
        admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
        organizations::{self, CreateOrgInput},
    },
    errors::{AppError, RouteResult},
};

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("You do not have admin access.".to_string()));
    }
    Ok(())
}

async fn require_capability(
    db: &DatabaseConnection,
    user_id: Uuid,
    cap: &str,
) -> Result<ScopeKind, AppError> {
    let scope = resolve_admin_capability_scope(db, user_id, cap).await?;
    if let ScopeKind::None = scope {
        return Err(AppError::Authorization(format!(
            "User lacks required admin capability: {}",
            cap
        )));
    }
    Ok(scope)
}

fn org_json(o: &organizations::Organization) -> JsonValue {
    json!({
        "id": o.id,
        "name": o.name,
        "shortCode": o.short_code,
        "createdBy": o.created_by,
        "createdAt": o.created_at.to_rfc3339(),
        "updatedAt": o.updated_at.to_rfc3339(),
        "expiresAfter": o.expires_after.map(|t| t.to_rfc3339()),
    })
}

// ── GET /admin/organizations ──────────────────────────────────────────────────

pub async fn list_organizations(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "OrgRead").await?;

    let all = organizations::list_live(&db).await?;
    let visible: Vec<_> = match &scope {
        ScopeKind::Global => all,
        ScopeKind::Scoped(org_ids) => all.into_iter().filter(|o| org_ids.contains(&o.id)).collect(),
        ScopeKind::None => return Err(AppError::Authorization(
            "You do not have permission to access organisations.".to_string(),
        )),
    };

    let result: Vec<JsonValue> = visible.iter().map(org_json).collect();
    Ok(Json(json!({ "organizations": result })))
}

// ── POST /admin/organizations ─────────────────────────────────────────────────

pub async fn create_organization(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "OrgCreate").await?;
    if let ScopeKind::Scoped(_) = scope {
        return Err(AppError::Authorization(
            "Creating organisations requires a global OrgCreate grant.".to_string(),
        ));
    }

    let name = body["name"]
        .as_str()
        .ok_or_else(|| AppError::Validation("name is required.".to_string()))?
        .trim()
        .to_owned();
    if name.is_empty() {
        return Err(AppError::Validation("Organisation name is required.".to_string()));
    }
    if name.len() > 200 {
        return Err(AppError::Validation("Organisation name is too long (max 200 characters).".to_string()));
    }

    let raw_code = body["shortCode"]
        .as_str()
        .ok_or_else(|| AppError::Validation("shortCode is required.".to_string()))?;
    let short_code = raw_code.trim().to_uppercase();
    if short_code.is_empty() || short_code.len() > 10 || !short_code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Validation(
            "Short code must be 1-10 uppercase alphanumeric characters.".to_string(),
        ));
    }

    if organizations::name_exists_live(&db, &name).await? {
        return Err(AppError::Validation(
            "An organisation with this name already exists.".to_string(),
        ));
    }
    if organizations::short_code_exists_live(&db, &short_code).await? {
        return Err(AppError::Validation(format!(
            "An organisation with short code \"{}\" already exists.", short_code
        )));
    }

    let new_id = Uuid::now_v7();
    organizations::create(
        &db,
        CreateOrgInput {
            id: new_id,
            name,
            short_code,
            created_by: session.user_id,
        },
    )
    .await?;

    let created = organizations::get_live(&db, new_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("org not found after insert")))?;
    organizations::audit(&db, session.user_id, "organization.created", new_id, "organization",
        json!({ "name": created.name, "shortCode": created.short_code })).await?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "organization": org_json(&created) })),
    ))
}

// ── DELETE /admin/organizations/:id ──────────────────────────────────────────

pub async fn delete_organization(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    require_capability(&db, session.user_id, "OrgDelete").await?;

    let org = organizations::get_live(&db, id).await?;
    if org.is_none() {
        return Err(AppError::NotFound("Organisation not found.".to_string()));
    }

    if organizations::live_member_count(&db, id).await? > 0 {
        return Err(AppError::Validation(
            "Cannot delete organisation with active members. Remove all members first.".to_string(),
        ));
    }
    if organizations::live_cluster_count(&db, id).await? > 0 {
        return Err(AppError::Validation(
            "Cannot delete organisation with active clusters. Move or delete the clusters first.".to_string(),
        ));
    }
    if organizations::live_system_edge_count(&db, id).await? > 0 {
        return Err(AppError::Validation(
            "Cannot delete organisation linked to systems. Transfer or remove the system organisation links first.".to_string(),
        ));
    }

    organizations::expire(&db, id).await?;
    organizations::audit(&db, session.user_id, "organization.invalidated", id, "organization",
        json!({ "name": org.unwrap().name })).await?;

    Ok(Json(json!({ "message": "Organisation deleted successfully." })))
}

// ── GET /admin/organizations/:id/members ─────────────────────────────────────

pub async fn list_org_members(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "OrgRead").await?;

    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&id) {
            return Err(AppError::NotFound("Organisation not found.".to_string()));
        }
    }
    let org = organizations::get_live(&db, id).await?;
    if org.is_none() {
        return Err(AppError::NotFound("Organisation not found.".to_string()));
    }

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT om.id AS membership_id, om.user_id, om.created_at AS joined_at,
                      u.full_name, u.email, u.status::TEXT AS status
               FROM organization_memberships om
               JOIN users u ON u.id = om.user_id
               WHERE om.organization_id = $1 AND om.expires_after IS NULL
               ORDER BY u.full_name"#,
            [id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("list org members: {}", e)))?;

    let members: Vec<JsonValue> = rows
        .iter()
        .map(|r| -> Result<JsonValue, AppError> {
            let user_id: Uuid = r.try_get("", "user_id").map_err(|e| AppError::Internal(anyhow::anyhow!("user_id: {}", e)))?;
            let joined_at: chrono::DateTime<chrono::FixedOffset> = r.try_get("", "joined_at").map_err(|e| AppError::Internal(anyhow::anyhow!("joined_at: {}", e)))?;
            Ok(json!({
                "userId": user_id,
                "fullName": r.try_get::<String>("", "full_name").unwrap_or_default(),
                "email": r.try_get::<String>("", "email").unwrap_or_default(),
                "status": r.try_get::<String>("", "status").unwrap_or_default(),
                "joinedAt": joined_at.to_rfc3339(),
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(json!({ "members": members })))
}

// ── POST /admin/organizations/:id/members ────────────────────────────────────

pub async fn add_org_member(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(org_id): Path<Uuid>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "OrgUpdate").await?;

    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&org_id) {
            return Err(AppError::NotFound("Organisation not found.".to_string()));
        }
    }
    let org = organizations::get_live(&db, org_id).await?;
    if org.is_none() {
        return Err(AppError::NotFound("Organisation not found.".to_string()));
    }

    let user_id_str = body["userId"]
        .as_str()
        .ok_or_else(|| AppError::Validation("userId is required.".to_string()))?;

    // 404-disguise on bad UUID or unknown user (repo convention).
    let user_id = Uuid::parse_str(user_id_str)
        .map_err(|_| AppError::NotFound("User not found.".to_string()))?;

    let user_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT status::TEXT AS status FROM users WHERE id = $1 LIMIT 1",
            [user_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("user lookup: {}", e)))?;

    if user_rows.is_empty() {
        return Err(AppError::NotFound("User not found.".to_string()));
    }

    let status: String = user_rows[0]
        .try_get("", "status")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("status: {}", e)))?;
    if status != "active" {
        return Err(AppError::Validation("Only active users can be added to organisations.".to_string()));
    }

    // Check not already a live member.
    let already = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 AND expires_after IS NULL LIMIT 1",
            [org_id.into(), user_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("membership check: {}", e)))?;
    if !already.is_empty() {
        return Err(AppError::Validation("User is already a member of this organisation.".to_string()));
    }

    let membership_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO organization_memberships (id, organization_id, user_id, added_by, created_at)
           VALUES ($1, $2, $3, $4, now())"#,
        [membership_id.into(), org_id.into(), user_id.into(), session.user_id.into()],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("insert membership: {}", e)))?;

    organizations::audit(&db, session.user_id, "organization_member.added", membership_id,
        "organization_membership", json!({ "organizationId": org_id, "userId": user_id })).await?;

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "membership": { "id": membership_id, "organizationId": org_id, "userId": user_id } })),
    ))
}

// ── PUT /admin/organizations/:id ─────────────────────────────────────────────

pub async fn update_organization(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(id): Path<Uuid>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "OrgUpdate").await?;
    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&id) {
            return Err(AppError::NotFound("Organisation not found.".to_string()));
        }
    }
    let org = organizations::get_live(&db, id).await?
        .ok_or_else(|| AppError::NotFound("Organisation not found.".to_string()))?;

    let has_name = body.get("name").is_some();
    let has_code = body.get("shortCode").is_some();
    if !has_name && !has_code {
        return Err(AppError::Validation("No fields to update.".to_string()));
    }
    let name = if has_name {
        let n = body["name"].as_str().ok_or_else(|| AppError::Validation("name must be a string.".to_string()))?.trim().to_string();
        if n.is_empty() || n.len() > 200 {
            return Err(AppError::Validation("Organisation name is required (1-200 characters).".to_string()));
        }
        if organizations::name_exists_live(&db, &n).await? && n.to_lowercase() != org.name.to_lowercase() {
            return Err(AppError::Validation("An organisation with this name already exists.".to_string()));
        }
        Some(n)
    } else { None };
    let code = if has_code {
        let raw = body["shortCode"].as_str().ok_or_else(|| AppError::Validation("shortCode must be a string.".to_string()))?;
        let c = raw.trim().to_uppercase();
        if c.is_empty() || c.len() > 10 || !c.chars().all(|ch| ch.is_ascii_alphanumeric()) {
            return Err(AppError::Validation("Short code must be 1-10 uppercase alphanumeric characters.".to_string()));
        }
        if organizations::short_code_exists_live(&db, &c).await? && c != org.short_code {
            return Err(AppError::Validation(format!("An organisation with short code \"{}\" already exists.", c)));
        }
        Some(c)
    } else { None };

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE organizations SET name = COALESCE($1, name), short_code = COALESCE($2, short_code), updated_at = now() WHERE id = $3",
        [name.clone().into(), code.clone().into(), id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("update org: {}", e)))?;
    organizations::audit(&db, session.user_id, "organization.updated", id, "organization",
        json!({ "name": name.clone().unwrap_or(org.name.clone()), "shortCode": code.clone().unwrap_or(org.short_code.clone()) })).await?;
    let updated = organizations::get_live(&db, id).await?.ok_or_else(|| AppError::NotFound("Organisation not found.".to_string()))?;
    Ok(Json(json!({ "organization": org_json(&updated) })))
}

// ── DELETE /admin/organizations/:id/members/:userId ──────────────────────────

pub async fn remove_org_member(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path((org_id, user_id)): Path<(Uuid, Uuid)>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "OrgUpdate").await?;
    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&org_id) {
            return Err(AppError::NotFound("Organisation not found.".to_string()));
        }
    }
    if organizations::get_live(&db, org_id).await?.is_none() {
        return Err(AppError::NotFound("Organisation not found.".to_string()));
    }
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 AND expires_after IS NULL LIMIT 1",
        [org_id.into(), user_id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("membership lookup: {}", e)))?;
    if rows.is_empty() {
        return Err(AppError::NotFound("Membership not found.".to_string()));
    }
    let membership_id: Uuid = rows[0].try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("membership id: {}", e)))?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE organization_memberships SET expires_after = now() WHERE id = $1",
        [membership_id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("remove membership: {}", e)))?;
    organizations::audit(&db, session.user_id, "organization_member.removed", membership_id,
        "organization_membership", json!({ "organizationId": org_id, "userId": user_id })).await?;
    Ok(Json(json!({ "message": "Member removed from organisation." })))
}
