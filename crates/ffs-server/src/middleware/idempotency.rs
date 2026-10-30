// Idempotency token enforcement + request-wide transaction middleware.
// Mirrors app-middleware.tsx:312-408.
//
// For every non-GET/OPTIONS mutating request from an authenticated user:
//   1. Begin a DatabaseTransaction → insert TxHandle into request extensions.
//   2. Consume the idempotency token (409 if missing/invalid/reused).
//   3. Run the handler.
//   4. Handler 5xx → ROLLBACK; handler 4xx/2xx → COMMIT.
//   5. Rotate the idempotency token OUTSIDE the transaction (never rolled back).
//
// IDEMPOTENCY_EXCLUDED_PATHS bypass step 2 (but still get a transaction).

use axum::{
    body::Body,
    extract::State,
    http::{Method, Request, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{DatabaseConnection, TransactionTrait};
use serde_json::json;

use crate::{
    auth::session::{get_current_user_from_request, get_session_token},
    config::Config,
    idempotency::{consume_idempotency_token, create_idempotency_token},
    tx::TxHandle,
};

/// Paths that skip idempotency token enforcement (but still get a tx).
const IDEMPOTENCY_EXCLUDED_PATHS: &[&str] = &[
    "/auth/signup",
    "/auth/login",
    "/auth/logout",
    "/auth/entra/exchange",
    "/auth/2fa/verify",
];

pub async fn idempotency_middleware(
    State((config, db)): State<(Config, DatabaseConnection)>,
    mut req: Request<Body>,
    next: Next,
) -> Response {
    let method = req.method().clone();

    // GET and OPTIONS always pass through without a transaction.
    if method == Method::GET || method == Method::OPTIONS {
        return next.run(req).await;
    }

    let path = req.uri().path().to_string();

    // Require an authenticated user for token enforcement.
    let https = config.is_https();
    let token_str = get_session_token(&req, &config.app_env, https);
    let user = match token_str {
        Some(ref t) => get_current_user_from_request(&db, t).await.unwrap_or(None),
        None => None,
    };

    // Unauthenticated requests pass through — route's own auth check answers.
    let user = match user {
        Some(u) => u,
        None => return next.run(req).await,
    };

    // Begin the request-wide transaction.
    let txn = match db.begin().await {
        Ok(t) => t,
        Err(err) => {
            tracing::error!("Failed to begin transaction: {:?}", err);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "An error occurred."})),
            )
                .into_response();
        }
    };

    let idempotency_token = req
        .headers()
        .get("X-Idempotency-Token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let excluded = IDEMPOTENCY_EXCLUDED_PATHS.contains(&path.as_str());

    // Consume idempotency token (unless excluded path).
    if !excluded {
        let valid = match &idempotency_token {
            Some(tok) => consume_idempotency_token(&txn, tok, &user.id).await.unwrap_or(false),
            None => false,
        };
        if !valid {
            let _ = txn.rollback().await;
            return (
                StatusCode::CONFLICT,
                Json(json!({
                    "error": "Missing, invalid, or already-used idempotency token. Refresh the page and try again."
                })),
            )
                .into_response();
        }
    }

    // Insert TxHandle into request extensions for handlers to use.
    let tx_handle = TxHandle::new(txn);
    req.extensions_mut().insert(tx_handle.clone());

    let mut response = next.run(req).await;

    // Commit or rollback based on response status.
    let status = response.status().as_u16();
    if status >= 500 {
        if let Err(err) = tx_handle.rollback().await {
            tracing::error!("Rollback failed: {:?}", err);
        }
    } else {
        if let Err(err) = tx_handle.commit().await {
            tracing::error!("Commit failed: {:?}", err);
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "An error occurred."})),
            )
                .into_response();
        }
    }

    // Rotate idempotency token OUTSIDE the transaction (even on failure).
    match create_idempotency_token(&db, &user.id).await {
        Ok(next_token) => {
            if let Ok(val) = next_token.parse() {
                response
                    .headers_mut()
                    .insert("X-Idempotency-Token", val);
            }
        }
        Err(err) => tracing::warn!("Token rotation failed: {:?}", err),
    }

    response
}
