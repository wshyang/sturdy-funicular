// Team CRUD helpers.
// Importers/callers: routes/admin/teams.rs (GET /admin/teams, POST /admin/teams)
// Affected API: list_live_enriched, get_live, level_taken, name_taken_in_cluster, create
// Data schemas: teams(id, cluster_id, name, level, description, created_by, created_at, updated_at, expires_after)

use chrono::{DateTime, FixedOffset};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

use crate::errors::AppError;

#[derive(Debug, Clone)]
pub struct Team {
    pub id: Uuid,
    pub cluster_id: Uuid,
    pub name: String,
    pub level: i16,
    pub description: Option<String>,
    pub created_by: Uuid,
    pub created_at: DateTime<FixedOffset>,
    pub updated_at: DateTime<FixedOffset>,
    pub expires_after: Option<DateTime<FixedOffset>>,
}

#[derive(Debug, Clone)]
pub struct AdminTeamRow {
    pub team: Team,
    pub cluster_type: Option<String>,
    pub cluster_name: Option<String>,
    pub organization_id: Option<Uuid>,
}

#[derive(Debug, Clone)]
pub struct CreateTeamInput {
    pub id: Uuid,
    pub cluster_id: Uuid,
    pub name: String,
    pub level: i16,
    pub description: Option<String>,
    pub created_by: Uuid,
}

fn row_to_team(r: &sea_orm::QueryResult) -> Result<Team, AppError> {
    Ok(Team {
        id: r.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("row id: {}", e)))?,
        cluster_id: r.try_get("", "cluster_id").map_err(|e| AppError::Internal(anyhow::anyhow!("row cluster_id: {}", e)))?,
        name: r.try_get("", "name").map_err(|e| AppError::Internal(anyhow::anyhow!("row name: {}", e)))?,
        level: r.try_get("", "level").map_err(|e| AppError::Internal(anyhow::anyhow!("row level: {}", e)))?,
        description: r.try_get("", "description").map_err(|e| AppError::Internal(anyhow::anyhow!("row description: {}", e)))?,
        created_by: r.try_get("", "created_by").map_err(|e| AppError::Internal(anyhow::anyhow!("row created_by: {}", e)))?,
        created_at: r.try_get("", "created_at").map_err(|e| AppError::Internal(anyhow::anyhow!("row created_at: {}", e)))?,
        updated_at: r.try_get("", "updated_at").map_err(|e| AppError::Internal(anyhow::anyhow!("row updated_at: {}", e)))?,
        expires_after: r.try_get("", "expires_after").map_err(|e| AppError::Internal(anyhow::anyhow!("row expires_after: {}", e)))?,
    })
}

pub async fn list_live_enriched(db: &DatabaseConnection) -> Result<Vec<AdminTeamRow>, AppError> {
    let sql = r#"
        SELECT
            t.id, t.cluster_id, t.name, t.level, t.description,
            t.created_by, t.created_at, t.updated_at, t.expires_after,
            c."type"::text AS cluster_type,
            c.name AS cluster_name,
            c.organization_id
        FROM teams t
        LEFT JOIN clusters c ON c.id = t.cluster_id AND c.expires_after IS NULL
        WHERE t.expires_after IS NULL
        ORDER BY t.name
    "#;
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, sql, []))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB list_live_enriched teams: {}", e)))?;
    rows.iter()
        .map(|r| {
            let team = row_to_team(r)?;
            let cluster_type: Option<String> = r.try_get("", "cluster_type").ok();
            let cluster_name: Option<String> = r.try_get("", "cluster_name").ok();
            let organization_id: Option<Uuid> = r.try_get("", "organization_id").ok();
            Ok(AdminTeamRow { team, cluster_type, cluster_name, organization_id })
        })
        .collect()
}

pub async fn get_live(db: &DatabaseConnection, id: Uuid) -> Result<Option<Team>, AppError> {
    let sql = r#"SELECT id, cluster_id, name, level, description, created_by, created_at, updated_at, expires_after
                 FROM teams WHERE id = $1 AND expires_after IS NULL LIMIT 1"#;
    let rows = db
        .query_all(Statement::from_sql_and_values(DbBackend::Postgres, sql, [id.into()]))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB get_live team: {}", e)))?;
    rows.first().map(row_to_team).transpose()
}

pub async fn level_taken(db: &DatabaseConnection, cluster_id: Uuid, level: i16) -> Result<Option<String>, AppError> {
    let sql = "SELECT name FROM teams WHERE cluster_id = $1 AND level = $2 AND expires_after IS NULL LIMIT 1";
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres, sql,
            [cluster_id.into(), (level as i32).into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB level_taken: {}", e)))?;
    Ok(rows.first().and_then(|r| r.try_get::<String>("", "name").ok()))
}

pub async fn name_taken_in_cluster(db: &DatabaseConnection, cluster_id: Uuid, name: &str) -> Result<bool, AppError> {
    let sql = "SELECT 1 FROM teams WHERE cluster_id = $1 AND name = $2 AND expires_after IS NULL LIMIT 1";
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres, sql,
            [cluster_id.into(), name.to_string().into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB name_taken_in_cluster: {}", e)))?;
    Ok(!rows.is_empty())
}

pub async fn create(db: &DatabaseConnection, input: CreateTeamInput) -> Result<(), AppError> {
    let sql = r#"
        INSERT INTO teams (id, cluster_id, name, level, description, created_by)
        VALUES ($1, $2, $3, $4, $5, $6)
    "#;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        [
            input.id.into(),
            input.cluster_id.into(),
            input.name.into(),
            (input.level as i32).into(),
            input.description.into(),
            input.created_by.into(),
        ],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("DB create team: {}", e)))?;
    Ok(())
}
