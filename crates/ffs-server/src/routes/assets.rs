//! Non-admin asset search (addendum-039): hostname autocomplete for submitters.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
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
    errors::{AppError, RouteResult},
};

fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB error: {}", e))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    #[serde(default)]
    q: String,
}

async fn can_submit(db: &DatabaseConnection, user_id: Uuid, system_id: Uuid) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1
               FROM systems s
               JOIN team_memberships tm ON tm.user_id = $2 AND tm.expires_after IS NULL
               JOIN system_workflow_steps sws ON sws.system_id = s.id AND sws.ordinal = 1 AND sws.expires_after IS NULL
               JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
                 AND t.cluster_id = sws.cluster_id AND t.level = sws.level
               WHERE s.id = $1 AND s.expires_after IS NULL
                 AND (
                   (SELECT affiliation::TEXT FROM users WHERE id = $2) <> 'vendor'
                   OR EXISTS (
                     SELECT 1 FROM organization_memberships om
                     JOIN system_organizations so ON so.organization_id = om.organization_id AND so.expires_after IS NULL
                     WHERE om.user_id = $2 AND om.expires_after IS NULL AND so.system_id = s.id
                   )
                 )
               LIMIT 1"#,
            [system_id.into(), user_id.into()],
        ))
        .await
        .map_err(db_err)?;
    Ok(!rows.is_empty())
}

pub async fn search_assets(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(system_id): Path<Uuid>,
    Query(query): Query<SearchQuery>,
) -> RouteResult<impl IntoResponse> {
    let exists = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM systems WHERE id = $1 LIMIT 1",
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    if exists.is_empty() {
        return Err(AppError::NotFound("System not found.".to_string()));
    }
    let q = query.q.trim();
    if q.chars().count() < 4 {
        return Err(AppError::Validation("q must be at least 4 characters.".to_string()));
    }
    if !can_submit(&db, session.user_id, system_id).await? {
        return Err(AppError::Authorization(
            "You are not authorized to submit requests for this system.".to_string(),
        ));
    }
    let pattern = format!("{}%", q.replace('%', "\\%").replace('_', "\\_"));
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, hostname, credential_name, credential_type::TEXT AS credential_type,
                      management_mode::TEXT AS management_mode, description, service
               FROM assets
               WHERE system_id = $1 AND expires_after IS NULL AND hostname ILIKE $2 ESCAPE '\'
               ORDER BY hostname LIMIT 50"#,
            [system_id.into(), pattern.into()],
        ))
        .await
        .map_err(db_err)?;
    let assets: Vec<serde_json::Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
                "hostname": r.try_get::<String>("", "hostname").unwrap_or_default(),
                "credentialName": r.try_get::<String>("", "credential_name").unwrap_or_default(),
                "credentialType": r.try_get::<String>("", "credential_type").unwrap_or_default(),
                "managementMode": r.try_get::<String>("", "management_mode").unwrap_or_default(),
                "description": r.try_get::<Option<String>>("", "description").unwrap_or(None),
                "service": r.try_get::<Option<String>>("", "service").unwrap_or(None),
            })
        })
        .collect();
    Ok(Json(json!({ "assets": assets })))
}
