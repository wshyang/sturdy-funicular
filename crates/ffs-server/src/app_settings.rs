//! Centralized app-settings registry + resolution (legacy server/app-settings.tsx).
//! Importers/callers: routes/admin/app_settings.rs, routes/admin/organization_overrides.rs,
//!   notifications.rs, ported app_settings_* tests.
//! Affected API: GET/PUT /admin/app-settings, export/import, org overrides.
//! Data schemas: app_settings (global rows organization_id IS NULL; org overrides keyed by org).
//! User instruction: continue the staged Rust port (Stage 2D).

use std::collections::HashMap;
use std::sync::Mutex;

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::Value;
use uuid::Uuid;

use crate::errors::AppError;

include!("app_settings_defaults.rs");

pub const SECRET_MASK: &str = "••••••••";

pub const ORG_OVERRIDABLE: &[&str] = &[
    "email_delivery_provider",
    "postman_api_key", "postman_default_from", "postman_default_classification",
    "smtp_host", "smtp_port", "smtp_username", "smtp_password", "smtp_from", "smtp_secure",
    "ses_region", "ses_from_address", "ses_configuration_set",
    "slack_client_id", "slack_client_secret", "slack_bot_token", "slack_redirect_uri",
    "aws_encrypt_private_key_pem_b64", "aws_encrypt_public_key_pem_b64",
];

pub fn default_setting(key: &str) -> Option<(&'static str, &'static str, &'static str, bool)> {
    DEFAULTS.iter().find(|(k, ..)| *k == key).map(|(_, v, t, c, s)| (*v, *t, *c, *s))
}
pub fn is_secret(key: &str) -> bool { default_setting(key).map(|d| d.3).unwrap_or(false) }
pub fn is_org_overridable(key: &str) -> bool { ORG_OVERRIDABLE.contains(&key) }

static CACHE: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);
static ORG_CACHE: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

pub fn clear_cache() { *CACHE.lock().unwrap() = None; }
pub fn clear_org_cache() { *ORG_CACHE.lock().unwrap() = None; }

fn coerce(raw: &str, ty: &str) -> Value {
    match ty {
        "int" => json_num(raw.parse::<i64>().unwrap_or(0)),
        "bool" => Value::Bool(raw == "true"),
        _ => Value::String(raw.to_string()),
    }
}
fn json_num(n: i64) -> Value { Value::Number(n.into()) }

pub async fn get_setting(db: &DatabaseConnection, key: &str) -> Result<Value, AppError> {
    let def = default_setting(key).ok_or_else(|| AppError::Validation(format!("Unknown app setting key: {key}")))?;
    if let Some(c) = CACHE.lock().unwrap().as_ref() { if let Some(v) = c.get(key) { return Ok(v.clone()); } }
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT value, value_type FROM app_settings WHERE key=$1 AND organization_id IS NULL", [key.into()])).await?;
    let value = match row {
        Some(r) => { let v: String = r.try_get("", "value")?; let t: String = r.try_get("", "value_type")?; coerce(&v, &t) }
        None => coerce(def.0, def.1),
    };
    CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(key.to_string(), value.clone());
    Ok(value)
}

pub async fn get_setting_string(db: &DatabaseConnection, key: &str) -> Result<String, AppError> {
    Ok(get_setting(db, key).await?.as_str().unwrap_or("").to_string())
}
pub async fn get_setting_int(db: &DatabaseConnection, key: &str) -> Result<i64, AppError> {
    Ok(get_setting(db, key).await?.as_i64().unwrap_or(0))
}
pub async fn get_setting_bool(db: &DatabaseConnection, key: &str) -> Result<bool, AppError> {
    Ok(get_setting(db, key).await?.as_bool().unwrap_or(false))
}

/// Env-overridable feature toggles: a set, non-empty env var wins; otherwise DB/default.
pub async fn get_email_delivery_enabled(db: &DatabaseConnection) -> Result<bool, AppError> {
    if let Ok(v) = std::env::var("EMAIL_DELIVERY_ENABLED") { if !v.is_empty() { return Ok(v == "true"); } }
    get_setting_bool(db, "email_delivery_enabled").await
}
pub async fn get_aws_integration_enabled(db: &DatabaseConnection) -> Result<bool, AppError> {
    if let Ok(v) = std::env::var("AWS_INTEGRATION_ENABLED") { if !v.is_empty() { return Ok(v == "true"); } }
    get_setting_bool(db, "aws_integration_enabled").await
}
pub async fn get_slack_integration_enabled(db: &DatabaseConnection) -> Result<bool, AppError> {
    if let Ok(v) = std::env::var("SLACK_INTEGRATION_ENABLED") { if !v.is_empty() { return Ok(v == "true"); } }
    get_setting_bool(db, "slack_integration_enabled").await
}
pub async fn get_email_delivery_provider(db: &DatabaseConnection) -> Result<String, AppError> {
    if let Ok(v) = std::env::var("EMAIL_DELIVERY_PROVIDER") { if !v.is_empty() { return Ok(v); } }
    get_setting_string(db, "email_delivery_provider").await
}

pub async fn get_org_setting(db: &DatabaseConnection, org: Uuid, key: &str) -> Result<Value, AppError> {
    let def = default_setting(key).ok_or_else(|| AppError::Validation(format!("Unknown app setting key: {key}")))?;
    if !is_org_overridable(key) { return Err(AppError::Validation(format!("App setting is not org-overridable: {key}"))); }
    let ck = format!("{org}:{key}");
    if let Some(c) = ORG_CACHE.lock().unwrap().as_ref() { if let Some(v) = c.get(&ck) { return Ok(v.clone()); } }
    let org_row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT value FROM app_settings WHERE organization_id=$1 AND key=$2 AND expires_after IS NULL", [org.into(), key.into()])).await?;
    let value = if let Some(r) = org_row {
        coerce(&r.try_get::<String>("", "value")?, def.1)
    } else {
        let g = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT value, value_type FROM app_settings WHERE key=$1 AND organization_id IS NULL", [key.into()])).await?;
        match g { Some(r) => coerce(&r.try_get::<String>("", "value")?, &r.try_get::<String>("", "value_type")?), None => coerce(def.0, def.1) }
    };
    ORG_CACHE.lock().unwrap().get_or_insert_with(HashMap::new).insert(ck, value.clone());
    Ok(value)
}

pub fn validate_bound(key: &str, value: &str, ty: &str) -> Result<(), String> {
    if ty == "int" {
        let n: i64 = value.trim().parse().map_err(|_| "Value must be an integer.".to_string())?;
        if n.to_string() != value.trim() { return Err("Value must be an integer.".into()); }
        if n < 0 { return Err("Value must be non-negative.".into()); }
        match key {
            "session_inactivity_timeout_ms" => if n < 60_000 { return Err("Inactivity timeout must be at least 60000 ms (60 s).".into()); },
            "session_ttl_ms" | "idempotency_token_ttl_ms" | "entra_state_ttl_ms" | "entra_handoff_ttl_ms" | "login_attempt_window_ms" | "login_lockout_duration_ms" => if n < 1000 { return Err("Duration must be at least 1000 ms.".into()); },
            "max_login_attempts" => if n < 1 { return Err("Must allow at least 1 attempt.".into()); },
            "password_min_length" => if n < 8 { return Err("Password minimum length must be at least 8.".into()); },
            "audit_log_list_cap" | "access_log_list_cap" | "sent_notification_list_cap" => if !(1..=10_000).contains(&n) { return Err("List cap must be between 1 and 10000.".into()); },
            _ => {}
        }
        return Ok(());
    }
    if ty == "bool" {
        if value != "true" && value != "false" { return Err("Value must be 'true' or 'false'.".into()); }
        return Ok(());
    }
    if key.starts_with("cron_") && value.trim().split_whitespace().count() != 5 {
        return Err("Cron expression must have exactly 5 space-separated fields.".into());
    }
    if key == "entra_sso_auth_context_id" { return Ok(()); }
    if value.is_empty() { return Err("Value cannot be empty.".into()); }
    Ok(())
}

fn pem_to_der(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let trimmed = value.trim();
    let text = if trimmed.starts_with("-----BEGIN") { trimmed.to_string() } else {
        String::from_utf8(base64::engine::general_purpose::STANDARD.decode(trimmed).map_err(|_| "not base64".to_string())?).map_err(|_| "not utf8".to_string())?
    };
    let b64: String = text.lines().filter(|l| !l.starts_with("-----")).collect();
    base64::engine::general_purpose::STANDARD.decode(b64).map_err(|_| "bad pem".to_string())
}

pub fn validate_pem(key: &str, value: &str) -> Result<(), String> {
    use rsa::pkcs8::{DecodePrivateKey, DecodePublicKey};
    if !matches!(key, "aws_encrypt_private_key_pem_b64" | "entra_client_key_pem_base64" | "aws_encrypt_public_key_pem_b64" | "entra_cert_pem_base64") { return Ok(()); }
    let der = pem_to_der(value)?;
    match key {
        "aws_encrypt_private_key_pem_b64" | "entra_client_key_pem_base64" => {
            rsa::RsaPrivateKey::from_pkcs8_der(&der).map_err(|_| "The uploaded file is not a valid RSA private key (PKCS#8 PEM).".to_string())?;
        }
        "aws_encrypt_public_key_pem_b64" => {
            rsa::RsaPublicKey::from_public_key_der(&der).map_err(|_| "The uploaded file is not a valid RSA public key (SPKI PEM).".to_string())?;
        }
        "entra_cert_pem_base64" => {
            // Minimal X.509 SPKI extraction: locate rsaEncryption OID then BIT STRING.
            if !der.windows(9).any(|w| w == [0x2a,0x86,0x48,0x86,0xf7,0x0d,0x01,0x01,0x01]) {
                return Err("The uploaded file is not a valid X.509 certificate containing an RSA public key.".into());
            }
        }
        _ => {}
    }
    Ok(())
}

pub async fn set_setting(db: &DatabaseConnection, key: &str, value: &str) -> Result<(), AppError> {
    let def = default_setting(key).ok_or_else(|| AppError::Validation(format!("Unknown app setting key: {key}")))?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"INSERT INTO app_settings (key, value, value_type, category, is_secret, updated_at)
           VALUES ($1,$2,$3,$4,$5,now())
           ON CONFLICT (key) WHERE organization_id IS NULL
           DO UPDATE SET value=EXCLUDED.value, updated_at=now()"#,
        [key.into(), value.into(), def.1.into(), def.2.into(), def.3.into()])).await?;
    clear_cache();
    Ok(())
}

// ── Provider getters (legacy app-settings.tsx SMTP/SES family) ──────────────
async fn opt_string(db: &DatabaseConnection, key: &str) -> Result<Option<String>, AppError> {
    let v = get_setting_string(db, key).await?;
    Ok(if v.is_empty() { None } else { Some(v) })
}
pub async fn get_smtp_host(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "smtp_host").await }
pub async fn get_smtp_port(db: &DatabaseConnection) -> Result<Option<i64>, AppError> {
    let v = get_setting(db, "smtp_port").await?;
    Ok(v.as_i64().filter(|n| *n != 0))
}
pub async fn get_smtp_username(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "smtp_username").await }
pub async fn get_smtp_password(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "smtp_password").await }
pub async fn get_smtp_from(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "smtp_from").await }
pub async fn get_smtp_secure(db: &DatabaseConnection) -> Result<Option<bool>, AppError> {
    let v = get_setting(db, "smtp_secure").await?;
    Ok(if v.as_bool() == Some(true) { Some(true) } else { None })
}
pub async fn is_smtp_configured(db: &DatabaseConnection) -> Result<bool, AppError> {
    Ok(get_smtp_host(db).await?.is_some() && get_smtp_port(db).await?.is_some()
        && get_smtp_username(db).await?.is_some() && get_smtp_password(db).await?.is_some()
        && get_smtp_from(db).await?.is_some())
}
pub async fn get_ses_region(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "ses_region").await }
pub async fn get_ses_from_address(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "ses_from_address").await }
pub async fn get_ses_configuration_set(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "ses_configuration_set").await }
pub async fn is_ses_configured(db: &DatabaseConnection) -> Result<bool, AppError> {
    Ok(get_ses_region(db).await?.is_some() && get_ses_from_address(db).await?.is_some())
}
pub async fn get_entra_private_key_pem(db: &DatabaseConnection) -> Result<Option<String>, AppError> { opt_string(db, "entra_client_key_pem_base64").await }
