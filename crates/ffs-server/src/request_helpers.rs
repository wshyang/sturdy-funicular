//! Shared request-content guard (port of server/request-helpers.tsx validateContent).
use std::collections::HashMap;
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

#[derive(Clone, Debug, Default)]
pub struct ValidatedContent {
    pub start_iso: String,
    pub end_iso: String,
    pub resolved_assets: HashMap<String, JsonValue>,
}

fn string_field(value: &str, label: &str, min: usize, max: usize) -> Result<(), String> {
    let t = value.trim();
    if t.len() < min || t.len() > max {
        Err(format!("{label} is required and must be {min}-{max} characters."))
    } else { Ok(()) }
}

pub async fn validate_content(db: &DatabaseConnection, body: &JsonValue, system_id: Uuid) -> Result<ValidatedContent, String> {
    let justification = body["justification"].as_str().unwrap_or("");
    string_field(justification, "Justification", 1, 2000)?;
    let sr = body["sr_number"].as_str().or_else(|| body["srNumber"].as_str()).unwrap_or("");
    string_field(sr, "SR number", 1, 100)?;
    let start_s = body["activity_start_at"].as_str().or_else(|| body["activityStartAt"].as_str()).unwrap_or("");
    let end_s = body["activity_end_at"].as_str().or_else(|| body["activityEndAt"].as_str()).unwrap_or("");
    if start_s.is_empty() || end_s.is_empty() { return Err("Activity start and end times are required.".into()); }
    let start = chrono::DateTime::parse_from_rfc3339(start_s).map_err(|_| "Activity start time is invalid.".to_string())?;
    let end = chrono::DateTime::parse_from_rfc3339(end_s).map_err(|_| "Activity end time is invalid.".to_string())?;
    if end <= start { return Err("Activity end time must be after start time.".into()); }
    let items = body["credential_items"].as_array().or_else(|| body["credentialItems"].as_array());
    let items = match items { Some(a) if !a.is_empty() => a, _ => return Err("At least one credential item (a selected asset) is required.".into()) };
    let mut resolved = HashMap::new();
    for item in items {
        let asset_id = item["asset_id"].as_str().or_else(|| item["assetId"].as_str()).unwrap_or("");
        if asset_id.is_empty() { return Err("Each credential item must reference a selected asset.".into()); }
        if resolved.contains_key(asset_id) { return Err("The same asset was selected more than once.".into()); }
        if let Some(desc) = item["hostname_description"].as_str().or_else(|| item["hostnameDescription"].as_str()) {
            if !desc.is_empty() { string_field(desc, "Hostname description", 1, 200)?; }
        }
        let asset_uuid = Uuid::parse_str(asset_id).map_err(|_| "Each credential item must reference a valid, active asset for this system.".to_string())?;
        let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
            "SELECT id, system_id, credential_type::text AS credential_type, management_mode::text AS management_mode, hostname, credential_name FROM assets WHERE id=$1 AND expires_after IS NULL",
            [asset_uuid.into()])).await.map_err(|e| e.to_string())?;
        let row = match row { Some(r) => r, None => return Err("Each credential item must reference a valid, active asset for this system.".into()) };
        let sys: Uuid = row.try_get("", "system_id").map_err(|e| e.to_string())?;
        if sys != system_id { return Err("Each credential item must reference a valid, active asset for this system.".into()); }
        resolved.insert(asset_id.to_string(), json!({
            "id": asset_id,
            "credentialType": row.try_get::<String>("", "credential_type").unwrap_or_default(),
            "managementMode": row.try_get::<String>("", "management_mode").unwrap_or_default(),
            "hostname": row.try_get::<String>("", "hostname").unwrap_or_default(),
            "credentialName": row.try_get::<Option<String>>("", "credential_name").ok().flatten(),
        }));
    }
    Ok(ValidatedContent {
        start_iso: start.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        end_iso: end.with_timezone(&chrono::Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string(),
        resolved_assets: resolved,
    })
}
