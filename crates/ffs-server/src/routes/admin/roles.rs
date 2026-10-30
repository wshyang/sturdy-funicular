//! Custom admin-role CRUD and per-user role settlement (addendum-072/-137).
//! Mutations run inside the request-wide idempotency transaction (`TxHandle`).

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::{privileges::require_admin_privilege, session::Session},
    config::Config,
    db::admin_roles::{self, DesiredRoleGrant, UpdateAdminRoleInput},
    errors::{AppError, RouteResult},
    tx::TxHandle,
};

fn session(ext: Option<Extension<Arc<Session>>>) -> Result<Arc<Session>, AppError> {
    ext.map(|e| e.0).ok_or_else(|| AppError::unauthenticated("Unauthorized"))
}

async fn require_manage(db: &DatabaseConnection, ext: Option<Extension<Arc<Session>>>) -> Result<Arc<Session>, AppError> {
    let s = session(ext)?;
    require_admin_privilege(db, s.user_id, "AdminRolesManage").await?;
    Ok(s)
}

fn caps(body: &Value) -> Result<Vec<String>, AppError> {
    let arr = body.get("capabilities").and_then(Value::as_array)
        .ok_or_else(|| AppError::validation("capabilities must be an array of known capability names."))?;
    arr.iter().map(|v| v.as_str().map(str::to_string)
        .ok_or_else(|| AppError::validation("capabilities must be an array of known capability names.")))
        .collect()
}

pub async fn create_role(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
    Extension(tx): Extension<TxHandle>,
    Json(body): Json<Value>,
) -> RouteResult<impl IntoResponse> {
    let actor = require_manage(&db, ext).await?;
    let key = body["key"].as_str().ok_or_else(|| AppError::validation("key is required."))?;
    let name = body["name"].as_str().ok_or_else(|| AppError::validation("name is required."))?;
    let description = body.get("description").and_then(Value::as_str).unwrap_or("");
    let capabilities = if body.get("capabilities").is_none() { Vec::new() } else { caps(&body)? };
    let guard = tx.0.lock().await;
    let conn = guard.as_ref().ok_or_else(|| AppError::Internal(anyhow::anyhow!("transaction consumed")))?;
    let role = admin_roles::create_admin_role(conn, key, name, description, capabilities, actor.user_id).await?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "role": role }))))
}

pub async fn update_role(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
    Path(key): Path<String>,
    Extension(tx): Extension<TxHandle>,
    Json(body): Json<Value>,
) -> RouteResult<impl IntoResponse> {
    let actor = require_manage(&db, ext).await?;
    let name = match body.get("name") { Some(Value::String(s)) => Some(s.clone()), Some(Value::Null) | None => None, _ => return Err(AppError::validation("name must be a string.")) };
    let description = match body.get("description") { Some(Value::String(s)) => Some(s.clone()), Some(Value::Null) | None => None, _ => return Err(AppError::validation("description must be a string.")) };
    let capabilities = if body.get("capabilities").is_some() { Some(caps(&body)?) } else { None };
    let guard = tx.0.lock().await;
    let conn = guard.as_ref().ok_or_else(|| AppError::Internal(anyhow::anyhow!("transaction consumed")))?;
    let role = admin_roles::update_admin_role(conn, &key, UpdateAdminRoleInput { name, description, capabilities }, actor.user_id).await?
        .ok_or_else(|| AppError::not_found("Role not found."))?;
    Ok(Json(json!({ "role": role })))
}

pub async fn delete_role(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
    Path(key): Path<String>,
    Extension(tx): Extension<TxHandle>,
) -> RouteResult<impl IntoResponse> {
    let actor = require_manage(&db, ext).await?;
    let guard = tx.0.lock().await;
    let conn = guard.as_ref().ok_or_else(|| AppError::Internal(anyhow::anyhow!("transaction consumed")))?;
    admin_roles::delete_admin_role(conn, &key, actor.user_id).await?;
    Ok(Json(json!({ "message": "Role deleted." })))
}

pub async fn update_user_roles(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
    Path(id): Path<Uuid>,
    Extension(tx): Extension<TxHandle>,
    Json(body): Json<Value>,
) -> RouteResult<impl IntoResponse> {
    let actor = require_manage(&db, ext).await?;
    let has_keys = body.get("roleKeys").is_some();
    let has_grants = body.get("grants").is_some();
    if has_keys == has_grants { return Err(AppError::validation("Provide exactly one of roleKeys or grants.")); }
    let user = db.query_one(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT status::text, affiliation::text, is_system, is_protected FROM users WHERE id=$1",
        [id.into()],
    )).await?.ok_or_else(|| AppError::not_found("User not found."))?;
    let is_system: bool = user.try_get("", "is_system").map_err(AppError::from)?;
    let is_protected: bool = user.try_get("", "is_protected").map_err(AppError::from)?;
    if is_system || is_protected { return Err(AppError::validation("This user is system-managed and cannot be modified.")); }
    let status: String = user.try_get("", "status").map_err(AppError::from)?;
    if status != "active" { return Err(AppError::validation("Only active users can have roles edited.")); }
    let affiliation: Option<String> = user.try_get("", "affiliation").map_err(AppError::from)?;
    if affiliation.as_deref() != Some("agency") { return Err(AppError::validation("Admin roles can only be granted to agency users.")); }

    let mut desired = Vec::new();
    let mut response_keys = Vec::new();
    if has_keys {
        let arr = body["roleKeys"].as_array().ok_or_else(|| AppError::validation("roleKeys must be an array."))?;
        for v in arr {
            let key = v.as_str().ok_or_else(|| AppError::validation("roleKeys must be strings."))?;
            response_keys.push(key.to_string());
            desired.push(DesiredRoleGrant { role_key: key.to_string(), organization_id: None });
        }
    } else {
        let arr = body["grants"].as_array().ok_or_else(|| AppError::validation("grants must be an array."))?;
        for v in arr {
            let key = v["roleKey"].as_str().ok_or_else(|| AppError::validation("roleKey is required."))?;
            let org = match v.get("organizationId") {
                Some(Value::Null) | None => None,
                Some(Value::String(s)) => Some(Uuid::parse_str(s).map_err(|_| AppError::validation("organizationId must be a UUID."))?),
                _ => return Err(AppError::validation("organizationId must be a UUID or null.")),
            };
            response_keys.push(key.to_string());
            desired.push(DesiredRoleGrant { role_key: key.to_string(), organization_id: org });
        }
    }
    let guard = tx.0.lock().await;
    let conn = guard.as_ref().ok_or_else(|| AppError::Internal(anyhow::anyhow!("transaction consumed")))?;
    admin_roles::set_user_roles(conn, id, desired, actor.user_id, "Updated via admin user roles endpoint").await?;
    Ok(Json(json!({ "message": "User roles updated.", "roleKeys": response_keys })))
}

pub async fn get_user_roles(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
    Path(id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    let actor = require_manage(&db, ext).await?;
    let _ = actor;
    let exists = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT 1 FROM users WHERE id=$1", [id.into()]))
        .await?.is_some();
    if !exists { return Err(AppError::not_found("User not found.")); }
    let grants = admin_roles::list_admin_role_grants(&db, id, false).await?;
    let role_keys: Vec<String> = grants.iter().map(|g| g.role_key.clone()).collect();
    let grants_json: Vec<Value> = grants.iter().map(|g| json!({"roleKey": g.role_key, "organizationId": g.organization_id})).collect();
    Ok(Json(json!({ "roleKeys": role_keys, "grants": grants_json })))
}
