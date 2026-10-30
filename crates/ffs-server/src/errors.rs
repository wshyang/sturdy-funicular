// Unified error types for the FFS backend.
// routeError parity: name-based mapping (not instanceof) matching server/route-helpers.tsx.
// AuthorizationError → 403, ValidationError → 400, NotFoundError → 404, else opaque 500.

use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde_json::json;
use thiserror::Error;

/// Domain errors that map to specific HTTP status codes.
#[derive(Debug, Error)]
pub enum AppError {
    /// 401 — not authenticated (no session, expired session).
    #[error("{0}")]
    Unauthenticated(String),

    /// 403 — authenticated but lacks permission.
    #[error("{0}")]
    Authorization(String),

    #[error("{0}")]
    Validation(String),

    #[error("{0}")]
    NotFound(String),

    #[error("{0}")]
    Conflict(String),

    #[error("{0}")]
    TooManyAttempts(String),

    #[error("An error occurred.")]
    Internal(#[from] anyhow::Error),
}

impl AppError {
    pub fn unauthenticated(msg: impl Into<String>) -> Self {
        AppError::Unauthenticated(msg.into())
    }
    pub fn auth(msg: impl Into<String>) -> Self {
        AppError::Authorization(msg.into())
    }
    pub fn validation(msg: impl Into<String>) -> Self {
        AppError::Validation(msg.into())
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        AppError::NotFound(msg.into())
    }
    pub fn conflict(msg: impl Into<String>) -> Self {
        AppError::Conflict(msg.into())
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, message) = match &self {
            AppError::Unauthenticated(msg) => (StatusCode::UNAUTHORIZED, msg.clone()),
            AppError::Authorization(msg) => (StatusCode::FORBIDDEN, msg.clone()),
            AppError::Validation(msg) => (StatusCode::BAD_REQUEST, msg.clone()),
            AppError::NotFound(msg) => (StatusCode::NOT_FOUND, msg.clone()),
            AppError::Conflict(msg) => (StatusCode::CONFLICT, msg.clone()),
            AppError::TooManyAttempts(msg) => (StatusCode::TOO_MANY_REQUESTS, msg.clone()),
            AppError::Internal(err) => {
                // Log the full error server-side; return opaque message to client.
                tracing::error!("Internal error: {:?}", err);
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Internal server error.".to_string(),
                )
            }
        };
        (status, Json(json!({ "error": message }))).into_response()
    }
}

/// Convenience alias used by all route handlers.
pub type RouteResult<T> = Result<T, AppError>;

impl From<sea_orm::DbErr> for AppError {
    fn from(err: sea_orm::DbErr) -> Self {
        AppError::Internal(anyhow::anyhow!("Database error: {}", err))
    }
}
