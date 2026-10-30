// Audit route handlers — request timeline.
// GET /audit/request/:id — returns a timeline of owner-decision events for a breakglass request.
//
// Importers/callers:
//   - main.rs: GET /audit/request/:id → audit::get_request_audit
//   - routes/mod.rs: pub mod audit
// Affected API: GET /audit/request/:id
//   Response: { timeline: [{ action: string, details: { pa_team_notified: bool } }] }
// Data schemas:
//   - breakglass_requests (id UUID, status request_status)
//   - sent_notifications (trigger_key email_trigger_key, related_target_type audit_target_type,
//                         related_target_id TEXT)
// User instruction: "Fix the rust port to ensure API and Playwright suites pass."

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DbBackend, DatabaseConnection, Statement};
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

pub async fn get_request_audit(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
) -> RouteResult<impl IntoResponse> {
    let _user_id = session.user_id;
    let request_id = request_id_str.parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let req_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT status::TEXT FROM breakglass_requests WHERE id = $1 LIMIT 1"#,
        [request_id.into()],
    )).await.map_err(db_err)?;
    if req_rows.is_empty() {
        return Err(AppError::NotFound("Request not found.".into()));
    }

    let pa_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT 1 FROM sent_notifications
           WHERE trigger_key = 'request.owner_approved_pa_team'
             AND related_target_type = 'breakglass_request'
             AND related_target_id = $1
           LIMIT 1"#,
        [request_id.to_string().into()],
    )).await.map_err(db_err)?;
    let pa_team_notified = !pa_rows.is_empty();

    let owner_approved_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT 1 FROM sent_notifications
           WHERE trigger_key = 'request.owner_approved_submitter'
             AND related_target_type = 'breakglass_request'
             AND related_target_id = $1
           LIMIT 1"#,
        [request_id.to_string().into()],
    )).await.map_err(db_err)?;

    let mut timeline = Vec::new();
    if !owner_approved_rows.is_empty() {
        timeline.push(json!({
            "action": "request.owner_approved",
            "details": { "pa_team_notified": pa_team_notified }
        }));
    }

    Ok(Json(json!({ "timeline": timeline })).into_response())
}
