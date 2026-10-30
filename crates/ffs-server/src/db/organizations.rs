// Organization CRUD helpers.
// Importers: routes/admin/organizations.rs (list_live, name_exists_live, short_code_exists_live, create, get_live),
//            routes/admin/clusters.rs (org_is_live, find_live_orgs_by_ids).
// Affected API: GET /admin/organizations, POST /admin/organizations.
// Schema: organizations(id UUID, name TEXT, short_code VARCHAR(10), created_by UUID,
//          created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, expires_after TIMESTAMPTZ).

use chrono::{DateTime, FixedOffset};
use serde_json::Value as JsonValue;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

use crate::errors::AppError;

#[derive(Debug, Clone)]
pub struct Organization {
    pub id: Uuid,
    pub name: String,
    pub short_code: String,
    pub created_by: Uuid,
    pub created_at: DateTime<FixedOffset>,
    pub updated_at: DateTime<FixedOffset>,
    pub expires_after: Option<DateTime<FixedOffset>>,
}

const SELECT_COLS: &str =
    "id, name, short_code, created_by, created_at, updated_at, expires_after";

fn row_to_org(r: &sea_orm::QueryResult) -> Result<Organization, AppError> {
    Ok(Organization {
        id: r.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("row id: {}", e)))?,
        name: r.try_get("", "name").map_err(|e| AppError::Internal(anyhow::anyhow!("row name: {}", e)))?,
        short_code: r.try_get("", "short_code").map_err(|e| AppError::Internal(anyhow::anyhow!("row short_code: {}", e)))?,
        created_by: r.try_get("", "created_by").map_err(|e| AppError::Internal(anyhow::anyhow!("row created_by: {}", e)))?,
        created_at: r.try_get("", "created_at").map_err(|e| AppError::Internal(anyhow::anyhow!("row created_at: {}", e)))?,
        updated_at: r.try_get("", "updated_at").map_err(|e| AppError::Internal(anyhow::anyhow!("row updated_at: {}", e)))?,
        expires_after: r.try_get("", "expires_after").map_err(|e| AppError::Internal(anyhow::anyhow!("row expires_after: {}", e)))?,
    })
}

pub async fn list_live(db: &DatabaseConnection) -> Result<Vec<Organization>, AppError> {
    let sql = format!(
        "SELECT {} FROM organizations WHERE expires_after IS NULL ORDER BY name",
        SELECT_COLS
    );
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, &sql, []))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    rows.iter().map(row_to_org).collect()
}

pub async fn get_live(db: &DatabaseConnection, id: Uuid) -> Result<Option<Organization>, AppError> {
    let sql = format!(
        "SELECT {} FROM organizations WHERE id = $1 AND expires_after IS NULL LIMIT 1",
        SELECT_COLS
    );
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, &sql, [id.into()]))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    rows.first().map(row_to_org).transpose()
}

pub async fn name_exists_live(db: &DatabaseConnection, name: &str) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM organizations WHERE lower(name) = lower($1) AND expires_after IS NULL LIMIT 1",
            [name.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    Ok(!rows.is_empty())
}

pub async fn short_code_exists_live(db: &DatabaseConnection, short_code: &str) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM organizations WHERE short_code = $1 AND expires_after IS NULL LIMIT 1",
            [short_code.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    Ok(!rows.is_empty())
}

pub struct CreateOrgInput {
    pub id: Uuid,
    pub name: String,
    pub short_code: String,
    pub created_by: Uuid,
}

pub async fn create(db: &DatabaseConnection, input: CreateOrgInput) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO organizations (id, name, short_code, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())"#,
        [
            input.id.into(),
            input.name.into(),
            input.short_code.into(),
            input.created_by.into(),
        ],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("DB insert org: {}", e)))?;
    Ok(())
}

/// Soft-delete an organization by setting expires_after = now().
pub async fn expire(db: &DatabaseConnection, id: Uuid) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE organizations SET expires_after = now(), updated_at = now() WHERE id = $1 AND expires_after IS NULL",
        [id.into()],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("DB expire org: {}", e)))?;
    Ok(())
}

/// Returns true if the organization exists and is not soft-deleted.
pub async fn org_is_live(db: &DatabaseConnection, org_id: Uuid) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 FROM organizations WHERE id = $1 AND expires_after IS NULL LIMIT 1"#,
            [org_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    Ok(!rows.is_empty())
}

/// From a list of org IDs, return only those that are live.
pub async fn find_live_orgs_by_ids(
    db: &DatabaseConnection,
    ids: &[Uuid],
) -> Result<Vec<Uuid>, AppError> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let placeholders: Vec<String> = (1..=ids.len()).map(|i| format!("${}", i)).collect();
    let sql = format!(
        "SELECT id FROM organizations WHERE id IN ({}) AND expires_after IS NULL",
        placeholders.join(", ")
    );
    let values: Vec<sea_orm::Value> = ids.iter().map(|id| (*id).into()).collect();
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, &sql, values))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    rows.iter()
        .map(|r| {
            r.try_get::<Uuid>("", "id")
                .map_err(|e| AppError::Internal(anyhow::anyhow!("row id: {}", e)))
        })
        .collect()
}


pub async fn audit<C: ConnectionTrait>(
    db: &C, actor: Uuid, action: &str, target_id: Uuid, target_type: &str, details: JsonValue,
) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4::audit_target_type,$5,$6)",
        [Uuid::now_v7().into(), actor.into(), action.into(), target_type.into(), target_id.into(), details.into()],
    )).await?;
    Ok(())
}

pub async fn live_member_count<C: ConnectionTrait>(db: &C, org_id: Uuid) -> Result<i64, AppError> {
    let row = db.query_one(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT COUNT(*) AS n FROM organization_memberships WHERE organization_id = $1 AND expires_after IS NULL",
        [org_id.into()],
    )).await?.ok_or_else(|| AppError::Internal(anyhow::anyhow!("member count")))?;
    Ok(row.try_get::<i64>("", "n").unwrap_or(0))
}

pub async fn live_cluster_count<C: ConnectionTrait>(db: &C, org_id: Uuid) -> Result<i64, AppError> {
    let row = db.query_one(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT COUNT(*) AS n FROM clusters WHERE organization_id = $1 AND expires_after IS NULL",
        [org_id.into()],
    )).await?.ok_or_else(|| AppError::Internal(anyhow::anyhow!("cluster count")))?;
    Ok(row.try_get::<i64>("", "n").unwrap_or(0))
}

pub async fn live_system_edge_count<C: ConnectionTrait>(db: &C, org_id: Uuid) -> Result<i64, AppError> {
    let row = db.query_one(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT COUNT(*) AS n FROM system_organizations WHERE organization_id = $1 AND expires_after IS NULL",
        [org_id.into()],
    )).await?.ok_or_else(|| AppError::Internal(anyhow::anyhow!("edge count")))?;
    Ok(row.try_get::<i64>("", "n").unwrap_or(0))
}

pub async fn member_is_live<C: ConnectionTrait>(db: &C, org_id: Uuid, user_id: Uuid) -> Result<bool, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM organization_memberships WHERE organization_id = $1 AND user_id = $2 AND expires_after IS NULL LIMIT 1",
        [org_id.into(), user_id.into()],
    )).await?;
    Ok(!rows.is_empty())
}
