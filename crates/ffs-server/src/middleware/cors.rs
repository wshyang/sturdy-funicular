// CORS configuration (PORT-0.6, layer 3).
// Mirrors app-middleware.tsx:100-133.
// Reflects back only configured frontend origins. Wildcard + credentials is
// spec-invalid (browsers drop it). Allowlists headers for X-Session-Token,
// X-Idempotency-Token, X-CSRF-Token.

use crate::config::{AppEnv, Config};
use tower_http::cors::{AllowOrigin, CorsLayer};
use axum::http::{HeaderValue, Method, header};

pub fn cors_layer(config: &Config) -> CorsLayer {
    let allowed_origins = cors_allowed_origins(config);

    CorsLayer::new()
        .allow_origin(allowed_origins)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::CONTENT_TYPE,
            header::AUTHORIZATION,
            axum::http::HeaderName::from_static("x-session-token"),
            axum::http::HeaderName::from_static("x-idempotency-token"),
            axum::http::HeaderName::from_static("x-csrf-token"),
        ])
        .expose_headers([
            header::CONTENT_LENGTH,
            axum::http::HeaderName::from_static("x-idempotency-token"),
        ])
        .allow_credentials(true)
        .max_age(std::time::Duration::from_secs(600))
}

fn cors_allowed_origins(config: &Config) -> AllowOrigin {
    let mut origins: Vec<HeaderValue> = Vec::new();

    if let Some(ref frontend_url) = config.frontend_url {
        if let Ok(val) = frontend_url.parse::<HeaderValue>() {
            origins.push(val);
        }
    }

    if config.app_env == AppEnv::Dev {
        for port in [5173u16, 4173, 4174, 4175, 4176, 4177] {
            if let Ok(val) = format!("http://localhost:{}", port).parse::<HeaderValue>() {
                origins.push(val);
            }
        }
    }

    AllowOrigin::list(origins)
}
