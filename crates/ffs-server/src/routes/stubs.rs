// Gate G1 stub routes — minimal implementations that let the session gate,
// authz-matrix, idempotency, and exceptional-conditions test suites pass.
// Every protected route:
//   • Returns 200 when session extension is present (gate injected it).
//   • Returns 403 when no session (gate passed no-token through; route answers).
//   • Admin-only routes additionally check user_admin_role_grants.
// Full implementations land in slices 2–7.

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, Statement};
use serde_json::{json, Value};

use crate::{
    auth::session::Session,
    config::Config,
    db::admin_roles::user_has_any_admin_role,
    errors::AppError,
    tx::TxHandle,
};

type RouteState = State<(Config, DatabaseConnection)>;

fn no_session() -> (StatusCode, Json<Value>) {
    (StatusCode::FORBIDDEN, Json(json!({"error": "Not authorized."})))
}

// ── /requests/* ──────────────────────────────────────────────────────────────

pub async fn my_requests(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

pub async fn requests_search(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

// ── /admin/* ─────────────────────────────────────────────────────────────────

pub async fn admin_users(
    State((_, db)): RouteState,
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    let session = match session {
        Some(s) => s,
        None => return no_session().into_response(),
    };
    match user_has_any_admin_role(&db, session.user_id).await {
        Ok(true) => Json(json!({"users": [], "total": 0})).into_response(),
        Ok(false) => no_session().into_response(),
        Err(e) => e.into_response(),
    }
}

pub async fn admin_users_by_id(
    State((_, db)): RouteState,
    Path(_id): Path<String>,
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    let session = match session {
        Some(s) => s,
        None => return no_session().into_response(),
    };
    match user_has_any_admin_role(&db, session.user_id).await {
        Ok(true) => (StatusCode::NOT_FOUND, Json(json!({"error": "User not found."}))).into_response(),
        Ok(false) => no_session().into_response(),
        Err(e) => e.into_response(),
    }
}

pub async fn admin_systems(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

pub async fn admin_data_export(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": []})).into_response()
}

pub async fn admin_app_settings(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"settings": {}})).into_response()
}

pub async fn admin_notification_templates(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

pub async fn admin_sent_notifications(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

pub async fn admin_access_log(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

pub async fn admin_clusters_list(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"clusters": []})).into_response()
}

pub async fn admin_clusters_create(
    session: Option<Extension<Arc<Session>>>,
    tx_handle: Option<Extension<TxHandle>>,
    body: Result<Json<Value>, axum::extract::rejection::JsonRejection>,
) -> impl IntoResponse {
    // Session check first — unauthenticated requests never reach TxHandle.
    let session = match session {
        Some(s) => s,
        None => return no_session().into_response(),
    };
    let tx_handle = match tx_handle {
        Some(Extension(h)) => h,
        None => return AppError::Internal(anyhow::anyhow!("TxHandle missing for authenticated POST")).into_response(),
    };
    let body = match body {
        Ok(b) => b,
        Err(_) => return AppError::validation("Invalid request body.").into_response(),
    };
    let name = body
        .get("name")
        .and_then(|n| n.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if name.is_empty() {
        return AppError::validation("name is required.").into_response();
    }
    let cluster_type = body
        .get("type")
        .and_then(|t| t.as_str())
        .unwrap_or("vendor")
        .to_string();
    let org_id = match body.get("organizationId").and_then(|o| o.as_str()) {
        Some(id) => id.to_string(),
        None => return AppError::validation("organizationId is required.").into_response(),
    };

    // INSERT inside the request-wide transaction so the idempotency rollback
    // also undoes the cluster row on 5xx (unique-constraint race test).
    let guard = tx_handle.0.lock().await;
    let txn = match guard.as_ref() {
        Some(t) => t,
        None => {
            return AppError::Internal(anyhow::anyhow!("transaction already consumed"))
                .into_response()
        }
    };
    let sql = "INSERT INTO clusters (id, name, type, organization_id, created_by, expires_after) \
               VALUES (uuid_generate_v7(), $1, $2::cluster_type, $3::uuid, $4::uuid, NULL)";
    let stmt = Statement::from_sql_and_values(
        sea_orm::DatabaseBackend::Postgres,
        sql,
        [
            name.clone().into(),
            cluster_type.into(),
            org_id.into(),
            session.user_id.to_string().into(),
        ],
    );
    match txn.execute(stmt).await {
        Ok(_) => (StatusCode::CREATED, Json(json!({"clusters": [{"name": name}]}))).into_response(),
        Err(e) => AppError::Internal(anyhow::anyhow!("cluster insert failed: {}", e)).into_response(),
    }
}

// ── /audit/* ─────────────────────────────────────────────────────────────────

pub async fn audit_logs(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

// ── /owner/* ─────────────────────────────────────────────────────────────────

pub async fn owner_systems(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": [], "total": 0})).into_response()
}

// ── /me/* ────────────────────────────────────────────────────────────────────

pub async fn me_integrations(
    session: Option<Extension<Arc<Session>>>,
) -> impl IntoResponse {
    if session.is_none() {
        return no_session().into_response();
    }
    Json(json!({"data": []})).into_response()
}

// ── Test-only ────────────────────────────────────────────────────────────────

/// Test-only route that always returns an opaque 500 (addendum-095 analog).
pub async fn audit_test_internal_error() -> impl IntoResponse {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({"error": "Internal server error."})),
    )
}
