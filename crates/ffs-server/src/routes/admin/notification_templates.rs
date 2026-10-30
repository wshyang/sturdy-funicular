// Admin notification-templates route handlers.
// Importers/callers: main.rs registers GET /admin/notification-templates via list_notification_templates.
// Affected API: GET /admin/notification-templates (ConfigEmailTemplateRead cap).
// Data schemas: notification_templates(id UUID, organization_id UUID nullable,
//   trigger_key email_trigger_key, subject VARCHAR(255), body_html TEXT,
//   body_text TEXT nullable, is_active BOOL, channels TEXT[], created_by UUID,
//   created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, expires_after TIMESTAMPTZ nullable).
// User instruction: "fix the rust port to ensure API and PlayWright suites pass."

use std::sync::Arc;

use axum::{extract::State, response::IntoResponse, Extension, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
    errors::{AppError, RouteResult},
};

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("You do not have admin access.".to_string()));
    }
    Ok(())
}

// ── GET /admin/notification-templates ────────────────────────────────────────

pub async fn list_notification_templates(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;

    let scope = resolve_admin_capability_scope(&db, session.user_id, "ConfigEmailTemplateRead").await?;
    if let ScopeKind::None = scope {
        return Err(AppError::Authorization("Missing capability: ConfigEmailTemplateRead".to_string()));
    }

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, trigger_key::TEXT AS trigger_key, subject, body_html,
                      body_text, is_active, channels, created_at, updated_at
               FROM notification_templates
               WHERE organization_id IS NULL AND expires_after IS NULL
               ORDER BY trigger_key"#,
            [],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("list notification_templates: {}", e)))?;

    // Load all variables in one query; group by template_id.
    let var_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT v.template_id, v.name, v.description
               FROM notification_template_variables v
               JOIN notification_templates t ON t.id = v.template_id
               WHERE t.organization_id IS NULL AND t.expires_after IS NULL
               ORDER BY v.template_id, v.ordinal"#,
            [],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("list template vars: {}", e)))?;

    let mut vars_by_template: std::collections::HashMap<Uuid, Vec<JsonValue>> = Default::default();
    for vr in &var_rows {
        let tid: Uuid = vr.try_get("", "template_id").map_err(|e| AppError::Internal(anyhow::anyhow!("tid: {}", e)))?;
        let name: String = vr.try_get("", "name").map_err(|e| AppError::Internal(anyhow::anyhow!("var name: {}", e)))?;
        let description: String = vr.try_get("", "description").map_err(|e| AppError::Internal(anyhow::anyhow!("var desc: {}", e)))?;
        vars_by_template.entry(tid).or_default().push(json!({ "name": name, "description": description }));
    }

    let templates: Vec<JsonValue> = rows
        .iter()
        .map(|r| -> Result<JsonValue, AppError> {
            let id: Uuid = r.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("id: {}", e)))?;
            let trigger_key: String = r.try_get("", "trigger_key").map_err(|e| AppError::Internal(anyhow::anyhow!("trigger_key: {}", e)))?;
            let subject: String = r.try_get("", "subject").map_err(|e| AppError::Internal(anyhow::anyhow!("subject: {}", e)))?;
            let body_html: String = r.try_get("", "body_html").map_err(|e| AppError::Internal(anyhow::anyhow!("body_html: {}", e)))?;
            let body_text: Option<String> = r.try_get("", "body_text").ok();
            let is_active: bool = r.try_get("", "is_active").unwrap_or(true);
            let channels: Vec<String> = r.try_get("", "channels").unwrap_or_else(|_| vec!["email".to_owned()]);
            let created_at: chrono::DateTime<chrono::FixedOffset> = r.try_get("", "created_at").map_err(|e| AppError::Internal(anyhow::anyhow!("created_at: {}", e)))?;
            let updated_at: chrono::DateTime<chrono::FixedOffset> = r.try_get("", "updated_at").map_err(|e| AppError::Internal(anyhow::anyhow!("updated_at: {}", e)))?;
            let variables = vars_by_template.get(&id).cloned().unwrap_or_default();

            Ok(json!({
                "id": id,
                "triggerKey": trigger_key,
                "subject": subject,
                "bodyHtml": body_html,
                "bodyText": body_text,
                "isActive": is_active,
                "channels": channels,
                "organizationId": null,
                "variables": variables,
                "createdAt": created_at.to_rfc3339(),
                "updatedAt": updated_at.to_rfc3339(),
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(json!({ "templates": templates })))
}

// ── PUT /admin/notification-templates/:id ────────────────────────────────────

pub async fn update_notification_template(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    axum::extract::Path(id): axum::extract::Path<Uuid>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    crate::auth::privileges::require_admin_privilege(&db, session.user_id, "ConfigEmailTemplateWrite").await?;
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, trigger_key::text AS trigger_key, subject, body_html, body_text, channels, is_active FROM notification_templates WHERE id=$1 AND organization_id IS NULL", [id.into()])).await?;
    let row = row.ok_or_else(|| AppError::NotFound("Email template not found.".into()))?;
    let old_subject: String = row.try_get("", "subject")?;
    let old_html: String = row.try_get("", "body_html")?;
    let mut subject = old_subject.clone();
    let mut html = old_html.clone();
    let mut body_text: Option<String> = row.try_get("", "body_text")?;
    let mut channels: Vec<String> = row.try_get("", "channels")?;
    let mut is_active: bool = row.try_get("", "is_active")?;
    let mut changed = Vec::new();
    if let Some(v) = body.get("subject") {
        let s = v.as_str().unwrap_or("").trim();
        if s.is_empty() || s.len() > 255 { return Err(AppError::Validation("Subject is required and must be 1-255 characters.".into())); }
        subject = s.to_string(); changed.push("subject");
    }
    if let Some(v) = body.get("bodyHtml") {
        let s = v.as_str().unwrap_or("");
        if s.trim().is_empty() { return Err(AppError::Validation("Body HTML is required.".into())); }
        html = crate::email_html::sanitize_email_html(s); changed.push("bodyHtml");
    }
    if let Some(v) = body.get("bodyText") {
        if !v.is_null() && !v.is_string() { return Err(AppError::Validation("body_text must be a string or null.".into())); }
        body_text = v.as_str().map(String::from); changed.push("bodyText");
    }
    if let Some(v) = body.get("channels") {
        let arr = v.as_array().ok_or_else(|| AppError::Validation("channels must be a non-empty array of 'email' and/or 'slack'.".into()))?;
        if arr.is_empty() || !arr.iter().all(|c| c.as_str() == Some("email") || c.as_str() == Some("slack")) {
            return Err(AppError::Validation("channels must be a non-empty array of 'email' and/or 'slack'.".into()));
        }
        channels = arr.iter().filter_map(|c| c.as_str().map(String::from)).collect(); changed.push("channels");
    }
    if let Some(v) = body.get("isActive") {
        is_active = v.as_bool().ok_or_else(|| AppError::Validation("is_active must be a boolean.".into()))?; changed.push("isActive");
    }
    if changed.is_empty() { return Err(AppError::Validation("No fields to update.".into())); }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE notification_templates SET subject=$1, body_html=$2, body_text=$3, channels=$4, is_active=$5, updated_at=now() WHERE id=$6",
        [subject.clone().into(), html.clone().into(), body_text.clone().into(), channels.clone().into(), is_active.into(), id.into()])).await?;
    crate::audit::write_audit_log(&db, session.user_id, "email_template.updated", "email_template", &id.to_string(), None, json!({
        "changedFields": changed,
        "oldValues": {"subject": old_subject, "bodyHtml": old_html},
        "newValues": {"subject": subject, "bodyHtml": html},
    }), None).await?;
    let trigger_key: String = row.try_get("", "trigger_key")?;
    Ok(Json(json!({"template": {"id":id,"triggerKey":trigger_key,"subject":subject,"bodyHtml":html,"bodyText":body_text,"channels":channels,"isActive":is_active}})))
}

// ── GET /admin/sent-notifications ────────────────────────────────────────────

pub async fn list_sent_notifications(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    crate::auth::privileges::require_admin_privilege(&db, session.user_id, "AuditSentNotificationsRead").await?;
    let cap = crate::app_settings::get_setting_int(&db, "sent_notification_list_cap").await.unwrap_or(100);
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, trigger_key::text AS trigger_key, rendered_subject, rendered_body_html, rendered_body_text, related_target_type::text AS related_target_type, related_target_id, created_at FROM sent_notifications ORDER BY created_at DESC LIMIT $1", [cap.into()])).await?;
    let mut out = Vec::new();
    for r in rows {
        out.push(json!({
            "id": r.try_get::<Uuid>("", "id")?,
            "triggerKey": r.try_get::<String>("", "trigger_key")?,
            "renderedSubject": r.try_get::<String>("", "rendered_subject")?,
            "renderedBodyHtml": crate::email_html::sanitize_email_html(&r.try_get::<String>("", "rendered_body_html")?),
            "renderedBodyText": r.try_get::<Option<String>>("", "rendered_body_text")?,
            "relatedTargetType": r.try_get::<Option<String>>("", "related_target_type")?,
            "relatedTargetId": r.try_get::<Option<String>>("", "related_target_id")?,
            "createdAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "created_at")?.to_rfc3339(),
        }));
    }
    Ok(Json(json!({"notifications":out})))
}
