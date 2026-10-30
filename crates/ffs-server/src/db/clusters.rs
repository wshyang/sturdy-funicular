// Cluster CRUD helpers.

use chrono::{DateTime, FixedOffset};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, Value};
use uuid::Uuid;

use crate::errors::AppError;

#[derive(Debug, Clone)]
pub struct Cluster {
    pub id: Uuid,
    pub name: String,
    pub type_: String,
    pub description: Option<String>,
    pub organization_id: Uuid,
    pub created_by: Uuid,
    pub created_at: DateTime<FixedOffset>,
    pub updated_at: DateTime<FixedOffset>,
    pub expires_after: Option<DateTime<FixedOffset>>,
}

const SELECT_COLS: &str = r#"
    id, name, "type"::text AS cluster_type, description,
    organization_id, created_by, created_at, updated_at, expires_after
"#;

fn row_to_cluster(r: &sea_orm::QueryResult) -> Result<Cluster, AppError> {
    Ok(Cluster {
        id: r.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("row id: {}", e)))?,
        name: r.try_get("", "name").map_err(|e| AppError::Internal(anyhow::anyhow!("row name: {}", e)))?,
        type_: r.try_get("", "cluster_type").map_err(|e| AppError::Internal(anyhow::anyhow!("row cluster_type: {}", e)))?,
        description: r.try_get("", "description").map_err(|e| AppError::Internal(anyhow::anyhow!("row description: {}", e)))?,
        organization_id: r.try_get("", "organization_id").map_err(|e| AppError::Internal(anyhow::anyhow!("row org_id: {}", e)))?,
        created_by: r.try_get("", "created_by").map_err(|e| AppError::Internal(anyhow::anyhow!("row created_by: {}", e)))?,
        created_at: r.try_get("", "created_at").map_err(|e| AppError::Internal(anyhow::anyhow!("row created_at: {}", e)))?,
        updated_at: r.try_get("", "updated_at").map_err(|e| AppError::Internal(anyhow::anyhow!("row updated_at: {}", e)))?,
        expires_after: r.try_get("", "expires_after").map_err(|e| AppError::Internal(anyhow::anyhow!("row expires_after: {}", e)))?,
    })
}

pub async fn list_live(db: &DatabaseConnection) -> Result<Vec<Cluster>, AppError> {
    let sql = format!("SELECT {} FROM clusters WHERE expires_after IS NULL ORDER BY name", SELECT_COLS);
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, &sql, []))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    rows.iter().map(row_to_cluster).collect()
}

pub async fn get_live<C: ConnectionTrait>(db: &C, id: Uuid) -> Result<Option<Cluster>, AppError> {
    let sql = format!("SELECT {} FROM clusters WHERE id = $1 AND expires_after IS NULL LIMIT 1", SELECT_COLS);
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, &sql, [id.into()]))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    rows.first().map(row_to_cluster).transpose()
}

/// Check whether a live cluster with the given (name, type) pair exists.
/// Pass `exclude_id` to skip a specific cluster (for update uniqueness checks).
pub async fn name_type_exists<C: ConnectionTrait>(
    db: &C,
    name: &str,
    cluster_type: &str,
    exclude_id: Option<Uuid>,
) -> Result<bool, AppError> {
    let rows = match exclude_id {
        Some(exc) => db.query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 FROM clusters
               WHERE name = $1 AND "type" = $2::cluster_type AND expires_after IS NULL AND id != $3
               LIMIT 1"#,
            [name.into(), cluster_type.into(), exc.into()],
        )).await,
        None => db.query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 FROM clusters
               WHERE name = $1 AND "type" = $2::cluster_type AND expires_after IS NULL
               LIMIT 1"#,
            [name.into(), cluster_type.into()],
        )).await,
    };
    let rows = rows.map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    Ok(!rows.is_empty())
}

/// Return all live clusters of a given type string.
pub async fn find_live_by_type(db: &DatabaseConnection, cluster_type: &str) -> Result<Vec<Cluster>, AppError> {
    let sql = format!(
        r#"SELECT {} FROM clusters WHERE "type" = $1::cluster_type AND expires_after IS NULL ORDER BY name"#,
        SELECT_COLS
    );
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, &sql, [cluster_type.into()]))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    rows.iter().map(row_to_cluster).collect()
}

pub struct CreateClusterInput {
    pub id: Uuid,
    pub name: String,
    pub type_: String,
    pub description: Option<String>,
    pub organization_id: Uuid,
    pub created_by: Uuid,
}

pub async fn create<C: ConnectionTrait>(db: &C, input: CreateClusterInput) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO clusters (id, name, "type", description, organization_id, created_by, created_at, updated_at)
           VALUES ($1, $2, $3::cluster_type, $4, $5, $6, now(), now())"#,
        [
            input.id.into(),
            input.name.into(),
            input.type_.into(),
            input.description.into(),
            input.organization_id.into(),
            input.created_by.into(),
        ],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("DB create cluster: {}", e)))?;
    Ok(())
}

/// Update only the fields that are Some. `description: Some(None)` = set to NULL.
pub async fn update(
    db: &DatabaseConnection,
    id: Uuid,
    name: Option<String>,
    description: Option<Option<String>>,
    org_id: Option<Uuid>,
) -> Result<(), AppError> {
    let mut sets: Vec<String> = vec!["updated_at = now()".to_string()];
    let mut values: Vec<Value> = vec![];
    let mut p = 1usize;

    if let Some(n) = name {
        sets.push(format!("name = ${}", p));
        values.push(n.into());
        p += 1;
    }
    if let Some(d) = description {
        sets.push(format!("description = ${}", p));
        match d {
            Some(s) => values.push(s.into()),
            None => values.push(Value::String(None)),
        }
        p += 1;
    }
    if let Some(o) = org_id {
        sets.push(format!("organization_id = ${}", p));
        values.push(o.into());
        p += 1;
    }

    values.push(id.into());
    let sql = format!(
        "UPDATE clusters SET {} WHERE id = ${} AND expires_after IS NULL",
        sets.join(", "),
        p
    );
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, &sql, values))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB update cluster: {}", e)))?;
    Ok(())
}

/// Soft-delete: set expires_after = now().
pub async fn invalidate(db: &DatabaseConnection, id: Uuid) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE clusters SET expires_after = now(), updated_at = now() WHERE id = $1"#,
        [id.into()],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("DB invalidate cluster: {}", e)))?;
    Ok(())
}

/// Count live teams belonging to a cluster.
pub async fn count_teams(db: &DatabaseConnection, cluster_id: Uuid) -> Result<i64, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT COUNT(*)::bigint AS cnt FROM teams WHERE cluster_id = $1 AND expires_after IS NULL"#,
            [cluster_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB count teams: {}", e)))?;
    Ok(rows.first().and_then(|r| r.try_get::<i64>("", "cnt").ok()).unwrap_or(0))
}
