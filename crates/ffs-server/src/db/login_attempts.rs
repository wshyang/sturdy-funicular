// Login attempt tracking for brute-force lockout.
// Mirrors server/utils.tsx checkLoginLock / recordLoginAttempt.
//
// Defaults: 5 attempts in a 15-min window → 30-min lockout.

use chrono::Utc;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use sha2::{Digest, Sha256};

use crate::errors::AppError;

const MAX_LOGIN_ATTEMPTS: i64 = 5;
const WINDOW_MS: i64 = 15 * 60 * 1000;
const LOCKOUT_MS: i64 = 30 * 60 * 1000;

fn email_hash(email: &str) -> String {
    let normalized = email.trim().to_lowercase();
    let mut hasher = Sha256::new();
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

/// Returns `Some(minutes_remaining)` if locked out, `None` if clear.
pub async fn check_login_lock(db: &DatabaseConnection, email: &str) -> Result<Option<i64>, AppError> {
    let key = email_hash(email);
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT locked_until FROM login_attempts WHERE email_hash = $1"#,
            [key.clone().into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;

    if rows.is_empty() {
        return Ok(None);
    }
    let locked_until: Option<chrono::DateTime<Utc>> = rows[0]
        .try_get("", "locked_until")
        .ok()
        .flatten();

    match locked_until {
        None => Ok(None),
        Some(until) => {
            let remaining_ms = until.timestamp_millis() - Utc::now().timestamp_millis();
            if remaining_ms <= 0 {
                let _ = db
                    .execute(Statement::from_sql_and_values(
                        DbBackend::Postgres,
                        r#"DELETE FROM login_attempts WHERE email_hash = $1"#,
                        [key.into()],
                    ))
                    .await;
                Ok(None)
            } else {
                let minutes = std::cmp::max(1, (remaining_ms + 59_999) / 60_000);
                Ok(Some(minutes))
            }
        }
    }
}

/// Record attempt. Success clears; failure upserts with window/lockout logic.
pub async fn record_login_attempt(db: &DatabaseConnection, email: &str, success: bool) -> Result<(), AppError> {
    let key = email_hash(email);
    if success {
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"DELETE FROM login_attempts WHERE email_hash = $1"#,
            [key.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
        return Ok(());
    }

    let now_ms = Utc::now().timestamp_millis();
    let now_iso = chrono::DateTime::<Utc>::from_timestamp_millis(now_ms)
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    let window_cutoff = chrono::DateTime::<Utc>::from_timestamp_millis(now_ms - WINDOW_MS)
        .unwrap_or_else(Utc::now)
        .to_rfc3339();
    let lockout_until = chrono::DateTime::<Utc>::from_timestamp_millis(now_ms + LOCKOUT_MS)
        .unwrap_or_else(Utc::now)
        .to_rfc3339();

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO login_attempts
             (email_hash, attempt_count, first_attempt_at, locked_until, updated_at)
           VALUES ($1, 1, $2::timestamptz, NULL, $2::timestamptz)
           ON CONFLICT (email_hash) DO UPDATE SET
             attempt_count = CASE
               WHEN login_attempts.first_attempt_at < $3::timestamptz THEN 1
               ELSE login_attempts.attempt_count + 1
             END,
             first_attempt_at = CASE
               WHEN login_attempts.first_attempt_at < $3::timestamptz THEN $2::timestamptz
               ELSE login_attempts.first_attempt_at
             END,
             locked_until = CASE
               WHEN login_attempts.first_attempt_at >= $3::timestamptz
                AND login_attempts.attempt_count + 1 >= $4 THEN $5::timestamptz
               ELSE NULL
             END,
             updated_at = $2::timestamptz"#,
        [
            key.into(),
            now_iso.into(),
            window_cutoff.into(),
            MAX_LOGIN_ATTEMPTS.into(),
            lockout_until.into(),
        ],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    Ok(())
}
