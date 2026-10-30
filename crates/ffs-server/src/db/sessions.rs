// SeaORM session update helpers (PORT-1.8).
// Only write-side operations — reads live in auth/session.rs.

use chrono::Utc;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection, EntityTrait};
use uuid::Uuid;

use crate::{auth::session::entity, errors::AppError};

pub async fn set_pending_totp_secret(
    db: &DatabaseConnection,
    token: &str,
    secret: Option<String>,
) -> Result<(), AppError> {
    let am = entity::ActiveModel {
        id: Set(token.to_string()),
        pending_totp_secret: Set(secret),
        ..Default::default()
    };
    am.update(db).await.map_err(AppError::from)?;
    Ok(())
}

pub async fn mark_twofa_verified(db: &DatabaseConnection, token: &str) -> Result<(), AppError> {
    let now = Utc::now();
    let am = entity::ActiveModel {
        id: Set(token.to_string()),
        twofa_verified_at: Set(Some(now.fixed_offset())),
        twofa_failed_attempts: Set(0),
        strong_auth_at: Set(Some(now.fixed_offset())),
        strong_auth_source: Set(Some("app_totp".to_string())),
        pending_totp_secret: Set(None),
        ..Default::default()
    };
    am.update(db).await.map_err(AppError::from)?;
    Ok(())
}

pub async fn record_twofa_failure(
    db: &DatabaseConnection,
    token: &str,
) -> Result<i32, AppError> {
    db.execute(sea_orm::Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        "UPDATE sessions SET twofa_failed_attempts = twofa_failed_attempts + 1 WHERE id = $1",
        [token.into()],
    ))
    .await
    .map_err(AppError::from)?;

    let row = entity::Entity::find_by_id(token)
        .one(db)
        .await
        .map_err(AppError::from)?;
    Ok(row.map(|r| r.twofa_failed_attempts).unwrap_or(1))
}

pub async fn confirm_totp_enrollment(
    db: &DatabaseConnection,
    user_id: Uuid,
    secret: &str,
) -> Result<(), AppError> {
    use crate::db::users::entity as user_entity;
    let am = user_entity::ActiveModel {
        id: Set(user_id),
        totp_secret: Set(Some(secret.to_string())),
        totp_enrolled_at: Set(Some(Utc::now().fixed_offset())),
        ..Default::default()
    };
    am.update(db).await.map_err(AppError::from)?;
    Ok(())
}
