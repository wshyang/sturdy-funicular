// Central session gate middleware (PORT-0.6 / PORT-1.6, layer 6).
// Mirrors app-middleware.tsx:211-310.
//
// GATE_ALLOWLIST: exact 11 paths + /auth/entra/* prefix.
// OPTIONS always passes. No token → pass through.
// Dead session + browser-nav → clear cookie, pass through.
// Dead session + API → 401 session_expired.
// Unverified 2FA + browser-nav → pass through.
// Unverified 2FA + API → 403 twofa_required.
// Live, verified → touch session, continue.

use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode, header},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::DatabaseConnection;
use serde_json::json;

use std::sync::Arc;

use crate::{
    auth::session::{get_session, get_session_token, touch_session},
    config::Config,
    security_headers::session_cookie_name,
};

/// Paths that bypass the session gate (GATE_ALLOWLIST from app-middleware.tsx:211-232).
const GATE_ALLOWLIST: &[&str] = &[
    "/health",
    "/setup",
    "/auth/signup",
    "/auth/login",
    "/auth/logout",
    "/auth/me",
    "/me/capability-snapshot",
    "/me/role-summary",
    "/auth/2fa/enroll",
    "/auth/2fa/verify",
    "/auth/accept-invite",
    "/auth/slack/callback",
];

fn is_gate_allowlisted(path: &str) -> bool {
    if GATE_ALLOWLIST.contains(&path) {
        return true;
    }
    // /auth/entra/* is allowlisted (SSO handoff precedes a verified session).
    if path.starts_with("/auth/entra/") {
        return true;
    }
    false
}

/// Returns true for browser document navigations: no X-Session-Token header
/// AND Accept includes text/html. (app-middleware.tsx:274-275)
fn is_browser_nav(req: &Request<Body>) -> bool {
    let has_session_header = req.headers().contains_key("X-Session-Token");
    let accept = req
        .headers()
        .get(header::ACCEPT)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    !has_session_header && accept.contains("text/html")
}

pub async fn session_gate_middleware(
    State((config, db)): State<(Config, DatabaseConnection)>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    // OPTIONS always passes.
    if req.method() == Method::OPTIONS {
        return next.run(req).await;
    }

    // Allowlisted paths pass through.
    let path = req.uri().path().to_string();
    if is_gate_allowlisted(&path) {
        return next.run(req).await;
    }

    // Extract session token (X-Session-Token header or cookie).
    let https = config.is_https();
    let token = get_session_token(&req, &config.app_env, https);

    // No token on a protected path → 403 (mirrors Node reference app-middleware.tsx).
    let token = match token {
        Some(t) => t,
        None => {
            // Legacy gate passes token-less requests through; these handlers
            // own the 401/200-false contract (introspection + role CRUD).
            if path == "/admin/is-admin" || path == "/me/managed-teams" || path == "/auth/change-password" || path.starts_with("/link/resolve/") || path.starts_with("/admin/capabilities") || path.starts_with("/admin/roles") {
                return next.run(req).await;
            }
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error": "You must be logged in.", "code": "not_authenticated"})),
            )
                .into_response();
        }
    };

    // Look up session.
    let session = match get_session(&db, &token).await {
        Ok(Some(s)) => s,
        Ok(None) => {
            // Dead/expired session.
            if is_browser_nav(&req) {
                // Browser nav: clear cookie, pass through to SPA.
                let mut response = next.run(req).await;
                let cookie_name = session_cookie_name(&config.app_env, https);
                let clear = format!("{}=; Max-Age=0; Path=/", cookie_name);
                if let Ok(val) = clear.parse() {
                    response.headers_mut().append(header::SET_COOKIE, val);
                }
                return response;
            }
            return (
                StatusCode::UNAUTHORIZED,
                Json(json!({
                    "error": "Your session has expired. Please log in again.",
                    "code": "session_expired"
                })),
            )
                .into_response();
        }
        Err(err) => {
            tracing::error!("Session gate DB error: {:?}", err);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "An error occurred."})),
            )
                .into_response();
        }
    };

    // Unverified 2FA.
    if session.twofa_verified_at.is_none() {
        if is_browser_nav(&req) {
            // Browser nav: pass through (cookie NOT cleared — session is alive).
            return next.run(req).await;
        }
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "Two-factor verification required.",
                "code": "twofa_required"
            })),
        )
            .into_response();
    }

    // Live-session invalidation: a tombstoned/rejected user's existing session
    // must stop reaching operational routes (legacy admin_users contract).
    {
        let active = match crate::db::users::get_user_by_id(&db, session.user_id).await {
            Ok(Some(u)) => u.is_active(),
            Ok(None) => false,
            Err(_) => true,
        };
        if !active {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"Account is no longer active.","code":"account_inactive"})),
            ).into_response();
        }
    }

    // Live, verified session — slide the inactivity window and inject into extensions.
    if let Err(err) = touch_session(&db, &token).await {
        tracing::warn!("touch_session failed (non-fatal): {:?}", err);
    }

    req.extensions_mut().insert(Arc::new(session));
    next.run(req).await
}
