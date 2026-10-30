//! Correlation-bound tenant exchange ledger. The S3 sweep must match a pending
//! row before retrieving an inbound object; state transitions are conditional
//! to prevent replaying processed or failed responses.
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

fn statement(sql: &str, values: Vec<sea_orm::Value>) -> Statement {
    Statement::from_sql_and_values(DbBackend::Postgres, sql, values)
}

pub async fn create(
    db: &DatabaseConnection, system_id: Uuid, correlation_id: Uuid, outbound_type: &str,
    expects_inbound: bool, expected_inbound_type: Option<&str>, outbound_key: &str,
) -> Result<Uuid, String> {
    let id = Uuid::now_v7();
    db.execute(statement(
        "INSERT INTO aws_tenant_exchanges (id,system_id,correlation_id,outbound_type,expects_inbound,expected_inbound_type,outbound_object_key,inbound_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        vec![id.into(), system_id.into(), correlation_id.into(), outbound_type.into(), expects_inbound.into(), expected_inbound_type.map(str::to_string).into(), outbound_key.into(), if expects_inbound { Some("awaiting".to_string()) } else { None }.into()],
    )).await.map_err(|e| e.to_string())?;
    Ok(id)
}

pub async fn find_awaiting(
    db: &DatabaseConnection, system_id: Uuid, correlation_id: Uuid, inbound_type: &str,
) -> Result<Option<Uuid>, String> {
    db.query_one(statement(
        "SELECT id FROM aws_tenant_exchanges WHERE system_id=$1 AND correlation_id=$2 AND expected_inbound_type=$3 AND inbound_status='awaiting' LIMIT 1",
        vec![system_id.into(), correlation_id.into(), inbound_type.into()],
    )).await.map_err(|e| e.to_string())?.map(|row| row.try_get("", "id").map_err(|e| e.to_string())).transpose()
}

/// Store GetObject.LastModified, not the app's first-observed time, as the
/// publication timestamp. Return false on a duplicate or terminal row.
pub async fn mark_received(
    db: &DatabaseConnection, id: Uuid, object_key: &str, published_at: chrono::DateTime<chrono::Utc>,
    received_at: chrono::DateTime<chrono::Utc>, etag: &str,
) -> Result<bool, String> {
    let result = db.execute(statement(
        "UPDATE aws_tenant_exchanges SET inbound_status='received',inbound_object_key=$2,inbound_published_at=$3,inbound_received_at=$4,inbound_etag=$5 WHERE id=$1 AND inbound_status='awaiting'",
        vec![id.into(), object_key.into(), published_at.into(), received_at.into(), etag.into()],
    )).await.map_err(|e| e.to_string())?;
    Ok(result.rows_affected() == 1)
}

pub async fn mark_processed(db: &DatabaseConnection, id: Uuid, at: chrono::DateTime<chrono::Utc>) -> Result<bool, String> {
    let result = db.execute(statement(
        "UPDATE aws_tenant_exchanges SET inbound_status='processed',inbound_processed_at=$2 WHERE id=$1 AND inbound_status='received'",
        vec![id.into(), at.into()],
    )).await.map_err(|e| e.to_string())?;
    Ok(result.rows_affected() == 1)
}

pub async fn mark_failed(db: &DatabaseConnection, id: Uuid, code: &str, message: &str) -> Result<bool, String> {
    let result = db.execute(statement(
        "UPDATE aws_tenant_exchanges SET inbound_status='failed',failure_code=$2,failure_message=$3 WHERE id=$1 AND inbound_status IN ('awaiting','received')",
        vec![id.into(), code.into(), message.into()],
    )).await.map_err(|e| e.to_string())?;
    Ok(result.rows_affected() == 1)
}

/// Record a tenant close acknowledgement as an operational event only. The
/// tenant cannot change the locally closed request's status or closure time.
pub async fn reconcile_close_acknowledgement(
    db: &DatabaseConnection, system_id: Uuid, request_id: Uuid, payload: &serde_json::Value,
) -> Result<(), String> {
    let details = serde_json::json!({
        "systemId": system_id,
        "status": payload.get("status").and_then(serde_json::Value::as_str),
        "actionSummary": payload.get("actionSummary").and_then(serde_json::Value::as_str),
        "errorMessage": payload.get("errorMessage").filter(|v| !v.is_null()).map(|v| v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())),
        "processedAt": payload.get("processedAt").and_then(serde_json::Value::as_str),
    });
    db.execute(statement(
        "INSERT INTO audit_log (id,actor_id,action,target_type,target_id,details) VALUES ($1,$2,'request.aws_close_acknowledged','breakglass_request',$3,$4)",
        vec![Uuid::now_v7().into(), Uuid::parse_str("00000000-0000-7000-8000-000000000001").unwrap().into(), request_id.to_string().into(), details.into()],
    )).await.map_err(|e| e.to_string())?;
    Ok(())
}
