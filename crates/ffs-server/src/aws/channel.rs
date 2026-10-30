//! S3 transport boundary for the tenant exchange. The caller owns AssumeRole,
//! SSM discovery and ledger eligibility checks; this layer never lists or
//! accepts uncorrelated inbound objects. LocalStack contract test is opt-in.
use aws_sdk_s3::{primitives::ByteStream, Client};
use sea_orm::DatabaseConnection;
use serde_json::Value;

use super::transport::{is_wrapped, resolve_transport_keys, unwrap, wrap};

pub const OUTBOUND_TYPES: &[(&str, &str)] = &[
    ("credential_request", "credential-request"),
    ("request_close", "request-close"),
    ("inventory_request", "inventory-request"),
];
pub const INBOUND_TYPES: &[(&str, &str)] = &[
    ("credential_response", "credential-response"),
    ("request_close_ack", "request-close-ack"),
    ("inventory_response", "inventory-response"),
];

fn object_key(folder: &str, direction: &str, kind: &str, correlation: &str, types: &[(&str, &str)]) -> Result<String, String> {
    let slug = types.iter().find(|(name, _)| *name == kind).map(|(_, slug)| *slug)
        .ok_or_else(|| format!("unknown AWS tenant exchange type: {kind}"))?;
    Ok(format!("{folder}/v1/{direction}/{slug}/{correlation}.json"))
}
pub fn outbound_object_key(folder: &str, kind: &str, correlation: &str) -> Result<String, String> {
    object_key(folder, "outbound", kind, correlation, OUTBOUND_TYPES)
}
pub fn inbound_object_key(folder: &str, kind: &str, correlation: &str) -> Result<String, String> {
    object_key(folder, "inbound", kind, correlation, INBOUND_TYPES)
}

/// Publish a request with the configured transport codec. Never fall back to
/// plaintext when a tenant key is present but invalid or app keys are missing.
pub async fn put_outbound(
    db: &DatabaseConnection, s3: &Client, bucket: &str, folder: &str,
    kind: &str, correlation: &str, tenant_pub_b64: Option<&str>, payload: &Value,
) -> Result<String, String> {
    let key = outbound_object_key(folder, kind, correlation)?;
    let keys = resolve_transport_keys(db, tenant_pub_b64).await?;
    let body = if let Some(keys) = keys {
        wrap(payload, &keys.app_priv_pem, &keys.tenant_pub_pem, "request")?
    } else {
        serde_json::to_string(payload).map_err(|e| e.to_string())?
    };
    s3.put_object().bucket(bucket).key(&key).body(ByteStream::from(body.into_bytes()))
        .content_type("application/json").send().await.map_err(|e| e.to_string())?;
    Ok(key)
}

/// Retrieve one ledger-approved object (the sweep must select its key first).
/// A wrapped file without configured keys is rejected rather than downgraded.
pub async fn get_inbound(
    db: &DatabaseConnection, s3: &Client, bucket: &str, key: &str,
    tenant_pub_b64: Option<&str>,
) -> Result<Value, String> {
    let response = s3.get_object().bucket(bucket).key(key).send().await.map_err(|e| e.to_string())?;
    let data = response.body.collect().await.map_err(|e| e.to_string())?.into_bytes();
    let text = String::from_utf8(data.to_vec()).map_err(|e| e.to_string())?;
    let keys = resolve_transport_keys(db, tenant_pub_b64).await?;
    if let Some(keys) = keys {
        unwrap(&text, &keys.app_priv_pem, &keys.tenant_pub_pem)
    } else if is_wrapped(&text) || serde_json::from_str::<Value>(&text).ok()
        .and_then(|v| v.get("schemaVersion").and_then(Value::as_str).map(str::to_string)).as_deref() == Some("2.0") {
        Err("AWS transport encryption: inbound file is encrypted but tenant keys are absent".into())
    } else {
        serde_json::from_str(&text).map_err(|e| e.to_string())
    }
}
