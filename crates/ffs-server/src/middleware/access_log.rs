// HTTP access log middleware (PORT-0.6, layer 1 — outermost).
// Mirrors server/access-log.tsx.
// Pre-inserts an access_log row before the handler runs (so the row id is
// available to createAuditLog() calls). Finalizes with status/duration after.
// Best-effort: errors do not fail the request.

use axum::{
    body::Body,
    extract::State,
    http::Request,
    middleware::Next,
    response::Response,
};
use sea_orm::DatabaseConnection;
use std::time::Instant;

use crate::auth::session::get_session_token;
use crate::config::Config;

pub async fn access_log_middleware(
    State((config, db)): State<(Config, DatabaseConnection)>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let start = Instant::now();
    let https = config.is_https();
    let method = req.method().to_string();
    let path = req.uri().path().to_string().chars().take(2048).collect::<String>();
    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(512).collect::<String>());

    // Real client IP: prefer X-Forwarded-For, fall back to socket peer.
    let src_ip = req
        .headers()
        .get("X-Forwarded-For")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|s| s.trim().to_string());

    let session_token = get_session_token(&req, &config.app_env, https);
    let session_present = session_token.is_some();

    // Pre-insert access_log row.
    let request_headers = crate::access_log::pick_loggable_headers(req.headers());

    let access_log_id = crate::access_log::begin_access_log(
        &db,
        crate::access_log::AccessLogFields {
            user_id: None, // resolved lazily inside the request; use None here
            session_present,
            src_ip,
            method: method.clone(),
            path: path.clone(),
            request_headers,
            user_agent,
        },
    )
    .await;

    // Store the access_log_id in request extensions so audit GUC plumbing can use it.
    let mut req = req;
    if let Some(id) = access_log_id {
        req.extensions_mut().insert(crate::access_log::AccessLogId(id));
    }
    let access_log_id = req.extensions().get::<crate::access_log::AccessLogId>().map(|a| a.0);

    let response = next.run(req).await;

    // Finalize with status + duration.
    crate::access_log::finalize_access_log(
        &db,
        access_log_id,
        response.status().as_u16(),
        start.elapsed().as_millis() as i32,
    )
    .await;

    response
}
