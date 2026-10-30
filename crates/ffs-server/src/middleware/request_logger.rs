// Request logger middleware (PORT-0.6, layer 2).
// Mirrors app-middleware.tsx:91-98: logs METHOD PATH STATUS ELAPSEDms.
// Uses c.req.path (pathname only — query string excluded) to avoid leaking
// OAuth codes / secret-material query params into stdout (addendum-095 #10).

use axum::{
    body::Body,
    http::Request,
    middleware::Next,
    response::Response,
};
use std::time::Instant;

pub async fn request_logger_middleware(req: Request<Body>, next: Next) -> Response {
    let method = req.method().clone();
    // Extract path only (no query string).
    let path = req.uri().path().to_string();
    let start = Instant::now();

    let response = next.run(req).await;

    let elapsed = start.elapsed().as_millis();
    tracing::info!("--> {} {} {} {}ms", method, path, response.status().as_u16(), elapsed);

    response
}
