//! Shared audit-log writer (legacy server/utils.tsx createAuditLog).
//! Importers/callers: admin route handlers (app_settings, organization_overrides, users, data).
//! Data schemas: audit_log (actor_id, action, target_type, target_id, details, organization_id).
//! User instruction: continue the staged Rust port (Stage 2D).

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use serde_json::Value;
use uuid::Uuid;

use crate::errors::AppError;

pub async fn write_audit_log<C: ConnectionTrait>(
    db: &C,
    actor_id: Uuid,
    action: &str,
    target_type: &str,
    target_id: &str,
    organization_id: Option<Uuid>,
    details: Value,
    _request_id: Option<Uuid>,
) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO audit_log (actor_id, action, target_type, target_id, organization_id, details)
           VALUES ($1,$2,$3::audit_target_type,$4,$5,$6)"#,
        [
            actor_id.into(),
            action.into(),
            target_type.into(),
            target_id.into(),
            organization_id.into(),
            details.into(),
        ],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("audit: {e}")))?;
    Ok(())
}
