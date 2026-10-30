// CSRF double-submit middleware (PORT-0.6 / PORT-1.4, layer 5).
// Mirrors app-middleware.tsx:153-192.
// Enforced ONLY when a session cookie is present (browser clients).
// Backend test suite + non-browser clients send no cookie → unaffected.
//
// Mutating methods checked: POST, PUT, PATCH, DELETE.
// On each response: set ffs_csrf cookie if absent (stable per-browser token).

use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use uuid::Uuid;

use crate::{
    config::Config,
    security_headers::{csrf_cookie_name, SESSION_COOKIE_HOST_PREFIXED, SESSION_COOKIE_NAME},
};

const MUTATING_METHODS: [Method; 4] = [Method::POST, Method::PUT, Method::DELETE, Method::PATCH];

pub async fn csrf_middleware(
    State(config): State<Config>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let https = config.is_https();
    let csrf_name = csrf_cookie_name(&config.app_env, https);

    let cookie_header = req
        .headers()
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    let cookies = parse_cookies(&cookie_header);

    let csrf_cookie = cookies.get(csrf_name).cloned();
    let has_session_cookie = cookies.contains_key(SESSION_COOKIE_HOST_PREFIXED)
        || cookies.contains_key(SESSION_COOKIE_NAME);

    // Enforce on mutating methods when a browser session cookie is present.
    if MUTATING_METHODS.contains(req.method()) && (has_session_cookie || csrf_cookie.is_some()) {
        let header_val = req
            .headers()
            .get("X-CSRF-Token")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());

        let token_matches = match (&csrf_cookie, &header_val) {
            (Some(cookie), Some(header)) => cookie == header,
            _ => false,
        };

        if !token_matches {
            return (StatusCode::FORBIDDEN, Json(json!({"error": "Invalid CSRF token."})))
                .into_response();
        }
    }

    let mut response = next.run(req).await;

    // Set the CSRF cookie if absent (stable per-browser token — do NOT rotate).
    if csrf_cookie.is_none() {
        let secure_flag = if https { "; Secure" } else { "" };
        let cookie_value = format!(
            "{}={}; SameSite=Lax; Path={}{}",
            csrf_name,
            Uuid::now_v7(),
            "/",
            secure_flag
        );
        if let Ok(val) = cookie_value.parse() {
            response.headers_mut().append(
                axum::http::header::SET_COOKIE,
                val,
            );
        }
    }

    response
}

/// Minimal cookie header parser.
fn parse_cookies(header: &str) -> std::collections::HashMap<String, String> {
    header
        .split(';')
        .filter_map(|pair| {
            let mut parts = pair.trim().splitn(2, '=');
            let key = parts.next()?.trim().to_string();
            let val = parts.next().unwrap_or("").trim().to_string();
            if key.is_empty() { None } else { Some((key, val)) }
        })
        .collect()
}
