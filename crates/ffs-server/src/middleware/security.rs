// Security headers middleware (PORT-0.6, layer 4).
// Injects CSP, X-Frame-Options, etc. on every response.
// Also adds Cache-Control: no-store on JSON API responses.
// Mirrors app-middleware.tsx:141-151.

use axum::{
    body::Body,
    extract::State,
    http::{Request, header},
    middleware::Next,
    response::Response,
};
use crate::{config::Config, security_headers::security_headers};

pub async fn security_headers_middleware(
    State(config): State<Config>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let https = req
        .headers()
        .get("X-Forwarded-Proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v == "https")
        .unwrap_or(config.is_https());

    let mut response = next.run(req).await;

    let headers = security_headers(&config.app_env, https);
    for (name, value) in headers {
        if let Ok(val) = value.parse() {
            response.headers_mut().insert(name, val);
        }
    }

    // Add Cache-Control: no-store on JSON responses (API endpoints only).
    let content_type = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    if content_type.contains("application/json") {
        if let Ok(val) = "no-store".parse() {
            response.headers_mut().insert(header::CACHE_CONTROL, val);
        }
    }

    response
}
