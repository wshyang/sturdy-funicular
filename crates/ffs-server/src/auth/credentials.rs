//! Self-service password rotation (legacy server/routes/auth-security.tsx).
use std::sync::Arc;

use axum::{extract::{Extension, State}, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::{
    app_settings,
    audit::write_audit_log,
    auth::{password::{generate_salt, hash_password, verify_password}, session::Session},
    config::Config,
    errors::{AppError, RouteResult},
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangePasswordBody { current_password: String, new_password: String }

pub async fn validate_new_password(db: &DatabaseConnection, password: &str) -> Result<(), AppError> {
    let min = app_settings::get_setting_int(db, "password_min_length").await?.max(1) as usize;
    let mut errors = Vec::new();
    if password.chars().count() < min { errors.push(format!("Password must be at least {min} characters.")); }
    if !password.chars().any(|c| c.is_ascii_uppercase()) { errors.push("Password must include at least one uppercase letter.".into()); }
    if !password.chars().any(|c| c.is_ascii_lowercase()) { errors.push("Password must include at least one lowercase letter.".into()); }
    if !password.chars().any(|c| c.is_ascii_digit()) { errors.push("Password must include at least one digit.".into()); }
    if !password.chars().any(|c| "!@#$%^&*(),.?\":{}|<>".contains(c)) { errors.push("Password must include at least one special character.".into()); }
    if errors.is_empty() { Ok(()) } else { Err(AppError::validation(errors.join(" "))) }
}

pub async fn change_password(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    session: Option<Extension<Arc<Session>>>,
    Json(body): Json<ChangePasswordBody>,
) -> RouteResult<Json<Value>> {
    // The session gate lets token-less requests reach this handler so it can
    // return the legacy 401 contract; a present token still passes the full gate.
    let Some(Extension(session)) = session else {
        return Err(AppError::unauthenticated("Authentication required."));
    };
    let user = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT is_system,password_login_disabled_at,password_salt,password_hash FROM users WHERE id=$1 AND status='active'",
        [session.user_id.into()])).await?
        .ok_or_else(|| AppError::unauthenticated("Authentication required."))?;
    let is_system: bool = user.try_get("", "is_system")?;
    let login_disabled: Option<chrono::DateTime<chrono::FixedOffset>> = user.try_get("", "password_login_disabled_at")?;
    let salt_old: Option<String> = user.try_get("", "password_salt")?;
    let hash_old: String = user.try_get("", "password_hash")?;
    if is_system || login_disabled.is_some() {
        return Err(AppError::auth("Password change is not available for this account."));
    }
    if !verify_password(&body.current_password, salt_old.as_deref().unwrap_or(""), &hash_old)? {
        return Err(AppError::validation("Current password is incorrect."));
    }
    validate_new_password(&db, &body.new_password).await?;
    if verify_password(&body.new_password, salt_old.as_deref().unwrap_or(""), &hash_old)? {
        return Err(AppError::validation("New password must be different from the current password."));
    }
    let salt = generate_salt();
    let hash = hash_password(&body.new_password, &salt).map_err(|e| AppError::Internal(anyhow::anyhow!("Hash error: {e}")))?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE users SET password_hash=$1,password_salt=$2,force_password_rotation=false,updated_at=now() WHERE id=$3",
        [hash.into(), salt.into(), session.user_id.into()])).await?;
    write_audit_log(&db, session.user_id, "user.password_changed", "user", &session.user_id.to_string(), None, json!({}), None).await?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "DELETE FROM sessions WHERE user_id=$1 AND id<>$2", [session.user_id.into(), session.id.clone().into()])).await?;
    Ok(Json(json!({"message":"Password updated."})))
}
