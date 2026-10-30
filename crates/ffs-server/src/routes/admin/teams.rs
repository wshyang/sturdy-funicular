// Admin teams route handlers.
// Importers/callers: main.rs → GET /admin/teams, POST /admin/teams.
// Affected API: list_teams (TeamRead), create_team (TeamCreate).
// Data schemas: teams + clusters JOIN (AdminTeamRow from db::teams).
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
        clusters,
        teams::{self, CreateTeamInput},
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

fn team_row_json(r: &teams::AdminTeamRow) -> JsonValue {
    json!({
        "id": r.team.id,
        "clusterId": r.team.cluster_id,
        "name": r.team.name,
        "level": r.team.level,
        "description": r.team.description,
        "createdBy": r.team.created_by,
        "createdAt": r.team.created_at.to_rfc3339(),
        "updatedAt": r.team.updated_at.to_rfc3339(),
        "expiresAfter": r.team.expires_after.map(|t| t.to_rfc3339()),
        "type": r.cluster_type,
        "clusterName": r.cluster_name,
        "organizationId": r.organization_id,
    })
}

// ── GET /admin/teams ──────────────────────────────────────────────────────────

pub async fn list_teams(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "TeamRead").await?;

    let all = teams::list_live_enriched(&db).await?;
    let visible: Vec<_> = match &scope {
        ScopeKind::Global => all,
        ScopeKind::Scoped(org_ids) => all
            .into_iter()
            .filter(|r| r.organization_id.map_or(false, |oid| org_ids.contains(&oid)))
            .collect(),
        ScopeKind::None => {
            return Err(AppError::Authorization(
                "You do not have permission to access teams.".to_string(),
            ));
        }
    };

    let result: Vec<JsonValue> = visible.iter().map(team_row_json).collect();
    Ok(Json(json!({ "teams": result })))
}

// ── POST /admin/teams ─────────────────────────────────────────────────────────

pub async fn create_team(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "TeamCreate").await?;

    let name = body["name"]
        .as_str()
        .ok_or_else(|| AppError::Validation("name is required.".to_string()))?
        .trim()
        .to_owned();
    if name.is_empty() {
        return Err(AppError::Validation("Team name is required.".to_string()));
    }
    if name.len() > 100 {
        return Err(AppError::Validation("Team name is too long (max 100 characters).".to_string()));
    }

    let cluster_id_str = body["clusterId"]
        .as_str()
        .ok_or_else(|| AppError::Validation("clusterId is required.".to_string()))?;
    let cluster_id = cluster_id_str
        .parse::<Uuid>()
        .map_err(|_| AppError::Validation("clusterId must be a valid UUID.".to_string()))?;

    let level = body["level"]
        .as_i64()
        .ok_or_else(|| AppError::Validation("level is required.".to_string()))?;
    if !(1..=5).contains(&level) {
        return Err(AppError::Validation("level must be between 1 and 5.".to_string()));
    }
    let level = level as i16;

    let description: Option<String> = body["description"]
        .as_str()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());

    // Cluster must exist.
    let cluster = clusters::get_live(&db, cluster_id)
        .await?
        .ok_or_else(|| AppError::Validation("The specified cluster does not exist.".to_string()))?;
    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&cluster.organization_id) {
            return Err(AppError::Validation(
                "Organisation selection is outside your granted organisations.".to_string(),
            ));
        }
    }

    // Scoped create: cluster's org must be in granted orgs.
    if let ScopeKind::Scoped(org_ids) = &scope {
        if !org_ids.contains(&cluster.organization_id) {
            return Err(AppError::Validation(
                "Organisation selection is outside your granted organisations.".to_string(),
            ));
        }
    }

    // Level uniqueness within cluster.
    if let Some(existing_name) = teams::level_taken(&db, cluster_id, level).await? {
        return Err(AppError::Validation(format!(
            "Level {} is already used by \"{}\" in this cluster.",
            level, existing_name
        )));
    }

    // Name uniqueness within cluster.
    if teams::name_taken_in_cluster(&db, cluster_id, &name).await? {
        return Err(AppError::Validation(
            "A team with this name already exists in this cluster.".to_string(),
        ));
    }

    let new_id = Uuid::now_v7();
    teams::create(
        &db,
        CreateTeamInput {
            id: new_id,
            cluster_id,
            name: name.clone(),
            level,
            description,
            created_by: session.user_id,
        },
    )
    .await?;

    let created = teams::get_live(&db, new_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("team not found after insert")))?;
    audit_team(&db, session.user_id, "team.created", new_id,
        json!({ "name": name, "clusterId": cluster_id, "level": level, "type": cluster.type_, "createdBy": session.user_id })).await?;

    let team_json = json!({
        "id": created.id,
        "clusterId": created.cluster_id,
        "name": created.name,
        "level": created.level,
        "description": created.description,
        "createdBy": created.created_by,
        "createdAt": created.created_at.to_rfc3339(),
        "updatedAt": created.updated_at.to_rfc3339(),
        "expiresAfter": created.expires_after.map(|t| t.to_rfc3339()),
    });

    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({ "team": team_json })),
    ))
}


async fn audit_team(db: &DatabaseConnection, actor: Uuid, action: &str, target_id: Uuid, details: JsonValue) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,'team',$4,$5)",
        [Uuid::now_v7().into(), actor.into(), action.into(), target_id.to_string().into(), details.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("audit: {}", e)))?;
    Ok(())
}

fn raw_team_json(t: &teams::Team) -> JsonValue {
    json!({
        "id": t.id, "clusterId": t.cluster_id, "name": t.name, "level": t.level,
        "description": t.description, "createdBy": t.created_by,
        "createdAt": t.created_at.to_rfc3339(), "updatedAt": t.updated_at.to_rfc3339(),
        "expiresAfter": t.expires_after.map(|x| x.to_rfc3339()),
    })
}

async fn team_scope_404(db: &DatabaseConnection, user_id: Uuid, cap: &str, team_id: Uuid) -> Result<teams::Team, AppError> {
    let scope = require_capability(db, user_id, cap).await?;
    let team = teams::get_live(db, team_id).await?
        .ok_or_else(|| AppError::NotFound("Team not found.".to_string()))?;
    if let ScopeKind::Scoped(org_ids) = scope {
        let cl = clusters::get_live(db, team.cluster_id).await?;
        if !cl.map(|c| org_ids.contains(&c.organization_id)).unwrap_or(false) {
            return Err(AppError::NotFound("Team not found.".to_string()));
        }
    }
    Ok(team)
}

pub async fn update_team(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(team_id): Path<Uuid>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let team = team_scope_404(&db, session.user_id, "TeamUpdate", team_id).await?;
    let name = body.get("name").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
    if let Some(ref n) = name {
        if n.is_empty() || n.chars().count() > 100 {
            return Err(AppError::Validation("Team name is required and must be 1-100 characters.".to_string()));
        }
        let clash = db.query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM teams WHERE cluster_id = $1 AND name = $2 AND id <> $3 AND expires_after IS NULL LIMIT 1",
            [team.cluster_id.into(), n.clone().into(), team_id.into()],
        )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
        if !clash.is_empty() {
            return Err(AppError::Validation("A team with this name already exists in this cluster.".to_string()));
        }
    }
    let description = if body.get("description").is_some() {
        let d = body["description"].as_str().unwrap_or("");
        if d.chars().count() > 500 {
            return Err(AppError::Validation("Team description must be 500 characters or fewer.".to_string()));
        }
        Some(if d.is_empty() { None } else { Some(d.to_string()) })
    } else { None };
    if name.is_none() && description.is_none() {
        return Err(AppError::Validation("No fields to update.".to_string()));
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE teams SET name = COALESCE($1, name), description = CASE WHEN $2::boolean THEN $3 ELSE description END, updated_at = now() WHERE id = $4",
        [name.clone().into(), description.is_some().into(), description.flatten().into(), team_id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    audit_team(&db, session.user_id, "team.updated", team_id,
        json!({ "changedFields": [if name.is_some() {"name"} else {"description"}], "oldValues": { "name": team.name, "description": team.description } })).await?;
    let updated = teams::get_live(&db, team_id).await?.unwrap();
    Ok(Json(json!({ "team": raw_team_json(&updated) })))
}

pub async fn delete_team(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(team_id): Path<Uuid>,
    body: Option<Json<JsonValue>>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let team = team_scope_404(&db, session.user_id, "TeamDelete", team_id).await?;
    let force = body.map(|Json(b)| b["force"].as_bool().unwrap_or(false)).unwrap_or(false);
    let refs = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT DISTINCT sws.system_id FROM system_workflow_steps sws
           JOIN systems s ON s.id = sws.system_id AND s.expires_after IS NULL
           WHERE sws.cluster_id = $1 AND sws.level = $2 AND sws.expires_after IS NULL"#,
        [team.cluster_id.into(), team.level.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    if !refs.is_empty() && !force {
        return Err(AppError::Validation(format!(
            "Team is referenced by {} live system workflow(s); deleting it would orphan their approval routing. Retry with force to acknowledge the cascade.",
            refs.len()
        )));
    }
    let memberships = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id, user_id FROM team_memberships WHERE team_id = $1 AND expires_after IS NULL",
        [team_id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    for m in &memberships {
        let mid: Uuid = m.try_get("", "id").unwrap();
        let uid: Uuid = m.try_get("", "user_id").unwrap();
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE team_memberships SET expires_after = now() WHERE id = $1", [mid.into()])).await.unwrap();
        audit_team(&db, session.user_id, "team_membership.auto_removed", mid,
            json!({ "userId": uid, "teamId": team_id, "trigger": "team_deleted" })).await?;
    }
    let mappings = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id, system_id FROM team_system_mappings WHERE team_id = $1 AND expires_after IS NULL",
        [team_id.into()],
    )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    for m in &mappings {
        let mid: Uuid = m.try_get("", "id").unwrap();
        let sid: Uuid = m.try_get("", "system_id").unwrap();
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE team_system_mappings SET expires_after = now() WHERE id = $1", [mid.into()])).await.unwrap();
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'team_system_mapping.invalidated','team_system_mapping',$3,$4)",
            [Uuid::now_v7().into(), session.user_id.into(), mid.to_string().into(), json!({ "teamId": team_id, "systemId": sid }).into()])).await.unwrap();
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE teams SET expires_after = now(), updated_at = now() WHERE id = $1", [team_id.into()])).await.unwrap();
    audit_team(&db, session.user_id, "team.invalidated", team_id,
        json!({ "name": team.name, "clusterId": team.cluster_id, "level": team.level, "member_count_at_deletion": memberships.len() })).await?;
    Ok(Json(json!({ "message": "Team deleted successfully." })))
}
