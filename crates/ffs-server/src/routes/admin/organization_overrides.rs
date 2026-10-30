//! Org-scoped settings/template overrides (legacy server/routes/admin/organization-overrides.tsx).
//! Importers/callers: main.rs registers /admin/organizations/:id/{settings,templates}.
//! Affected API: GET/PUT/DELETE org settings + GET/PUT/DELETE org templates.
//! Data schemas: app_settings + notification_templates (organization_id non-null), audit_log.
//! User instruction: continue the staged Rust port (Stage 2D).

use std::sync::Arc;

use axum::{extract::{Extension, Path, State}, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    app_settings::{self as settings, default_setting, is_org_overridable, is_secret, validate_pem, SECRET_MASK},
    audit::write_audit_log,
    auth::session::Session,
    config::Config,
    db::admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
    email_html::sanitize_email_html,
    errors::{AppError, RouteResult},
};

type RouteState = State<(Config, DatabaseConnection)>;
const NOT_FOUND: &str = "Organisation not found.";

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? { return Err(AppError::Authorization("You do not have admin access.".into())); }
    Ok(())
}
async fn require_org_cap(db: &DatabaseConnection, user_id: Uuid, cap: &str, org: Uuid) -> Result<(), AppError> {
    let sc = resolve_admin_capability_scope(db, user_id, cap).await?;
    match sc {
        ScopeKind::Global => Ok(()),
        ScopeKind::Scoped(orgs) if orgs.contains(&org) => Ok(()),
        _ => Err(AppError::NotFound(NOT_FOUND.into())),
    }
}
async fn ensure_org(db: &DatabaseConnection, org: Uuid) -> Result<(), AppError> {
    let r = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM organizations WHERE id=$1 AND expires_after IS NULL", [org.into()])).await?;
    if r.is_empty() { return Err(AppError::NotFound(NOT_FOUND.into())); }
    Ok(())
}

pub async fn get_org_settings(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(org): Path<Uuid>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_org_cap(&db, session.user_id, "OrgAppSettingsRead", org).await?;
    ensure_org(&db, org).await?;
    let overrides = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT key, value, updated_at FROM app_settings WHERE organization_id=$1 AND expires_after IS NULL", [org.into()])).await?;
    let globals = db.query_all(Statement::from_string(DbBackend::Postgres, "SELECT key, value, value_type, updated_at FROM app_settings WHERE organization_id IS NULL".to_string())).await?;
    let mut ov = std::collections::HashMap::new();
    for r in overrides { ov.insert(r.try_get::<String>("", "key")?, (r.try_get::<String>("", "value")?, r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at")?)); }
    let mut gl = std::collections::HashMap::new();
    for r in globals { gl.insert(r.try_get::<String>("", "key")?, (r.try_get::<String>("", "value")?, r.try_get::<String>("", "value_type")?, r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at")?)); }
    let mut out = Vec::new();
    for key in settings::ORG_OVERRIDABLE {
        let def = default_setting(key).unwrap();
        let secret = is_secret(key);
        let (value, source, org_updated) = if let Some((v, t)) = ov.get(*key) {
            (v.clone(), "organization", Some(t.to_rfc3339()))
        } else if let Some((v, _, _t)) = gl.get(*key) {
            (v.clone(), "global", None)
        } else { (def.0.to_string(), "global", None) };
        let value_type = gl.get(*key).map(|g| g.1.clone()).unwrap_or_else(|| def.1.to_string());
        let global_updated = gl.get(*key).map(|g| g.2.to_rfc3339());
        out.push(json!({
            "key": key,
            "value": if secret && !value.is_empty() { SECRET_MASK.to_string() } else { value },
            "valueType": value_type, "category": def.2, "isSecret": secret,
            "source": source, "orgUpdatedAt": org_updated, "globalUpdatedAt": global_updated,
        }));
    }
    Ok(Json(json!({"settings":out})))
}

pub async fn update_org_setting(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path((org, key)): Path<(Uuid, String)>, Json(body): Json<JsonValue>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_org_cap(&db, session.user_id, "OrgAppSettingsWrite", org).await?;
    ensure_org(&db, org).await?;
    if default_setting(&key).is_none() { return Err(AppError::NotFound(format!("Unknown setting: {key}"))); }
    if !is_org_overridable(&key) { return Err(AppError::Validation(format!("Setting {key} is not org-overridable — it is managed in the global app settings."))); }
    for imm in ["key", "valueType", "category", "organizationId"] {
        if body.get(imm).is_some() { return Err(AppError::Validation(format!("{imm} is immutable and cannot be changed."))); }
    }
    let value = body["value"].as_str().ok_or_else(|| AppError::Validation("A string `value` is required.".into()))?;
    if !value.is_empty() { validate_pem(&key, value).map_err(AppError::Validation)?; }
    let secret = is_secret(&key);
    let existing = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, value FROM app_settings WHERE organization_id=$1 AND key=$2 AND expires_after IS NULL", [org.into(), key.clone().into()])).await?;
    let old_value = existing.as_ref().map(|r| r.try_get::<String>("", "value").unwrap_or_default());
    if let Some(r) = existing {
        let id: Uuid = r.try_get("", "id")?;
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE app_settings SET value=$1, updated_by=$2, updated_at=now() WHERE id=$3", [value.into(), session.user_id.into(), id.into()])).await?;
    } else {
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO app_settings (organization_id, key, value, updated_by, updated_at) VALUES ($1,$2,$3,$4,now())",
            [org.into(), key.clone().into(), value.into(), session.user_id.into()])).await?;
    }
    settings::clear_org_cache();
    write_audit_log(&db, session.user_id, "organization_setting.updated", "organization", &org.to_string(), Some(org), json!({
        "key": key,
        "oldValue": if secret { "[hidden]".to_string() } else { old_value.unwrap_or_else(|| "(inherited)".into()) },
        "newValue": if secret { "[hidden]".to_string() } else { value.to_string() },
    }), None).await?;
    Ok(Json(json!({"message":"Organisation setting updated.","key":key,"value": if secret && !value.is_empty() { SECRET_MASK.to_string() } else { value.to_string() },"source":"organization"})))
}

pub async fn delete_org_setting(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path((org, key)): Path<(Uuid, String)>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_org_cap(&db, session.user_id, "OrgAppSettingsWrite", org).await?;
    ensure_org(&db, org).await?;
    if default_setting(&key).is_none() { return Err(AppError::NotFound(format!("Unknown setting: {key}"))); }
    let existing = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, value FROM app_settings WHERE organization_id=$1 AND key=$2 AND expires_after IS NULL", [org.into(), key.clone().into()])).await?;
    let r = existing.ok_or_else(|| AppError::NotFound("No organisation override for this setting.".into()))?;
    let id: Uuid = r.try_get("", "id")?;
    let old: String = r.try_get("", "value")?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE app_settings SET expires_after=now() WHERE id=$1", [id.into()])).await?;
    settings::clear_org_cache();
    write_audit_log(&db, session.user_id, "organization_setting.reverted", "organization", &org.to_string(), Some(org),
        json!({"key":key,"oldValue": if is_secret(&key) { "[hidden]".to_string() } else { old }}), None).await?;
    Ok(Json(json!({"message":"Organisation override removed — the global value applies again.","key":key})))
}

async fn template_json(r: &sea_orm::QueryResult, source: &str, org_updated: Option<String>, global_updated: String) -> Result<JsonValue, AppError> {
    Ok(json!({
        "triggerKey": r.try_get::<String>("", "trigger_key")?,
        "subject": r.try_get::<String>("", "subject")?,
        "bodyHtml": sanitize_email_html(&r.try_get::<String>("", "body_html")?),
        "bodyText": r.try_get::<Option<String>>("", "body_text")?,
        "channels": r.try_get::<Vec<String>>("", "channels")?,
        "isActive": r.try_get::<bool>("", "is_active")?,
        "source": source, "orgUpdatedAt": org_updated, "globalUpdatedAt": global_updated,
    }))
}

pub async fn get_org_templates(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path(org): Path<Uuid>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_org_cap(&db, session.user_id, "OrgTemplateRead", org).await?;
    ensure_org(&db, org).await?;
    let globals = db.query_all(Statement::from_string(DbBackend::Postgres, "SELECT trigger_key::text AS trigger_key, subject, body_html, body_text, channels, is_active, updated_at FROM notification_templates WHERE organization_id IS NULL AND expires_after IS NULL ORDER BY trigger_key".to_string())).await?;
    let overrides = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT trigger_key::text AS trigger_key, subject, body_html, body_text, channels, is_active, updated_at FROM notification_templates WHERE organization_id=$1 AND expires_after IS NULL", [org.into()])).await?;
    let mut ov = std::collections::HashMap::new();
    for r in overrides { ov.insert(r.try_get::<String>("", "trigger_key")?, r); }
    let mut out = Vec::new();
    for g in &globals {
        let tk: String = g.try_get("", "trigger_key")?;
        let gu = g.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at")?.to_rfc3339();
        if let Some(o) = ov.get(&tk) {
            let ou = o.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at")?.to_rfc3339();
            out.push(template_json(o, "organization", Some(ou), gu).await?);
        } else {
            out.push(template_json(g, "global", None, gu).await?);
        }
    }
    Ok(Json(json!({"templates":out})))
}

pub async fn update_org_template(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path((org, trigger)): Path<(Uuid, String)>, Json(body): Json<JsonValue>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_org_cap(&db, session.user_id, "OrgTemplateWrite", org).await?;
    ensure_org(&db, org).await?;
    let g = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, subject, body_html, body_text, channels, is_active FROM notification_templates WHERE organization_id IS NULL AND trigger_key::text=$1 AND expires_after IS NULL", [trigger.clone().into()])).await?;
    let g = g.ok_or_else(|| AppError::NotFound("Unknown notification trigger.".into()))?;
    let existing = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id FROM notification_templates WHERE organization_id=$1 AND trigger_key::text=$2 AND expires_after IS NULL", [org.into(), trigger.clone().into()])).await?;
    let subject = body.get("subject").and_then(|v| v.as_str()).map(|s| s.trim().to_string());
    if let Some(s) = &subject { if s.is_empty() || s.len() > 255 { return Err(AppError::Validation("Subject is required and must be 1-255 characters.".into())); } }
    let body_html = body.get("bodyHtml").and_then(|v| v.as_str()).map(|s| sanitize_email_html(s));
    if let Some(h) = &body_html { if h.trim().is_empty() { return Err(AppError::Validation("Body HTML is required.".into())); } }
    let final_subject = subject.unwrap_or_else(|| g.try_get("", "subject").unwrap_or_default());
    let final_html = body_html.unwrap_or_else(|| g.try_get("", "body_html").unwrap_or_default());
    let body_text = body.get("bodyText").and_then(|v| v.as_str()).map(|s| s.to_string()).or_else(|| g.try_get("", "body_text").ok());
    let channels = body.get("channels").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect::<Vec<_>>()).unwrap_or_else(|| g.try_get("", "channels").unwrap_or_else(|_| vec!["email".into()]));
    let is_active = body.get("isActive").and_then(|v| v.as_bool()).unwrap_or_else(|| g.try_get("", "is_active").unwrap_or(true));
    if let Some(r) = existing {
        let id: Uuid = r.try_get("", "id")?;
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE notification_templates SET subject=$1, body_html=$2, body_text=$3, channels=$4, is_active=$5, updated_at=now() WHERE id=$6",
            [final_subject.into(), final_html.into(), body_text.into(), channels.into(), is_active.into(), id.into()])).await?;
    } else {
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO notification_templates (organization_id, trigger_key, subject, body_html, body_text, channels, is_active, created_by, updated_at) VALUES ($1,$2::email_trigger_key,$3,$4,$5,$6,$7,$8,now())",
            [org.into(), trigger.clone().into(), final_subject.into(), final_html.into(), body_text.into(), channels.into(), is_active.into(), session.user_id.into()])).await?;
    }
    write_audit_log(&db, session.user_id, "organization_template.updated", "organization", &org.to_string(), Some(org), json!({"triggerKey":trigger}), None).await?;
    Ok(Json(json!({"message":"Organisation template updated.","triggerKey":trigger,"source":"organization"})))
}

pub async fn delete_org_template(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Path((org, trigger)): Path<(Uuid, String)>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_org_cap(&db, session.user_id, "OrgTemplateWrite", org).await?;
    ensure_org(&db, org).await?;
    let r = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id FROM notification_templates WHERE organization_id=$1 AND trigger_key::text=$2 AND expires_after IS NULL", [org.into(), trigger.clone().into()])).await?;
    let r = r.ok_or_else(|| AppError::NotFound("No organisation override for this template.".into()))?;
    let id: Uuid = r.try_get("", "id")?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE notification_templates SET expires_after=now() WHERE id=$1", [id.into()])).await?;
    write_audit_log(&db, session.user_id, "organization_template.reverted", "organization", &org.to_string(), Some(org), json!({"triggerKey":trigger}), None).await?;
    Ok(Json(json!({"message":"Organisation template override removed.","triggerKey":trigger})))
}
