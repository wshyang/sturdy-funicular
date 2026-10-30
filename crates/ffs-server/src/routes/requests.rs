// Request workflow route handlers — submit, step-decision, owner-decision,
// issue-credential, close. Parity target: server/routes/requests/*.tsx.
//
// State machine transitions inlined from workflow-machine.tsx (pure XState logic).
// No XState in Rust; transition table small enough to model directly.

use std::sync::Arc;

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use chrono::Utc;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    errors::{AppError, RouteResult},
};

// ── State machine (inlined from workflow-machine.tsx) ─────────────────────────

struct NextState {
    status: &'static str,
    current_step_ordinal: i16,
}

fn step_approve_next(has_next_step: bool, next_ordinal: i16) -> NextState {
    if has_next_step {
        NextState { status: "under_review", current_step_ordinal: next_ordinal }
    } else {
        NextState { status: "under_review", current_step_ordinal: 0 }
    }
}

fn step_return_next(current_ordinal: i16) -> NextState {
    NextState { status: "returned_to_vendor", current_step_ordinal: current_ordinal }
}

fn step_reject_next(current_ordinal: i16) -> NextState {
    NextState { status: "rejected", current_step_ordinal: current_ordinal }
}

fn owner_approve_next() -> NextState {
    NextState { status: "approved", current_step_ordinal: 0 }
}

fn owner_return_next(current_ordinal: i16) -> NextState {
    NextState { status: "returned_to_vendor", current_step_ordinal: current_ordinal }
}

fn owner_reject_next(current_ordinal: i16) -> NextState {
    NextState { status: "rejected", current_step_ordinal: current_ordinal }
}

fn issue_credential_next() -> NextState {
    NextState { status: "credential_issued", current_step_ordinal: 0 }
}

fn close_next() -> NextState {
    NextState { status: "closed", current_step_ordinal: 0 }
}

// ── DB error helper ───────────────────────────────────────────────────────────

fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB: {}", e))
}

// ── Authorization helpers ─────────────────────────────────────────────────────

async fn can_submit(db: &DatabaseConnection, user_id: Uuid, system_id: Uuid) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT
                 u.affiliation::TEXT,
                 EXISTS(
                   SELECT 1 FROM team_memberships tm
                   JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
                   JOIN system_workflow_steps sws
                     ON sws.cluster_id = t.cluster_id
                    AND sws.level = t.level
                    AND sws.system_id = $1
                    AND sws.ordinal = 1
                    AND sws.expires_after IS NULL
                   WHERE tm.user_id = $2 AND tm.expires_after IS NULL
                 ) AS is_submitter,
                 EXISTS(
                   SELECT 1 FROM organization_memberships om
                   JOIN system_organizations so ON so.organization_id = om.organization_id
                   WHERE om.user_id = $2 AND om.expires_after IS NULL
                     AND so.system_id = $1 AND so.expires_after IS NULL
                 ) AS serves_org
               FROM users u WHERE u.id = $2 AND u.status = 'active'"#,
            [system_id.into(), user_id.into()],
        ))
        .await
        .map_err(db_err)?;

    if rows.is_empty() {
        return Ok(false);
    }
    let row = &rows[0];
    let is_submitter: bool = row.try_get("", "is_submitter")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("read is_submitter: {}", e)))?;
    if !is_submitter {
        return Ok(false);
    }
    let affiliation: Option<String> = row.try_get("", "affiliation").ok().flatten();
    if affiliation.as_deref() == Some("vendor") {
        let serves_org: bool = row.try_get("", "serves_org")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("read serves_org: {}", e)))?;
        return Ok(serves_org);
    }
    Ok(true)
}

async fn resolve_submitter_cluster(
    db: &DatabaseConnection,
    user_id: Uuid,
    system_id: Uuid,
) -> Result<Option<Uuid>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT t.cluster_id
               FROM team_memberships tm
               JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
               JOIN system_workflow_steps sws
                 ON sws.cluster_id = t.cluster_id
                AND sws.level = t.level
                AND sws.system_id = $1
                AND sws.ordinal = 1
                AND sws.expires_after IS NULL
               WHERE tm.user_id = $2 AND tm.expires_after IS NULL
               LIMIT 1"#,
            [system_id.into(), user_id.into()],
        ))
        .await
        .map_err(db_err)?;

    if rows.is_empty() {
        return Ok(None);
    }
    let cluster_id: Uuid = rows[0]
        .try_get("", "cluster_id")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("read cluster_id: {}", e)))?;
    Ok(Some(cluster_id))
}

async fn can_review(db: &DatabaseConnection, user_id: Uuid, system_id: Uuid) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT
                 u.affiliation::TEXT,
                 EXISTS(
                   SELECT 1 FROM team_memberships tm
                   JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
                   JOIN system_workflow_steps sws
                     ON sws.cluster_id = t.cluster_id
                    AND sws.level = t.level
                    AND sws.system_id = $1
                    AND sws.ordinal > 1
                    AND sws.expires_after IS NULL
                   WHERE tm.user_id = $2 AND tm.expires_after IS NULL
                 ) AS is_reviewer,
                 EXISTS(
                   SELECT 1 FROM organization_memberships om
                   JOIN system_organizations so ON so.organization_id = om.organization_id
                   WHERE om.user_id = $2 AND om.expires_after IS NULL
                     AND so.system_id = $1 AND so.expires_after IS NULL
                 ) AS serves_org
               FROM users u WHERE u.id = $2 AND u.status = 'active'"#,
            [system_id.into(), user_id.into()],
        ))
        .await
        .map_err(db_err)?;

    if rows.is_empty() {
        return Ok(false);
    }
    let row = &rows[0];
    let is_reviewer: bool = row.try_get("", "is_reviewer")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("read is_reviewer: {}", e)))?;
    if !is_reviewer {
        return Ok(false);
    }
    let affiliation: Option<String> = row.try_get("", "affiliation").ok().flatten();
    if affiliation.as_deref() == Some("vendor") {
        let serves_org: bool = row.try_get("", "serves_org")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("read serves_org: {}", e)))?;
        return Ok(serves_org);
    }
    Ok(true)
}

async fn is_step_reviewer(
    db: &DatabaseConnection,
    user_id: Uuid,
    required_cluster_id: Uuid,
    required_level: i16,
) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 FROM team_memberships tm
               JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
               WHERE tm.user_id = $1 AND tm.expires_after IS NULL
                 AND t.cluster_id = $2 AND t.level = $3
               LIMIT 1"#,
            [user_id.into(), required_cluster_id.into(), required_level.into()],
        ))
        .await
        .map_err(db_err)?;
    Ok(!rows.is_empty())
}

async fn can_approve(db: &DatabaseConnection, user_id: Uuid, system_id: Uuid) -> Result<bool, AppError> {
    let owner_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 FROM system_owners
               WHERE system_id = $1 AND user_id = $2 AND expires_after IS NULL
               LIMIT 1"#,
            [system_id.into(), user_id.into()],
        ))
        .await
        .map_err(db_err)?;
    if !owner_rows.is_empty() {
        return Ok(true);
    }

    let delegate_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT active_from, active_until FROM system_delegates
               WHERE system_id = $1 AND delegate_user_id = $2 AND expires_after IS NULL
               LIMIT 1"#,
            [system_id.into(), user_id.into()],
        ))
        .await
        .map_err(db_err)?;

    for row in &delegate_rows {
        let active_from: Option<chrono::DateTime<Utc>> = row.try_get("", "active_from").ok().flatten();
        let active_until: Option<chrono::DateTime<Utc>> = row.try_get("", "active_until").ok().flatten();
        let now = Utc::now();
        if let Some(from) = active_from {
            if now < from {
                continue;
            }
        }
        if let Some(until) = active_until {
            if now >= until {
                continue;
            }
        }
        return Ok(true);
    }
    Ok(false)
}

async fn user_serves_system_orgs(
    db: &DatabaseConnection,
    user_id: Uuid,
    system_id: Uuid,
) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT u.affiliation::TEXT,
                 EXISTS(
                   SELECT 1 FROM organization_memberships om
                   JOIN system_organizations so ON so.organization_id = om.organization_id
                   WHERE om.user_id = $1 AND om.expires_after IS NULL
                     AND so.system_id = $2 AND so.expires_after IS NULL
                 ) AS serves_org
               FROM users u WHERE u.id = $1 AND u.status = 'active'"#,
            [user_id.into(), system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    if rows.is_empty() {
        return Ok(false);
    }
    let affiliation: Option<String> = rows[0].try_get("", "affiliation").ok().flatten();
    if affiliation.as_deref() == Some("vendor") {
        let serves_org: bool = rows[0].try_get("", "serves_org")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("read serves_org: {}", e)))?;
        return Ok(serves_org);
    }
    Ok(true)
}

// ── Request number generation ─────────────────────────────────────────────────

pub async fn next_request_sequence(
    db: &DatabaseConnection,
    short_code: &str,
    seq_date: &str,
) -> Result<i32, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO request_number_sequences (system_short_code, seq_date, counter)
               VALUES ($1, $2::date, 1)
               ON CONFLICT (system_short_code, seq_date) DO UPDATE
                 SET counter = request_number_sequences.counter + 1
               RETURNING counter"#,
            [short_code.to_owned().into(), seq_date.to_owned().into()],
        ))
        .await
        .map_err(db_err)?;

    let counter: i32 = rows[0]
        .try_get("", "counter")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("read counter: {}", e)))?;
    Ok(counter)
}

fn generate_request_number(short_code: &str, date: &chrono::DateTime<Utc>, seq: i32) -> String {
    let date_str = date.format("%Y%m%d").to_string();
    let seq_str = if seq < 1000 { format!("{:03}", seq) } else { seq.to_string() };
    format!("BG-{}-{}-{}", short_code, date_str, seq_str)
}

// ── Email notification helpers ────────────────────────────────────────────────

async fn insert_notification(
    db: &DatabaseConnection,
    trigger_key: &str,
    target_id: Uuid,
    emails: &[String],
) -> Result<(), AppError> {
    if emails.is_empty() { return Ok(()); }
    let ctx = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT r.request_number,r.sr_number,r.submitted_by,r.system_id,s.name AS system_name,u.full_name AS submitter_name
           FROM breakglass_requests r JOIN systems s ON s.id=r.system_id JOIN users u ON u.id=r.submitted_by
           WHERE r.id=$1"#, [target_id.into()])).await.map_err(db_err)?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;
    let created_by: Uuid = ctx.try_get("", "submitted_by").map_err(db_err)?;
    // Single-recipient notifications are scoped to that recipient; multi-recipient
    // team notifications use an unscoped locator plus live canViewRequest checks.
    let intended = if emails.len() == 1 {
        let r = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT id FROM users WHERE email=$1 LIMIT 1", [emails[0].clone().into()])).await.map_err(db_err)?;
        r.and_then(|r| r.try_get::<Uuid>("", "id").ok())
    } else { None };
    let link = crate::direct_links::create_direct_link_url(db, "breakglass_request", target_id, created_by, intended).await?;
    let mut data = std::collections::HashMap::new();
    for (k, col) in [("request_number","request_number"),("sr_number","sr_number"),("system_name","system_name"),("submitter_name","submitter_name")] {
        data.insert(k.to_string(), ctx.try_get::<String>("", col).unwrap_or_default());
    }
    data.insert("system_id".into(), ctx.try_get::<Uuid>("", "system_id").map(|v| v.to_string()).unwrap_or_default());
    data.insert("request_direct_link".into(), link);
    let Some(rendered) = crate::email_templates::render_notification(db, trigger_key, &data).await? else { return Ok(()); };
    let notification_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"INSERT INTO sent_notifications
             (id, trigger_key, rendered_subject, rendered_body_html, rendered_body_text,
              related_target_type, related_target_id)
           VALUES ($1, $2::email_trigger_key, $3, $4, $5, 'breakglass_request'::audit_target_type, $6)"#,
        [notification_id.into(), trigger_key.to_owned().into(), rendered.subject.into(),
         rendered.html.into(), rendered.plain_text.into(), target_id.to_string().into()])).await.map_err(db_err)?;
    for (i, email) in emails.iter().enumerate() {
        let user_rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT id, full_name FROM users WHERE email = $1 LIMIT 1", [email.clone().into()])).await.map_err(db_err)?;
        let (opt_uid, opt_name): (Option<Uuid>, Option<String>) = if let Some(r) = user_rows.first() {
            (Some(r.try_get("", "id").map_err(db_err)?), Some(r.try_get("", "full_name").map_err(db_err)?))
        } else { (None, None) };
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            r#"INSERT INTO notification_recipients
                 (id, notification_id, ordinal, recipient_user_id, email_snapshot, display_name_snapshot)
               VALUES ($1, $2, $3, $4, $5, $6)"#,
            [Uuid::now_v7().into(), notification_id.into(), ((i + 1) as i16).into(),
             opt_uid.into(), email.clone().into(), opt_name.into()])).await.map_err(db_err)?;
    }
    Ok(())
}

async fn resolve_team_emails(
    db: &DatabaseConnection,
    cluster_id: Uuid,
    level: i16,
) -> Result<Vec<String>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT DISTINCT u.email
               FROM team_memberships tm
               JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
               JOIN users u ON u.id = tm.user_id AND u.status = 'active'
               WHERE t.cluster_id = $1 AND t.level = $2 AND tm.expires_after IS NULL"#,
            [cluster_id.into(), level.into()],
        ))
        .await
        .map_err(db_err)?;
    rows.iter()
        .map(|r| r.try_get::<String>("", "email")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("email: {}", e))))
        .collect()
}

async fn get_primary_owner_email(db: &DatabaseConnection, system_id: Uuid) -> Result<Option<String>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT u.email FROM system_owners so
               JOIN users u ON u.id = so.user_id AND u.status = 'active'
               WHERE so.system_id = $1 AND so.kind = 'primary' AND so.expires_after IS NULL
               LIMIT 1"#,
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let email: String = rows[0].try_get("", "email")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("read owner email: {}", e)))?;
    Ok(Some(email))
}

async fn get_user_email(db: &DatabaseConnection, user_id: Uuid) -> Result<Option<String>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT email FROM users WHERE id = $1 AND status = 'active' LIMIT 1"#,
            [user_id.into()],
        ))
        .await
        .map_err(db_err)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let email: String = rows[0].try_get("", "email")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("read user email: {}", e)))?;
    Ok(Some(email))
}

async fn get_pa_team_emails(db: &DatabaseConnection, system_id: Uuid) -> Result<Vec<String>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT DISTINCT u.email
               FROM system_owners so
               JOIN system_owner_pa_mappings sopm ON sopm.system_owner_id = so.id
               JOIN team_memberships tm ON tm.team_id = sopm.pa_team_id AND tm.expires_after IS NULL
               JOIN users u ON u.id = tm.user_id AND u.status = 'active'
               WHERE so.system_id = $1 AND so.kind = 'primary' AND so.expires_after IS NULL"#,
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    rows.iter()
        .map(|r| r.try_get::<String>("", "email")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("pa email: {}", e))))
        .collect()
}

// ── Request/step row fetchers ─────────────────────────────────────────────────

#[allow(dead_code)]
pub(crate) struct RequestRow {
    id: Uuid,
    system_id: Uuid,
    submitted_by: Uuid,
    status: String,
    current_step_ordinal: i16,
    return_count: i32,
    request_number: String,
    owner_decision_by: Option<Uuid>,
    justification: String,
}

pub(crate) async fn get_request_row(db: &DatabaseConnection, request_id: Uuid) -> Result<Option<RequestRow>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, system_id, submitted_by, status::TEXT, current_step_ordinal, return_count,
                      request_number, owner_decision_by, justification
               FROM breakglass_requests WHERE id = $1"#,
            [request_id.into()],
        ))
        .await
        .map_err(db_err)?;

    if rows.is_empty() {
        return Ok(None);
    }
    let r = &rows[0];
    Ok(Some(RequestRow {
        id: r.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("id: {}", e)))?,
        system_id: r.try_get("", "system_id").map_err(|e| AppError::Internal(anyhow::anyhow!("system_id: {}", e)))?,
        submitted_by: r.try_get("", "submitted_by").map_err(|e| AppError::Internal(anyhow::anyhow!("submitted_by: {}", e)))?,
        status: r.try_get("", "status").map_err(|e| AppError::Internal(anyhow::anyhow!("status: {}", e)))?,
        current_step_ordinal: r.try_get("", "current_step_ordinal").map_err(|e| AppError::Internal(anyhow::anyhow!("ordinal: {}", e)))?,
        return_count: r.try_get("", "return_count").map_err(|e| AppError::Internal(anyhow::anyhow!("return_count: {}", e)))?,
        request_number: r.try_get("", "request_number").map_err(|e| AppError::Internal(anyhow::anyhow!("request_number: {}", e)))?,
        owner_decision_by: r.try_get("", "owner_decision_by").ok().flatten(),
        justification: r.try_get("", "justification").unwrap_or_default(),
    }))
}

struct StepRow {
    id: Uuid,
    required_cluster_id: Uuid,
    required_level: i16,
}

async fn get_step_by_ordinal(
    db: &DatabaseConnection,
    request_id: Uuid,
    ordinal: i16,
) -> Result<Option<StepRow>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, required_cluster_id, required_level
               FROM request_approval_steps
               WHERE request_id = $1 AND step_ordinal = $2 LIMIT 1"#,
            [request_id.into(), ordinal.into()],
        ))
        .await
        .map_err(db_err)?;
    if rows.is_empty() {
        return Ok(None);
    }
    let r = &rows[0];
    Ok(Some(StepRow {
        id: r.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("step id: {}", e)))?,
        required_cluster_id: r.try_get("", "required_cluster_id").map_err(|e| AppError::Internal(anyhow::anyhow!("req_cluster: {}", e)))?,
        required_level: r.try_get("", "required_level").map_err(|e| AppError::Internal(anyhow::anyhow!("req_level: {}", e)))?,
    }))
}

async fn step_has_next(db: &DatabaseConnection, request_id: Uuid, current_ordinal: i16) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 FROM request_approval_steps
               WHERE request_id = $1 AND step_ordinal = $2 LIMIT 1"#,
            [request_id.into(), (current_ordinal + 1).into()],
        ))
        .await
        .map_err(db_err)?;
    Ok(!rows.is_empty())
}

async fn check_override_eligible(
    db: &DatabaseConnection,
    user_id: Uuid,
    request_id: Uuid,
    current_ordinal: i16,
) -> Result<bool, AppError> {
    let steps = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT required_cluster_id, required_level
               FROM request_approval_steps
               WHERE request_id = $1 AND step_ordinal > $2
               ORDER BY step_ordinal ASC"#,
            [request_id.into(), current_ordinal.into()],
        ))
        .await
        .map_err(db_err)?;
    for row in &steps {
        let cluster: Uuid = row.try_get("", "required_cluster_id")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("override cluster: {}", e)))?;
        let level: i16 = row.try_get("", "required_level")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("override level: {}", e)))?;
        if is_step_reviewer(db, user_id, cluster, level).await? {
            return Ok(true);
        }
    }
    Ok(false)
}

// ── POST /requests ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialItemInput {
    asset_id: Option<String>,
    hostname_description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitRequestBody {
    system_id: Option<String>,
    justification: Option<String>,
    sr_number: Option<String>,
    activity_start_at: Option<String>,
    activity_end_at: Option<String>,
    credential_items: Option<Vec<CredentialItemInput>>,
    pub public_key: Option<String>,
}

pub async fn post_request(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Json(body): Json<SubmitRequestBody>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    if let Some(pk) = &body.public_key {
        if !crate::request_crypto::is_valid_public_key(pk) {
            return Err(AppError::Validation("Invalid public key — expected an RSA-OAEP-2048 SPKI public key.".into()));
        }
    }

    let system_id_str = body.system_id.as_deref().unwrap_or("");
    if system_id_str.is_empty() {
        return Err(AppError::Validation("System is required.".into()));
    }
    let system_id = system_id_str.parse::<Uuid>()
        .map_err(|_| AppError::Validation("System is required.".into()))?;

    let justification = body.justification.as_deref().unwrap_or("").trim().to_string();
    if justification.len() < 20 {
        return Err(AppError::Validation("Justification must be at least 20 characters.".into()));
    }
    if justification.is_empty() {
        return Err(AppError::Validation("Justification is required and must be between 1 and 2000 characters.".into()));
    }
    if justification.len() > 2000 {
        return Err(AppError::Validation("Justification must be 2000 characters or fewer.".into()));
    }
    let sr_number = body.sr_number.as_deref().unwrap_or("").trim().to_string();
    if sr_number.is_empty() {
        return Err(AppError::Validation("SR number is required.".into()));
    }

    let sr_number = body.sr_number.as_deref().unwrap_or("").trim().to_string();
    if sr_number.is_empty() {
        return Err(AppError::Validation("SR number is required and must be between 1 and 100 characters.".into()));
    }
    if sr_number.len() > 100 {
        return Err(AppError::Validation("SR number must be 100 characters or fewer.".into()));
    }

    let start_str = body.activity_start_at.as_deref().unwrap_or("");
    let end_str = body.activity_end_at.as_deref().unwrap_or("");
    if start_str.is_empty() || end_str.is_empty() {
        return Err(AppError::Validation("Activity start and end times are required.".into()));
    }
    let start_time = start_str.parse::<chrono::DateTime<Utc>>()
        .map_err(|_| AppError::Validation("Activity start time is invalid.".into()))?;
    let end_time = end_str.parse::<chrono::DateTime<Utc>>()
        .map_err(|_| AppError::Validation("Activity end time is invalid.".into()))?;
    if end_time <= start_time {
        return Err(AppError::Validation("Activity end time must be after start time.".into()));
    }

    let credential_items = body.credential_items.as_deref().unwrap_or(&[]);
    if credential_items.is_empty() {
        return Err(AppError::Validation(
            "At least one credential item (a selected asset) is required.".into(),
        ));
    }

    struct AssetInfo {
        id: Uuid,
        credential_type: String,
        management_mode: String,
        hostname: String,
    }
    let mut seen_asset_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut resolved_assets: Vec<AssetInfo> = Vec::new();

    for item in credential_items {
        let asset_id_str = item.asset_id.as_deref().unwrap_or("");
        if asset_id_str.is_empty() {
            return Err(AppError::Validation("Each credential item must reference a selected asset.".into()));
        }
        if seen_asset_ids.contains(asset_id_str) {
            return Err(AppError::Validation("The same asset was selected more than once.".into()));
        }
        seen_asset_ids.insert(asset_id_str.to_string());

        if let Some(ref desc) = item.hostname_description {
            let desc_trimmed = desc.trim();
            if desc_trimmed.len() > 200 {
                return Err(AppError::Validation(
                    "Hostname description must be 200 characters or fewer.".into(),
                ));
            }
        }

        let asset_id = asset_id_str.parse::<Uuid>()
            .map_err(|_| AppError::Validation("Each credential item must reference a valid, active asset for this system.".into()))?;
        let asset_rows = db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT id, system_id, credential_type::TEXT, management_mode::TEXT, hostname
                   FROM assets WHERE id = $1 AND expires_after IS NULL"#,
                [asset_id.into()],
            ))
            .await
            .map_err(db_err)?;
        if asset_rows.is_empty() {
            return Err(AppError::Validation("Each credential item must reference a valid, active asset for this system.".into()));
        }
        let asset_sys_id: Uuid = asset_rows[0].try_get("", "system_id")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("asset system_id: {}", e)))?;
        if asset_sys_id != system_id {
            return Err(AppError::Validation("Each credential item must reference a valid, active asset for this system.".into()));
        }
        let cred_type: String = asset_rows[0].try_get("", "credential_type")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("credential_type: {}", e)))?;
        let mgmt_mode: String = asset_rows[0].try_get("", "management_mode")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("management_mode: {}", e)))?;
        let hostname: String = asset_rows[0].try_get("", "hostname")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("hostname: {}", e)))?;
        resolved_assets.push(AssetInfo { id: asset_id, credential_type: cred_type, management_mode: mgmt_mode, hostname });
    }

    // Live submitter-affiliation re-check (legacy admin_users contract): an
    // existing session cannot keep submitting after the account is flipped off
    // vendor affiliation.
    {
        let aff_rows = db.query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT affiliation::text AS affiliation FROM users WHERE id=$1 AND status='active'",
            [user_id.into()],
        )).await.map_err(db_err)?;
        let aff: Option<String> = aff_rows.first().and_then(|r| r.try_get("", "affiliation").ok().flatten());
        if aff.as_deref() != Some("vendor") {
            return Err(AppError::Authorization("You are not authorized to submit requests for this system.".into()));
        }
    }
    if !can_submit(&db, user_id, system_id).await? {
        return Err(AppError::Authorization(
            "You are not authorized to submit requests for this system.".into(),
        ));
    }

    let sys_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, short_code FROM systems WHERE id = $1 AND expires_after IS NULL"#,
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    if sys_rows.is_empty() {
        return Err(AppError::Validation("The specified system does not exist.".into()));
    }
    let short_code: String = sys_rows[0].try_get("", "short_code")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("short_code: {}", e)))?;

    let submitter_cluster_id = resolve_submitter_cluster(&db, user_id, system_id)
        .await?
        .ok_or_else(|| AppError::Validation("Could not resolve your submitter team for this system.".into()))?;

    let now = Utc::now();
    let seq_date = now.format("%Y-%m-%d").to_string();
    let sequence = next_request_sequence(&db, &short_code, &seq_date).await?;
    let request_number = generate_request_number(&short_code, &now, sequence);

    let workflow_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT ordinal, cluster_id, level, step_kind::TEXT
               FROM system_workflow_steps
               WHERE system_id = $1 AND expires_after IS NULL
               ORDER BY ordinal ASC"#,
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;

    let has_approval_steps = workflow_rows.len() > 1;
    let initial_status = if has_approval_steps { "submitted" } else { "under_review" };
    let initial_ordinal: i16 = if has_approval_steps { 2 } else { 0 };

    let wrap_key = crate::request_crypto::generate_wrap_key();
    let server_key_material = if body.public_key.is_none() {
        Some(crate::request_crypto::generate_with_wrapped_private_key(&wrap_key)?)
    } else { None };

    let request_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO breakglass_requests
             (id, request_number, system_id, submitted_by, vendor_cluster_id,
              justification, sr_number, activity_start_at, activity_end_at,
              status, current_step_ordinal, return_count,
              created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz, $10::request_status, $11, 0, now(), now())"#,
        [
            request_id.into(),
            request_number.clone().into(),
            system_id.into(),
            user_id.into(),
            submitter_cluster_id.into(),
            justification.clone().into(),
            sr_number.clone().into(),
            start_time.to_rfc3339().into(),
            end_time.to_rfc3339().into(),
            initial_status.to_owned().into(),
            initial_ordinal.into(),
        ],
    ))
    .await
    .map_err(db_err)?;

    let km_id = Uuid::now_v7();
    let public_key_val = match &body.public_key {
        Some(pk) => pk.clone(),
        None => server_key_material.as_ref().unwrap().public_key.clone(),
    };
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO request_key_material
             (id, request_id, public_key, key_algorithm, private_key_wrap_key, created_at)
           VALUES ($1, $2, $3, 'RSA-OAEP-2048-SHA256', $4, now())"#,
        [
            km_id.into(),
            request_id.into(),
            public_key_val.to_owned().into(),
            wrap_key.clone().into(),
        ],
    ))
    .await
    .map_err(db_err)?;

    let decided_at = Utc::now().to_rfc3339();
    for wf_row in &workflow_rows {
        let ordinal: i16 = wf_row.try_get("", "ordinal")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("ordinal: {}", e)))?;
        let cluster_id: Uuid = wf_row.try_get("", "cluster_id")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("cluster_id: {}", e)))?;
        let level: i16 = wf_row.try_get("", "level")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("level: {}", e)))?;
        let step_kind: String = wf_row.try_get("", "step_kind")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("step_kind: {}", e)))?;

        let is_submitter_step = ordinal == 1;
        let step_status = if is_submitter_step { "submitted" } else { "pending" };
        let step_id = Uuid::now_v7();

        let cluster_type_rows = db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT type::TEXT FROM clusters WHERE id = $1 LIMIT 1"#,
                [cluster_id.into()],
            ))
            .await
            .map_err(db_err)?;
        let cluster_type = if cluster_type_rows.is_empty() {
            "agency".to_string()
        } else {
            cluster_type_rows[0].try_get::<String>("", "type")
                .map_err(|e| AppError::Internal(anyhow::anyhow!("cluster type: {}", e)))?
        };

        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO request_approval_steps
                 (id, request_id, step_ordinal, required_cluster_id, required_team_type,
                  required_level, step_kind, step_status, assigned_reviewer_id,
                  decision_notes, decided_at, decided_by, decided_via_override, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5::cluster_type, $6, $7::step_kind, $8::step_status,
                       $9, NULL, $10::timestamptz, $11, false, now(), now())"#,
            [
                step_id.into(),
                request_id.into(),
                ordinal.into(),
                cluster_id.into(),
                cluster_type.into(),
                level.into(),
                step_kind.into(),
                step_status.to_owned().into(),
                (if is_submitter_step { Some(user_id) } else { None }).into(),
                (if is_submitter_step { Some(decided_at.clone()) } else { None }).into(),
                (if is_submitter_step { Some(user_id) } else { None }).into(),
            ],
        ))
        .await
        .map_err(db_err)?;
    }

    let mut credential_item_jsons: Vec<JsonValue> = Vec::new();
    for (item, asset) in credential_items.iter().zip(resolved_assets.iter()) {
        let item_id = Uuid::now_v7();
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO request_credential_items
                 (id, request_id, asset_id, hostname, hostname_description,
                  credential_type, management_mode, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7::asset_management_mode, now(), now())"#,
            [
                item_id.into(),
                request_id.into(),
                asset.id.into(),
                asset.hostname.clone().into(),
                item.hostname_description.clone().into(),
                asset.credential_type.clone().into(),
                asset.management_mode.clone().into(),
            ],
        ))
        .await
        .map_err(db_err)?;

        credential_item_jsons.push(json!({
            "id": item_id.to_string(),
            "requestId": request_id.to_string(),
            "assetId": asset.id.to_string(),
            "hostname": asset.hostname,
            "hostnameDescription": item.hostname_description,
            "credentialType": asset.credential_type,
            "managementMode": asset.management_mode,
        }));
    }

    if has_approval_steps {
        if let Some(step2_row) = workflow_rows.get(1) {
            let step2_cluster: Uuid = step2_row.try_get("", "cluster_id")
                .map_err(|e| AppError::Internal(anyhow::anyhow!("s2 cluster: {}", e)))?;
            let step2_level: i16 = step2_row.try_get("", "level")
                .map_err(|e| AppError::Internal(anyhow::anyhow!("s2 level: {}", e)))?;
            let reviewer_emails = resolve_team_emails(&db, step2_cluster, step2_level).await?;
            insert_notification(&db, "request.submitted", request_id, &reviewer_emails).await?;
        }
    } else if let Some(owner_email) = get_primary_owner_email(&db, system_id).await? {
        insert_notification(&db, "request.submitted", request_id, &[owner_email]).await?;
    }
    if let Some(submitter_email) = get_user_email(&db, user_id).await? {
        insert_notification(&db, "request.submitted_confirmation", request_id, &[submitter_email]).await?;
    }

    let mut response = json!({
        "request": {
            "id": request_id.to_string(),
            "requestNumber": request_number,
            "systemId": system_id.to_string(),
            "submittedBy": user_id.to_string(),
            "vendorClusterId": submitter_cluster_id.to_string(),
            "justification": justification,
            "srNumber": sr_number,
            "activityStartAt": start_time.to_rfc3339(),
            "activityEndAt": end_time.to_rfc3339(),
            "status": initial_status,
            "currentStepOrdinal": initial_ordinal,
            "returnCount": 0,
            "ownerDecisionBy": null,
            "ownerDecisionNotes": null,
            "ownerDecisionAt": null,
            "credentialIssuedBy": null,
            "credentialIssuedAt": null,
            "closedBy": null,
            "closingNotes": null,
            "closedAt": null,
        },
        "credentialItems": credential_item_jsons,
        "privateKeyWrapKey": wrap_key,
    });
    if let Some(material) = server_key_material {
        response["wrappedPrivateKeyFile"] = json!(material.wrapped_private_key_file);
    }
    Ok((StatusCode::CREATED, Json(response)).into_response())
}

// ── POST /requests/:id/step-decision ─────────────────────────────────────────

#[derive(Deserialize)]
pub struct StepDecisionBody {
    decision: Option<String>,
    notes: Option<String>,
    #[serde(rename = "override")]
    override_flag: Option<bool>,
}

pub async fn post_step_decision(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
    Json(body): Json<StepDecisionBody>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let request_id = request_id_str.parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let decision = body.decision.as_deref().unwrap_or("");
    if !["approve", "return", "reject"].contains(&decision) {
        return Err(AppError::Validation("decision must be 'approve', 'return', or 'reject'.".into()));
    }
    if (decision == "return" || decision == "reject")
        && body.notes.as_deref().map(str::trim).unwrap_or("").is_empty()
    {
        return Err(AppError::Validation("Notes are required when returning or rejecting a request.".into()));
    }
    if let Some(ref notes) = body.notes {
        if notes.len() > 2000 {
            return Err(AppError::Validation("Notes must be 2000 characters or fewer.".into()));
        }
    }

    let req = get_request_row(&db, request_id).await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    let at_step = (req.status == "submitted" || req.status == "under_review")
        && req.current_step_ordinal > 0;
    if !at_step {
        return Err(AppError::Validation("This request has no approval step awaiting a decision.".into()));
    }

    let step = get_step_by_ordinal(&db, request_id, req.current_step_ordinal).await?
        .ok_or_else(|| AppError::Validation("Current approval step not found.".into()))?;

    let serves = user_serves_system_orgs(&db, user_id, req.system_id).await?;
    let is_assigned = serves
        && is_step_reviewer(&db, user_id, step.required_cluster_id, step.required_level).await?;

    if !is_assigned {
        if !body.override_flag.unwrap_or(false) {
            return Err(AppError::Authorization(
                "You are not authorized to act on the current approval step.".into(),
            ));
        }
        let override_ok = check_override_eligible(&db, user_id, request_id, req.current_step_ordinal).await?;
        if !override_ok {
            return Err(AppError::Authorization("You are not authorized to override this step.".into()));
        }
    }

    let notes_trimmed = body.notes.as_deref().map(str::trim).map(String::from);
    let used_override = !is_assigned;

    match decision {
        "approve" => {
            let has_next = step_has_next(&db, request_id, req.current_step_ordinal).await?;
            let next = step_approve_next(has_next, req.current_step_ordinal + 1);
            let locked = db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE breakglass_requests
                   SET status = $1::request_status, current_step_ordinal = $2, updated_at = now()
                   WHERE id = $3 AND status IN ('submitted','under_review') AND current_step_ordinal = $4"#,
                [next.status.to_owned().into(), next.current_step_ordinal.into(), request_id.into(), req.current_step_ordinal.into()],
            )).await.map_err(db_err)?;
            if locked.rows_affected() == 0 { return Err(AppError::Authorization("You are not authorized to act on the current approval step.".into())); }
            crate::audit::write_audit_log(&db, user_id, if used_override { "request.step_override_approved" } else { "request.step_approved" }, "breakglass_request", &request_id.to_string(), None, json!({"requestId": request_id.to_string(), "stepOrdinal": req.current_step_ordinal}), None).await?;
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE request_approval_steps
                   SET step_status = 'approved'::step_status,
                       assigned_reviewer_id = $1, decided_by = $1,
                       decided_at = now(), decision_notes = $2,
                       decided_via_override = $4, updated_at = now()
                   WHERE id = $3"#,
                [user_id.into(), notes_trimmed.clone().into(), step.id.into(), used_override.into()],
            )).await.map_err(db_err)?;
            if has_next {
                if let Some(next_step) = get_step_by_ordinal(&db, request_id, req.current_step_ordinal + 1).await? {
                    let emails = resolve_team_emails(&db, next_step.required_cluster_id, next_step.required_level).await?;
                    insert_notification(&db, "request.step_approved_next_reviewer", request_id, &emails).await?;
                }
            } else if let Some(owner_email) = get_primary_owner_email(&db, req.system_id).await? {
                insert_notification(&db, "request.step_approved_owner", request_id, &[owner_email]).await?;
            }

            let msg = if has_next {
                "Step approved; advanced to next approver."
            } else {
                "Step approved; routed to system owner."
            };
            Ok(Json(json!({"message": msg})).into_response())
        }
        "return" => {
            let next = step_return_next(req.current_step_ordinal);
            let locked = db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE breakglass_requests
                   SET status = $1::request_status, return_count = return_count + 1, updated_at = now()
                   WHERE id = $2 AND status IN ('submitted','under_review') AND current_step_ordinal = $3"#,
                [next.status.to_owned().into(), request_id.into(), req.current_step_ordinal.into()],
            )).await.map_err(db_err)?;
            if locked.rows_affected() == 0 { return Err(AppError::Authorization("You are not authorized to act on the current approval step.".into())); }
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE request_approval_steps
                   SET step_status = 'returned'::step_status,
                       assigned_reviewer_id = $1, decided_by = $1,
                       decided_at = now(), decision_notes = $2,
                       decided_via_override = $4, updated_at = now()
                   WHERE id = $3"#,
                [user_id.into(), notes_trimmed.clone().into(), step.id.into(), used_override.into()],
            )).await.map_err(db_err)?;
            if let Some(email) = get_user_email(&db, req.submitted_by).await? {
                insert_notification(&db, "request.step_returned", request_id, &[email]).await?;
            }
            Ok(Json(json!({"message": "Request returned to vendor for revision."})).into_response())
        }
        _ => {
            let next = step_reject_next(req.current_step_ordinal);
            let locked = db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE breakglass_requests
                   SET status = $1::request_status, updated_at = now()
                   WHERE id = $2 AND status IN ('submitted','under_review') AND current_step_ordinal = $3"#,
                [next.status.to_owned().into(), request_id.into(), req.current_step_ordinal.into()],
            )).await.map_err(db_err)?;
            if locked.rows_affected() == 0 { return Err(AppError::Authorization("You are not authorized to act on the current approval step.".into())); }
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE request_approval_steps
                   SET step_status = 'rejected'::step_status,
                       assigned_reviewer_id = $1, decided_by = $1,
                       decided_at = now(), decision_notes = $2,
                       decided_via_override = $4, updated_at = now()
                   WHERE id = $3"#,
                [user_id.into(), notes_trimmed.clone().into(), step.id.into(), used_override.into()],
            )).await.map_err(db_err)?;
            if let Some(email) = get_user_email(&db, req.submitted_by).await? {
                insert_notification(&db, "request.step_rejected", request_id, &[email]).await?;
            }
            Ok(Json(json!({"message": "Request rejected."})).into_response())
        }
    }
}

// ── POST /requests/:id/owner-decision ────────────────────────────────────────

#[derive(Deserialize)]
pub struct OwnerDecisionBody {
    decision: Option<String>,
    notes: Option<String>,
}

pub async fn post_owner_decision(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
    Json(body): Json<OwnerDecisionBody>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let request_id = request_id_str.parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let decision = body.decision.as_deref().unwrap_or("");
    if !["approve", "return", "reject"].contains(&decision) {
        return Err(AppError::Validation("decision must be 'approve', 'return', or 'reject'.".into()));
    }
    if (decision == "return" || decision == "reject")
        && body.notes.as_deref().map(str::trim).unwrap_or("").is_empty()
    {
        return Err(AppError::Validation("Notes are required when returning or rejecting a request.".into()));
    }
    if let Some(ref notes) = body.notes {
        if notes.len() > 2000 {
            return Err(AppError::Validation("Notes must be 2000 characters or fewer.".into()));
        }
    }

    let req = get_request_row(&db, request_id).await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    if !can_approve(&db, user_id, req.system_id).await? {
        return Err(AppError::Authorization(
            "You are not authorized to make the owner decision for this system.".into(),
        ));
    }

    if req.status != "under_review" || req.current_step_ordinal != 0 {
        return Err(AppError::Validation(
            "This request is not awaiting the owner's terminal decision.".into(),
        ));
    }

    let notes_trimmed = body.notes.as_deref().map(str::trim).map(String::from);

    match decision {
        "approve" => {
            let next = owner_approve_next();
            let tx = db.begin().await.map_err(db_err)?;
            let locked = tx.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE breakglass_requests
                   SET status = $1::request_status,
                       owner_decision_by = $2, owner_decision_notes = $3,
                       owner_decision_at = now(), updated_at = now()
                   WHERE id = $4 AND status = 'under_review' AND current_step_ordinal = 0"#,
                [next.status.to_owned().into(), user_id.into(), notes_trimmed.clone().into(), request_id.into()],
            )).await.map_err(db_err)?;
            if locked.rows_affected() == 0 { return Err(AppError::Validation("This request is not awaiting the owner's terminal decision.".into())); }
            crate::routes::custody::instantiate_for_approval(&tx, request_id, req.system_id).await?;
            tx.commit().await.map_err(db_err)?;

            let last_step_rows = db
                .query_all(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    r#"SELECT required_cluster_id, required_level
                       FROM request_approval_steps
                       WHERE request_id = $1 AND step_ordinal > 1
                       ORDER BY step_ordinal DESC LIMIT 1"#,
                    [request_id.into()],
                ))
                .await
                .map_err(db_err)?;
            if let Some(last_step) = last_step_rows.first() {
                let cluster: Uuid = last_step.try_get("", "required_cluster_id")
                    .map_err(|e| AppError::Internal(anyhow::anyhow!("last cluster: {}", e)))?;
                let level: i16 = last_step.try_get("", "required_level")
                    .map_err(|e| AppError::Internal(anyhow::anyhow!("last level: {}", e)))?;
                let agency_emails = resolve_team_emails(&db, cluster, level).await?;
                insert_notification(&db, "request.owner_approved_agency_l1", request_id, &agency_emails).await?;
            }

            let pa_emails = get_pa_team_emails(&db, req.system_id).await.unwrap_or_default();
            if !pa_emails.is_empty() {
                insert_notification(&db, "request.owner_approved_pa_team", request_id, &pa_emails).await?;
            }
            if let Some(email) = get_user_email(&db, req.submitted_by).await? {
                insert_notification(&db, "request.owner_approved_submitter", request_id, &[email]).await?;
            }

            Ok(Json(json!({"message": "Request approved."})).into_response())
        }
        "return" => {
            let next = owner_return_next(req.current_step_ordinal);
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE breakglass_requests
                   SET status = $1::request_status,
                       owner_decision_by = $2, owner_decision_notes = $3,
                       owner_decision_at = now(), return_count = return_count + 1, updated_at = now()
                   WHERE id = $4"#,
                [next.status.to_owned().into(), user_id.into(), notes_trimmed.clone().into(), request_id.into()],
            )).await.map_err(db_err)?;
            if let Some(email) = get_user_email(&db, req.submitted_by).await? {
                insert_notification(&db, "request.owner_returned", request_id, &[email]).await?;
            }
            Ok(Json(json!({"message": "Request returned to vendor for revision."})).into_response())
        }
        _ => {
            let next = owner_reject_next(req.current_step_ordinal);
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"UPDATE breakglass_requests
                   SET status = $1::request_status,
                       owner_decision_by = $2, owner_decision_notes = $3,
                       owner_decision_at = now(), updated_at = now()
                   WHERE id = $4"#,
                [next.status.to_owned().into(), user_id.into(), notes_trimmed.clone().into(), request_id.into()],
            )).await.map_err(db_err)?;
            if let Some(email) = get_user_email(&db, req.submitted_by).await? {
                insert_notification(&db, "request.owner_rejected", request_id, &[email]).await?;
            }
            Ok(Json(json!({"message": "Request rejected."})).into_response())
        }
    }
}

// ── POST /requests/:id/issue-credential ───────────────────────────────────────

pub async fn post_issue_credential(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let request_id = request_id_str.parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let req = get_request_row(&db, request_id).await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    if req.status != "approved" {
        return Err(AppError::Validation("Request has not been approved yet.".into()));
    }

    if !can_review(&db, user_id, req.system_id).await? {
        return Err(AppError::Authorization(
            "You are not authorized to handle requests for this system.".into(),
        ));
    }

    // Persisted custody routing cannot be bypassed through exchange delivery.
    let blocked = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT EXISTS (
             SELECT 1 FROM request_asset_custody_cases WHERE request_id=$1 AND NOT (
               state IN ('in_requester_custody','return_pending','received_by_agency','returned_to_inventory')
               OR (state IN ('exception_open','resolved_exception') AND state_before_exception IN
                   ('in_requester_custody','return_pending','received_by_agency','returned_to_inventory'))
             )) AS blocked"#,
        [request_id.into()])).await.map_err(db_err)?
        .and_then(|r| r.try_get::<bool>("", "blocked").ok()).unwrap_or(false);
    if blocked {
        return Err(AppError::Conflict("Credential cannot be marked as issued until physical custody handover is complete.".into()));
    }

    let next = issue_credential_next();
    let locked = db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE breakglass_requests
           SET status = $1::request_status,
               credential_issued_by = $2, credential_issued_at = now(), updated_at = now()
           WHERE id = $3 AND status = 'approved'"#,
        [next.status.to_owned().into(), user_id.into(), request_id.into()],
    )).await.map_err(db_err)?;
    if locked.rows_affected() == 0 { return Err(AppError::Validation("Request has not been approved yet.".into())); }

    if let Some(email) = get_user_email(&db, req.submitted_by).await? {
        insert_notification(&db, "request.credential_issued", request_id, &[email]).await?;
    }

    Ok(Json(json!({"message": "Credential marked as issued."})).into_response())
}

// ── POST /requests/:id/close ──────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseRequestBody {
    closing_notes: Option<String>,
}

pub async fn post_close_request(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
    Json(body): Json<CloseRequestBody>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let request_id = request_id_str.parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let req = get_request_row(&db, request_id).await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    if req.status != "credential_issued" {
        return Err(AppError::Validation(
            "Cannot close request — credential has not been marked as issued.".into(),
        ));
    }

    if let Some(ref notes) = body.closing_notes {
        if notes.len() > 2000 {
            return Err(AppError::Validation("Closing notes must be 2000 characters or fewer.".into()));
        }
    }

    let is_requester = req.submitted_by == user_id;
    let authorized_reviewer = can_review(&db, user_id, req.system_id).await?;
    if !authorized_reviewer && !is_requester {
        return Err(AppError::Authorization(
            "You are not authorized to handle requests for this system.".into(),
        ));
    }

    let next = close_next();
    let locked = db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE breakglass_requests
           SET status = $1::request_status,
               closed_by = $2, closed_at = now(), closing_notes = $3, updated_at = now()
           WHERE id = $4 AND status = 'credential_issued'"#,
        [
            next.status.to_owned().into(),
            user_id.into(),
            body.closing_notes.clone().into(),
            request_id.into(),
        ],
    )).await.map_err(db_err)?;
    if locked.rows_affected() == 0 { return Err(AppError::Validation("Cannot close request — credential has not been marked as issued.".into())); }

    if let Some(email) = get_user_email(&db, req.submitted_by).await? {
        insert_notification(&db, "request.closed_submitter", request_id, &[email]).await?;
    }
    if let Some(owner_email) = get_primary_owner_email(&db, req.system_id).await? {
        insert_notification(&db, "request.closed_system_owner", request_id, &[owner_email]).await?;
    }

    Ok(Json(json!({"message": "Request closed successfully."})).into_response())
}

// ── PUT /requests/:id/approver-edit ──────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproverEditBody {
    justification: Option<String>,
    sr_number: Option<String>,
    activity_start_at: Option<String>,
    activity_end_at: Option<String>,
    credential_items: Option<Vec<CredentialItemInput>>,
}

pub async fn put_approver_edit(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
    Json(body): Json<ApproverEditBody>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let request_id = request_id_str.parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let req = get_request_row(&db, request_id).await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    if (req.status != "submitted" && req.status != "under_review") || req.current_step_ordinal <= 0 {
        return Err(AppError::Validation(
            "Request can only be edited while it is at an approval step.".into(),
        ));
    }

    let step = get_step_by_ordinal(&db, request_id, req.current_step_ordinal).await?
        .ok_or_else(|| AppError::Validation("Current approval step not found.".into()))?;

    let serves_org = user_serves_system_orgs(&db, user_id, req.system_id).await?;
    if !serves_org {
        return Err(AppError::Authorization(
            "Only the current step's approver can edit this request.".into(),
        ));
    }
    let is_reviewer = is_step_reviewer(&db, user_id, step.required_cluster_id, step.required_level).await?;
    if !is_reviewer {
        return Err(AppError::Authorization(
            "Only the current step's approver can edit this request.".into(),
        ));
    }

    let justification = body.justification.as_deref().unwrap_or("").trim().to_string();
    if justification.is_empty() || justification.len() > 2000 {
        return Err(AppError::Validation(
            "Justification is required and must be between 1 and 2000 characters.".into(),
        ));
    }
    let sr_number = body.sr_number.as_deref().unwrap_or("").trim().to_string();
    let start_str = body.activity_start_at.as_deref().unwrap_or("");
    let end_str = body.activity_end_at.as_deref().unwrap_or("");
    if start_str.is_empty() || end_str.is_empty() {
        return Err(AppError::Validation("Activity start and end times are required.".into()));
    }
    let start_time = start_str.parse::<chrono::DateTime<Utc>>()
        .map_err(|_| AppError::Validation("Activity start time is invalid.".into()))?;
    let end_time = end_str.parse::<chrono::DateTime<Utc>>()
        .map_err(|_| AppError::Validation("Activity end time is invalid.".into()))?;
    if end_time <= start_time {
        return Err(AppError::Validation("Activity end time must be after start time.".into()));
    }

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE breakglass_requests
           SET justification = $1, sr_number = $2,
               activity_start_at = $3::timestamptz, activity_end_at = $4::timestamptz,
               updated_at = now()
           WHERE id = $5"#,
        [
            justification.into(),
            sr_number.into(),
            start_str.to_owned().into(),
            end_str.to_owned().into(),
            request_id.into(),
        ],
    )).await.map_err(db_err)?;

    if let Some(items) = body.credential_items {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"DELETE FROM request_credential_items WHERE request_id = $1"#,
            [request_id.into()],
        )).await.map_err(db_err)?;

        for item in &items {
            let aid_str = item.asset_id.as_deref().unwrap_or("");
            if aid_str.is_empty() { continue; }
            let asset_id = match aid_str.parse::<Uuid>() {
                Ok(id) => id,
                Err(_) => continue,
            };
            let asset_rows = db.query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT id, credential_type::TEXT, management_mode::TEXT, hostname
                   FROM assets WHERE id = $1 AND system_id = $2 AND expires_after IS NULL"#,
                [asset_id.into(), req.system_id.into()],
            )).await.map_err(db_err)?;
            if asset_rows.is_empty() { continue; }
            let hostname: String = asset_rows[0].try_get("", "hostname").map_err(db_err)?;
            let cred_type: String = asset_rows[0].try_get("", "credential_type").map_err(db_err)?;
            let mgmt_mode: String = asset_rows[0].try_get("", "management_mode").map_err(db_err)?;
            let item_id = Uuid::now_v7();
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"INSERT INTO request_credential_items
                     (id, request_id, asset_id, hostname, hostname_description,
                      credential_type, management_mode, created_at, updated_at)
                   VALUES ($1, $2, $3, $4, $5, $6, $7::asset_management_mode, now(), now())"#,
                [
                    item_id.into(), request_id.into(), asset_id.into(),
                    hostname.into(),
                    item.hostname_description.clone().unwrap_or_default().into(),
                    cred_type.into(), mgmt_mode.into(),
                ],
            )).await.map_err(db_err)?;
        }
    }

    Ok(Json(json!({"message": "Request updated."})).into_response())
}

// ── PUT /requests/:id/resubmit ────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResubmitBody {
    justification: Option<String>,
    sr_number: Option<String>,
    activity_start_at: Option<String>,
    activity_end_at: Option<String>,
    credential_items: Option<Vec<CredentialItemInput>>,
}

pub async fn put_resubmit(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
    Json(body): Json<ResubmitBody>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let request_id = request_id_str.parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let req = get_request_row(&db, request_id).await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    if req.submitted_by != user_id {
        return Err(AppError::Authorization(
            "Only the original submitter can resubmit this request.".into(),
        ));
    }

    if req.status != "returned_to_vendor" {
        return Err(AppError::Validation(
            "Only returned requests can be resubmitted.".into(),
        ));
    }

    let authorized = can_submit(&db, user_id, req.system_id).await?;
    if !authorized {
        return Err(AppError::Authorization(
            "You are no longer authorized to submit requests for this system.".into(),
        ));
    }

    let justification = body.justification.as_deref().unwrap_or("").trim().to_string();
    if justification.is_empty() || justification.len() > 2000 {
        return Err(AppError::Validation(
            "Justification is required and must be between 1 and 2000 characters.".into(),
        ));
    }
    let sr_number = body.sr_number.as_deref().unwrap_or("").trim().to_string();
    let start_str = body.activity_start_at.as_deref().unwrap_or("");
    let end_str = body.activity_end_at.as_deref().unwrap_or("");
    if !start_str.is_empty() && !end_str.is_empty() {
        let start_time = start_str.parse::<chrono::DateTime<Utc>>()
            .map_err(|_| AppError::Validation("Activity start time is invalid.".into()))?;
        let end_time = end_str.parse::<chrono::DateTime<Utc>>()
            .map_err(|_| AppError::Validation("Activity end time is invalid.".into()))?;
        if end_time <= start_time {
            return Err(AppError::Validation("Activity end time must be after start time.".into()));
        }
    }

    let workflow_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT ordinal, cluster_id, level, step_kind::TEXT
           FROM system_workflow_steps
           WHERE system_id = $1 AND expires_after IS NULL
           ORDER BY ordinal ASC"#,
        [req.system_id.into()],
    )).await.map_err(db_err)?;

    let has_approval_steps = workflow_rows.len() > 1;
    let new_status = if has_approval_steps { "submitted" } else { "under_review" };
    let new_ordinal: i16 = if has_approval_steps { 2 } else { 0 };

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"DELETE FROM request_approval_steps WHERE request_id = $1"#,
        [request_id.into()],
    )).await.map_err(db_err)?;

    let decided_at = Utc::now().to_rfc3339();
    for wf_row in &workflow_rows {
        let ordinal: i16 = wf_row.try_get("", "ordinal")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("ordinal: {}", e)))?;
        let cluster_id: Uuid = wf_row.try_get("", "cluster_id")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("cluster_id: {}", e)))?;
        let level: i16 = wf_row.try_get("", "level")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("level: {}", e)))?;
        let step_kind: String = wf_row.try_get("", "step_kind")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("step_kind: {}", e)))?;

        let cluster_type_rows = db.query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT type::TEXT FROM clusters WHERE id = $1 LIMIT 1"#,
            [cluster_id.into()],
        )).await.map_err(db_err)?;
        let cluster_type = if cluster_type_rows.is_empty() {
            "agency".to_string()
        } else {
            cluster_type_rows[0].try_get::<String>("", "type")
                .map_err(|e| AppError::Internal(anyhow::anyhow!("cluster type: {}", e)))?
        };

        let is_submitter_step = ordinal == 1;
        let step_status = if is_submitter_step { "submitted" } else { "pending" };
        let step_id = Uuid::now_v7();

        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO request_approval_steps
                 (id, request_id, step_ordinal, required_cluster_id, required_team_type,
                  required_level, step_kind, step_status, assigned_reviewer_id,
                  decision_notes, decided_at, decided_by, decided_via_override, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5::cluster_type, $6, $7::step_kind, $8::step_status,
                       $9, NULL, $10::timestamptz, $11, false, now(), now())"#,
            [
                step_id.into(), request_id.into(), ordinal.into(), cluster_id.into(),
                cluster_type.into(), level.into(), step_kind.into(), step_status.to_owned().into(),
                (if is_submitter_step { Some(user_id) } else { None }).into(),
                (if is_submitter_step { Some(decided_at.clone()) } else { None }).into(),
                (if is_submitter_step { Some(user_id) } else { None }).into(),
            ],
        )).await.map_err(db_err)?;
    }

    let update_start = if start_str.is_empty() { None } else { Some(start_str.to_owned()) };
    let update_end = if end_str.is_empty() { None } else { Some(end_str.to_owned()) };

    if let (Some(s), Some(e)) = (update_start, update_end) {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"UPDATE breakglass_requests
               SET status = $1::request_status, current_step_ordinal = $2,
                   justification = $3, sr_number = $4,
                   activity_start_at = $5::timestamptz, activity_end_at = $6::timestamptz,
                   owner_decision_by = NULL, owner_decision_notes = NULL,
                   owner_decision_at = NULL,
                   return_count = return_count + 1, updated_at = now()
               WHERE id = $7"#,
            [
                new_status.to_owned().into(), new_ordinal.into(),
                justification.into(), sr_number.into(),
                s.into(), e.into(), request_id.into(),
            ],
        )).await.map_err(db_err)?;
    } else {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"UPDATE breakglass_requests
               SET status = $1::request_status, current_step_ordinal = $2,
                   justification = $3, sr_number = $4,
                   owner_decision_by = NULL, owner_decision_notes = NULL,
                   owner_decision_at = NULL,
                   return_count = return_count + 1, updated_at = now()
               WHERE id = $5"#,
            [
                new_status.to_owned().into(), new_ordinal.into(),
                justification.into(), sr_number.into(), request_id.into(),
            ],
        )).await.map_err(db_err)?;
    }

    if has_approval_steps {
        // Notify step 2 reviewer team (addendum-044 #3).
        let step2_row = workflow_rows.iter().find(|r| {
            r.try_get::<i16>("", "ordinal").unwrap_or(0) == 2
        });
        if let Some(s2) = step2_row {
            let step2_cluster: Uuid = s2.try_get("", "cluster_id").unwrap_or_default();
            let step2_level: i16 = s2.try_get("", "level").unwrap_or(0);
            let team_rows = db.query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT id FROM teams
                   WHERE cluster_id = $1 AND level = $2 AND expires_after IS NULL
                   LIMIT 1"#,
                [step2_cluster.into(), step2_level.into()],
            )).await.map_err(db_err)?;
            if let Some(team_row) = team_rows.first() {
                let team_id: Uuid = team_row.try_get("", "id").unwrap_or_default();
                let email_rows = db.query_all(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    r#"SELECT u.email FROM team_memberships tm
                       JOIN users u ON u.id = tm.user_id
                       WHERE tm.team_id = $1 AND tm.expires_after IS NULL
                         AND u.status = 'active'"#,
                    [team_id.into()],
                )).await.map_err(db_err)?;
                let emails: Vec<String> = email_rows.iter()
                    .filter_map(|r| r.try_get::<String>("", "email").ok())
                    .collect();
                if !emails.is_empty() {
                    insert_notification(&db, "request.resubmitted_step2", request_id, &emails).await?;
                }
            }
        }
    }

    Ok(Json(json!({"message": "Request resubmitted successfully."})).into_response())
}

// ── Visibility helpers ─────────────────────────────────────────────────────────

fn is_pre_owner(status: &str, ordinal: i16) -> bool {
    (status == "submitted" || status == "under_review") && ordinal > 0
}

async fn get_reviewer_system_ids(
    db: &DatabaseConnection,
    user_id: Uuid,
) -> Result<Vec<Uuid>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT DISTINCT sws.system_id
               FROM system_workflow_steps sws
               JOIN teams t ON t.cluster_id = sws.cluster_id AND t.level = sws.level
                 AND t.expires_after IS NULL
               JOIN team_memberships tm ON tm.team_id = t.id AND tm.expires_after IS NULL
               WHERE tm.user_id = $1
                 AND sws.ordinal > 1
                 AND sws.expires_after IS NULL"#,
            [user_id.into()],
        ))
        .await
        .map_err(db_err)?;
    Ok(rows.iter().filter_map(|r| r.try_get("", "system_id").ok()).collect())
}

async fn get_visible_system_ids(
    db: &DatabaseConnection,
    user_id: Uuid,
) -> Result<Vec<Uuid>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT DISTINCT system_id FROM (
               SELECT system_id FROM system_owners WHERE user_id = $1 AND expires_after IS NULL
               UNION
               SELECT DISTINCT sws.system_id
               FROM system_workflow_steps sws
               JOIN teams t ON t.cluster_id = sws.cluster_id AND t.level = sws.level
                 AND t.expires_after IS NULL
               JOIN team_memberships tm ON tm.team_id = t.id AND tm.expires_after IS NULL
               WHERE tm.user_id = $1 AND sws.expires_after IS NULL
               UNION
               SELECT system_id FROM system_delegates WHERE delegate_user_id = $1 AND expires_after IS NULL
            ) q"#,
            [user_id.into()],
        ))
        .await
        .map_err(db_err)?;
    Ok(rows.iter().filter_map(|r| r.try_get("", "system_id").ok()).collect())
}

pub(crate) async fn req_can_view(
    db: &DatabaseConnection,
    user_id: Uuid,
    req: &RequestRow,
) -> Result<bool, AppError> {
    if req.submitted_by == user_id {
        return Ok(true);
    }
    if crate::db::admin_roles::has_global_admin_grant(db, user_id).await? {
        return Ok(true);
    }
    if is_pre_owner(&req.status, req.current_step_ordinal) {
        let ids = get_reviewer_system_ids(db, user_id).await?;
        return Ok(ids.contains(&req.system_id));
    }
    let ids = get_visible_system_ids(db, user_id).await?;
    Ok(ids.contains(&req.system_id))
}

async fn req_is_current_step_reviewer(
    db: &DatabaseConnection,
    user_id: Uuid,
    req: &RequestRow,
) -> Result<bool, AppError> {
    if req.current_step_ordinal <= 0 {
        return Ok(false);
    }
    let step_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT required_cluster_id, required_level FROM request_approval_steps
               WHERE request_id = $1 AND step_ordinal = $2 LIMIT 1"#,
            [req.id.into(), req.current_step_ordinal.into()],
        ))
        .await
        .map_err(db_err)?;
    if step_rows.is_empty() {
        return Ok(false);
    }
    let cluster_id: Uuid = step_rows[0]
        .try_get("", "required_cluster_id")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("cluster_id: {}", e)))?;
    let level: i16 = step_rows[0]
        .try_get("", "required_level")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("level: {}", e)))?;
    is_step_reviewer(db, user_id, cluster_id, level).await
}

// ── GET /requests/:id ─────────────────────────────────────────────────────────

pub async fn get_request(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let request_id = request_id_str
        .parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let req = get_request_row(&db, request_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    if !req_can_view(&db, user_id, &req).await? {
        return Err(AppError::NotFound("Request not found.".into()));
    }

    let steps_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT step_ordinal, step_status::TEXT, step_kind::TEXT,
                      decided_via_override, decision_notes, decided_at, decided_by
               FROM request_approval_steps
               WHERE request_id = $1 ORDER BY step_ordinal"#,
            [request_id.into()],
        ))
        .await
        .map_err(db_err)?;
    let approval_steps: Vec<JsonValue> = steps_rows
        .iter()
        .map(|r| {
            let ordinal: i16 = r.try_get("", "step_ordinal").unwrap_or(0);
            let status: String = r.try_get("", "step_status").unwrap_or_default();
            let kind: String = r.try_get("", "step_kind").unwrap_or_default();
            let via_override: bool = r.try_get("", "decided_via_override").unwrap_or(false);
            let decided_by: Option<Uuid> = r.try_get("", "decided_by").ok().flatten();
            json!({ "stepOrdinal": ordinal, "stepStatus": status, "stepKind": kind, "decidedViaOverride": via_override, "decidedBy": decided_by })
        })
        .collect();

    let submitter_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, full_name, email FROM users WHERE id = $1 LIMIT 1"#,
            [req.submitted_by.into()],
        ))
        .await
        .map_err(db_err)?;
    let submitter = if submitter_rows.is_empty() {
        serde_json::Value::Null
    } else {
        let full_name: String = submitter_rows[0].try_get("", "full_name").unwrap_or_default();
        let email: String = submitter_rows[0].try_get("", "email").unwrap_or_default();
        json!({ "id": req.submitted_by, "fullName": full_name, "email": email })
    };

    let ci_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT rci.id, rci.asset_id, rci.hostname, rci.hostname_description,
                      rci.credential_type::TEXT, rci.management_mode::TEXT,
                      a.credential_name
               FROM request_credential_items rci
               LEFT JOIN assets a ON a.id = rci.asset_id
               WHERE rci.request_id = $1"#,
            [request_id.into()],
        ))
        .await
        .map_err(db_err)?;
    let credential_items: Vec<JsonValue> = ci_rows
        .iter()
        .map(|r| {
            let id: Uuid = r.try_get("", "id").unwrap_or(Uuid::nil());
            let asset_id: Option<Uuid> = r.try_get("", "asset_id").ok();
            let hostname: String = r.try_get("", "hostname").unwrap_or_default();
            let hostname_desc: Option<String> = r.try_get("", "hostname_description").ok().flatten();
            let cred_type: String = r.try_get("", "credential_type").unwrap_or_default();
            let mgmt_mode: String = r.try_get("", "management_mode").unwrap_or_default();
            let cred_name: Option<String> = r.try_get("", "credential_name").ok().flatten();
            json!({
                "id": id, "assetId": asset_id,
                "hostname": hostname, "hostnameDescription": hostname_desc,
                "credentialType": cred_type, "managementMode": mgmt_mode,
                "credentialName": cred_name,
            })
        })
        .collect();

    let viewer_is_reviewer = req_is_current_step_reviewer(&db, user_id, &req).await?;
    let viewer_can_override = if is_pre_owner(&req.status, req.current_step_ordinal) && !viewer_is_reviewer && user_id != req.submitted_by {
        check_override_eligible(&db, user_id, request_id, req.current_step_ordinal)
            .await
            .unwrap_or(false)
    } else {
        false
    };

    let ready_row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT EXISTS(SELECT 1 FROM request_key_material WHERE request_id=$1 AND encrypted_secret_payload IS NOT NULL) AS ready",
        [request_id.into()])).await.map_err(db_err)?;
    let secret_material_ready: bool = ready_row.and_then(|r| r.try_get("", "ready").ok()).unwrap_or(false);
    let asset_custody = crate::routes::custody::read_model(&db, request_id, user_id).await?;

    Ok(Json(json!({
        "request": {
            "id": req.id,
            "requestNumber": req.request_number,
            "secretMaterialReady": secret_material_ready,
            "systemId": req.system_id,
            "submittedBy": req.submitted_by,
            "status": req.status,
            "currentStepOrdinal": req.current_step_ordinal,
            "returnCount": req.return_count,
            "ownerDecisionBy": req.owner_decision_by,
            "justification": req.justification,
            "viewerIsCurrentStepReviewer": viewer_is_reviewer,
            "viewerCanOverride": viewer_can_override,
        },
        "credentialItems": credential_items,
        "approvalSteps": approval_steps,
        "submitter": submitter,
        "assetCustody": asset_custody,
    }))
    .into_response())
}

// ── POST /requests/:id/admin-reset ────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminResetBody {
    notes: Option<String>,
}

pub async fn post_admin_reset(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(request_id_str): Path<String>,
    Json(_body): Json<AdminResetBody>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;

    if !crate::db::admin_roles::user_has_any_admin_role(&db, user_id).await? {
        return Err(AppError::Authorization("Admin access required.".into()));
    }

    let request_id = request_id_str
        .parse::<Uuid>()
        .map_err(|_| AppError::NotFound("Request not found.".into()))?;

    let req = get_request_row(&db, request_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Request not found.".into()))?;

    if req.status == "closed" {
        return Err(AppError::Validation("Closed requests cannot be reset.".into()));
    }

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE request_approval_steps
           SET step_status = 'pending'::step_status,
               assigned_reviewer_id = NULL, decision_notes = NULL,
               decided_at = NULL, decided_by = NULL, updated_at = now()
           WHERE request_id = $1 AND step_ordinal > 1"#,
        [request_id.into()],
    ))
    .await
    .map_err(db_err)?;

    let min_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT MIN(step_ordinal)::smallint AS min_ordinal
               FROM request_approval_steps WHERE request_id = $1 AND step_ordinal > 1"#,
            [request_id.into()],
        ))
        .await
        .map_err(db_err)?;
    let new_ordinal: i16 = min_rows
        .first()
        .and_then(|r| r.try_get::<Option<i16>>("", "min_ordinal").ok().flatten())
        .unwrap_or(req.current_step_ordinal);

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE breakglass_requests
           SET status = 'returned_to_vendor'::request_status,
               current_step_ordinal = $1,
               owner_decision_by = NULL, owner_decision_notes = NULL, owner_decision_at = NULL,
               return_count = return_count + 1, updated_at = now()
           WHERE id = $2"#,
        [new_ordinal.into(), request_id.into()],
    ))
    .await
    .map_err(db_err)?;

    if let Some(email) = get_user_email(&db, req.submitted_by).await? {
        insert_notification(&db, "request.admin_reset", request_id, &[email]).await?;
    }

    Ok(Json(json!({"message": "Request reset and returned to the submitter."})).into_response())
}

// ── GET /requests/my-requests ─────────────────────────────────────────────────

pub async fn get_my_requests(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;
    let is_admin = crate::db::admin_roles::user_has_any_admin_role(&db, user_id).await?;

    let reviewer_ids = get_reviewer_system_ids(&db, user_id).await?;
    let visible_ids = get_visible_system_ids(&db, user_id).await?;

    // Fetch submitter's own requests
    let own_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, system_id, submitted_by, status::TEXT, current_step_ordinal,
                      return_count, request_number
               FROM breakglass_requests WHERE submitted_by = $1
               ORDER BY created_at DESC"#,
            [user_id.into()],
        ))
        .await
        .map_err(db_err)?;

    // Fetch requests for visible systems (non-submitter path)
    let vis_rows = if visible_ids.is_empty() {
        vec![]
    } else {
        let id_list = visible_ids
            .iter()
            .map(|id| format!("'{}'", id))
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r#"SELECT id, system_id, submitted_by, status::TEXT, current_step_ordinal,
                      return_count, request_number
               FROM breakglass_requests
               WHERE system_id IN ({}) AND submitted_by != '{}'
               ORDER BY created_at DESC"#,
            id_list, user_id
        );
        db.query_all(sea_orm::Statement::from_string(DbBackend::Postgres, sql))
            .await
            .map_err(db_err)?
    };

    struct ReqCandidate {
        id: Uuid,
        system_id: Uuid,
        submitted_by: Uuid,
        status: String,
        current_step_ordinal: i16,
        return_count: i32,
        request_number: String,
    }

    fn row_to_candidate(r: &sea_orm::QueryResult) -> Option<ReqCandidate> {
        Some(ReqCandidate {
            id: r.try_get("", "id").ok()?,
            system_id: r.try_get("", "system_id").ok()?,
            submitted_by: r.try_get("", "submitted_by").ok()?,
            status: r.try_get("", "status").ok()?,
            current_step_ordinal: r.try_get("", "current_step_ordinal").ok()?,
            return_count: r.try_get("", "return_count").ok()?,
            request_number: r.try_get("", "request_number").ok()?,
        })
    }

    let mut results: Vec<JsonValue> = Vec::new();
    let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();

    // Submitter's own requests — always included; compute viewerIsCurrentStepReviewer per row
    for r in &own_rows {
        if let Some(c) = row_to_candidate(r) {
            if seen.insert(c.id) {
                let req_row = RequestRow {
                    id: c.id, system_id: c.system_id, submitted_by: c.submitted_by,
                    status: c.status.clone(), current_step_ordinal: c.current_step_ordinal,
                    return_count: c.return_count, request_number: c.request_number.clone(),
                    owner_decision_by: None, justification: String::new(),
                };
                let is_reviewer = req_is_current_step_reviewer(&db, user_id, &req_row).await?;
                let pending_actions = crate::pending_actions::actions_for(&db, user_id, c.id, c.system_id, &c.status, c.current_step_ordinal).await?;
                results.push(json!({
                    "id": c.id, "systemId": c.system_id, "submittedBy": c.submitted_by,
                    "status": c.status, "currentStepOrdinal": c.current_step_ordinal,
                    "returnCount": c.return_count, "requestNumber": c.request_number,
                    "viewerIsCurrentStepReviewer": is_reviewer,
                    "pendingActions": pending_actions,
                }));
            }
        }
    }

    // Non-submitter path — admins bypass step filter (VISIBLE_ALL by design)
    for r in &vis_rows {
        if let Some(c) = row_to_candidate(r) {
            if seen.contains(&c.id) || !visible_ids.contains(&c.system_id) {
                continue;
            }
            let req_row = RequestRow {
                id: c.id, system_id: c.system_id, submitted_by: c.submitted_by,
                status: c.status.clone(), current_step_ordinal: c.current_step_ordinal,
                return_count: c.return_count, request_number: c.request_number.clone(),
                owner_decision_by: None, justification: String::new(),
            };
            let is_reviewer = req_is_current_step_reviewer(&db, user_id, &req_row).await?;
            let pending_actions = crate::pending_actions::actions_for(&db, user_id, c.id, c.system_id, &c.status, c.current_step_ordinal).await?;
            if !is_admin {
                if is_pre_owner(&c.status, c.current_step_ordinal) {
                    if !reviewer_ids.contains(&c.system_id) || !is_reviewer {
                        continue;
                    }
                } else if c.status == "returned_to_vendor" {
                    continue;
                }
            }
            seen.insert(c.id);
            results.push(json!({
                "id": c.id, "systemId": c.system_id, "submittedBy": c.submitted_by,
                "status": c.status, "currentStepOrdinal": c.current_step_ordinal,
                "returnCount": c.return_count, "requestNumber": c.request_number,
                "viewerIsCurrentStepReviewer": is_reviewer,
                "pendingActions": pending_actions,
            }));
        }
    }

    Ok(Json(json!({ "requests": results })).into_response())
}

// ── GET /requests/search ──────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct SearchParams {
    q: Option<String>,
}

pub async fn get_search_requests(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Query(params): Query<SearchParams>,
) -> RouteResult<impl IntoResponse> {
    let user_id = session.user_id;

    let q = params.q.as_deref().unwrap_or("").trim().to_string();
    if q.is_empty() {
        return Ok(Json(json!({ "requests": [] })).into_response());
    }
    if q.len() < 3 || q.len() > 128 {
        return Err(AppError::Validation("q must be between 3 and 128 characters.".into()));
    }

    let reviewer_ids = get_reviewer_system_ids(&db, user_id).await?;
    let visible_ids = get_visible_system_ids(&db, user_id).await?;
    // Escape % and _ for ILIKE
    let safe_q = q.replace('%', "\\%").replace('_', "\\_");
    let pattern = format!("%{}%", safe_q);

    // Fetch own matching requests
    let own_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, system_id, submitted_by, status::TEXT, current_step_ordinal,
                      return_count, request_number
               FROM breakglass_requests
               WHERE submitted_by = $1 AND request_number ILIKE $2
               ORDER BY created_at DESC"#,
            [user_id.into(), pattern.clone().into()],
        ))
        .await
        .map_err(db_err)?;

    // Fetch visible system matching requests
    let vis_rows = if visible_ids.is_empty() {
        vec![]
    } else {
        let id_list = visible_ids
            .iter()
            .map(|id| format!("'{}'", id))
            .collect::<Vec<_>>()
            .join(", ");
        let safe_pattern = pattern.replace('\'', "''");
        let sql = format!(
            r#"SELECT id, system_id, submitted_by, status::TEXT, current_step_ordinal,
                      return_count, request_number
               FROM breakglass_requests
               WHERE system_id IN ({})
                 AND submitted_by != '{}'
                 AND request_number ILIKE '{}'
               ORDER BY created_at DESC"#,
            id_list, user_id, safe_pattern
        );
        db.query_all(sea_orm::Statement::from_string(DbBackend::Postgres, sql))
            .await
            .map_err(db_err)?
    };

    struct SReq {
        id: Uuid,
        system_id: Uuid,
        submitted_by: Uuid,
        status: String,
        current_step_ordinal: i16,
        return_count: i32,
        request_number: String,
    }
    fn to_sreq(r: &sea_orm::QueryResult) -> Option<SReq> {
        Some(SReq {
            id: r.try_get("", "id").ok()?,
            system_id: r.try_get("", "system_id").ok()?,
            submitted_by: r.try_get("", "submitted_by").ok()?,
            status: r.try_get("", "status").ok()?,
            current_step_ordinal: r.try_get("", "current_step_ordinal").ok()?,
            return_count: r.try_get("", "return_count").ok()?,
            request_number: r.try_get("", "request_number").ok()?,
        })
    }

    let mut results: Vec<JsonValue> = Vec::new();
    let mut seen: std::collections::HashSet<Uuid> = std::collections::HashSet::new();

    for r in own_rows.iter().chain(vis_rows.iter()) {
        if let Some(c) = to_sreq(r) {
            if seen.contains(&c.id) {
                continue;
            }
            // filterMappedRequests logic
            let include = if c.submitted_by == user_id {
                true
            } else if !visible_ids.contains(&c.system_id) {
                false
            } else if is_pre_owner(&c.status, c.current_step_ordinal) {
                reviewer_ids.contains(&c.system_id)
            } else {
                true
            };
            if !include {
                continue;
            }

            seen.insert(c.id);
            let req_row = RequestRow {
                id: c.id, system_id: c.system_id, submitted_by: c.submitted_by,
                status: c.status.clone(), current_step_ordinal: c.current_step_ordinal,
                return_count: c.return_count, request_number: c.request_number.clone(),
                owner_decision_by: None, justification: String::new(),
            };
            let viewer_is_reviewer = req_is_current_step_reviewer(&db, user_id, &req_row).await?;
            let viewer_can_override =
                if is_pre_owner(&c.status, c.current_step_ordinal) && !viewer_is_reviewer && user_id != c.submitted_by {
                    check_override_eligible(&db, user_id, c.id, c.current_step_ordinal)
                        .await
                        .unwrap_or(false)
                } else {
                    false
                };
            results.push(json!({
                "id": c.id, "systemId": c.system_id, "submittedBy": c.submitted_by,
                "status": c.status, "currentStepOrdinal": c.current_step_ordinal,
                "returnCount": c.return_count, "requestNumber": c.request_number,
                "viewerIsCurrentStepReviewer": viewer_is_reviewer,
                "viewerCanOverride": viewer_can_override,
            }));
        }
    }

    Ok(Json(json!({ "requests": results })).into_response())
}
