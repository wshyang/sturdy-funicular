// Admin system planes: CRUD, org edges, owners, assets, mappings, /my-systems.
// Org truth is system_organizations (addendum-206); scoped reads key on the
// OWNER edge, scoped writes are 404-disguised, org-edge writes are global-only.

use std::{collections::{HashMap, HashSet}, sync::Arc};

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DbBackend, DatabaseConnection, Statement, TransactionTrait};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
    errors::{AppError, RouteResult},
    aws::asset_inventory,
    mapping_sync,
};


fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB error: {}", e))
}

const CUSTODY_STAGES: [&str; 5] = ["prepare", "initiate_handover", "verify_return", "return_to_inventory", "investigate_exception"];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CustodyConfigInput {
    stage: String,
    agency_team_id: Uuid,
    instructions: Option<String>,
    due_in_hours: Option<i32>,
}

async fn parse_custody_configs(db: &DatabaseConnection, value: &JsonValue, agency_cluster: Uuid) -> Result<Vec<CustodyConfigInput>, AppError> {
    if !value.as_array().is_some_and(|items| items.iter().all(|row|
        row.get("instructions").is_some() && row.get("dueInHours").is_some())) {
        return Err(AppError::validation("Invalid custody stage configuration."));
    }
    let rows: Vec<CustodyConfigInput> = serde_json::from_value(value.clone())
        .map_err(|_| AppError::validation("Invalid custody stage configuration."))?;
    if rows.len() != 5 || rows.iter().map(|r| r.stage.as_str()).collect::<HashSet<_>>().len() != 5
        || rows.iter().any(|r| !CUSTODY_STAGES.contains(&r.stage.as_str())) {
        return Err(AppError::validation("Custody configuration must contain each fixed agency stage exactly once."));
    }
    for row in &rows {
        if row.instructions.as_ref().is_some_and(|v| v.chars().count() > 1000)
            || row.due_in_hours.is_some_and(|h| !(1..=8760).contains(&h)) {
            return Err(AppError::validation("Invalid custody stage configuration."));
        }
        let team = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT 1 FROM teams t JOIN clusters c ON c.id = t.cluster_id AND c.expires_after IS NULL AND c.type = 'agency' WHERE t.id = $1 AND t.cluster_id = $2 AND t.expires_after IS NULL",
            [row.agency_team_id.into(), agency_cluster.into()])).await.map_err(db_err)?;
        if team.is_none() {
            return Err(AppError::validation("Every custody stage must select a live team in the system agency cluster."));
        }
    }
    Ok(rows)
}

async fn replace_custody_configs(db: &DatabaseConnection, system_id: Uuid, actor_id: Uuid, rows: &[CustodyConfigInput]) -> Result<(), AppError> {
    let tx = db.begin().await.map_err(db_err)?;
    tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE system_custody_stage_configs SET expires_after = now(), updated_at = now() WHERE system_id = $1 AND expires_after IS NULL",
        [system_id.into()])).await.map_err(db_err)?;
    for row in rows {
        tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO system_custody_stage_configs (id,system_id,stage,agency_team_id,instructions,due_in_hours,created_by) VALUES ($1,$2,$3::custody_stage,$4,$5,$6,$7)",
            [Uuid::now_v7().into(), system_id.into(), row.stage.clone().into(), row.agency_team_id.into(), row.instructions.clone().into(), row.due_in_hours.into(), actor_id.into()])).await.map_err(db_err)?;
    }
    tx.commit().await.map_err(db_err)?;
    Ok(())
}

async fn custody_configs(db: &DatabaseConnection, system_id: Option<Uuid>) -> Result<HashMap<Uuid, Vec<JsonValue>>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT system_id, id, stage::text, agency_team_id, instructions, due_in_hours, created_by, created_at, updated_at FROM system_custody_stage_configs WHERE expires_after IS NULL AND ($1::uuid IS NULL OR system_id = $1) ORDER BY system_custody_stage_configs.stage",
        [system_id.into()])).await.map_err(db_err)?;
    let mut by_system: HashMap<Uuid, Vec<JsonValue>> = HashMap::new();
    for r in rows {
        let id: Uuid = r.try_get("", "system_id").map_err(db_err)?;
        by_system.entry(id).or_default().push(json!({
            "id": r.try_get::<Uuid>("", "id").map_err(db_err)?,
            "systemId": id,
            "stage": r.try_get::<String>("", "stage").map_err(db_err)?,
            "agencyTeamId": r.try_get::<Uuid>("", "agency_team_id").map_err(db_err)?,
            "instructions": r.try_get::<Option<String>>("", "instructions").map_err(db_err)?,
            "dueInHours": r.try_get::<Option<i32>>("", "due_in_hours").map_err(db_err)?,
            "createdBy": r.try_get::<Uuid>("", "created_by").map_err(db_err)?,
            "createdAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "created_at").map_err(db_err)?.to_rfc3339(),
            "updatedAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at").map_err(db_err)?.to_rfc3339(),
            "expiresAfter": JsonValue::Null,
        }));
    }
    Ok(by_system)
}

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? {
        return Err(AppError::Authorization("You do not have admin access.".to_string()));
    }
    Ok(())
}

async fn scope(db: &DatabaseConnection, user_id: Uuid, cap: &str) -> Result<ScopeKind, AppError> {
    let s = resolve_admin_capability_scope(db, user_id, cap).await?;
    if let ScopeKind::None = s {
        return Err(AppError::Authorization(format!("User lacks required admin capability: {}", cap)));
    }
    Ok(s)
}

async fn owner_org(db: &DatabaseConnection, system_id: Uuid) -> Result<Option<Uuid>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT organization_id FROM system_organizations WHERE system_id = $1 AND role = 'owner' AND expires_after IS NULL LIMIT 1",
        [system_id.into()],
    )).await.map_err(db_err)?;
    Ok(rows.first().and_then(|r| r.try_get("", "organization_id").ok()))
}

async fn system_in_scope(db: &DatabaseConnection, s: &ScopeKind, system_id: Uuid) -> Result<(), AppError> {
    let exists = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM systems WHERE id = $1 AND expires_after IS NULL LIMIT 1",
        [system_id.into()],
    )).await.map_err(db_err)?;
    if exists.is_empty() { return Err(AppError::NotFound("System not found.".to_string())); }
    if let ScopeKind::Scoped(org_ids) = s {
        let org = owner_org(db, system_id).await?;
        if !org.map(|o| org_ids.contains(&o)).unwrap_or(false) {
            return Err(AppError::NotFound("System not found.".to_string()));
        }
    }
    Ok(())
}

async fn edges_json(db: &DatabaseConnection, system_id: Uuid) -> Result<Vec<JsonValue>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT so.id, so.organization_id, so.role::TEXT, o.name
           FROM system_organizations so JOIN organizations o ON o.id = so.organization_id
           WHERE so.system_id = $1 AND so.expires_after IS NULL ORDER BY so.role DESC, o.name"#,
        [system_id.into()],
    )).await.map_err(db_err)?;
    Ok(rows.iter().map(|r| json!({
        "id": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
        "systemId": system_id,
        "organizationId": r.try_get::<Uuid>("", "organization_id").unwrap_or(Uuid::nil()),
        "organizationName": r.try_get::<String>("", "name").unwrap_or_default(),
        "role": r.try_get::<String>("", "role").unwrap_or_default(),
    })).collect())
}

async fn audit_system(db: &DatabaseConnection, actor: Uuid, action: &str, target_id: Uuid, details: JsonValue) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,'system',$4,$5)",
        [Uuid::now_v7().into(), actor.into(), action.into(), target_id.to_string().into(), details.into()],
    )).await.map_err(db_err)?;
    Ok(())
}

// ── GET /admin/systems ───────────────────────────────────────────────────────

pub async fn list_systems(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemRead").await?;
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT s.id, s.short_code, s.name, s.description, s.agency_cluster_id, s.created_at, s.updated_at,
                  so.organization_id AS owner_organization_id,
                  (SELECT user_id FROM system_owners WHERE system_id = s.id AND kind = 'primary' AND expires_after IS NULL LIMIT 1) AS primary_owner_id,
                  (SELECT user_id FROM system_owners WHERE system_id = s.id AND kind = 'backup' AND expires_after IS NULL LIMIT 1) AS backup_owner_id
           FROM systems s
           LEFT JOIN system_organizations so ON so.system_id = s.id AND so.role = 'owner' AND so.expires_after IS NULL
           WHERE s.expires_after IS NULL ORDER BY s.name"#,
        [],
    )).await.map_err(db_err)?;
    // One batched custody projection, not a per-system query (list can be large).
    let custody_by_system = custody_configs(db, None).await?;
    let systems: Vec<JsonValue> = rows.iter().filter_map(|r| {
        let org: Option<Uuid> = r.try_get("", "owner_organization_id").ok();
        if let ScopeKind::Scoped(org_ids) = &s {
            if !org.map(|o| org_ids.contains(&o)).unwrap_or(false) { return None; }
        }
        let system_id = r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil());
        Some(json!({
            "id": system_id,
            "custodyStageConfigs": custody_by_system.get(&system_id).cloned().unwrap_or_default(),
            "shortCode": r.try_get::<String>("", "short_code").unwrap_or_default(),
            "name": r.try_get::<String>("", "name").unwrap_or_default(),
            "description": r.try_get::<Option<String>>("", "description").unwrap_or(None),
            "agencyClusterId": r.try_get::<Uuid>("", "agency_cluster_id").unwrap_or(Uuid::nil()),
            "ownerOrganizationId": org,
            "primaryOwnerId": r.try_get::<Option<Uuid>>("", "primary_owner_id").unwrap_or(None),
            "backupOwnerId": r.try_get::<Option<Uuid>>("", "backup_owner_id").unwrap_or(None),
            "createdAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "created_at").map(|t| t.to_rfc3339()).unwrap_or_default(),
            "updatedAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at").map(|t| t.to_rfc3339()).unwrap_or_default(),
        }))
    }).collect();
    Ok(Json(json!({ "systems": systems })))
}

// ── GET /my-systems ──────────────────────────────────────────────────────────

pub async fn my_systems(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT DISTINCT s.id, s.name, s.short_code
           FROM systems s
           WHERE s.expires_after IS NULL AND (
             EXISTS (SELECT 1 FROM system_owners so WHERE so.system_id = s.id AND so.user_id = $1 AND so.expires_after IS NULL)
             OR EXISTS (
               SELECT 1 FROM team_memberships tm
               JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
               JOIN system_workflow_steps sws ON sws.cluster_id = t.cluster_id AND sws.level = t.level
                 AND sws.system_id = s.id AND sws.ordinal = 1 AND sws.expires_after IS NULL
               JOIN system_organizations so2 ON so2.system_id = s.id AND so2.expires_after IS NULL
               JOIN organization_memberships om ON om.organization_id = so2.organization_id AND om.user_id = $1 AND om.expires_after IS NULL
               WHERE tm.user_id = $1 AND tm.expires_after IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM team_memberships tm
               JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL
               JOIN system_workflow_steps sws ON sws.cluster_id = t.cluster_id AND sws.level = t.level
                 AND sws.system_id = s.id AND sws.ordinal > 1 AND sws.expires_after IS NULL
               WHERE tm.user_id = $1 AND tm.expires_after IS NULL
             )
           ) ORDER BY s.name"#,
        [session.user_id.into()],
    )).await.map_err(db_err)?;
    let systems: Vec<JsonValue> = rows.iter().map(|r| json!({
        "id": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
        "name": r.try_get::<String>("", "name").unwrap_or_default(),
        "shortCode": r.try_get::<String>("", "short_code").unwrap_or_default(),
    })).collect();
    Ok(Json(json!({ "systems": systems })))
}

// ── POST /admin/systems ──────────────────────────────────────────────────────

pub async fn create_system(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Json(body): Json<JsonValue>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemCreate").await?;
    let short_code = body["shortCode"].as_str().unwrap_or("").trim().to_uppercase();
    let name = body["name"].as_str().unwrap_or("").trim().to_string();
    let primary_owner = body["primaryOwnerId"].as_str().and_then(|v| Uuid::parse_str(v).ok());
    let agency_cluster = body["agencyClusterId"].as_str().and_then(|v| Uuid::parse_str(v).ok());
    if short_code.is_empty() || name.is_empty() || primary_owner.is_none() {
        return Err(AppError::Validation("Short code, name, and primary owner are required.".to_string()));
    }
    let agency_cluster = agency_cluster.ok_or_else(|| AppError::Validation("The specified cluster does not exist.".to_string()))?;
    let agency_org_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT organization_id FROM clusters WHERE id = $1 AND expires_after IS NULL LIMIT 1",
        [agency_cluster.into()],
    )).await.map_err(db_err)?;
    let agency_org: Uuid = agency_org_rows.first().and_then(|r| r.try_get("", "organization_id").ok())
        .ok_or_else(|| AppError::Validation("The agency cluster is not anchored to an organisation.".to_string()))?;
    let mut owner_org_id = agency_org;
    let explicit_owner = body.get("ownerOrganizationId").and_then(|v| v.as_str()).and_then(|v| Uuid::parse_str(v).ok());
    if let Some(explicit) = explicit_owner {
        if !crate::db::organizations::org_is_live(db, explicit).await? {
            return Err(AppError::Validation("Organisation not found.".to_string()));
        }
        owner_org_id = explicit;
    }
    let mut participants: Vec<Uuid> = Vec::new();
    if let Some(arr) = body.get("participantOrganizationIds").and_then(|v| v.as_array()) {
        for v in arr {
            let pid = v.as_str().and_then(|v| Uuid::parse_str(v).ok())
                .ok_or_else(|| AppError::Validation("Organisation not found.".to_string()))?;
            if !participants.contains(&pid) { participants.push(pid); }
        }
    }
    for pid in &participants {
        if !crate::db::organizations::org_is_live(db, *pid).await? {
            return Err(AppError::Validation("Organisation not found.".to_string()));
        }
        if *pid == owner_org_id {
            return Err(AppError::Validation("This organisation is already the system's owner.".to_string()));
        }
    }
    if let ScopeKind::Scoped(org_ids) = &s {
        if !org_ids.contains(&agency_org) || explicit_owner.is_some() || !participants.is_empty() {
            return Err(AppError::Validation("Organisation selection is outside your granted organisations.".to_string()));
        }
    }
    if short_code.len() > 10 || !short_code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(AppError::Validation("Short code must be 1-10 uppercase alphanumeric characters.".to_string()));
    }
    let dup = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM systems WHERE short_code = $1 AND expires_after IS NULL LIMIT 1",
        [short_code.clone().into()],
    )).await.map_err(db_err)?;
    if !dup.is_empty() { return Err(AppError::Validation("A system with this short code already exists.".to_string())); }
    let vendor_ids: Vec<Uuid> = body.get("vendorClusterIds").and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok())).collect())
        .unwrap_or_default();
    let workflow = body.get("workflowDefinition").and_then(|v| v.as_array()).cloned().unwrap_or_default();
    validate_cluster_refs(db, &vendor_ids, agency_cluster).await?;
    check_workflow(db, &workflow, &vendor_ids, agency_cluster, None).await?;
    if name.chars().count() > 100 { return Err(AppError::Validation("System name is required and must be 1-100 characters.".to_string())); }
    let dup_name = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM systems WHERE name = $1 AND expires_after IS NULL LIMIT 1", [name.clone().into()])).await.map_err(db_err)?;
    if !dup_name.is_empty() { return Err(AppError::Validation("A system with this name already exists.".to_string())); }
    let description = optional_text(&body, "description", "System description")?.flatten();
    let aws_note = optional_text(&body, "awsRoleArnNote", "AWS role ARN note")?.flatten();
    let owner_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT status::TEXT AS status, affiliation::TEXT AS affiliation FROM users WHERE id = $1 LIMIT 1",
        [primary_owner.unwrap().into()],
    )).await.map_err(db_err)?;
    let status: String = owner_rows.first().and_then(|r| r.try_get("", "status").ok()).unwrap_or_default();
    let affiliation: String = owner_rows.first().and_then(|r| r.try_get("", "affiliation").ok()).unwrap_or_default();
    if status != "active" { return Err(AppError::Validation("Primary owner must be an active user.".to_string())); }
    if affiliation != "agency" { return Err(AppError::Validation("Primary owner must have agency affiliation.".to_string())); }
    let backup_owner = body["backupOwnerId"].as_str().and_then(|v| Uuid::parse_str(v).ok());
    if let Some(bid) = backup_owner {
        if bid == primary_owner.unwrap() { return Err(AppError::Validation("Backup owner cannot be the same person as the primary owner.".to_string())); }
        validate_owner(db, bid, "Backup").await?;
    }

    let tx = db.begin().await.map_err(db_err)?;
    let system_id = Uuid::now_v7();
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO systems (id, short_code, name, description, agency_cluster_id, aws_role_arn_note, created_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,now(),now())"#,
        [system_id.into(), short_code.clone().into(), name.clone().into(), description.into(), agency_cluster.into(), aws_note.into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    if let Some(arr) = body.get("vendorClusterIds").and_then(|v| v.as_array()) {
        for (i, v) in arr.iter().enumerate() {
            if let Some(cid) = v.as_str().and_then(|v| Uuid::parse_str(v).ok()) {
                tx.execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "INSERT INTO system_vendor_clusters (id, system_id, cluster_id, ordinal, created_at) VALUES ($1,$2,$3,$4,now())",
                    [Uuid::now_v7().into(), system_id.into(), cid.into(), (i as i16 + 1).into()],
                )).await.map_err(db_err)?;
            }
        }
    }
    if let Some(arr) = body.get("workflowDefinition").and_then(|v| v.as_array()) {
        for step in arr {
            let ordinal = step["ordinal"].as_i64().unwrap_or(1) as i16;
            let cid = step["clusterId"].as_str().and_then(|v| Uuid::parse_str(v).ok());
            let level = step["level"].as_i64().unwrap_or(1) as i16;
            let kind = step["stepKind"].as_str().unwrap_or("hierarchical");
            if let Some(cid) = cid {
                tx.execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    r#"INSERT INTO system_workflow_steps (id, system_id, ordinal, cluster_id, level, step_kind, created_at)
                       VALUES ($1,$2,$3,$4,$5,$6::step_kind,now())"#,
                    [Uuid::now_v7().into(), system_id.into(), ordinal.into(), cid.into(), level.into(), kind.to_string().into()],
                )).await.map_err(db_err)?;
            }
        }
    }
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO system_organizations (id, system_id, organization_id, role, created_by) VALUES ($1,$2,$3,'owner',$4)",
        [Uuid::now_v7().into(), system_id.into(), owner_org_id.into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    for pid in &participants {
        tx.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO system_organizations (id, system_id, organization_id, role, created_by) VALUES ($1,$2,$3,'participant',$4)",
            [Uuid::now_v7().into(), system_id.into(), (*pid).into(), session.user_id.into()],
        )).await.map_err(db_err)?;
    }
    let primary_row = Uuid::now_v7();
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO system_owners (id, system_id, user_id, kind, created_by, created_at) VALUES ($1,$2,$3,'primary',$4,now())",
        [primary_row.into(), system_id.into(), primary_owner.unwrap().into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    if let Some(bid) = backup_owner {
        tx.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO system_owners (id, system_id, user_id, kind, created_by, created_at) VALUES ($1,$2,$3,'backup',$4,now())",
            [Uuid::now_v7().into(), system_id.into(), bid.into(), session.user_id.into()])).await.map_err(db_err)?;
    }
    mapping_sync::sync_mappings_for_system(&tx, system_id, &workflow, session.user_id).await?;
    tx.commit().await.map_err(db_err)?;
    audit_system(db, session.user_id, "system.created", system_id, json!({ "name": name, "shortCode": short_code })).await?;
    // Return the same normalized projection as reads/updates, including the
    // vendor-cluster and workflow junctions committed above. The legacy create
    // response is consumed directly by the admin form; a partial row is not a
    // compatible replacement just because it contains the new id.
    let mut system = system_full_json(db, system_id).await?;
    let backup_row: Option<Uuid> = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id FROM system_owners WHERE system_id = $1 AND kind = 'backup' AND expires_after IS NULL LIMIT 1",
        [system_id.into()],
    )).await.map_err(db_err)?.first().and_then(|r| r.try_get("", "id").ok());
    let fields = system.as_object_mut().expect("system projection is an object");
    fields.insert("primaryOwnerRowId".into(), json!(primary_row));
    fields.insert("backupOwnerRowId".into(), json!(backup_row));
    fields.insert("ownerOrganizationId".into(), json!(owner_org_id));
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "system": system }))))
}

// ── PUT /admin/systems/:id ───────────────────────────────────────────────────

pub async fn update_system(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemUpdate").await?;
    system_in_scope(db, &s, id).await?;
    let sys_rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT name, description, aws_role_arn_note, agency_cluster_id FROM systems WHERE id = $1 AND expires_after IS NULL LIMIT 1", [id.into()])).await.map_err(db_err)?;
    let sys = sys_rows.first().ok_or_else(|| AppError::NotFound("System not found.".to_string()))?;
    let _current_name: String = sys.try_get("", "name").unwrap_or_default();
    let current_agency: Uuid = sys.try_get("", "agency_cluster_id").unwrap_or(Uuid::nil());

    let name = body.get("name").and_then(|v| v.as_str()).map(|v| v.trim().to_string());
    if let Some(ref n) = name {
        if n.is_empty() || n.chars().count() > 100 { return Err(AppError::Validation("System name is required and must be 1-100 characters.".to_string())); }
        let dup = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT 1 FROM systems WHERE name = $1 AND id <> $2 AND expires_after IS NULL LIMIT 1", [n.clone().into(), id.into()])).await.map_err(db_err)?;
        if !dup.is_empty() { return Err(AppError::Validation("A system with this name already exists.".to_string())); }
    }
    let description = optional_text(&body, "description", "System description")?;
    let aws_note = optional_text(&body, "awsRoleArnNote", "AWS role ARN note")?;

    // Effective cluster set.
    let vendor_ids: Vec<Uuid> = if let Some(arr) = body.get("vendorClusterIds").and_then(|v| v.as_array()) {
        arr.iter().filter_map(|v| v.as_str().and_then(|s| Uuid::parse_str(s).ok())).collect()
    } else {
        let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT cluster_id FROM system_vendor_clusters WHERE system_id = $1 AND expires_after IS NULL ORDER BY ordinal", [id.into()])).await.map_err(db_err)?;
        rows.iter().filter_map(|r| r.try_get::<Uuid>("", "cluster_id").ok()).collect()
    };
    let agency_cluster = body.get("agencyClusterId").and_then(|v| v.as_str()).and_then(|v| Uuid::parse_str(v).ok()).unwrap_or(current_agency);
    let clusters_changed = body.get("vendorClusterIds").is_some() || body.get("agencyClusterId").is_some();
    if clusters_changed {
        if let Some(new_agency) = body.get("agencyClusterId").and_then(|v| v.as_str()).and_then(|v| Uuid::parse_str(v).ok()) {
            if new_agency != current_agency {
                if let ScopeKind::Scoped(org_ids) = &s {
                    let org = crate::db::clusters::get_live(db, new_agency).await?.map(|c| c.organization_id);
                    if !org.map(|o| org_ids.contains(&o)).unwrap_or(false) {
                        return Err(AppError::Validation("Organisation selection is outside your granted organisations.".to_string()));
                    }
                }
            }
        }
        validate_cluster_refs(db, &vendor_ids, agency_cluster).await?;
    }
    let workflow = body.get("workflowDefinition").and_then(|v| v.as_array()).cloned();
    if workflow.is_some() || clusters_changed {
        let eff: Vec<JsonValue> = match &workflow { Some(w) => w.clone(), None => load_workflow(db, id).await? };
        check_workflow(db, &eff, &vendor_ids, agency_cluster, Some(id)).await?;
    }

    // Owner cross-field validation.
    let current_primary = owner_user(db, id, "primary").await?;
    let current_backup = owner_user(db, id, "backup").await?;
    let primary_owner = if body.get("primaryOwnerId").is_some() {
        let pid = body["primaryOwnerId"].as_str().and_then(|v| Uuid::parse_str(v).ok());
        if let Some(pid) = pid { validate_owner(db, pid, "Primary").await?; }
        pid
    } else { current_primary };
    let backup_owner = if body.get("backupOwnerId").is_some() {
        let bid = body["backupOwnerId"].as_str().and_then(|v| Uuid::parse_str(v).ok());
        if let Some(bid) = bid { validate_owner(db, bid, "Backup").await?; }
        bid
    } else { current_backup };
    if let (Some(p), Some(b)) = (primary_owner, backup_owner) {
        if p == b { return Err(AppError::Validation("Backup owner cannot be the same person as the primary owner.".to_string())); }
    }

    let custody_update = match body.get("custodyStageConfigs") {
        Some(value) => Some(parse_custody_configs(db, value, agency_cluster).await?),
        None => None,
    };
    if body.get("agencyClusterId").is_some() && custody_update.is_none() {
        let existing = custody_configs(db, Some(id)).await?.remove(&id).unwrap_or_default();
        if !existing.is_empty() { parse_custody_configs(db, &json!(existing), agency_cluster).await?; }
    }
    let has_changes = name.is_some() || description.is_some() || aws_note.is_some() || clusters_changed || workflow.is_some()
        || body.get("primaryOwnerId").is_some() || body.get("backupOwnerId").is_some() || custody_update.is_some();
    if !has_changes { return Err(AppError::Validation("No fields to update.".to_string())); }

    if name.is_some() || description.is_some() || aws_note.is_some() || clusters_changed {
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE systems SET name = COALESCE($1, name), description = CASE WHEN $2::boolean THEN $3 ELSE description END, aws_role_arn_note = CASE WHEN $4::boolean THEN $5 ELSE aws_role_arn_note END, agency_cluster_id = $6, updated_at = now() WHERE id = $7",
            [name.clone().into(), description.is_some().into(), description.flatten().into(), aws_note.is_some().into(), aws_note.flatten().into(), agency_cluster.into(), id.into()])).await.map_err(db_err)?;
    }
    if clusters_changed {
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "UPDATE system_vendor_clusters SET expires_after = now() WHERE system_id = $1 AND expires_after IS NULL", [id.into()])).await.map_err(db_err)?;
        for (i, cid) in vendor_ids.iter().enumerate() {
            db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
                "INSERT INTO system_vendor_clusters (id, system_id, cluster_id, ordinal, created_at) VALUES ($1,$2,$3,$4,now())",
                [Uuid::now_v7().into(), id.into(), (*cid).into(), (i as i16 + 1).into()])).await.map_err(db_err)?;
        }
    }
    if let Some(ref wf) = workflow {
        replace_workflow_steps(db, id, wf).await?;
        mapping_sync::sync_mappings_for_system(db, id, wf, session.user_id).await?;
    }
    if body.get("primaryOwnerId").is_some() { replace_owner(db, id, "primary", primary_owner, session.user_id).await?; }
    if body.get("backupOwnerId").is_some() { replace_owner(db, id, "backup", backup_owner, session.user_id).await?; }
    if let Some(ref configs) = custody_update { replace_custody_configs(db, id, session.user_id, configs).await?; }
    audit_system(db, session.user_id, "system.updated", id, json!({ "changedFields": body.as_object().map(|o| o.keys().cloned().collect::<Vec<_>>()).unwrap_or_default() })).await?;
    Ok(Json(json!({ "system": system_full_json(db, id).await? })))
}

// ── DELETE /admin/systems/:id ────────────────────────────────────────────────

pub async fn delete_system(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(system_id_str): Path<String>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemDelete").await?;
    let system_id = system_id_str.parse::<Uuid>().map_err(|_| AppError::NotFound("System not found.".to_string()))?;
    system_in_scope(db, &s, system_id).await?;
    let open_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT count(*)::INT AS n FROM breakglass_requests WHERE system_id = $1 AND status NOT IN ('rejected','closed')",
        [system_id.into()],
    )).await.map_err(db_err)?;
    let open: i32 = open_rows.first().and_then(|r| r.try_get("", "n").ok()).unwrap_or(0);
    if open > 0 {
        return Err(AppError::Validation(format!("Cannot delete this system — it has {} open break-glass requests. Close or cancel all requests first.", open)));
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE team_system_mappings SET expires_after = now() WHERE system_id = $1 AND expires_after IS NULL", [system_id.into()])).await.map_err(db_err)?;
    let owners = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT id FROM system_owners WHERE system_id = $1 AND expires_after IS NULL", [system_id.into()])).await.map_err(db_err)?;
    for o in &owners {
        let oid: Uuid = o.try_get("", "id").unwrap();
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owners SET expires_after = now() WHERE id = $1", [oid.into()])).await.map_err(db_err)?;
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owner_pa_mappings SET expires_after = now() WHERE system_owner_id = $1 AND expires_after IS NULL", [oid.into()])).await.map_err(db_err)?;
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_delegates SET expires_after = now() WHERE system_id = $1 AND expires_after IS NULL", [system_id.into()])).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE systems SET expires_after = now(), updated_at = now() WHERE id = $1", [system_id.into()])).await.map_err(db_err)?;
    audit_system(db, session.user_id, "system.invalidated", system_id, json!({ "systemId": system_id })).await?;
    Ok(Json(json!({ "message": "System deleted successfully." })))
}

// ── GET /admin/systems/:id/mappings ──────────────────────────────────────────

pub async fn get_system_mappings(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemMappingRead").await?;
    system_in_scope(db, &s, id).await?;
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT m.id, m.team_id, m.created_by, m.created_at, t.name AS team_name, t.level, t.cluster_id, t.description
           FROM team_system_mappings m JOIN teams t ON t.id = m.team_id
           WHERE m.system_id = $1 AND m.expires_after IS NULL AND t.expires_after IS NULL"#,
        [id.into()],
    )).await.map_err(db_err)?;
    let mut mapped_clusters: Vec<Uuid> = Vec::new();
    let mappings: Vec<JsonValue> = rows.iter().map(|r| {
        let cid: Uuid = r.try_get("", "cluster_id").unwrap_or(Uuid::nil());
        if !mapped_clusters.contains(&cid) { mapped_clusters.push(cid); }
        json!({
            "mappingId": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
            "team": { "id": r.try_get::<Uuid>("", "team_id").unwrap_or(Uuid::nil()), "name": r.try_get::<String>("", "team_name").unwrap_or_default(), "level": r.try_get::<i16>("", "level").unwrap_or(0), "clusterId": cid, "description": r.try_get::<Option<String>>("", "description").unwrap_or(None) },
            "createdBy": r.try_get::<Uuid>("", "created_by").unwrap_or(Uuid::nil()),
            "createdAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "created_at").map(|t| t.to_rfc3339()).unwrap_or_default(),
        })
    }).collect();
    let declared = declared_clusters(db, id).await?;
    let mut unmapped_clusters = Vec::new();
    for cid in declared {
        if mapped_clusters.contains(&cid) { continue; }
        if let Some(cl) = crate::db::clusters::get_live(db, cid).await? {
            unmapped_clusters.push(json!({ "id": cl.id, "name": cl.name, "type": cl.type_ }));
        }
    }
    let steps = load_workflow(db, id).await?;
    let mut unmapped_steps = Vec::new();
    for step in steps {
        let cid = step["clusterId"].as_str().and_then(|v| Uuid::parse_str(v).ok()).unwrap_or(Uuid::nil());
        let level = step["level"].as_i64().unwrap_or(0) as i16;
        let team = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT 1 FROM teams WHERE cluster_id = $1 AND level = $2 AND expires_after IS NULL LIMIT 1", [cid.into(), level.into()])).await.map_err(db_err)?;
        if team.is_empty() { unmapped_steps.push(json!({ "ordinal": step["ordinal"], "clusterId": cid, "level": level })); }
    }
    Ok(Json(json!({ "mappings": mappings, "unmappedClusters": unmapped_clusters, "unmappedSteps": unmapped_steps })))
}

pub async fn get_mappable_teams(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemMappableTeamsRead").await?;
    system_in_scope(db, &s, id).await?;
    let allowed = declared_clusters(db, id).await?;
    let mapped = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT team_id FROM team_system_mappings WHERE system_id = $1 AND expires_after IS NULL", [id.into()])).await.map_err(db_err)?;
    let mapped_ids: Vec<Uuid> = mapped.iter().filter_map(|r| r.try_get("", "team_id").ok()).collect();
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT t.id, t.cluster_id, t.name, t.level, t.description, c.type::TEXT AS cluster_type, c.name AS cluster_name
           FROM teams t JOIN clusters c ON c.id = t.cluster_id
           WHERE t.expires_after IS NULL AND c.expires_after IS NULL ORDER BY t.name"#, [])).await.map_err(db_err)?;
    let teams: Vec<JsonValue> = rows.iter().filter_map(|r| {
        let tid: Uuid = r.try_get("", "id").ok()?;
        let cid: Uuid = r.try_get("", "cluster_id").ok()?;
        if !allowed.contains(&cid) || mapped_ids.contains(&tid) { return None; }
        Some(json!({ "id": tid, "clusterId": cid, "name": r.try_get::<String>("", "name").unwrap_or_default(), "level": r.try_get::<i16>("", "level").unwrap_or(0), "description": r.try_get::<Option<String>>("", "description").unwrap_or(None), "type": r.try_get::<Option<String>>("", "cluster_type").unwrap_or(None), "clusterName": r.try_get::<Option<String>>("", "cluster_name").unwrap_or(None) }))
    }).collect();
    Ok(Json(json!({ "teams": teams })))
}

// ── POST /admin/systems/:id/owners ───────────────────────────────────────────

pub async fn add_system_owner(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemOwnerManage").await?;
    system_in_scope(db, &s, id).await?;
    let user_id = body["userId"].as_str().and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| AppError::Validation("Owner must be an active user.".to_string()))?;
    let kind = body["kind"].as_str().unwrap_or("backup");
    if kind != "primary" && kind != "backup" { return Err(AppError::Validation("kind must be primary or backup.".to_string())); }
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT status::TEXT AS status, affiliation::TEXT AS affiliation FROM users WHERE id = $1 LIMIT 1",
        [user_id.into()],
    )).await.map_err(db_err)?;
    let status: String = rows.first().and_then(|r| r.try_get("", "status").ok()).unwrap_or_default();
    let affiliation: String = rows.first().and_then(|r| r.try_get("", "affiliation").ok()).unwrap_or_default();
    if status != "active" { return Err(AppError::Validation("Owner must be an active user.".to_string())); }
    if affiliation != "agency" { return Err(AppError::Validation("Owner must have agency affiliation.".to_string())); }
    let other_kind = if kind == "primary" { "backup" } else { "primary" };
    let other = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT user_id FROM system_owners WHERE system_id = $1 AND kind = $2::system_owner_kind AND expires_after IS NULL LIMIT 1",
        [id.into(), other_kind.to_string().into()],
    )).await.map_err(db_err)?;
    if let Some(row) = other.first() {
        let other_user: Uuid = row.try_get("", "user_id").unwrap_or(Uuid::nil());
        if other_user == user_id {
            return Err(AppError::Validation(format!("This user is already the {} owner of this system.", other_kind)));
        }
    }
    let existing = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id FROM system_owners WHERE system_id = $1 AND kind = $2::system_owner_kind AND expires_after IS NULL LIMIT 1",
        [id.into(), kind.to_string().into()],
    )).await.map_err(db_err)?;
    if let Some(row) = existing.first() {
        let existing_id: Uuid = row.try_get("", "id").unwrap_or(Uuid::nil());
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE system_owners SET expires_after = now() WHERE id = $1",
            [existing_id.into()],
        )).await.map_err(db_err)?;
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "UPDATE system_owner_pa_mappings SET expires_after = now() WHERE system_owner_id = $1 AND expires_after IS NULL",
            [existing_id.into()],
        )).await.map_err(db_err)?;
    }
    let owner_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO system_owners (id, system_id, user_id, kind, created_by, created_at) VALUES ($1,$2,$3,$4::system_owner_kind,$5,now())",
        [owner_id.into(), id.into(), user_id.into(), kind.to_string().into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "owner": { "id": owner_id, "systemId": id, "userId": user_id, "kind": kind } }))))
}

// ── Org edges ────────────────────────────────────────────────────────────────

pub async fn get_system_org_edges(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemRead").await?;
    system_in_scope(db, &s, id).await?;
    Ok(Json(json!({ "edges": edges_json(db, id).await? })))
}

async fn require_global_update(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    let s = resolve_admin_capability_scope(db, user_id, "SystemUpdate").await?;
    match s {
        ScopeKind::Global => Ok(()),
        _ => Err(AppError::Authorization("User lacks required admin capability: SystemUpdate".to_string())),
    }
}

pub async fn transfer_system_owner_org(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    require_global_update(db, session.user_id).await?;
    system_in_scope(db, &ScopeKind::Global, id).await?;
    let target = body["organizationId"].as_str().and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| AppError::Validation("Organisation not found.".to_string()))?;
    if !crate::db::organizations::org_is_live(db, target).await? {
        return Err(AppError::Validation("Organisation not found.".to_string()));
    }
    let current = owner_org(db, id).await?;
    if current == Some(target) {
        return Err(AppError::Validation("This organisation is already the system's owner.".to_string()));
    }
    let delegates = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM system_delegates WHERE system_id = $1 AND expires_after IS NULL LIMIT 1",
        [id.into()],
    )).await.map_err(db_err)?;
    if !delegates.is_empty() {
        return Err(AppError::Validation("Remove all delegates before transferring this system's organisation.".to_string()));
    }
    let tx = db.begin().await.map_err(db_err)?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE system_organizations SET expires_after = now() WHERE system_id = $1 AND expires_after IS NULL",
        [id.into()],
    )).await.map_err(db_err)?;
    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO system_organizations (id, system_id, organization_id, role, created_by) VALUES ($1,$2,$3,'owner',$4)",
        [Uuid::now_v7().into(), id.into(), target.into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    audit_system(db, session.user_id, "system_org_edge.owner_transferred", id,
        json!({ "systemId": id, "fromOrganizationId": current, "toOrganizationId": target })).await?;
    Ok(Json(json!({ "edges": edges_json(db, id).await? })))
}

pub async fn add_system_org_participant(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    require_global_update(db, session.user_id).await?;
    system_in_scope(db, &ScopeKind::Global, id).await?;
    let target = body["organizationId"].as_str().and_then(|v| Uuid::parse_str(v).ok())
        .ok_or_else(|| AppError::Validation("Organisation not found.".to_string()))?;
    if !crate::db::organizations::org_is_live(db, target).await? {
        return Err(AppError::Validation("Organisation not found.".to_string()));
    }
    if owner_org(db, id).await? == Some(target) {
        return Err(AppError::Validation("This organisation is already the system's owner.".to_string()));
    }
    let dup = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM system_organizations WHERE system_id = $1 AND organization_id = $2 AND expires_after IS NULL LIMIT 1",
        [id.into(), target.into()],
    )).await.map_err(db_err)?;
    if !dup.is_empty() { return Err(AppError::Validation("This organisation is already linked to this system.".to_string())); }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO system_organizations (id, system_id, organization_id, role, created_by) VALUES ($1,$2,$3,'participant',$4)",
        [Uuid::now_v7().into(), id.into(), target.into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    audit_system(db, session.user_id, "system_org_edge.participant_added", id,
        json!({ "systemId": id, "organizationId": target })).await?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "edges": edges_json(db, id).await? }))))
}

pub async fn remove_system_org_participant(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path((id, org_id)): Path<(Uuid, Uuid)>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    require_global_update(db, session.user_id).await?;
    system_in_scope(db, &ScopeKind::Global, id).await?;
    let edge = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT id FROM system_organizations WHERE system_id = $1 AND organization_id = $2 AND role = 'participant' AND expires_after IS NULL LIMIT 1",
        [id.into(), org_id.into()],
    )).await.map_err(db_err)?;
    if edge.is_empty() { return Err(AppError::NotFound("Organisation is not a participant of this system.".to_string())); }
    let orphans = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT 1 FROM system_delegates sd
           WHERE sd.system_id = $1 AND sd.expires_after IS NULL
             AND NOT EXISTS (
               SELECT 1 FROM organization_memberships om
               JOIN system_organizations so ON so.organization_id = om.organization_id
               WHERE so.system_id = $1 AND so.expires_after IS NULL AND so.organization_id <> $2
                 AND om.user_id = sd.delegate_user_id AND om.expires_after IS NULL
             ) LIMIT 1"#,
        [id.into(), org_id.into()],
    )).await.map_err(db_err)?;
    if !orphans.is_empty() {
        return Err(AppError::Validation("Removing this organisation would leave delegates without a serving organisation; remove those delegates first.".to_string()));
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE system_organizations SET expires_after = now() WHERE system_id = $1 AND organization_id = $2 AND role = 'participant' AND expires_after IS NULL",
        [id.into(), org_id.into()],
    )).await.map_err(db_err)?;
    audit_system(db, session.user_id, "system_org_edge.participant_removed", id,
        json!({ "systemId": id, "organizationId": org_id })).await?;
    Ok(Json(json!({ "edges": edges_json(db, id).await? })))
}

// ── Owners / Assets ─────────────────────────────────────────────────────────

pub async fn remove_system_owner(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path((id, owner_id)): Path<(Uuid, Uuid)>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "SystemOwnerManage").await?;
    system_in_scope(db, &s, id).await?;
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, kind::TEXT AS kind FROM system_owners WHERE id = $1 AND system_id = $2 AND expires_after IS NULL LIMIT 1", [owner_id.into(), id.into()])).await.map_err(db_err)?;
    if rows.is_empty() { return Err(AppError::NotFound("System owner record not found.".to_string())); }
    let kind: String = rows[0].try_get("", "kind").unwrap_or_default();
    if kind == "primary" && owner_user(db, id, "backup").await?.is_none() {
        return Err(AppError::Validation("Cannot remove the primary owner — assign a backup owner first, or use PUT /admin/systems/:id to reassign.".to_string()));
    }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owners SET expires_after = now() WHERE id = $1", [owner_id.into()])).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owner_pa_mappings SET expires_after = now() WHERE system_owner_id = $1 AND expires_after IS NULL", [owner_id.into()])).await.map_err(db_err)?;
    Ok(Json(json!({ "message": "System owner removed successfully." })))
}

fn asset_json(r: &sea_orm::QueryResult) -> JsonValue {
    json!({
        "id": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
        "systemId": r.try_get::<Uuid>("", "system_id").unwrap_or(Uuid::nil()),
        "systemManaged": r.try_get::<bool>("", "system_managed").unwrap_or(false),
        "managementMode": r.try_get::<String>("", "management_mode").unwrap_or_else(|_| "api_managed".into()),
        "credentialType": r.try_get::<String>("", "credential_type").unwrap_or_default(),
        "hostname": r.try_get::<String>("", "hostname").unwrap_or_default(),
        "credentialName": r.try_get::<String>("", "credential_name").unwrap_or_default(),
        "description": r.try_get::<Option<String>>("", "description").unwrap_or(None),
        "service": r.try_get::<Option<String>>("", "service").unwrap_or(None),
        "expiresAfter": r.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>>("", "expires_after").unwrap_or(None).map(|t| t.to_rfc3339()),
    })
}

const ASSET_COLS: &str = "id, system_id, system_managed, management_mode::TEXT AS management_mode, credential_type::TEXT AS credential_type, hostname, credential_name, description, service, expires_after";

pub async fn list_system_assets(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "AssetRead").await?;
    system_in_scope(db, &s, id).await?;
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        &format!("SELECT {} FROM assets WHERE system_id = $1 ORDER BY hostname", ASSET_COLS), [id.into()])).await.map_err(db_err)?;
    Ok(Json(json!({ "assets": rows.iter().map(asset_json).collect::<Vec<_>>() })))
}

pub async fn create_system_asset(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>, Json(body): Json<JsonValue>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "AssetCreate").await?;
    system_in_scope(db, &s, id).await?;
    let hostname = body["hostname"].as_str().unwrap_or("").trim();
    let credential_name = body["credentialName"].as_str().unwrap_or("").trim();
    if hostname.is_empty() { return Err(AppError::Validation("hostname is required.".to_string())); }
    if credential_name.is_empty() { return Err(AppError::Validation("credentialName is required.".to_string())); }
    let ctype = body["credentialType"].as_str().unwrap_or("password");
    if !["password","token","device"].contains(&ctype) { return Err(AppError::Validation("credentialType must be one of: password, token, device.".to_string())); }
    let mode = body["managementMode"].as_str().unwrap_or("api_managed");
    if !["api_managed","manual"].contains(&mode) { return Err(AppError::Validation("managementMode must be one of: api_managed, manual.".to_string())); }
    let description = body["description"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    if description.as_ref().map(|d| d.chars().count() > 500).unwrap_or(false) { return Err(AppError::Validation("Asset description must be 500 characters or fewer.".to_string())); }
    let service = body["service"].as_str().filter(|s| !s.is_empty()).map(str::to_string);
    if mode == "api_managed" {
        let note = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT aws_role_arn_note FROM systems WHERE id = $1", [id.into()])).await.map_err(db_err)?;
        let has_note = note.first().and_then(|r| r.try_get::<Option<String>>("", "aws_role_arn_note").ok()).flatten().map(|s| !s.is_empty()).unwrap_or(false);
        if !has_note { return Err(AppError::Validation("This system has no AWS exchange configuration, so API-managed assets cannot be fulfilled. Declare the asset as manual, or configure the system's exchange first.".to_string())); }
    }
    let dup = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM assets WHERE system_id = $1 AND hostname = $2 AND credential_name = $3 AND service IS NOT DISTINCT FROM $4 AND expires_after IS NULL LIMIT 1",
        [id.into(), hostname.into(), credential_name.into(), service.clone().into()])).await.map_err(db_err)?;
    if !dup.is_empty() { return Err(AppError::Validation("An asset with this hostname and credential name already exists for this system.".to_string())); }
    let asset_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO assets (id, system_id, system_managed, management_mode, credential_type, hostname, credential_name, description, service, created_at, updated_at) VALUES ($1,$2,false,$3::asset_management_mode,$4,$5,$6,$7,$8,now(),now())",
        [asset_id.into(), id.into(), mode.into(), ctype.into(), hostname.into(), credential_name.into(), description.into(), service.into()])).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'asset.created','asset',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), asset_id.to_string().into(), json!({ "systemId": id, "hostname": hostname, "credentialName": credential_name }).into()])).await.map_err(db_err)?;
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, &format!("SELECT {} FROM assets WHERE id = $1", ASSET_COLS), [asset_id.into()])).await.map_err(db_err)?;
    Ok((axum::http::StatusCode::CREATED, Json(json!({ "asset": asset_json(&rows[0]) }))))
}

async fn asset_in_scope(db: &DatabaseConnection, s: &ScopeKind, asset_id: Uuid) -> Result<Uuid, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT system_id FROM assets WHERE id = $1 LIMIT 1", [asset_id.into()])).await.map_err(db_err)?;
    let system_id: Uuid = rows.first().and_then(|r| r.try_get("", "system_id").ok())
        .ok_or_else(|| AppError::NotFound("Asset not found.".to_string()))?;
    system_in_scope(db, s, system_id).await.map_err(|_| AppError::NotFound("Asset not found.".to_string()))?;
    Ok(system_id)
}

pub async fn update_system_asset(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path((path_system, asset_id)): Path<(Uuid, Uuid)>, Json(body): Json<JsonValue>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "AssetUpdate").await?;
    let real_system = asset_in_scope(db, &s, asset_id).await?;
    if real_system != path_system { return Err(AppError::NotFound("Asset not found for this system.".to_string())); }
    let obj = body.as_object().ok_or_else(|| AppError::Validation("Nothing to update.".to_string()))?;
    if obj.is_empty() { return Err(AppError::Validation("Nothing to update — only expiresAfter, managementMode, or description may change on an asset.".to_string())); }
    let allowed = ["expiresAfter","managementMode","description"];
    if obj.keys().any(|k| !allowed.contains(&k.as_str())) {
        return Err(AppError::Validation("Only expiresAfter (set to null), managementMode, or description may be updated on an asset — hostname/credentialName/credentialType are immutable.".to_string()));
    }
    if let Some(exp) = obj.get("expiresAfter") {
        if !exp.is_null() && !obj.contains_key("managementMode") && !obj.contains_key("description") {
            return Err(AppError::Validation("Only expiresAfter (set to null), managementMode, or description may be updated on an asset — hostname/credentialName/credentialType are immutable.".to_string()));
        }
    }
    let mode = obj.get("managementMode").and_then(|v| v.as_str());
    if let Some(m) = mode {
        if !["api_managed","manual"].contains(&m) { return Err(AppError::Validation("managementMode must be one of: api_managed, manual.".to_string())); }
        if m == "api_managed" {
            let note = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT aws_role_arn_note FROM systems WHERE id = $1", [real_system.into()])).await.map_err(db_err)?;
            let has_note = note.first().and_then(|r| r.try_get::<Option<String>>("", "aws_role_arn_note").ok()).flatten().map(|s| !s.is_empty()).unwrap_or(false);
            if !has_note { return Err(AppError::Validation("This system has no AWS exchange configuration, so API-managed assets cannot be fulfilled. Keep the asset manual, or configure the system's exchange first.".to_string())); }
        }
    }
    let description = if obj.contains_key("description") { Some(obj["description"].as_str().filter(|s| !s.is_empty()).map(str::to_string)) } else { None };
    if let Some(Some(d)) = &description { if d.chars().count() > 500 { return Err(AppError::Validation("Asset description must be 500 characters or fewer.".to_string())); } }
    let unexpire = obj.get("expiresAfter").map(|v| v.is_null()).unwrap_or(false);
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE assets SET management_mode = COALESCE($1::asset_management_mode, management_mode), description = CASE WHEN $2::boolean THEN $3 ELSE description END, expires_after = CASE WHEN $4::boolean THEN NULL ELSE expires_after END, updated_at = now() WHERE id = $5",
        [mode.into(), description.is_some().into(), description.flatten().into(), unexpire.into(), asset_id.into()])).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'asset.updated','asset',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), asset_id.to_string().into(), json!({ "systemId": real_system }).into()])).await.map_err(db_err)?;
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, &format!("SELECT {} FROM assets WHERE id = $1", ASSET_COLS), [asset_id.into()])).await.map_err(db_err)?;
    Ok(Json(json!({ "asset": asset_json(&rows[0]) })))
}

pub async fn delete_system_asset(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path((path_system, asset_id)): Path<(Uuid, Uuid)>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    let s = scope(db, session.user_id, "AssetDelete").await?;
    let real_system = asset_in_scope(db, &s, asset_id).await?;
    if real_system != path_system { return Err(AppError::NotFound("Asset not found for this system.".to_string())); }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE assets SET expires_after = now(), updated_at = now() WHERE id = $1", [asset_id.into()])).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'asset.invalidated','asset',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), asset_id.to_string().into(), json!({ "systemId": real_system }).into()])).await.map_err(db_err)?;
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, &format!("SELECT {} FROM assets WHERE id = $1", ASSET_COLS), [asset_id.into()])).await.map_err(db_err)?;
    Ok(Json(json!({ "asset": asset_json(&rows[0]) })))
}

pub async fn sync_system_assets(State(state): State<(Config, DatabaseConnection)>, Extension(session): Extension<Arc<Session>>, Path(id): Path<Uuid>) -> RouteResult<impl IntoResponse> {
    let db = &state.1;
    ensure_admin(db, session.user_id).await?;
    crate::auth::privileges::require_admin_privilege(db, session.user_id, "AssetSync").await?;
    let exists = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT aws_role_arn_note FROM systems WHERE id = $1 LIMIT 1", [id.into()])).await.map_err(db_err)?;
    let row = exists.first().ok_or_else(|| AppError::NotFound("System not found.".to_string()))?;
    if !asset_inventory::is_aws_integration_enabled(db).await? {
        return Err(AppError::Validation("The AWS integration is not enabled.".to_string()));
    }
    let note: Option<String> = row.try_get("", "aws_role_arn_note").unwrap_or(None);
    if note.map(|s| s.is_empty()).unwrap_or(true) {
        return Err(AppError::Validation("This system has no aws_role_arn_note configured — nothing to sync against.".to_string()));
    }
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, &format!("SELECT {} FROM assets WHERE system_id = $1 ORDER BY hostname", ASSET_COLS), [id.into()])).await.map_err(db_err)?;
    Ok(Json(json!({ "assets": rows.iter().map(asset_json).collect::<Vec<_>>() })))
}

// ── helpers ─────────────────────────────────────────────────────────────────

fn optional_text(body: &JsonValue, key: &str, label: &str) -> Result<Option<Option<String>>, AppError> {
    if !body.as_object().map(|o| o.contains_key(key)).unwrap_or(false) { return Ok(None); }
    let v = body[key].as_str().unwrap_or("");
    if v.chars().count() > 500 { return Err(AppError::Validation(format!("{} must be 500 characters or fewer.", label))); }
    Ok(Some(if v.is_empty() { None } else { Some(v.to_string()) }))
}

async fn declared_clusters(db: &DatabaseConnection, id: Uuid) -> Result<Vec<Uuid>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT cluster_id FROM system_vendor_clusters WHERE system_id = $1 AND expires_after IS NULL ORDER BY ordinal", [id.into()])).await.map_err(db_err)?;
    let mut out: Vec<Uuid> = rows.iter().filter_map(|r| r.try_get("", "cluster_id").ok()).collect();
    let agency = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, "SELECT agency_cluster_id FROM systems WHERE id = $1", [id.into()])).await.map_err(db_err)?;
    if let Some(a) = agency.first().and_then(|r| r.try_get::<Uuid>("", "agency_cluster_id").ok()) { out.push(a); }
    Ok(out)
}

async fn load_workflow(db: &DatabaseConnection, id: Uuid) -> Result<Vec<JsonValue>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT ordinal, cluster_id, level, step_kind::TEXT AS step_kind FROM system_workflow_steps WHERE system_id = $1 AND expires_after IS NULL ORDER BY ordinal", [id.into()])).await.map_err(db_err)?;
    Ok(rows.iter().map(|r| json!({ "ordinal": r.try_get::<i16>("", "ordinal").unwrap_or(0), "clusterId": r.try_get::<Uuid>("", "cluster_id").unwrap_or(Uuid::nil()), "level": r.try_get::<i16>("", "level").unwrap_or(0), "stepKind": r.try_get::<String>("", "step_kind").unwrap_or_else(|_| "hierarchical".into()) })).collect())
}

async fn replace_workflow_steps(db: &DatabaseConnection, id: Uuid, wf: &[JsonValue]) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_workflow_steps SET expires_after = now() WHERE system_id = $1 AND expires_after IS NULL", [id.into()])).await.map_err(db_err)?;
    for step in wf {
        let ordinal = step["ordinal"].as_i64().unwrap_or(1) as i16;
        let cid = step["clusterId"].as_str().and_then(|v| Uuid::parse_str(v).ok()).unwrap_or(Uuid::nil());
        let level = step["level"].as_i64().unwrap_or(1) as i16;
        let kind = step["stepKind"].as_str().unwrap_or("hierarchical");
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO system_workflow_steps (id, system_id, ordinal, cluster_id, level, step_kind, created_at) VALUES ($1,$2,$3,$4,$5,$6::step_kind,now())",
            [Uuid::now_v7().into(), id.into(), ordinal.into(), cid.into(), level.into(), kind.into()])).await.map_err(db_err)?;
    }
    Ok(())
}

async fn validate_cluster_refs(db: &DatabaseConnection, vendor_ids: &[Uuid], agency: Uuid) -> Result<(), AppError> {
    if vendor_ids.is_empty() { return Err(AppError::Validation("At least one vendor cluster is required.".to_string())); }
    for cid in vendor_ids {
        let cl = crate::db::clusters::get_live(db, *cid).await?;
        match cl { Some(c) if c.type_ == "vendor" => {}, Some(c) => return Err(AppError::Validation(format!("Cluster \"{}\" is not a vendor cluster.", c.name))), None => return Err(AppError::Validation(format!("Vendor cluster {} does not exist.", cid))) }
    }
    let ac = crate::db::clusters::get_live(db, agency).await?;
    match ac { Some(c) if c.type_ == "agency" => Ok(()), Some(c) => Err(AppError::Validation(format!("Cluster \"{}\" is not an agency cluster.", c.name))), None => Err(AppError::Validation("The specified agency cluster does not exist.".to_string())) }
}

async fn check_workflow(db: &DatabaseConnection, steps: &[JsonValue], vendor_ids: &[Uuid], agency: Uuid, system_id: Option<Uuid>) -> Result<(), AppError> {
    if steps.is_empty() { return Err(AppError::Validation("Invalid workflow: Workflow must have at least one step (the submitter).".to_string())); }
    let mut mapped: Vec<Uuid> = Vec::new();
    if let Some(sid) = system_id {
        let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT DISTINCT t.cluster_id FROM team_system_mappings m JOIN teams t ON t.id = m.team_id WHERE m.system_id = $1 AND m.expires_after IS NULL AND t.expires_after IS NULL", [sid.into()])).await.map_err(db_err)?;
        mapped.extend(rows.iter().filter_map(|r| r.try_get::<Uuid>("", "cluster_id").ok()));
        let existing = load_workflow(db, sid).await?;
        for s in existing { if let Some(c) = s["clusterId"].as_str().and_then(|v| Uuid::parse_str(v).ok()) { if !mapped.contains(&c) { mapped.push(c); } } }
    } else {
        mapped.extend(vendor_ids.iter().copied()); mapped.push(agency);
    }
    let mut sorted: Vec<&JsonValue> = steps.iter().collect();
    sorted.sort_by_key(|s| s["ordinal"].as_i64().unwrap_or(0));
    let submitter = sorted[0];
    let mut errors: Vec<String> = Vec::new();
    for (i, step) in sorted.iter().enumerate() {
        let ordinal = step["ordinal"].as_i64().unwrap_or(0);
        if ordinal != (i as i64 + 1) { errors.push(format!("Workflow ordinals must be contiguous starting at 1 (got {} at position {}).", ordinal, i + 1)); }
        let cid = step["clusterId"].as_str().and_then(|v| Uuid::parse_str(v).ok());
        let level = step["level"].as_i64().unwrap_or(0);
        let cid = match cid { Some(c) => c, None => { errors.push(format!("Step {} references unknown cluster.", ordinal)); continue; } };
        let cl = crate::db::clusters::get_live(db, cid).await?;
        let ctype = match cl { Some(c) => c.type_, None => { errors.push(format!("Step {} references unknown cluster {}.", ordinal, cid)); continue; } };
        if ctype == "pa" { errors.push(format!("Step {}: PA clusters cannot be part of the workflow.", ordinal)); }
        if ordinal > 1 {
            let sc = submitter["clusterId"].as_str().and_then(|v| Uuid::parse_str(v).ok()).unwrap_or(Uuid::nil());
            let sl = submitter["level"].as_i64().unwrap_or(0);
            if cid == sc && level == sl { errors.push(format!("Step {}: the submitter's own team/level cannot also be an approval step.", ordinal)); }
        }
        if ctype == "vendor" && !vendor_ids.contains(&cid) { errors.push(format!("Step {}: vendor cluster is not authorized for this system.", ordinal)); }
        if ctype == "agency" && cid != agency { errors.push(format!("Step {}: agency cluster does not match the system's agency cluster.", ordinal)); }
        if !mapped.contains(&cid) { errors.push(format!("Step {}: cluster must be mapped to the system before it can appear in the workflow.", ordinal)); }
        if !(1..=5).contains(&level) { errors.push(format!("Step {}: level must be between 1 and 5.", ordinal)); }
    }
    if errors.is_empty() { Ok(()) } else { Err(AppError::Validation(format!("Invalid workflow: {}", errors.join(" ")))) }
}

async fn owner_user(db: &DatabaseConnection, id: Uuid, kind: &str) -> Result<Option<Uuid>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT user_id FROM system_owners WHERE system_id = $1 AND kind = $2::system_owner_kind AND expires_after IS NULL LIMIT 1", [id.into(), kind.into()])).await.map_err(db_err)?;
    Ok(rows.first().and_then(|r| r.try_get("", "user_id").ok()))
}

async fn validate_owner(db: &DatabaseConnection, user_id: Uuid, label: &str) -> Result<(), AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT status::TEXT AS status, affiliation::TEXT AS affiliation FROM users WHERE id = $1 LIMIT 1", [user_id.into()])).await.map_err(db_err)?;
    let status: String = rows.first().and_then(|r| r.try_get("", "status").ok()).unwrap_or_default();
    let aff: String = rows.first().and_then(|r| r.try_get("", "affiliation").ok()).unwrap_or_default();
    if status != "active" { return Err(AppError::Validation(format!("{} owner must be an active user.", label))); }
    if aff != "agency" { return Err(AppError::Validation(format!("{} owner must have agency affiliation.", label))); }
    Ok(())
}

async fn replace_owner(db: &DatabaseConnection, id: Uuid, kind: &str, user_id: Option<Uuid>, actor: Uuid) -> Result<(), AppError> {
    let existing = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id FROM system_owners WHERE system_id = $1 AND kind = $2::system_owner_kind AND expires_after IS NULL LIMIT 1", [id.into(), kind.into()])).await.map_err(db_err)?;
    if let Some(r) = existing.first() {
        let oid: Uuid = r.try_get("", "id").unwrap();
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owners SET expires_after = now() WHERE id = $1", [oid.into()])).await.map_err(db_err)?;
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "UPDATE system_owner_pa_mappings SET expires_after = now() WHERE system_owner_id = $1 AND expires_after IS NULL", [oid.into()])).await.map_err(db_err)?;
    }
    if let Some(uid) = user_id {
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
            "INSERT INTO system_owners (id, system_id, user_id, kind, created_by, created_at) VALUES ($1,$2,$3,$4::system_owner_kind,$5,now())",
            [Uuid::now_v7().into(), id.into(), uid.into(), kind.into(), actor.into()])).await.map_err(db_err)?;
    }
    Ok(())
}

async fn system_full_json(db: &DatabaseConnection, id: Uuid) -> Result<JsonValue, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, short_code, name, description, agency_cluster_id, aws_role_arn_note FROM systems WHERE id = $1", [id.into()])).await.map_err(db_err)?;
    let r = rows.first().ok_or_else(|| AppError::NotFound("System not found.".to_string()))?;
    let primary = owner_user(db, id, "primary").await?;
    let backup = owner_user(db, id, "backup").await?;
    let vendors = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT cluster_id FROM system_vendor_clusters WHERE system_id = $1 AND expires_after IS NULL ORDER BY ordinal", [id.into()])).await.map_err(db_err)?;
    let custody = custody_configs(db, Some(id)).await?.remove(&id).unwrap_or_default();
    Ok(json!({
        "id": id, "shortCode": r.try_get::<String>("", "short_code").unwrap_or_default(),
        "name": r.try_get::<String>("", "name").unwrap_or_default(),
        "description": r.try_get::<Option<String>>("", "description").unwrap_or(None),
        "agencyClusterId": r.try_get::<Uuid>("", "agency_cluster_id").unwrap_or(Uuid::nil()),
        "awsRoleArnNote": r.try_get::<Option<String>>("", "aws_role_arn_note").unwrap_or(None),
        "primaryOwnerId": primary, "backupOwnerId": backup,
        "vendorClusterIds": vendors.iter().filter_map(|x| x.try_get::<Uuid>("", "cluster_id").ok()).collect::<Vec<_>>(),
        "workflowDefinition": load_workflow(db, id).await?,
        "custodyStageConfigs": custody,
    }))
}
