//! Custody exception HTTP validation boundary (Stage 5 negative guards only).
//! A valid report MUST NOT write anything until the custody workflow, upload
//! validation, audit and durable attachment storage are ported. Fail closed.
use std::sync::Arc;

use axum::{extract::{Extension, Multipart, Path, State}, http::StatusCode, response::{IntoResponse, Response}, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{auth::session::Session, config::Config, errors::{AppError, RouteResult}};

const INVALID: &str = "Invalid custody exception report.";

/// Called inside the owner-approval transaction. Only configured manual assets
/// get cases; request status and custody rows commit or roll back together.
pub(crate) async fn instantiate_for_approval(
    db: &impl ConnectionTrait, request_id: Uuid, system_id: Uuid,
) -> RouteResult<()> {
    let config_rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT stage::text, due_in_hours FROM system_custody_stage_configs WHERE system_id=$1 AND expires_after IS NULL",
        [system_id.into()])).await?;
    if config_rows.len() != 5 { return Ok(()); }
    let items = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT rci.id, rci.asset_id, a.hostname, a.credential_name, a.service, a.description
            FROM request_credential_items rci JOIN assets a ON a.id=rci.asset_id
            WHERE rci.request_id=$1 AND rci.management_mode='manual' AND a.expires_after IS NULL
            ORDER BY rci.created_at, rci.id"#,
        [request_id.into()])).await?;
    if items.is_empty() { return Ok(()); }
    // A reset/reapproval must not create duplicate cases for the same open run.
    let prior = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id FROM request_asset_custody_runs WHERE request_id=$1 AND status='in_progress'",
        [request_id.into()])).await?;
    if prior.is_some() { return Ok(()); }
    let prepare_hours: Option<i32> = config_rows.iter().find(|r|
        r.try_get::<String>("", "stage").ok().as_deref() == Some("prepare"))
        .and_then(|r| r.try_get("", "due_in_hours").ok().flatten());
    let due_at = prepare_hours.map(|hours| chrono::Utc::now() + chrono::Duration::hours(i64::from(hours)));
    let run_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO request_asset_custody_runs (id,request_id,system_id) VALUES ($1,$2,$3)",
        [run_id.into(), request_id.into(), system_id.into()])).await?;
    for item in items {
        let request_item_id: Uuid = item.try_get("", "id")?;
        let asset_id: Uuid = item.try_get("", "asset_id")?;
        let hostname: String = item.try_get("", "hostname")?;
        let credential_name: String = item.try_get("", "credential_name")?;
        let service: Option<String> = item.try_get("", "service")?;
        let description: Option<String> = item.try_get("", "description")?;
        let run_item_id = Uuid::now_v7();
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO request_asset_custody_run_items (id,run_id,request_id,request_item_id,asset_id) VALUES ($1,$2,$3,$4,$5)",
            [run_item_id.into(), run_id.into(), request_id.into(), request_item_id.into(), asset_id.into()])).await?;
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            r#"INSERT INTO request_asset_custody_cases
               (id,run_item_id,run_id,request_id,request_item_id,asset_id,
                asset_tag_snapshot,hostname_snapshot,credential_name_snapshot,
                service_snapshot,description_snapshot,expected_location_snapshot,due_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$10,$11)"#,
            [Uuid::now_v7().into(), run_item_id.into(), run_id.into(), request_id.into(),
                request_item_id.into(), asset_id.into(), hostname.into(), credential_name.into(),
                service.into(), description.into(), due_at.into()])).await?;
    }
    Ok(())
}

/// Initial relational read model. Action transitions and evidence hydration are
/// separate Stage 5 work; never report a case without its persisted row.
pub(crate) async fn read_model(db: &DatabaseConnection, request_id: Uuid, viewer: Uuid) -> RouteResult<Option<JsonValue>> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT id, request_item_id, asset_id, asset_tag_snapshot, credential_name_snapshot,
                  serial_number_snapshot, expected_location_snapshot, state::text,
                  current_custodian_user_id, attention_required, due_at
           FROM request_asset_custody_cases WHERE request_id=$1 ORDER BY created_at,id"#,
        [request_id.into()])).await?;
    if rows.is_empty() { return Ok(None); }
    let config = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT prep.agency_team_id AS prep_team,
                  hand.agency_team_id AS hand_team
           FROM breakglass_requests req
           JOIN system_custody_stage_configs prep ON prep.system_id=req.system_id AND prep.stage='prepare' AND prep.expires_after IS NULL
           JOIN system_custody_stage_configs hand ON hand.system_id=req.system_id AND hand.stage='initiate_handover' AND hand.expires_after IS NULL
           WHERE req.id=$1"#,
        [request_id.into()])).await?;
    let can_prepare = if let Some(ref cfg) = config {
        let prep: Uuid = cfg.try_get("", "prep_team")?;
        let member = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT 1 FROM team_memberships WHERE team_id=$1 AND user_id=$2 AND expires_after IS NULL",
            [prep.into(), viewer.into()])).await?;
        member.is_some()
    } else { false };
    let combined = can_prepare && config.as_ref().is_some_and(|cfg| {
        cfg.try_get::<Uuid>("", "prep_team").ok() == cfg.try_get::<Uuid>("", "hand_team").ok()
    });
    let mut returned = 0;
    let mut exceptions = 0;
    let mut awaiting = 0;
    let mut cases = Vec::with_capacity(rows.len());
    for r in &rows {
        let state: String = r.try_get("", "state")?;
        let attention: bool = r.try_get("", "attention_required")?;
        if state == "returned_to_inventory" { returned += 1; }
        if attention { exceptions += 1; }
        let actions: Vec<&str> = if state == "awaiting_preparation" && can_prepare {
            vec![if combined { "prepare_and_handover" } else { "confirm_preparation" }]
        } else { vec![] }; // remaining state actions are not yet ported
        if !actions.is_empty() { awaiting += 1; }
        cases.push(json!({
            "id": r.try_get::<Uuid>("", "id")?,
            "requestItemId": r.try_get::<Uuid>("", "request_item_id")?,
            "assetId": r.try_get::<Uuid>("", "asset_id")?,
            "assetTag": r.try_get::<Option<String>>("", "asset_tag_snapshot")?,
            "displayName": r.try_get::<String>("", "credential_name_snapshot")?,
            "serialNumber": r.try_get::<Option<String>>("", "serial_number_snapshot")?,
            "expectedLocation": r.try_get::<Option<String>>("", "expected_location_snapshot")?,
            "state": state,
            "currentCustodian": JsonValue::Null,
            "attentionRequired": attention,
            "dueAt": r.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>>("", "due_at")?.map(|t| t.to_rfc3339()),
            "availableActions": actions,
            "activeException": JsonValue::Null,
            "events": [],
        }));
    }
    let total = cases.len();
    Ok(Some(json!({
        "status": if exceptions > 0 { "attention_required" } else if returned == total { "completed" } else { "in_progress" },
        "totalCount": total, "returnedCount": returned,
        "awaitingActionCount": awaiting, "exceptionCount": exceptions, "cases": cases,
    })))
}

pub async fn post_exception(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id): Path<String>,
    mut multipart: Multipart,
) -> RouteResult<Response> {
    // Resolve and authorize BEFORE inspecting fields, as in the legacy route.
    let id = request_id.parse::<Uuid>().map_err(|_| AppError::not_found("Request not found."))?;
    let request = super::requests::get_request_row(&db, id).await?
        .ok_or_else(|| AppError::not_found("Request not found."))?;
    if !super::requests::req_can_view(&db, session.user_id, &request).await? {
        return Err(AppError::not_found("Request not found."));
    }

    let mut case_id = String::new();
    let mut exception_type = String::new();
    let mut description = String::new();
    let mut attachment_count = 0usize;
    let mut non_file_attachment = false;
    while let Some(field) = multipart.next_field().await.map_err(|_| AppError::validation(INVALID))? {
        let name = field.name().unwrap_or_default().to_string();
        if name == "attachments" {
            attachment_count += 1;
            non_file_attachment |= field.file_name().is_none();
            // Do not persist or trust uploads: the positive path remains unimplemented.
            continue;
        }
        match name.as_str() {
            "custodyCaseId" => case_id = field.text().await.map_err(|_| AppError::validation(INVALID))?,
            "exceptionType" => exception_type = field.text().await.map_err(|_| AppError::validation(INVALID))?,
            "description" => description = field.text().await.map_err(|_| AppError::validation(INVALID))?,
            _ => {},
        }
    }
    let case_id = case_id.parse::<Uuid>().map_err(|_| AppError::validation(INVALID))?;
    if !matches!(exception_type.as_str(),
        "missing" | "damaged" | "wrong_item" | "identity_mismatch" | "quantity_mismatch"
        | "handover_disputed" | "receipt_disputed" | "return_disputed" | "unavailable" | "other")
        || description.trim().is_empty() || description.trim().chars().count() > 4000
    {
        return Err(AppError::validation(INVALID));
    }
    if attachment_count > 20 || non_file_attachment {
        return Err(AppError::validation("Attachments must be files (maximum 20)."));
    }

    let exists = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id FROM request_asset_custody_cases WHERE id = $1 AND request_id = $2",
        [case_id.into(), id.into()])).await?.is_some();
    if !exists { return Err(AppError::not_found("Custody case not found.")); }
    // Explicitly refuse a valid existing case rather than acknowledge a report
    // that was never recorded. The positive custody flow is a later stage.
    Ok((StatusCode::NOT_IMPLEMENTED, Json(json!({"error":"Custody exception reporting is not implemented."}))).into_response())
}
