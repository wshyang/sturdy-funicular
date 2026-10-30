//! Owner-plane self-service routes (legacy server/routes/owner.tsx).
//! GET /owner/systems, GET /owner/systems/:id/eligible-delegates,
//! POST/DELETE /owner/systems/:id/delegates, GET /owner/statistics.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::{
    extract::{Extension, Path, Query, State},
    http::{HeaderName, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    errors::{AppError, RouteResult},
};

type Db = DatabaseConnection;

async fn system_exists(db: &Db, system_id: Uuid) -> Result<bool, AppError> {
    Ok(db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM systems WHERE id=$1 AND expires_after IS NULL", [system_id.into()]))
        .await?.is_some())
}

async fn require_primary(db: &Db, system_id: Uuid, user_id: Uuid) -> Result<(), AppError> {
    if !system_exists(db, system_id).await? { return Err(AppError::NotFound("System not found.".into())); }
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT user_id FROM system_owners WHERE system_id=$1 AND kind='primary' AND expires_after IS NULL LIMIT 1",
        [system_id.into()])).await?;
    match row {
        Some(r) => { let uid: Uuid = r.try_get("", "user_id")?; if uid == user_id { Ok(()) } else { Err(AppError::NotFound("System not found.".into())) } }
        None => Err(AppError::NotFound("System not found.".into())),
    }
}

async fn linked_org_ids(db: &Db, system_id: Uuid) -> Result<Vec<Uuid>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT organization_id FROM system_organizations WHERE system_id=$1 AND expires_after IS NULL",
        [system_id.into()])).await?;
    Ok(rows.iter().filter_map(|r| r.try_get("", "organization_id").ok()).collect())
}

async fn owned_or_delegated_ids(db: &Db, user_id: Uuid) -> Result<Vec<Uuid>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, r#"
        SELECT system_id FROM system_owners WHERE user_id=$1 AND expires_after IS NULL
        UNION
        SELECT system_id FROM system_delegates WHERE delegate_user_id=$1 AND expires_after IS NULL
          AND (active_from IS NULL OR active_from <= now())
          AND (active_until IS NULL OR active_until > now())
    "#, [user_id.into()])).await?;
    let mut ids: Vec<Uuid> = rows.iter().filter_map(|r| r.try_get("", "system_id").ok()).collect();
    ids.sort(); ids.dedup();
    Ok(ids)
}

fn uuid_list(ids: &[Uuid]) -> String {
    if ids.is_empty() { "NULL".into() } else { ids.iter().map(|id| format!("'{id}'")).collect::<Vec<_>>().join(",") }
}

pub async fn get_owner_systems(
    State((_config, db)): State<(Config, Db)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<Response> {
    let user_id = session.user_id;
    let mut queries = 0usize;
    let system_ids = owned_or_delegated_ids(&db, user_id).await?; queries += 1;
    if system_ids.is_empty() {
        return Ok((StatusCode::OK, [(HeaderName::from_static("x-query-count"), queries.to_string())], Json(json!({"systems": []}))).into_response());
    }
    let list = uuid_list(&system_ids);
    let system_rows = db.query_all(Statement::from_string(DbBackend::Postgres, format!(
        "SELECT id, short_code, name, description, created_at FROM systems WHERE id IN ({list}) AND expires_after IS NULL ORDER BY created_at"))).await?; queries += 1;
    let owner_rows = db.query_all(Statement::from_string(DbBackend::Postgres, format!(
        "SELECT id, system_id, user_id, kind::text AS kind FROM system_owners WHERE system_id IN ({list}) AND expires_after IS NULL"))).await?; queries += 1;
    let delegate_rows = db.query_all(Statement::from_string(DbBackend::Postgres, format!(
        "SELECT id, system_id, owner_id, delegate_user_id, created_at, active_from, active_until FROM system_delegates WHERE system_id IN ({list}) AND expires_after IS NULL ORDER BY created_at"))).await?; queries += 1;
    let mut user_ids: HashSet<Uuid> = HashSet::new();
    for r in owner_rows.iter().chain(delegate_rows.iter()) {
        if let Ok(uid) = r.try_get::<Uuid>("", "user_id") { user_ids.insert(uid); }
        if let Ok(uid) = r.try_get::<Uuid>("", "delegate_user_id") { user_ids.insert(uid); }
    }
    let mut user_by_id: HashMap<Uuid, JsonValue> = HashMap::new();
    if !user_ids.is_empty() {
        let ul = uuid_list(&user_ids.into_iter().collect::<Vec<_>>());
        let user_rows = db.query_all(Statement::from_string(DbBackend::Postgres, format!(
            "SELECT id, full_name, email FROM users WHERE id IN ({ul})"))).await?; queries += 1;
        for r in user_rows {
            let id: Uuid = r.try_get("", "id")?;
            user_by_id.insert(id, json!({"id": id, "fullName": r.try_get::<String>("", "full_name")?, "email": r.try_get::<String>("", "email")?}));
        }
    }
    let mut result = Vec::new();
    for s in system_rows {
        let sid: Uuid = s.try_get("", "id")?;
        let owners: Vec<&sea_orm::QueryResult> = owner_rows.iter().filter(|o| o.try_get::<Uuid>("", "system_id").ok() == Some(sid)).collect();
        let my_owner = owners.iter().find(|o| o.try_get::<Uuid>("", "user_id").ok() == Some(user_id));
        let user_role = match my_owner { Some(o) => if o.try_get::<String>("", "kind").ok().as_deref() == Some("primary") { "primary_owner" } else { "backup_owner" }, None => "delegate" };
        let primary = owners.iter().find(|o| o.try_get::<String>("", "kind").ok().as_deref() == Some("primary")).and_then(|o| o.try_get::<Uuid>("", "user_id").ok()).and_then(|id| user_by_id.get(&id).cloned()).unwrap_or(JsonValue::Null);
        let backup = owners.iter().find(|o| o.try_get::<String>("", "kind").ok().as_deref() == Some("backup")).and_then(|o| o.try_get::<Uuid>("", "user_id").ok()).and_then(|id| user_by_id.get(&id).cloned()).unwrap_or(JsonValue::Null);
        let delegates: Vec<JsonValue> = delegate_rows.iter().filter(|d| d.try_get::<Uuid>("", "system_id").ok() == Some(sid)).filter_map(|d| {
            let uid: Uuid = d.try_get("", "delegate_user_id").ok()?;
            let u = user_by_id.get(&uid)?;
            Some(json!({"id": d.try_get::<Uuid>("", "id").ok()?, "delegateUserId": uid, "fullName": u["fullName"], "email": u["email"], "ownerId": d.try_get::<Uuid>("", "owner_id").ok()?, "createdAt": d.try_get::<chrono::DateTime<chrono::Utc>>("", "created_at").ok()?, "activeFrom": d.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", "active_from").ok().flatten(), "activeUntil": d.try_get::<Option<chrono::DateTime<chrono::Utc>>>("", "active_until").ok().flatten()}))
        }).collect();
        result.push(json!({"id": sid, "shortCode": s.try_get::<String>("", "short_code")?, "name": s.try_get::<String>("", "name")?, "description": s.try_get::<Option<String>>("", "description").ok().flatten(), "userRole": user_role, "primaryOwner": primary, "backupOwner": backup, "delegates": delegates, "createdAt": s.try_get::<chrono::DateTime<chrono::Utc>>("", "created_at")?}));
    }
    Ok((StatusCode::OK, [(HeaderName::from_static("x-query-count"), queries.to_string())], Json(json!({"systems": result}))).into_response())
}

pub async fn get_eligible_delegates(
    State((_config, db)): State<(Config, Db)>,
    Extension(session): Extension<Arc<Session>>,
    Path(system_id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    require_primary(&db, system_id, session.user_id).await?;
    let orgs = linked_org_ids(&db, system_id).await?;
    if orgs.is_empty() { return Ok(Json(json!({"users": []}))); }
    let org_list = uuid_list(&orgs);
    let rows = db.query_all(Statement::from_string(DbBackend::Postgres, format!(r#"
        SELECT DISTINCT u.id, u.full_name, u.email, u.affiliation::text AS affiliation
        FROM users u
        JOIN organization_memberships om ON om.user_id=u.id AND om.expires_after IS NULL
        WHERE u.status='active' AND u.affiliation='agency' AND om.organization_id IN ({org_list})
          AND u.id NOT IN (SELECT user_id FROM system_owners WHERE system_id='{system_id}' AND expires_after IS NULL)
          AND u.id NOT IN (SELECT delegate_user_id FROM system_delegates WHERE system_id='{system_id}' AND expires_after IS NULL)
        ORDER BY u.full_name
    "#))).await?;
    let users: Vec<JsonValue> = rows.iter().map(|r| json!({"id": r.try_get::<Uuid>("", "id").unwrap(), "fullName": r.try_get::<String>("", "full_name").unwrap_or_default(), "email": r.try_get::<String>("", "email").unwrap_or_default(), "affiliation": r.try_get::<String>("", "affiliation").unwrap_or_default()})).collect();
    Ok(Json(json!({"users": users})))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddDelegateBody {
    delegate_user_id: Option<String>,
    active_from: Option<String>,
    active_until: Option<String>,
}

pub async fn post_system_delegate(
    State((_config, db)): State<(Config, Db)>,
    Extension(session): Extension<Arc<Session>>,
    Path(system_id): Path<Uuid>,
    Json(body): Json<AddDelegateBody>,
) -> RouteResult<impl IntoResponse> {
    let owner_id = session.user_id;
    require_primary(&db, system_id, owner_id).await?;
    let delegate_id: Uuid = body.delegate_user_id.as_deref().unwrap_or("").parse()
        .map_err(|_| AppError::validation("Delegate must be an active user."))?;
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT id, full_name, email, affiliation::text AS affiliation, status::text AS status FROM users WHERE id=$1",
        [delegate_id.into()])).await?;
    let row = match row { Some(r) => r, None => return Err(AppError::validation("Delegate must be an active user.")) };
    let status: String = row.try_get("", "status")?;
    if status != "active" { return Err(AppError::validation("Delegate must be an active user.")); }
    if delegate_id == owner_id { return Err(AppError::validation("You cannot delegate to yourself.")); }
    let is_owner = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM system_owners WHERE system_id=$1 AND user_id=$2 AND expires_after IS NULL",
        [system_id.into(), delegate_id.into()])).await?.is_some();
    if is_owner { return Err(AppError::validation("This user is already an owner of the system.")); }
    let existing = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT 1 FROM system_delegates WHERE system_id=$1 AND delegate_user_id=$2 AND expires_after IS NULL",
        [system_id.into(), delegate_id.into()])).await?.is_some();
    if existing { return Err(AppError::validation("This user is already a delegate for this system.")); }
    let affiliation: String = row.try_get("", "affiliation")?;
    let orgs = linked_org_ids(&db, system_id).await?;
    let member = if orgs.is_empty() { false } else {
        db.query_one(Statement::from_string(DbBackend::Postgres, format!(
            "SELECT 1 FROM organization_memberships WHERE user_id='{delegate_id}' AND expires_after IS NULL AND organization_id IN ({}) LIMIT 1", uuid_list(&orgs)))).await?.is_some()
    };
    if affiliation != "agency" || !member {
        return Err(AppError::validation("Delegate must be an agency user with membership in the same organisation as the system."));
    }
    let id = Uuid::now_v7();
    let active_from = body.active_from.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&chrono::Utc));
    let active_until = body.active_until.as_deref().and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()).map(|d| d.with_timezone(&chrono::Utc));
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO system_delegates (id, system_id, owner_id, delegate_user_id, active_from, active_until) VALUES ($1,$2,$3,$4,$5,$6)",
        [id.into(), system_id.into(), owner_id.into(), delegate_id.into(), active_from.into(), active_until.into()])).await?;
    let full_name: String = row.try_get("", "full_name")?;
    let email: String = row.try_get("", "email")?;
    crate::audit::write_audit_log(&db, owner_id, "system_delegate.added", "system_delegate", &id.to_string(), None,
        json!({"systemId": system_id, "delegate_name": full_name, "delegate_email": email}), None).await?;
    crate::notifications::notify_trigger(&db, "system_delegate.added", &[email.clone()], "system_delegate", id).await?;
    Ok((StatusCode::CREATED, Json(json!({"delegate": {"id": id, "delegateUserId": delegate_id, "fullName": full_name, "email": email, "affiliation": affiliation, "ownerId": owner_id, "activeFrom": active_from, "activeUntil": active_until}}))))
}

pub async fn delete_system_delegate(
    State((_config, db)): State<(Config, Db)>,
    Extension(session): Extension<Arc<Session>>,
    Path((system_id, delegate_id)): Path<(Uuid, Uuid)>,
) -> RouteResult<impl IntoResponse> {
    let owner_id = session.user_id;
    require_primary(&db, system_id, owner_id).await?;
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT delegate_user_id FROM system_delegates WHERE id=$1 AND system_id=$2 AND expires_after IS NULL",
        [delegate_id.into(), system_id.into()])).await?;
    let row = match row { Some(r) => r, None => return Err(AppError::NotFound("Delegate not found for this system.".into())) };
    let delegate_user_id: Uuid = row.try_get("", "delegate_user_id")?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "UPDATE system_delegates SET expires_after=now() WHERE id=$1", [delegate_id.into()])).await?;
    let user = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT full_name, email FROM users WHERE id=$1", [delegate_user_id.into()])).await?;
    let (name, email) = match user { Some(u) => (u.try_get::<String>("", "full_name").unwrap_or_default(), u.try_get::<String>("", "email").unwrap_or_default()), None => ("Unknown".into(), String::new()) };
    crate::audit::write_audit_log(&db, owner_id, "system_delegate.removed", "system_delegate", &delegate_id.to_string(), None,
        json!({"systemId": system_id, "delegate_name": name, "delegate_email": email}), None).await?;
    if !email.is_empty() { crate::notifications::notify_trigger(&db, "system_delegate.removed", &[email], "system_delegate", delegate_id).await?; }
    Ok(Json(json!({"message": "Delegate removed successfully."})))
}

#[derive(Deserialize)]
pub struct StatisticsParams { from: Option<String>, to: Option<String>, system_id: Option<String> }

pub async fn get_owner_statistics(
    State((_config, db)): State<(Config, Db)>,
    Extension(session): Extension<Arc<Session>>,
    Query(params): Query<StatisticsParams>,
) -> RouteResult<impl IntoResponse> {
    let from = params.from.as_deref().unwrap_or("");
    let to = params.to.as_deref().unwrap_or("");
    if from.is_empty() || to.is_empty() { return Err(AppError::validation("from and to are required.")); }
    let from_dt = chrono::DateTime::parse_from_rfc3339(from).map_err(|_| AppError::validation("Invalid date range."))?;
    let to_dt = chrono::DateTime::parse_from_rfc3339(to).map_err(|_| AppError::validation("Invalid date range."))?;
    if to_dt <= from_dt { return Err(AppError::validation("Invalid date range.")); }
    let system_ids = owned_or_delegated_ids(&db, session.user_id).await?;
    if system_ids.is_empty() { return Ok(Json(json!({"mode":"by_system","systemId":JsonValue::Null,"from":from,"to":to,"data":[]}))); }
    if let Some(sid) = params.system_id.as_deref() {
        let sid: Uuid = sid.parse().map_err(|_| AppError::NotFound("System not found.".to_string()))?;
        if !system_ids.contains(&sid) { return Err(AppError::NotFound("System not found.".into())); }
        let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, r#"
            SELECT COALESCE(rci.hostname, a.hostname) AS id, COALESCE(rci.hostname, a.hostname) AS label, COUNT(DISTINCT r.id)::int AS count
            FROM breakglass_requests r
            JOIN request_credential_items rci ON rci.request_id=r.id
            LEFT JOIN assets a ON a.id=rci.asset_id
            WHERE r.system_id=$1 AND r.created_at >= $2 AND r.created_at < $3
            GROUP BY COALESCE(rci.hostname, a.hostname) ORDER BY count DESC
        "#, [sid.into(), from_dt.with_timezone(&chrono::Utc).into(), to_dt.with_timezone(&chrono::Utc).into()])).await?;
        let data: Vec<JsonValue> = rows.iter().map(|r| json!({"id": r.try_get::<Option<String>>("", "id").ok().flatten(), "label": r.try_get::<Option<String>>("", "label").ok().flatten(), "count": r.try_get::<i32>("", "count").unwrap_or(0)})).collect();
        return Ok(Json(json!({"mode":"by_hostname","systemId":sid,"from":from,"to":to,"data":data})));
    }
    let list = uuid_list(&system_ids);
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, &format!(r#"
        SELECT s.id, s.name AS label, COUNT(r.id)::int AS count
        FROM breakglass_requests r JOIN systems s ON s.id=r.system_id
        WHERE r.system_id IN ({list}) AND r.created_at >= $1 AND r.created_at < $2
        GROUP BY s.id, s.name ORDER BY count DESC
    "#), [from_dt.with_timezone(&chrono::Utc).into(), to_dt.with_timezone(&chrono::Utc).into()])).await?;
    let data: Vec<JsonValue> = rows.iter().map(|r| json!({"id": r.try_get::<Uuid>("", "id").unwrap(), "label": r.try_get::<String>("", "label").unwrap_or_default(), "count": r.try_get::<i32>("", "count").unwrap_or(0)})).collect();
    Ok(Json(json!({"mode":"by_system","systemId":JsonValue::Null,"from":from,"to":to,"data":data})))
}
