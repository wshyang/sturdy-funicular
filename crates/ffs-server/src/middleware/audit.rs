// Audit GUC middleware (PORT-0.4).
// Sets transaction-scoped GUCs that ffs_audit_mutation() trigger reads.
// Mirrors audit-context.tsx setAuditContext() in exact GUC order.
//
// Called from route handlers via set_audit_context() after the TxHandle
// is available in request extensions. NOT a Tower middleware — a helper
// called inside handlers that already have the txn.

use sea_orm::{ConnectionTrait, Statement};
use crate::errors::AppError;

#[derive(Debug, Clone)]
pub struct AuditContext {
    pub action: String,
    pub actor_id: Option<String>,
    pub details: Option<serde_json::Value>,
    pub organization_id: Option<String>,
    pub access_log_id: Option<String>,
    pub job_run_id: Option<String>,
}

/// Sets ffs.* GUCs in the given transaction (SET LOCAL — tx-scoped, auto-reset on commit/rollback).
/// Must be called inside the SAME transaction as the audited mutation.
/// Order matches audit-context.tsx:30-84.
pub async fn set_audit_context<C: ConnectionTrait>(
    conn: &C,
    ctx: &AuditContext,
) -> Result<(), AppError> {
    let backend = sea_orm::DatabaseBackend::Postgres;

    let queries = [
        format!("SELECT set_config('ffs.action', '{}', true)", escape_guc(&ctx.action)),
        format!("SELECT set_config('ffs.actor_id', '{}', true)", escape_guc(ctx.actor_id.as_deref().unwrap_or(""))),
        format!("SELECT set_config('ffs.access_log_id', '{}', true)", escape_guc(ctx.access_log_id.as_deref().unwrap_or(""))),
        format!("SELECT set_config('ffs.job_run_id', '{}', true)", escape_guc(ctx.job_run_id.as_deref().unwrap_or(""))),
        format!("SELECT set_config('ffs.details', '{}', true)", escape_guc(&ctx.details.as_ref().map(|d| d.to_string()).unwrap_or_default())),
        format!("SELECT set_config('ffs.organization_id', '{}', true)", escape_guc(ctx.organization_id.as_deref().unwrap_or(""))),
    ];

    for sql in &queries {
        conn.execute(Statement::from_string(backend, sql.clone()))
            .await
            .map_err(AppError::from)?;
    }

    Ok(())
}

/// Clear audit GUCs back to empty baseline.
pub async fn clear_audit_context<C: ConnectionTrait>(conn: &C) -> Result<(), AppError> {
    conn.execute(Statement::from_string(
        sea_orm::DatabaseBackend::Postgres,
        "SELECT set_config('ffs.action', '', true) AS a, \
                set_config('ffs.actor_id', '', true) AS b, \
                set_config('ffs.access_log_id', '', true) AS c, \
                set_config('ffs.job_run_id', '', true) AS d, \
                set_config('ffs.details', '', true) AS e, \
                set_config('ffs.organization_id', '', true) AS f",
    ))
    .await
    .map_err(AppError::from)?;
    Ok(())
}

/// Escape a string value for embedding in a GUC set_config literal.
/// Only basic escaping — GUC values are single-quoted in Postgres.
fn escape_guc(val: &str) -> String {
    val.replace('\'', "''")
}
