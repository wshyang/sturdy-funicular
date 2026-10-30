//! GET /link/resolve/:key — 2FA-gated, recipient-scoped, live re-authorization.
use std::sync::Arc;

use axum::{extract::{Extension, Path, State}, response::{IntoResponse, Response}, Json};
use sea_orm::DatabaseConnection;
use serde_json::json;

use crate::{
    audit::write_audit_log, auth::session::Session, config::Config,
    direct_links::consume_if_valid_for_user, errors::{AppError, RouteResult},
};

const GENERIC: &str = "This direct link is no longer valid.";

pub async fn resolve_direct_link(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    session: Option<Extension<Arc<Session>>>,
    Path(key): Path<String>,
) -> RouteResult<Response> {
    let Some(Extension(session)) = session else {
        return Err(AppError::unauthenticated("Not authenticated."));
    };
    if session.twofa_verified_at.is_none() {
        return Ok((axum::http::StatusCode::FORBIDDEN,
            Json(json!({"error":"Two-factor verification required.","code":"twofa_required"}))).into_response());
    }
    let user = crate::db::users::get_user_by_id(&db, session.user_id).await?
        .filter(|u| u.is_active())
        .ok_or_else(|| AppError::auth("Your account is not active."))?;
    let mapping = consume_if_valid_for_user(&db, &key, user.id).await?
        .ok_or_else(|| AppError::not_found(GENERIC))?;
    if mapping.target_type != "breakglass_request" {
        return Err(AppError::not_found(GENERIC));
    }
    let request = crate::routes::requests::get_request_row(&db, mapping.target_id).await?
        .ok_or_else(|| AppError::not_found(GENERIC))?;
    if !crate::routes::requests::req_can_view(&db, user.id, &request).await? {
        return Err(AppError::not_found(GENERIC));
    }
    write_audit_log(&db, user.id, "link_mapping.resolved", "link_mapping", &key, None,
        json!({"targetType":mapping.target_type,"targetId":mapping.target_id}), None).await?;
    Ok(Json(json!({"targetType":mapping.target_type,"targetId":mapping.target_id})).into_response())
}
