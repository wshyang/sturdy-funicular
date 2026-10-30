//! Asset-inventory domain reconciliation (addendum-037 / addendum-039).
//! Pure once given a response: no S3 transport here. The admin sync route and
//! the centralized tenant sweep both dispatch inbound `inventory_response`
//! objects to `reconcile_asset_inventory`.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde::Deserialize;
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{errors::AppError, notifications::notify_trigger};

fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB error: {}", e))
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryResponseAssetEntry {
    pub hostname: String,
    pub credential_name: String,
    pub credential_type: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InventoryResponse {
    #[serde(default)]
    pub schema_version: String,
    #[serde(default)]
    pub system_id: String,
    pub status: String,
    pub assets: Option<Vec<InventoryResponseAssetEntry>>,
    #[serde(default)]
    pub error_message: Option<String>,
    #[serde(default)]
    pub processed_at: String,
}

/// Env override wins; otherwise the centralized app_settings kill-switch.
pub async fn is_aws_integration_enabled<C: ConnectionTrait>(db: &C) -> Result<bool, AppError> {
    if let Ok(v) = std::env::var("AWS_INTEGRATION_ENABLED") {
        if !v.is_empty() {
            return Ok(v == "true");
        }
    }
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT value FROM app_settings WHERE key = 'aws_integration_enabled' LIMIT 1",
            [],
        ))
        .await
        .map_err(db_err)?;
    Ok(rows
        .first()
        .and_then(|r| r.try_get::<JsonValue>("", "value").ok())
        .and_then(|v| v.as_bool())
        .unwrap_or(false))
}

const SYSTEM_USER_ID: &str = "00000000-0000-7000-8000-000000000001";

pub async fn reconcile_asset_inventory(
    db: &DatabaseConnection,
    system_id: Uuid,
    response: &InventoryResponse,
) -> Result<(), AppError> {
    let system_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT name FROM systems WHERE id = $1 LIMIT 1",
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    let system_name: String = system_rows
        .first()
        .and_then(|r| r.try_get("", "name").ok())
        .ok_or_else(|| AppError::NotFound("System not found.".to_string()))?;
    let system_actor: Uuid = SYSTEM_USER_ID.parse().unwrap();

    if response.status != "success" || response.assets.is_none() {
        let owner_rows = db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"SELECT u.email FROM system_owners so JOIN users u ON u.id = so.user_id
                   WHERE so.system_id = $1 AND so.kind = 'primary' AND so.expires_after IS NULL LIMIT 1"#,
                [system_id.into()],
            ))
            .await
            .map_err(db_err)?;
        let recipients: Vec<String> = if let Some(r) = owner_rows.first() {
            vec![r.try_get::<String>("", "email").map_err(db_err)?]
        } else {
            let admins = db
                .query_all(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    r#"SELECT DISTINCT u.email FROM user_admin_role_grants g
                       JOIN users u ON u.id = g.user_id
                       WHERE g.role_key = 'full_admin' AND g.revoked_at IS NULL AND u.status = 'active'"#,
                    [],
                ))
                .await
                .map_err(db_err)?;
            admins.iter().filter_map(|r| r.try_get::<String>("", "email").ok()).collect()
        };
        let tx = db.begin().await.map_err(db_err)?;
        tx.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'asset_inventory.sync_failed','system',$3,$4)",
            [Uuid::now_v7().into(), system_actor.into(), system_id.to_string().into(),
             json!({ "systemId": system_id, "errorMessage": response.error_message }).into()],
        ))
        .await
        .map_err(db_err)?;
        notify_trigger(&tx, "asset_inventory.sync_failed", &recipients, "system", system_id).await?;
        tx.commit().await.map_err(db_err)?;
        let _ = system_name;
        return Ok(());
    }

    let entries = response.assets.as_ref().unwrap();
    let tx = db.begin().await.map_err(db_err)?;
    let existing = tx
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id, hostname, credential_name, credential_type::TEXT AS credential_type, expires_after
               FROM assets WHERE system_id = $1 AND system_managed = true"#,
            [system_id.into()],
        ))
        .await
        .map_err(db_err)?;
    let mut created = 0i64;
    let mut updated = 0i64;
    let mut expired = 0i64;
    let mut seen: Vec<(String, String)> = Vec::new();
    let mut known: Vec<(Uuid, String, String, String, bool)> = existing
        .iter()
        .filter_map(|r| {
            Some((
                r.try_get::<Uuid>("", "id").ok()?,
                r.try_get::<String>("", "hostname").ok()?,
                r.try_get::<String>("", "credential_name").ok()?,
                r.try_get::<String>("", "credential_type").ok()?,
                r.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>>("", "expires_after").ok()?.is_some(),
            ))
        })
        .collect();

    for entry in entries {
        let key = (entry.hostname.clone(), entry.credential_name.clone());
        if seen.contains(&key) { continue; }
        seen.push(key.clone());
        if let Some(pos) = known.iter().position(|(_, h, c, _, _)| *h == entry.hostname && *c == entry.credential_name) {
            let (id, _, _, ref ctype, ref is_expired) = known[pos];
            if *ctype != entry.credential_type || *is_expired {
                tx.execute(Statement::from_sql_and_values(
                    DbBackend::Postgres,
                    "UPDATE assets SET credential_type = $1, expires_after = NULL, updated_at = now() WHERE id = $2",
                    [entry.credential_type.clone().into(), id.into()],
                ))
                .await
                .map_err(db_err)?;
                updated += 1;
                known[pos].3 = entry.credential_type.clone();
                known[pos].4 = false;
            }
        } else {
            let id = Uuid::now_v7();
            tx.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"INSERT INTO assets (id, system_id, system_managed, management_mode, credential_type, hostname, credential_name, created_at, updated_at)
                   VALUES ($1,$2,true,'api_managed',$3,$4,$5,now(),now())"#,
                [id.into(), system_id.into(), entry.credential_type.clone().into(), entry.hostname.clone().into(), entry.credential_name.clone().into()],
            ))
            .await
            .map_err(db_err)?;
            known.push((id, entry.hostname.clone(), entry.credential_name.clone(), entry.credential_type.clone(), false));
            created += 1;
        }
    }

    for (id, hostname, credential_name, _, is_expired) in &known {
        if !is_expired && !seen.contains(&(hostname.clone(), credential_name.clone())) {
            tx.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "UPDATE assets SET expires_after = now(), updated_at = now() WHERE id = $1",
                [(*id).into()],
            ))
            .await
            .map_err(db_err)?;
            expired += 1;
        }
    }

    tx.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'asset_inventory.synced','system',$3,$4)",
        [Uuid::now_v7().into(), system_actor.into(), system_id.to_string().into(),
         json!({ "systemId": system_id, "created": created, "updated": updated, "expired": expired }).into()],
    ))
    .await
    .map_err(db_err)?;
    tx.commit().await.map_err(db_err)?;
    Ok(())
}
