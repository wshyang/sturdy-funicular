// GET  /admin/capabilities              — effective caps for current admin user.
// GET  /admin/capabilities/check        — single-cap check.
// GET  /admin/capabilities/all          — full static registry (requires admin).
// POST /admin/capabilities/check-multiple — batch cap check (requires admin).
// GET  /admin/roles                     — all admin roles from admin_roles table.
// GET  /admin/roles/my-grants           — enriched grants for current user (requires admin).
// GET  /admin/is-admin                  — 200 for ALL callers, true/false.
// Importers/callers: main.rs registers all above routes.
// Affected API: GET /admin/roles (new), GET /admin/capabilities*, GET /admin/roles/*, GET /admin/is-admin.
// Data schemas: admin_roles(id, key, name, description, is_system_role, capabilities[], created_at, updated_at),
//               user_admin_role_grants(user_id, role_key, organization_id, revoked_at).
// User instruction: "fix the rust port to ensure API and PlayWright suites pass"

use std::sync::Arc;

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::Deserialize;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::admin_roles::user_has_any_admin_role,
    errors::{AppError, RouteResult},
};

// Canonical registry lives in the role domain; re-export keeps the public Rust path stable.
pub use crate::db::admin_roles::ALL_CAPABILITIES;

// ORG_SCOPEABLE is the canonical list from db::admin_roles — imported above.

// ── Shared auth helper ────────────────────────────────────────────────────────

fn require_session(ext: Option<Extension<Arc<Session>>>) -> Result<Arc<Session>, AppError> {
    ext.map(|e| e.0)
        .ok_or_else(|| AppError::Unauthenticated("Authentication required.".to_string()))
}

async fn require_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("You do not have admin access.".to_string()));
    }
    Ok(())
}

// ── GET /admin/capabilities ───────────────────────────────────────────────────

pub async fn get_capabilities(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
) -> RouteResult<impl IntoResponse> {
    let session = require_session(ext)?;
    require_admin(&db, session.user_id).await?;

    let (capabilities, scoped_capabilities) = effective_and_scoped(&db, session.user_id).await?;
    let count = capabilities.len();

    Ok(Json(json!({
        "capabilities": capabilities,
        "count": count,
        "scopedCapabilities": scoped_capabilities,
    })))
}

// ── GET /admin/capabilities/check ────────────────────────────────────────────

#[derive(Deserialize)]
pub struct CheckQuery {
    pub capability: Option<String>,
}

pub async fn check_capability(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
    Query(params): Query<CheckQuery>,
) -> RouteResult<impl IntoResponse> {
    let session = require_session(ext)?;
    require_admin(&db, session.user_id).await?;

    let cap = params
        .capability
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| AppError::Validation("capability query parameter is required.".to_string()))?;

    if !ALL_CAPABILITIES.contains(&cap) {
        return Err(AppError::Validation(format!("Unknown capability: {}", cap)));
    }

    let has_capability = crate::auth::privileges::has_admin_privilege(&db, session.user_id, cap).await?;

    Ok(Json(json!({
        "capability": cap,
        "hasCapability": has_capability,
    })))
}

// ── GET /admin/capabilities/all ───────────────────────────────────────────────

pub async fn get_all_capabilities(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
) -> RouteResult<impl IntoResponse> {
    let session = require_session(ext)?;
    require_admin(&db, session.user_id).await?;

    Ok(Json(json!({
        "capabilities": ALL_CAPABILITIES,
        "count": ALL_CAPABILITIES.len(),
    })))
}

// ── POST /admin/capabilities/check-multiple ───────────────────────────────────

pub async fn check_multiple(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
    Json(body): Json<Value>,
) -> RouteResult<impl IntoResponse> {
    let session = require_session(ext)?;
    require_admin(&db, session.user_id).await?;

    let caps = body
        .get("capabilities")
        .and_then(|v| v.as_array())
        .filter(|a| !a.is_empty())
        .ok_or_else(|| AppError::Validation("capabilities array is required.".to_string()))?;

    // Validate and collect in one pass — no second loop, no unwrap.
    let validated: Vec<&str> = caps
        .iter()
        .map(|cap_val| {
            let cap = cap_val
                .as_str()
                .ok_or_else(|| AppError::Validation("Each capability must be a string.".to_string()))?;
            if !ALL_CAPABILITIES.contains(&cap) {
                return Err(AppError::Validation(format!("Unknown capability: {}", cap)));
            }
            Ok(cap)
        })
        .collect::<Result<Vec<_>, _>>()?;

    let mut results = Vec::with_capacity(validated.len());
    for cap in validated {
        let has_capability = crate::auth::privileges::has_admin_privilege(&db, session.user_id, cap).await?;
        results.push(json!({
            "capability": cap,
            "hasCapability": has_capability,
        }));
    }

    Ok(Json(json!({ "results": results })))
}

// ── GET /admin/roles/my-grants ────────────────────────────────────────────────

pub async fn my_grants(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
) -> RouteResult<impl IntoResponse> {
    let session = require_session(ext)?;
    require_admin(&db, session.user_id).await?;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT g.id, g.role_key, r.name AS role_name, r.description AS role_description,
                      g.organization_id, g.granted_at
               FROM user_admin_role_grants g
               JOIN admin_roles r ON r.key = g.role_key
               WHERE g.user_id = $1 AND g.revoked_at IS NULL
               ORDER BY g.granted_at"#,
            [session.user_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("my grants: {}", e)))?;

    let grants: Vec<Value> = rows
        .iter()
        .map(|r| -> Result<Value, AppError> {
            let granted_at = r
                .try_get::<chrono::DateTime<chrono::Utc>>("", "granted_at")
                .ok()
                .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
            Ok(json!({
                "id": r.try_get::<Uuid>("", "id").ok(),
                "roleKey": r.try_get::<String>("", "role_key").map_err(|e| AppError::Internal(anyhow::anyhow!("read role_key: {}", e)))?,
                "roleName": r.try_get::<String>("", "role_name").map_err(|e| AppError::Internal(anyhow::anyhow!("read role_name: {}", e)))?,
                "roleDescription": r.try_get::<String>("", "role_description").map_err(|e| AppError::Internal(anyhow::anyhow!("read role_description: {}", e)))?,
                "organizationId": r.try_get::<Option<Uuid>>("", "organization_id").ok().flatten(),
                "grantedAt": granted_at,
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(json!({ "grants": grants })))
}

// ── GET /admin/is-admin ───────────────────────────────────────────────────────
// Returns 200 for ALL callers — anonymous gets { isAdmin: false }.

pub async fn is_admin(
    State((_, db)): State<(Config, DatabaseConnection)>,
    ext: Option<Extension<Arc<Session>>>,
) -> RouteResult<impl IntoResponse> {
    let is_admin = match ext.map(|e| e.0) {
        None => false,
        Some(session) => user_has_any_admin_role(&db, session.user_id).await?,
    };

    Ok(Json(json!({ "isAdmin": is_admin })))
}

// ── Internal helpers ──────────────────────────────────────────────────────────

async fn effective_and_scoped(
    db: &DatabaseConnection,
    user_id: Uuid,
) -> Result<(Vec<String>, Vec<String>), AppError> {
    use crate::db::admin_roles::{get_effective_admin_capabilities, get_scoped_admin_capabilities};
    let capabilities = get_effective_admin_capabilities(db, user_id).await?.into_iter().collect();
    let mut scoped = std::collections::BTreeSet::new();
    for caps in get_scoped_admin_capabilities(db, user_id).await?.into_values() {
        scoped.extend(caps);
    }
    Ok((capabilities, scoped.into_iter().collect()))
}

// ── GET /admin/roles ──────────────────────────────────────────────────────────

pub async fn list_roles(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    require_admin(&db, session.user_id).await?;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, key, name, description, is_system_role, capabilities, created_at, updated_at
               FROM admin_roles ORDER BY is_system_role DESC, name"#,
            [],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("list admin_roles: {}", e)))?;

    use crate::db::admin_roles::ROLE_CAPABILITIES;

    let roles: Vec<Value> = rows
        .iter()
        .map(|row| -> Result<Value, AppError> {
            let id: Uuid = row.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("id: {}", e)))?;
            let key: String = row.try_get("", "key").map_err(|e| AppError::Internal(anyhow::anyhow!("key: {}", e)))?;
            let name: String = row.try_get("", "name").map_err(|e| AppError::Internal(anyhow::anyhow!("name: {}", e)))?;
            let description: String = row.try_get("", "description").map_err(|e| AppError::Internal(anyhow::anyhow!("description: {}", e)))?;
            let is_system_role: bool = row.try_get("", "is_system_role").map_err(|e| AppError::Internal(anyhow::anyhow!("is_system_role: {}", e)))?;
            let db_caps: Vec<String> = row.try_get("", "capabilities").unwrap_or_default();
            let created_at: chrono::DateTime<chrono::FixedOffset> = row.try_get("", "created_at").map_err(|e| AppError::Internal(anyhow::anyhow!("created_at: {}", e)))?;
            let updated_at: chrono::DateTime<chrono::FixedOffset> = row.try_get("", "updated_at").map_err(|e| AppError::Internal(anyhow::anyhow!("updated_at: {}", e)))?;

            // Mirror Node: DB capabilities, fall back to PRECONFIGURED_ROLES if empty.
            let capabilities: Vec<&str> = if db_caps.is_empty() {
                ROLE_CAPABILITIES
                    .iter()
                    .find(|(k, _)| *k == key.as_str())
                    .map(|(_, caps)| caps.to_vec())
                    .unwrap_or_default()
            } else {
                db_caps.iter().map(|s| s.as_str()).collect()
            };
            let capability_count = capabilities.len();

            Ok(json!({
                "id": id,
                "key": key,
                "name": name,
                "description": description,
                "isSystemRole": is_system_role,
                "capabilities": capabilities,
                "capabilityCount": capability_count,
                "createdAt": created_at.to_rfc3339(),
                "updatedAt": updated_at.to_rfc3339(),
            }))
        })
        .collect::<Result<Vec<_>, _>>()?;

    Ok(Json(json!({ "roles": roles })))
}
