// HTTP access logging.
// Mirrors server/access-log.tsx.
//
// One row per HTTP request (including GETs), best-effort / non-blocking:
// beginAccessLog failure → returns None, request continues; access_log_id is
// null in any audit rows written during that request.
// finalizeAccessLog fills in status_code + duration_ms after handler completes.

use chrono::Utc;
use indexmap::IndexMap;
use sea_orm::{ActiveModelTrait, ActiveValue::Set, DatabaseConnection};
use uuid::Uuid;

/// Newtype wrapper for the access_log row ID stored in request extensions.
#[derive(Clone, Copy, Debug)]
pub struct AccessLogId(pub uuid::Uuid);

pub mod entity {
    use sea_orm::entity::prelude::*;

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "access_log")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Option<Uuid>,
        pub session_present: bool,
        pub src_ip: Option<String>,
        pub method: String,
        pub path: String,
        pub status_code: Option<i32>,
        pub duration_ms: Option<i32>,
        pub request_headers: Option<serde_json::Value>,
        pub user_agent: Option<String>,
        pub created_at: DateTimeWithTimeZone,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

const HEADER_ALLOWLIST: &[&str] = &[
    "accept",
    "content-type",
    "origin",
    "referer",
    "traceparent",
    "user-agent",
    "x-request-id",
];
const MAX_HEADER_VALUE_LEN: usize = 512;
const MAX_CAPTURED_BYTES: usize = 2048;

/// Pick only allowlisted headers, bounded by MAX_CAPTURED_BYTES total.
pub fn pick_loggable_headers(
    headers: &axum::http::HeaderMap,
) -> IndexMap<String, String> {
    let mut picked = IndexMap::new();
    let mut captured = 0usize;
    for (name, value) in headers.iter() {
        let name_lc = name.as_str().to_ascii_lowercase();
        if !HEADER_ALLOWLIST.contains(&name_lc.as_str()) {
            continue;
        }
        let remaining = MAX_CAPTURED_BYTES.saturating_sub(captured + name_lc.len());
        if remaining == 0 {
            break;
        }
        let raw = value.to_str().unwrap_or_default();
        let val = &raw[..raw.len().min(MAX_HEADER_VALUE_LEN).min(remaining)];
        captured += name_lc.len() + val.len();
        picked.insert(name_lc, val.to_string());
    }
    picked
}

pub struct AccessLogFields {
    pub user_id: Option<Uuid>,
    pub session_present: bool,
    pub src_ip: Option<String>,
    pub method: String,
    pub path: String,
    pub request_headers: IndexMap<String, String>,
    pub user_agent: Option<String>,
}

/// Pre-insert the access_log row BEFORE the handler runs.
/// Returns None (never panics) on write failure.
pub async fn begin_access_log(
    db: &DatabaseConnection,
    fields: AccessLogFields,
) -> Option<Uuid> {
    let id = Uuid::now_v7();
    let headers_json = serde_json::to_value(&fields.request_headers).ok();
    let am = entity::ActiveModel {
        id: Set(id),
        user_id: Set(fields.user_id),
        session_present: Set(fields.session_present),
        src_ip: Set(fields.src_ip),
        method: Set(fields.method),
        path: Set(fields.path),
        status_code: Set(None),
        duration_ms: Set(None),
        request_headers: Set(headers_json),
        user_agent: Set(fields.user_agent),
        created_at: Set(Utc::now().fixed_offset()),
    };
    match am.insert(db).await {
        Ok(_) => Some(id),
        Err(err) => {
            tracing::error!("Access log pre-insert failed (non-fatal): {:?}", err);
            None
        }
    }
}

/// Finalize the access_log row with status_code + duration_ms.
/// No-ops on None id (pre-insert failed).
pub async fn finalize_access_log(
    db: &DatabaseConnection,
    id: Option<Uuid>,
    status_code: u16,
    duration_ms: i32,
) {
    let id = match id {
        Some(v) => v,
        None => return,
    };
    use entity::ActiveModel;
    let am = ActiveModel {
        id: Set(id),
        status_code: Set(Some(status_code as i32)),
        duration_ms: Set(Some(duration_ms)),
        ..Default::default()
    };
    if let Err(err) = am.update(db).await {
        tracing::error!("Access log finalize failed (non-fatal): {:?}", err);
    }
}
