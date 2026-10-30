//! GET /requests/:id/secret-material — submitter-only, eligibility-window gated.
//! The private-key wrap key is never yielded until encrypted delivery has landed.
use std::sync::Arc;

use axum::{extract::{Extension, Path, State}, Json};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{auth::session::Session, config::Config, errors::{AppError, RouteResult}};

pub async fn get_secret_material(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(id): Path<String>,
) -> RouteResult<Json<Value>> {
    let request_id = id.parse::<Uuid>().map_err(|_| AppError::not_found("Request not found."))?;
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT submitted_by,status::text AS status,activity_start_at,activity_end_at
           FROM breakglass_requests WHERE id=$1"#, [request_id.into()])).await?
        .ok_or_else(|| AppError::not_found("Request not found."))?;
    let submitter: Uuid = row.try_get("", "submitted_by")?;
    if submitter != session.user_id { return Err(AppError::not_found("Request not found.")); }
    let status: String = row.try_get("", "status")?;
    let start: DateTime<Utc> = row.try_get("", "activity_start_at")?;
    let end: DateTime<Utc> = row.try_get("", "activity_end_at")?;
    let now = Utc::now();
    if !matches!(status.as_str(), "approved" | "credential_issued") || now < start || now > end {
        return Err(AppError::auth("Password retrieval is not available for this request right now."));
    }
    let km = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT private_key_wrap_key,encrypted_secret_payload FROM request_key_material WHERE request_id=$1",
        [request_id.into()])).await?
        .ok_or_else(|| AppError::not_found("Request not found."))?;
    let payload: Option<String> = km.try_get("", "encrypted_secret_payload")?;
    let Some(payload) = payload else {
        return Err(AppError::conflict("The password has not been delivered yet — it will be available shortly. Please refresh and try again."));
    };
    let payload: Value = serde_json::from_str(&payload)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Invalid encrypted payload: {e}")))?;
    let wrap_key: String = km.try_get("", "private_key_wrap_key")?;
    let items = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT rci.id,rci.asset_id,rci.hostname,rci.hostname_description,
                  rci.credential_type::text AS credential_type,rci.management_mode::text AS management_mode,
                  a.credential_name
           FROM request_credential_items rci LEFT JOIN assets a ON a.id=rci.asset_id
           WHERE rci.request_id=$1 AND rci.credential_type='password'
           ORDER BY rci.created_at,rci.id"#, [request_id.into()])).await?;
    let password_items: Vec<Value> = items.iter().map(|r| -> Result<Value, AppError> {
        Ok(json!({"id":r.try_get::<Uuid>("","id")?,"assetId":r.try_get::<Option<Uuid>>("","asset_id")?,
            "hostname":r.try_get::<String>("","hostname")?,
            "hostnameDescription":r.try_get::<Option<String>>("","hostname_description")?,
            "credentialType":r.try_get::<String>("","credential_type")?,
            "managementMode":r.try_get::<String>("","management_mode")?,
            "credentialName":r.try_get::<Option<String>>("","credential_name")?}))
    }).collect::<Result<_,_>>()?;
    Ok(Json(json!({"privateKeyWrapKey":wrap_key,"encryptedSecretPayload":payload,
        "passwordCredentialItems":password_items})))
}
