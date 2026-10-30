//! Admin app-settings routes (legacy server/routes/admin/app-settings.tsx).
//! Importers/callers: main.rs registers GET/PUT /admin/app-settings, export/import, runtime-info.
//! Affected API: GET /admin/app-settings, PUT /admin/app-settings/:key,
//!   GET /admin/app-settings/export, POST /admin/app-settings/import, GET /admin/runtime-info.
//! Data schemas: app_settings (global rows), audit_log (app_setting / export_bundle / import_operation).
//! User instruction: continue the staged Rust port (Stage 2D).

use std::sync::Arc;

use axum::{
    extract::{Extension, Path, State},
    response::IntoResponse,
    Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    app_settings::{self as settings, default_setting, is_secret, validate_bound, validate_pem, SECRET_MASK},
    audit,
    auth::{privileges::require_admin_privilege, session::Session},
    db::admin_roles::user_has_any_admin_role,
    config::Config,
    errors::{AppError, RouteResult},
};

pub async fn list_settings(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_admin_privilege(&db, session.user_id, "ConfigAppSettingsRead").await?;
    let rows = db.query_all(Statement::from_string(DbBackend::Postgres,
        "SELECT key, value, value_type, category, description, is_secret, updated_by, updated_at FROM app_settings WHERE organization_id IS NULL ORDER BY category, key".to_string())).await?;
    let mut out = Vec::new();
    for r in rows {
        let secret: bool = r.try_get("", "is_secret")?;
        let value: String = r.try_get("", "value")?;
        out.push(json!({
            "key": r.try_get::<String>("", "key")?,
            "value": if secret && !value.is_empty() { SECRET_MASK.to_string() } else { value },
            "valueType": r.try_get::<String>("", "value_type")?,
            "category": r.try_get::<String>("", "category")?,
            "description": r.try_get::<String>("", "description")?,
            "isSecret": secret,
            "updatedBy": r.try_get::<Option<Uuid>>("", "updated_by")?,
            "updatedAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at")?.to_rfc3339(),
        }));
    }
    Ok(Json(json!({"settings": out})))
}

#[derive(Deserialize)]
pub struct UpdateSettingBody {
    value: Option<JsonValue>,
    clear: Option<bool>,
    #[serde(flatten)]
    extra: std::collections::HashMap<String, JsonValue>,
}

pub async fn update_setting(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(key): Path<String>,
    Json(body): Json<UpdateSettingBody>,
) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_admin_privilege(&db, session.user_id, "ConfigAppSettingsWrite").await?;
    let def = default_setting(&key).ok_or_else(|| AppError::NotFound(format!("Unknown setting: {key}")))?;
    for imm in ["key", "value_type", "valueType", "category"] {
        if body.extra.contains_key(imm) {
            return Err(AppError::Validation(format!("{imm} is immutable and cannot be changed.")));
        }
    }
    let secret = is_secret(&key);
    let clear = secret && body.clear == Some(true);
    let new_value = if clear {
        String::new()
    } else {
        let v = body.value.as_ref().and_then(|v| v.as_str()).ok_or_else(|| AppError::Validation("A string `value` is required.".into()))?;
        validate_bound(&key, v, def.1).map_err(AppError::Validation)?;
        if !v.is_empty() { validate_pem(&key, v).map_err(AppError::Validation)?; }
        v.to_string()
    };
    let old = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT value FROM app_settings WHERE key=$1 AND organization_id IS NULL", [key.clone().into()])).await?;
    if old.is_none() { return Err(AppError::NotFound(format!("Unknown setting: {key}"))); }
    let old_value: String = old.unwrap().try_get("", "value")?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE app_settings SET value=$1, updated_by=$2, updated_at=now() WHERE key=$3 AND organization_id IS NULL",
        [new_value.clone().into(), session.user_id.into(), key.clone().into()])).await?;
    settings::clear_cache();
    audit::write_audit_log(&db, session.user_id, "app_setting.updated", "app_setting", &key, None, json!({
        "key": key,
        "oldValue": if secret { "[hidden]".to_string() } else { old_value },
        "newValue": if secret { "[hidden]".to_string() } else { new_value.clone() },
    }), None).await?;
    Ok(Json(json!({"message":"Setting updated.","key":key,"value": if secret && !new_value.is_empty() { SECRET_MASK.to_string() } else { new_value }})))
}

pub async fn export_settings(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_admin_privilege(&db, session.user_id, "ConfigAppSettingsBulkTransfer").await?;
    let rows = db.query_all(Statement::from_string(DbBackend::Postgres,
        "SELECT key, value FROM app_settings WHERE organization_id IS NULL".to_string())).await?;
    let mut values = std::collections::HashMap::new();
    for r in rows { values.insert(r.try_get::<String>("", "key")?, r.try_get::<String>("", "value")?); }
    let mut keys: Vec<&str> = settings::DEFAULTS.iter().map(|d| d.0).collect();
    keys.sort();
    let out: Vec<JsonValue> = keys.iter().map(|k| json!({"key":k,"value": values.get(*k).cloned().unwrap_or_else(|| default_setting(k).unwrap().0.to_string())})).collect();
    audit::write_audit_log(&db, session.user_id, "app_setting.bulk_exported", "export_bundle", "app-settings-export", None, json!({"settingCount": out.len()}), None).await?;
    Ok(Json(json!({"version":1,"exportedAt":chrono::Utc::now().to_rfc3339(),"settings":out})))
}

#[derive(Deserialize)]
pub struct ImportSettingsBody { settings: Vec<ImportEntry> }
#[derive(Deserialize)]
struct ImportEntry { key: String, value: String }

pub async fn import_settings(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Json(body): Json<ImportSettingsBody>,
) -> RouteResult<axum::response::Response> {
    ensure_admin(&db, session.user_id).await?;
    require_admin_privilege(&db, session.user_id, "ConfigAppSettingsBulkTransfer").await?;
    if body.settings.is_empty() { return Err(AppError::Validation("settings must be a non-empty array.".into())); }
    let mut seen = std::collections::HashSet::new();
    let mut failures = Vec::new();
    for e in &body.settings {
        if !seen.insert(e.key.clone()) { failures.push(json!({"key":e.key,"error":"Duplicate setting key in import."})); continue; }
        let Some(def) = default_setting(&e.key) else { failures.push(json!({"key":e.key,"error":format!("Unknown setting: {}",e.key)})); continue; };
        if is_secret(&e.key) && e.value.is_empty() { continue; }
        if def.1 == "string" && e.value.is_empty() { continue; }
        if let Err(err) = validate_bound(&e.key, &e.value, def.1) { failures.push(json!({"key":e.key,"error":err})); continue; }
        if !e.value.is_empty() { if let Err(err) = validate_pem(&e.key, &e.value) { failures.push(json!({"key":e.key,"error":err})); } }
    }
    if !failures.is_empty() {
        return Ok((axum::http::StatusCode::BAD_REQUEST, Json(json!({"error":format!("Import rejected: {} of {} settings failed validation. Nothing was applied.", failures.len(), body.settings.len()),"failures":failures}))).into_response());
    }
    let txn = db.begin().await?;
    for e in &body.settings {
        let def = default_setting(&e.key).unwrap();
        txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            r#"INSERT INTO app_settings (key,value,value_type,category,is_secret,updated_at) VALUES ($1,$2,$3,$4,$5,now())
               ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET value=EXCLUDED.value, updated_at=now()"#,
            [e.key.clone().into(), e.value.clone().into(), def.1.into(), def.2.into(), def.3.into()])).await?;
    }
    txn.commit().await?;
    settings::clear_cache();
    audit::write_audit_log(&db, session.user_id, "app_setting.bulk_imported", "import_operation", "app-settings-import", None,
        json!({"appliedCount":body.settings.len(),"keys":body.settings.iter().map(|e| e.key.clone()).collect::<Vec<_>>()}), None).await?;
    Ok(Json(json!({"message":"Settings imported.","appliedCount":body.settings.len()})).into_response())
}

pub async fn runtime_info(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    let mode = std::env::var("BREAKGLASS_DEV").unwrap_or_else(|_| "PROD".into());
    let demo = mode == "DEV" || mode == "DEMO";
    Ok(Json(json!({"breakglassDevMode":mode,"demoControlsEnabled":demo})))
}

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("You do not have admin access.".to_string()));
    }
    Ok(())
}

