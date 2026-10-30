//! Team↔System mapping auto-sync (addendum-127 / addendum-205).
//! Re-materializes `team_system_mappings` from a saved workflow definition.
//! Admin-plane only; runtime authorization derives workflow ⋈ live teams.

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::errors::AppError;

fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB error: {}", e))
}

#[derive(Debug, Default)]
pub struct MappingSyncReport {
    pub created_ids: Vec<Uuid>,
    pub invalidated_ids: Vec<Uuid>,
    pub retained_team_ids: Vec<Uuid>,
    pub unresolvable_steps: Vec<(Uuid, i16)>,
}

pub async fn sync_mappings_for_system<C: ConnectionTrait>(
    db: &C,
    system_id: Uuid,
    definition: &[JsonValue],
    actor_user_id: Uuid,
) -> Result<MappingSyncReport, AppError> {
    let mut report = MappingSyncReport::default();
    let mut desired: Vec<Uuid> = Vec::new();
    let mut seen_steps: Vec<(Uuid, i16)> = Vec::new();

    for step in definition {
        let cluster_id = match step["clusterId"].as_str().and_then(|s| Uuid::parse_str(s).ok()) {
            Some(id) => id,
            None => continue,
        };
        let level = step["level"].as_i64().unwrap_or(0) as i16;
        if seen_steps.contains(&(cluster_id, level)) {
            continue;
        }
        seen_steps.push((cluster_id, level));
        let rows = db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT id FROM teams WHERE cluster_id = $1 AND level = $2 AND expires_after IS NULL LIMIT 1",
                [cluster_id.into(), level.into()],
            ))
            .await
            .map_err(db_err)?;
        match rows.first() {
            Some(r) => {
                let team_id: Uuid = r.try_get("", "id").map_err(db_err)?;
                if !desired.contains(&team_id) {
                    desired.push(team_id);
                }
            }
            None => report.unresolvable_steps.push((cluster_id, level)),
        }
    }

    let current = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id, team_id FROM team_system_mappings WHERE system_id = $1 AND expires_after IS NULL",
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    let current_team_ids: Vec<Uuid> = current
        .iter()
        .filter_map(|r| r.try_get::<Uuid>("", "team_id").ok())
        .collect();

    for team_id in &desired {
        if current_team_ids.contains(team_id) {
            continue;
        }
        let mapping_id = Uuid::now_v7();
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO team_system_mappings (id, team_id, system_id, created_by, created_at) VALUES ($1,$2,$3,$4,now())",
            [mapping_id.into(), (*team_id).into(), system_id.into(), actor_user_id.into()],
        ))
        .await
        .map_err(db_err)?;
        audit(db, actor_user_id, "team_system_mapping.created", mapping_id,
            json!({ "teamId": team_id, "systemId": system_id, "via": "workflow_save_auto_sync" })).await?;
        report.created_ids.push(mapping_id);
    }

    let surplus: Vec<(Uuid, Uuid)> = current
        .iter()
        .filter_map(|r| {
            let id: Uuid = r.try_get("", "id").ok()?;
            let team_id: Uuid = r.try_get("", "team_id").ok()?;
            if desired.contains(&team_id) { None } else { Some((id, team_id)) }
        })
        .collect();

    if !surplus.is_empty() {
        let in_flight = db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT DISTINCT ras.required_cluster_id, ras.required_level
                   FROM request_approval_steps ras
                   JOIN breakglass_requests r ON r.id = ras.request_id
                   WHERE r.system_id = $1
                     AND r.status IN ('submitted','under_review','returned_to_vendor')
                     AND ras.step_status IN ('pending','in_review','submitted')"#,
                [system_id.into()],
            ))
            .await
            .map_err(db_err)?;
        for (mapping_id, team_id) in surplus {
            let team_rows = db
                .query_all(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "SELECT cluster_id, level, expires_after FROM teams WHERE id = $1 LIMIT 1",
                    [team_id.into()],
                ))
                .await
                .map_err(db_err)?;
            let guarded = team_rows.first().map(|r| {
                let expired: Option<chrono::DateTime<chrono::FixedOffset>> =
                    r.try_get("", "expires_after").unwrap_or(None);
                if expired.is_some() { return false; }
                let cid: Uuid = r.try_get("", "cluster_id").unwrap_or(Uuid::nil());
                let lvl: i16 = r.try_get("", "level").unwrap_or(0);
                in_flight.iter().any(|p| {
                    p.try_get::<Uuid>("", "required_cluster_id").map(|c| c == cid).unwrap_or(false)
                        && p.try_get::<i16>("", "required_level").map(|l| l == lvl).unwrap_or(false)
                })
            }).unwrap_or(false);
            if guarded {
                report.retained_team_ids.push(team_id);
                continue;
            }
            db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE team_system_mappings SET expires_after = now() WHERE id = $1",
                [mapping_id.into()],
            ))
            .await
            .map_err(db_err)?;
            audit(db, actor_user_id, "team_system_mapping.invalidated", mapping_id,
                json!({ "teamId": team_id, "systemId": system_id, "via": "workflow_save_auto_sync" })).await?;
            report.invalidated_ids.push(mapping_id);
        }
    }
    Ok(report)
}

async fn audit<C: ConnectionTrait>(
    db: &C, actor: Uuid, action: &str, target_id: Uuid, details: JsonValue,
) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,'team_system_mapping',$4,$5)",
        [Uuid::now_v7().into(), actor.into(), action.into(), target_id.to_string().into(), details.into()],
    ))
    .await
    .map_err(db_err)?;
    Ok(())
}
