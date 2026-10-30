// Idempotency token issuance and consumption.
// Mirrors server/idempotency.tsx.
//
// Tokens are UUIDs, single-use, 15-min TTL (default; app_settings integration deferred).
// consume atomically marks used via UPDATE WHERE used_at IS NULL.
// create mints a fresh token outside any transaction so it is never rolled back.

use chrono::{Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ConnectionTrait, DatabaseConnection,
    Statement,
};
use uuid::Uuid;

use crate::errors::AppError;

const IDEMPOTENCY_TTL_MS: i64 = 15 * 60 * 1000;

pub mod entity {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "idempotency_tokens")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub token: Uuid,
        pub created_at: DateTimeWithTimeZone,
        pub used_at: Option<DateTimeWithTimeZone>,
        pub expires_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

/// Atomically consume the token via a single UPDATE WHERE used_at IS NULL.
/// Mirrors Hono's tokens.tsx consume() — the single UPDATE is what makes this
/// race-safe: two concurrent requests on the same token, only one UPDATE wins.
/// Returns true if this call consumed the token, false if missing/used/expired.
pub async fn consume_idempotency_token<C: ConnectionTrait>(
    conn: &C,
    token: &str,
    user_id: &Uuid,
) -> Result<bool, AppError> {
    let token_uuid = match token.parse::<Uuid>() {
        Ok(u) => u,
        Err(_) => return Ok(false), // invalid format → treat as missing
    };

    // Single atomic UPDATE: only one racer can set used_at when both see NULL.
    let sql = "UPDATE idempotency_tokens \
               SET used_at = now() \
               WHERE token = $1 AND user_id = $2 \
                 AND used_at IS NULL AND expires_at > now() \
               RETURNING id";
    let stmt = Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        sql,
        [token_uuid.into(), (*user_id).into()],
    );
    let result = conn.query_one(stmt).await.map_err(AppError::from)?;
    Ok(result.is_some())
}

/// Mint a fresh idempotency token for the user. Called OUTSIDE the request
/// transaction so it is never rolled back on handler failure.
pub async fn create_idempotency_token(
    db: &DatabaseConnection,
    user_id: &Uuid,
) -> Result<String, AppError> {
    use entity::ActiveModel;

    let id = Uuid::now_v7();
    let token = Uuid::now_v7();
    let now = Utc::now();
    let expires_at = now + Duration::milliseconds(IDEMPOTENCY_TTL_MS);

    let am = ActiveModel {
        id: Set(id),
        user_id: Set(*user_id),
        token: Set(token),
        created_at: Set(now.fixed_offset()),
        used_at: Set(None),
        expires_at: Set(expires_at.fixed_offset()),
    };
    am.insert(db).await.map_err(AppError::from)?;
    Ok(token.to_string())
}

/// Hourly cron sweep (addendum-019): delete tokens whose expiry is more than
/// one hour in the past. The grace window keeps recently-expired tokens around
/// so an in-flight retry can still observe a definitive used/expired answer.
/// Mirrors sweepExpiredIdempotencyTokens() from server/idempotency.tsx.
pub async fn sweep_expired_idempotency_tokens(
    db: &DatabaseConnection,
) -> Result<u64, AppError> {
    let result = db
        .execute(Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "DELETE FROM idempotency_tokens WHERE expires_at < now() - interval '1 hour'",
            [],
        ))
        .await
        .map_err(AppError::from)?;
    Ok(result.rows_affected())
}
