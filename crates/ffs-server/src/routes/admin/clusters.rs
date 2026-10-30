// Admin cluster route handlers.
// GET /admin/clusters, POST /admin/clusters, PUT /admin/clusters/:id, DELETE /admin/clusters/:id

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::{
        admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
        clusters::{self, CreateClusterInput},
        organizations,
    },
    errors::{AppError, RouteResult},
    tx::TxHandle,
};

// ── Helpers ──────────────────────────────────────────────────────────────────

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("You do not have admin access.".to_string()));
    }
    Ok(())
}

async fn require_capability(
    db: &DatabaseConnection,
    user_id: Uuid,
    cap: &str,
) -> Result<ScopeKind, AppError> {
    let scope = resolve_admin_capability_scope(db, user_id, cap).await?;
    if let ScopeKind::None = scope {
        return Err(AppError::Authorization(format!(
            "User lacks required admin capability: {}",
            cap
        )));
    }
    Ok(scope)
}

fn cluster_json(c: &clusters::Cluster) -> JsonValue {
    json!({
        "id": c.id,
        "name": c.name,
        "type": c.type_,
        "description": c.description,
        "organizationId": c.organization_id,
        "createdBy": c.created_by,
        "createdAt": c.created_at.to_rfc3339(),
        "updatedAt": c.updated_at.to_rfc3339(),
    })
}

// ── GET /admin/clusters ───────────────────────────────────────────────────────

pub async fn list_clusters(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "ClusterRead").await?;

    let all = clusters::list_live(&db).await?;
    let filtered: Vec<_> = match &scope {
        ScopeKind::Global => all,
        ScopeKind::Scoped(org_ids) => all.into_iter().filter(|c| org_ids.contains(&c.organization_id)).collect(),
        ScopeKind::None => {
            return Err(AppError::Authorization(
                "You do not have permission to access clusters.".to_string(),
            ));
        }
    };

    let mut result: Vec<JsonValue> = Vec::with_capacity(filtered.len());
    for c in &filtered {
        let team_count = clusters::count_teams(&db, c.id).await?;
        let mut obj = cluster_json(c);
        obj["teamCount"] = json!(team_count);
        result.push(obj);
    }

    Ok(Json(json!({ "clusters": result })))
}

// ── POST /admin/clusters ──────────────────────────────────────────────────────

pub async fn create_cluster(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    tx_handle: Option<Extension<TxHandle>>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "ClusterCreate").await?;

    let name = body["name"]
        .as_str()
        .ok_or_else(|| AppError::Validation("name is required.".to_string()))?
        .to_owned();
    let cluster_type = body["type"]
        .as_str()
        .ok_or_else(|| AppError::Validation("type is required.".to_string()))?
        .to_owned();
    if !["vendor", "agency", "pa"].contains(&cluster_type.as_str()) {
        return Err(AppError::Validation("Cluster type must be one of: vendor, agency, pa.".to_string()));
    }
    let description = body["description"].as_str().map(|s| s.to_owned());

    let org_id_val = &body["organizationId"];
    if org_id_val.is_null() || org_id_val.is_object() || org_id_val == &JsonValue::Null {
        return Err(AppError::Validation(
            "An organisation is required for every cluster.".to_string(),
        ));
    }
    let org_id: Uuid = org_id_val
        .as_str()
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| AppError::Validation("An organisation is required for every cluster.".to_string()))?;

    // Scoped admin: org must be within scope.
    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&org_id) {
            return Err(AppError::Validation(
                "Organisation selection is outside your granted organisations.".to_string(),
            ));
        }
    }

    // Org must be live.
    if !organizations::org_is_live(&db, org_id).await? {
        return Err(AppError::Validation("Organisation not found.".to_string()));
    }

    // Use the request-wide transaction so idempotency token consumption and
    // the cluster write commit/rollback together (addendum-014).
    let tx_handle = tx_handle
        .map(|Extension(h)| h)
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("TxHandle missing for authenticated POST")))?;
    let guard = tx_handle.0.lock().await;
    let txn = guard
        .as_ref()
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("transaction already consumed")))?;

    // Name uniqueness per type.
    if clusters::name_type_exists(txn, &name, &cluster_type, None).await? {
        return Err(AppError::Validation(
            "A cluster with this name and type already exists.".to_string(),
        ));
    }

    let new_id = Uuid::now_v7();
    clusters::create(
        txn,
        CreateClusterInput {
            id: new_id,
            name,
            type_: cluster_type,
            description,
            organization_id: org_id,
            created_by: session.user_id,
        },
    )
    .await?;

    let created = clusters::get_live(txn, new_id)
        .await?
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("cluster not found after insert")))?;

    Ok((axum::http::StatusCode::CREATED, Json(json!({ "cluster": cluster_json(&created) }))))
}

// ── PUT /admin/clusters/:id ───────────────────────────────────────────────────

pub async fn update_cluster(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(cluster_id): Path<Uuid>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "ClusterUpdate").await?;

    let existing = clusters::get_live(&db, cluster_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Cluster not found.".to_string()))?;

    // Scoped admin: target cluster must be within their org scope.
    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&existing.organization_id) {
            return Err(AppError::NotFound("Cluster not found.".to_string()));
        }
    }

    let name: Option<String> = body.get("name").and_then(|v| v.as_str()).map(|s| s.to_owned());
    let description: Option<Option<String>> = if body.get("description").is_some() {
        Some(body["description"].as_str().map(|s| s.to_owned()))
    } else {
        None
    };

    // organizationId: check if key is present in JSON object.
    let org_id_update: Option<Uuid> = if let Some(org_val) = body.get("organizationId") {
        if org_val.is_null() {
            return Err(AppError::Validation(
                "An organisation is required for every cluster.".to_string(),
            ));
        }
        let id: Uuid = org_val
            .as_str()
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| AppError::Validation("Invalid organizationId.".to_string()))?;
        // Org must be live.
        if !organizations::org_is_live(&db, id).await? {
            return Err(AppError::Validation("Organisation not found.".to_string()));
        }
        if let ScopeKind::Scoped(ref org_ids) = scope {
            if !org_ids.contains(&id) {
                return Err(AppError::Validation(
                    "Organisation selection is outside your granted organisations.".to_string(),
                ));
            }
        }
        // A cluster referenced by live systems cannot change organisation.
        let refs = db.query_all(sea_orm::Statement::from_sql_and_values(
            sea_orm::DbBackend::Postgres,
            r#"SELECT 1 FROM systems s
               WHERE s.expires_after IS NULL
                 AND (s.agency_cluster_id = $1 OR EXISTS (
                   SELECT 1 FROM system_vendor_clusters svc
                   WHERE svc.system_id = s.id AND svc.cluster_id = $1 AND svc.expires_after IS NULL
                 )) LIMIT 1"#,
            [cluster_id.into()],
        )).await.map_err(|e| AppError::Internal(anyhow::anyhow!("cluster refs: {}", e)))?;
        if !refs.is_empty() {
            return Err(AppError::Validation(
                "Cannot change a cluster's organisation while live systems reference it.".to_string(),
            ));
        }
        Some(id)
    } else {
        None
    };

    let has_changes = name.is_some() || description.is_some() || org_id_update.is_some();
    if !has_changes {
        return Err(AppError::Validation("No fields to update.".to_string()));
    }

    // Name uniqueness per type (exclude self).
    if let Some(ref new_name) = name {
        if clusters::name_type_exists(&db, new_name, &existing.type_, Some(cluster_id)).await? {
            return Err(AppError::Validation(
                "A cluster with this name and type already exists.".to_string(),
            ));
        }
    }

    clusters::update(&db, cluster_id, name, description, org_id_update).await?;

    let updated = clusters::get_live(&db, cluster_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Cluster not found.".to_string()))?;

    Ok(Json(json!({ "cluster": cluster_json(&updated) })))
}

// ── DELETE /admin/clusters/:id ────────────────────────────────────────────────

pub async fn delete_cluster(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(cluster_id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    ensure_admin(&db, session.user_id).await?;
    let scope = require_capability(&db, session.user_id, "ClusterDelete").await?;

    let existing = clusters::get_live(&db, cluster_id)
        .await?
        .ok_or_else(|| AppError::NotFound("Cluster not found.".to_string()))?;

    // Scoped admin: target cluster must be within their org scope.
    if let ScopeKind::Scoped(ref org_ids) = scope {
        if !org_ids.contains(&existing.organization_id) {
            return Err(AppError::NotFound("Cluster not found.".to_string()));
        }
    }

    let team_count = clusters::count_teams(&db, cluster_id).await?;
    if team_count > 0 {
        return Err(AppError::Validation(
            "Cannot delete cluster with existing teams.".to_string(),
        ));
    }

    clusters::invalidate(&db, cluster_id).await?;

    Ok(Json(json!({ "message": "Cluster deleted successfully." })))
}
