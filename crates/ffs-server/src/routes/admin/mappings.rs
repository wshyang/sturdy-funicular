// Admin owner-PA mapping routes (addendum-207 R6): keyed on system_owners.id.
// Scoped OwnerPAMappingManage checks the OWNERSHIP row's system owner-org.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
    errors::{AppError, RouteResult},
};

fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB error: {}", e))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateOwnerPaMappingBody {
    system_owner_id: Uuid,
    pa_team_id: Uuid,
}

async fn mapping_scope(db: &DatabaseConnection, user_id: Uuid) -> Result<ScopeKind, AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("Admin access required.".into()));
    }
    let s = resolve_admin_capability_scope(db, user_id, "OwnerPAMappingManage").await?;
    if let ScopeKind::None = s {
        return Err(AppError::Authorization("User lacks required admin capability: OwnerPAMappingManage".into()));
    }
    Ok(s)
}

async fn ownership_org(db: &DatabaseConnection, owner_row_id: Uuid) -> Result<Option<Uuid>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT org.organization_id
           FROM system_owners so
           JOIN system_organizations org ON org.system_id = so.system_id AND org.role = 'owner' AND org.expires_after IS NULL
           WHERE so.id = $1 AND so.expires_after IS NULL LIMIT 1"#,
        [owner_row_id.into()],
    )).await.map_err(db_err)?;
    Ok(rows.first().and_then(|r| r.try_get("", "organization_id").ok()))
}

pub async fn post_owner_pa_mapping(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Json(body): Json<CreateOwnerPaMappingBody>,
) -> RouteResult<impl IntoResponse> {
    let s = mapping_scope(&db, session.user_id).await?;
    if let ScopeKind::Scoped(org_ids) = &s {
        let org = ownership_org(&db, body.system_owner_id).await?;
        if !org.map(|o| org_ids.contains(&o)).unwrap_or(false) {
            return Err(AppError::NotFound("System not found.".into()));
        }
    }
    let owner_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT so.user_id, u.status::TEXT AS status
           FROM system_owners so JOIN users u ON u.id = so.user_id
           WHERE so.id = $1 AND so.expires_after IS NULL LIMIT 1"#,
        [body.system_owner_id.into()],
    )).await.map_err(db_err)?;
    if owner_rows.is_empty() { return Err(AppError::NotFound("System owner record not found.".into())); }
    let status: String = owner_rows[0].try_get("", "status").unwrap_or_default();
    if status != "active" { return Err(AppError::Validation("The system owner is not an active user.".into())); }
    let team_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT c.type::TEXT AS cluster_type FROM teams t JOIN clusters c ON c.id = t.cluster_id
           WHERE t.id = $1 AND t.expires_after IS NULL LIMIT 1"#,
        [body.pa_team_id.into()],
    )).await.map_err(db_err)?;
    if team_rows.is_empty() { return Err(AppError::NotFound("Team not found.".into())); }
    let team_type: String = team_rows[0].try_get("", "cluster_type").unwrap_or_default();
    if team_type != "pa" { return Err(AppError::Validation("Only PA teams can be assigned to System Owners.".into())); }
    let existing = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM system_owner_pa_mappings WHERE system_owner_id = $1 AND expires_after IS NULL LIMIT 1",
        [body.system_owner_id.into()],
    )).await.map_err(db_err)?;
    if !existing.is_empty() { return Err(AppError::Validation("This system owner already has a PA team assigned.".into())); }
    let mapping_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO system_owner_pa_mappings (id, system_owner_id, pa_team_id, created_by, created_at) VALUES ($1,$2,$3,$4,now())",
        [mapping_id.into(), body.system_owner_id.into(), body.pa_team_id.into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "mapping": {
        "id": mapping_id, "systemOwnerId": body.system_owner_id, "paTeamId": body.pa_team_id,
    } }))))
}

pub async fn delete_owner_pa_mapping(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    let s = mapping_scope(&db, session.user_id).await?;
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT system_owner_id FROM system_owner_pa_mappings WHERE id = $1 AND expires_after IS NULL LIMIT 1",
        [id.into()],
    )).await.map_err(db_err)?;
    let owner_row: Uuid = rows.first().and_then(|r| r.try_get("", "system_owner_id").ok())
        .ok_or_else(|| AppError::NotFound("Mapping not found.".into()))?;
    if let ScopeKind::Scoped(org_ids) = &s {
        let org = ownership_org(&db, owner_row).await?;
        if !org.map(|o| org_ids.contains(&o)).unwrap_or(false) {
            return Err(AppError::NotFound("Mapping not found.".into()));
        }
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE system_owner_pa_mappings SET expires_after = now() WHERE id = $1",
        [id.into()],
    )).await.map_err(db_err)?;
    Ok(Json(json!({ "message": "Mapping deleted successfully." })))
}

// ── Team↔System mappings (addendum-015) ─────────────────────────────────────

async fn system_mapping_scope(db: &DatabaseConnection, user_id: Uuid, system_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("Admin access required.".into()));
    }
    let s = resolve_admin_capability_scope(db, user_id, "TeamSystemMappingManage").await?;
    match s {
        ScopeKind::None => return Err(AppError::Authorization("User lacks required admin capability: TeamSystemMappingManage".into())),
        ScopeKind::Global => {}
        ScopeKind::Scoped(org_ids) => {
            let rows = db.query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT organization_id FROM system_organizations WHERE system_id = $1 AND role = 'owner' AND expires_after IS NULL LIMIT 1",
                [system_id.into()],
            )).await.map_err(db_err)?;
            let org: Option<Uuid> = rows.first().and_then(|r| r.try_get("", "organization_id").ok());
            if !org.map(|o| org_ids.contains(&o)).unwrap_or(false) {
                return Err(AppError::NotFound("System not found.".into()));
            }
        }
    }
    Ok(())
}

pub async fn post_team_system_mapping(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Json(body): Json<serde_json::Value>,
) -> RouteResult<impl IntoResponse> {
    let team_id = body["teamId"].as_str().and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| AppError::Validation("teamId is required.".into()))?;
    let system_id = body["systemId"].as_str().and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| AppError::Validation("systemId is required.".into()))?;
    system_mapping_scope(&db, session.user_id, system_id).await?;
    let team_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT t.cluster_id, c.type::TEXT AS cluster_type FROM teams t JOIN clusters c ON c.id = t.cluster_id
           WHERE t.id = $1 AND t.expires_after IS NULL LIMIT 1"#,
        [team_id.into()],
    )).await.map_err(db_err)?;
    let team = team_rows.first().ok_or_else(|| AppError::NotFound("Team not found.".into()))?;
    let team_type: String = team.try_get("", "cluster_type").unwrap_or_default();
    if team_type != "vendor" && team_type != "agency" {
        return Err(AppError::Validation("Only vendor and agency teams can be mapped to systems.".into()));
    }
    let team_cluster: Uuid = team.try_get("", "cluster_id").unwrap_or(Uuid::nil());
    let sys_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT agency_cluster_id FROM systems WHERE id = $1 AND expires_after IS NULL LIMIT 1",
        [system_id.into()],
    )).await.map_err(db_err)?;
    let sys = sys_rows.first().ok_or_else(|| AppError::Validation("The specified system does not exist.".into()))?;
    let agency: Uuid = sys.try_get("", "agency_cluster_id").unwrap_or(Uuid::nil());
    let allowed = if team_type == "vendor" {
        let v = db.query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM system_vendor_clusters WHERE system_id = $1 AND cluster_id = $2 AND expires_after IS NULL LIMIT 1",
            [system_id.into(), team_cluster.into()],
        )).await.map_err(db_err)?;
        !v.is_empty()
    } else {
        team_cluster == agency
    };
    if !allowed {
        return Err(AppError::Validation("This team's cluster is not one of this system's assigned clusters.".into()));
    }
    let dup = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM team_system_mappings WHERE team_id = $1 AND system_id = $2 AND expires_after IS NULL LIMIT 1",
        [team_id.into(), system_id.into()],
    )).await.map_err(db_err)?;
    if !dup.is_empty() {
        return Err(AppError::Validation("This team is already mapped to this system.".into()));
    }
    let mapping_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO team_system_mappings (id, team_id, system_id, created_by, created_at) VALUES ($1,$2,$3,$4,now())",
        [mapping_id.into(), team_id.into(), system_id.into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'team_system_mapping.created','team_system_mapping',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), mapping_id.to_string().into(), json!({ "teamId": team_id, "systemId": system_id }).into()],
    )).await.map_err(db_err)?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "mapping": { "id": mapping_id, "teamId": team_id, "systemId": system_id } }))))
}

pub async fn delete_team_system_mapping(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT team_id, system_id FROM team_system_mappings WHERE id = $1 AND expires_after IS NULL LIMIT 1",
        [id.into()],
    )).await.map_err(db_err)?;
    let r = rows.first().ok_or_else(|| AppError::NotFound("Mapping not found.".into()))?;
    let system_id: Uuid = r.try_get("", "system_id").unwrap_or(Uuid::nil());
    let team_id: Uuid = r.try_get("", "team_id").unwrap_or(Uuid::nil());
    system_mapping_scope(&db, session.user_id, system_id).await?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE team_system_mappings SET expires_after = now() WHERE id = $1",
        [id.into()],
    )).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'team_system_mapping.invalidated','team_system_mapping',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), id.to_string().into(), json!({ "teamId": team_id, "systemId": system_id }).into()],
    )).await.map_err(db_err)?;
    Ok(Json(json!({ "message": "Mapping deleted successfully." })))
}
