// Session lifecycle and HTTP cookie transport.
// Mirrors server/auth-session.tsx — bearer (X-Session-Token) + cookie dual transport.
//
// TTL defaults (fallback when app_settings table not seeded):
//   absolute: 24 h, inactivity: 15 min — matches server/app-settings.tsx DEFAULTS.
// Full app_settings integration deferred to the app-settings port (Slice 2).

use axum::{
    body::Body,
    http::{Request, header},
};
use chrono::{DateTime, Duration, Utc};
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    config::AppEnv,
    errors::AppError,
    security_headers::{session_cookie_name, parse_cookies},
};

// Defaults matching server/app-settings.tsx
const SESSION_TTL_MS: i64 = 24 * 60 * 60 * 1000;
const INACTIVITY_TIMEOUT_MS: i64 = 15 * 60 * 1000;

// Session token: 64-char hex (32 random bytes) — bearer credential, not entity id.
fn generate_session_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    hex::encode(bytes)
}

// ── Session struct ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Session {
    pub id: String,
    pub user_id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_activity_at: DateTime<Utc>,
    pub twofa_verified_at: Option<DateTime<Utc>>,
    pub pending_totp_secret: Option<String>,
    pub twofa_failed_attempts: i32,
    pub expires_at: DateTime<Utc>,
    pub auth_method: String,
    pub entra_mfa_performed: bool,
    pub entra_auth_time: Option<DateTime<Utc>>,
    pub strong_auth_at: Option<DateTime<Utc>>,
    pub strong_auth_source: Option<String>,
}

// ── SeaORM entity (inline — no separate entities/ file yet) ───────────────

pub mod entity {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "sessions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: String,
        pub user_id: Uuid,
        pub created_at: DateTimeWithTimeZone,
        pub last_activity_at: DateTimeWithTimeZone,
        pub twofa_verified_at: Option<DateTimeWithTimeZone>,
        pub pending_totp_secret: Option<String>,
        pub twofa_failed_attempts: i32,
        pub expires_at: DateTimeWithTimeZone,
        pub auth_method: String,
        pub entra_mfa_performed: bool,
        pub entra_auth_time: Option<DateTimeWithTimeZone>,
        pub strong_auth_at: Option<DateTimeWithTimeZone>,
        pub strong_auth_source: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

fn model_to_session(m: entity::Model) -> Session {
    use chrono::TimeZone;
    let conv = |dt: chrono::DateTime<chrono::FixedOffset>| {
        Utc.from_utc_datetime(&dt.naive_utc())
    };
    Session {
        id: m.id,
        user_id: m.user_id,
        created_at: conv(m.created_at),
        last_activity_at: conv(m.last_activity_at),
        twofa_verified_at: m.twofa_verified_at.map(conv),
        pending_totp_secret: m.pending_totp_secret,
        twofa_failed_attempts: m.twofa_failed_attempts,
        expires_at: conv(m.expires_at),
        auth_method: m.auth_method,
        entra_mfa_performed: m.entra_mfa_performed,
        entra_auth_time: m.entra_auth_time.map(conv),
        strong_auth_at: m.strong_auth_at.map(conv),
        strong_auth_source: m.strong_auth_source,
    }
}

// ── Token extraction ────────────────────────────────────────────────────────

/// X-Session-Token header first, then cookie. Mirrors getSessionToken() / getSessionTokenFromRequest().
pub fn get_session_token(req: &Request<Body>, app_env: &AppEnv, https: bool) -> Option<String> {
    // Bearer header (non-browser clients, backend test suite).
    if let Some(v) = req.headers().get("X-Session-Token") {
        if let Ok(s) = v.to_str() {
            let s = s.trim().to_string();
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    // Cookie fallback (browser transport).
    let cookie_header = req
        .headers()
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let cookies = parse_cookies(cookie_header);
    let name = session_cookie_name(app_env, https);
    // Check both possible cookie names (dev and prod prefixes).
    cookies
        .get(name)
        .or_else(|| cookies.get("ffs_session"))
        .or_else(|| cookies.get("__Host-ffs_session"))
        .cloned()
}

// ── Session CRUD ────────────────────────────────────────────────────────────

/// Look up an active session. Deletes and returns None if expired or idle.
/// Mirrors getSession() from auth-session.tsx — single choke-point for expiry.
pub async fn get_session(
    db: &DatabaseConnection,
    token: &str,
) -> Result<Option<Session>, AppError> {
    use entity::Entity;

    let row = Entity::find_by_id(token)
        .one(db)
        .await
        .map_err(AppError::from)?;

    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };

    let now = Utc::now();
    let last_activity: chrono::DateTime<Utc> = {
        use chrono::TimeZone;
        Utc.from_utc_datetime(&row.last_activity_at.naive_utc())
    };
    let expires_at: chrono::DateTime<Utc> = {
        use chrono::TimeZone;
        Utc.from_utc_datetime(&row.expires_at.naive_utc())
    };

    let expired_absolute = expires_at <= now;
    let idle_too_long = (now - last_activity).num_milliseconds() > INACTIVITY_TIMEOUT_MS;

    if expired_absolute || idle_too_long {
        // Delete dead session on read — never leave it lying around.
        let _ = Entity::delete_by_id(token).exec(db).await;
        return Ok(None);
    }

    Ok(Some(model_to_session(row)))
}

/// Slide the inactivity window forward. Called once per authenticated request.
pub async fn touch_session(db: &DatabaseConnection, token: &str) -> Result<(), AppError> {
    use entity::ActiveModel;

    let am = ActiveModel {
        id: Set(token.to_string()),
        last_activity_at: Set(Utc::now().fixed_offset()),
        ..Default::default()
    };
    am.update(db).await.map_err(AppError::from)?;
    Ok(())
}

pub struct CreateSessionOpts {
    pub auth_method: Option<String>,
    pub twofa_verified_at: Option<DateTime<Utc>>,
    pub entra_mfa_performed: bool,
    pub entra_auth_time: Option<DateTime<Utc>>,
    pub strong_auth_at: Option<DateTime<Utc>>,
    pub strong_auth_source: Option<String>,
}

impl Default for CreateSessionOpts {
    fn default() -> Self {
        Self {
            auth_method: None,
            twofa_verified_at: None,
            entra_mfa_performed: false,
            entra_auth_time: None,
            strong_auth_at: None,
            strong_auth_source: None,
        }
    }
}

/// Create a new session row and return the token.
pub async fn create_session(
    db: &DatabaseConnection,
    user_id: Uuid,
    opts: CreateSessionOpts,
) -> Result<String, AppError> {
    use entity::ActiveModel;

    let token = generate_session_token();
    let now = Utc::now();
    let expires_at = now + Duration::milliseconds(SESSION_TTL_MS);

    let am = ActiveModel {
        id: Set(token.clone()),
        user_id: Set(user_id),
        created_at: Set(now.fixed_offset()),
        last_activity_at: Set(now.fixed_offset()),
        twofa_verified_at: Set(opts.twofa_verified_at.map(|dt| dt.fixed_offset())),
        pending_totp_secret: Set(None),
        twofa_failed_attempts: Set(0),
        expires_at: Set(expires_at.fixed_offset()),
        auth_method: Set(opts.auth_method.unwrap_or_else(|| "password".to_string())),
        entra_mfa_performed: Set(opts.entra_mfa_performed),
        entra_auth_time: Set(opts.entra_auth_time.map(|dt| dt.fixed_offset())),
        strong_auth_at: Set(opts.strong_auth_at.map(|dt| dt.fixed_offset())),
        strong_auth_source: Set(opts.strong_auth_source),
    };
    am.insert(db).await.map_err(AppError::from)?;
    Ok(token)
}

/// Single-active-session sign-in (addendum-097): create new session then
/// delete all OTHER sessions for the user. Non-exclusive create_session stays
/// for tests that set up multi-session scenarios.
pub async fn create_session_exclusive(
    db: &DatabaseConnection,
    user_id: Uuid,
    opts: CreateSessionOpts,
) -> Result<String, AppError> {
    use entity::Entity;

    use entity::Column;
    let token = create_session(db, user_id, opts).await?;
    // Delete every other session belonging to this user.
    Entity::delete_many()
        .filter(Column::UserId.eq(user_id))
        .filter(Column::Id.ne(token.clone()))
        .exec(db)
        .await
        .map_err(AppError::from)?;
    Ok(token)
}

pub async fn destroy_session(db: &DatabaseConnection, token: &str) -> Result<(), AppError> {
    use entity::Entity;
    Entity::delete_by_id(token).exec(db).await.map_err(AppError::from)?;
    Ok(())
}

// ── Cookie helpers ──────────────────────────────────────────────────────────

/// Build a Set-Cookie header value for clearing both possible session cookie names.
/// Returns a Vec of header values to append to the response.
pub fn clear_session_cookie_headers(app_env: &AppEnv, https: bool) -> Vec<String> {
    let primary = session_cookie_name(app_env, https);
    // Clear both prefixed and plain names so dev→prod transitions don't leave stale cookies.
    let names: Vec<&str> = vec![
        primary,
        "ffs_session",
        "__Host-ffs_session",
    ];
    names
        .into_iter()
        .map(|n| format!("{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0", n))
        .collect()
}

/// Build a Set-Cookie header value for setting the session cookie.
pub fn set_session_cookie_header(app_env: &AppEnv, https: bool, token: &str) -> String {
    let name = session_cookie_name(app_env, https);
    let secure = crate::security_headers::is_secure_cookie(app_env, https);
    if secure {
        format!("{}={}; HttpOnly; SameSite=Lax; Path=/; Secure", name, token)
    } else {
        format!("{}={}; HttpOnly; SameSite=Lax; Path=/", name, token)
    }
}

// Convenience re-export used by session_gate.rs:
pub use clear_session_cookie_headers as clear_session_cookie;

// ── Session response field ──────────────────────────────────────────────────

/// Bearer transport: include session token in JSON if client sent X-Session-Transport: bearer.
pub fn session_response_field(req: &Request<Body>, token: &str) -> Option<String> {
    req.headers()
        .get("X-Session-Transport")
        .and_then(|v| v.to_str().ok())
        .filter(|v| *v == "bearer")
        .map(|_| token.to_string())
}

// ── Current user helper ─────────────────────────────────────────────────────

/// Resolve the current user from a session token string.
/// Used by idempotency middleware to identify the authed user.
pub async fn get_current_user_from_request(
    db: &DatabaseConnection,
    token: &str,
) -> Result<Option<crate::models::User>, AppError> {
    let session = match get_session(db, token).await? {
        Some(s) => s,
        None => return Ok(None),
    };
    crate::db::users::get_user_by_id(db, session.user_id).await.map(|u| {
        u.filter(|user| user.is_active())
    })
}
