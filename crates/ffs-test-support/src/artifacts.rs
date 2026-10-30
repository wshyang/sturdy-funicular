//! Failure-artifact seams (port of test/backend/deno/harness/artifacts.ts).
//! DB snapshots redact registry-declared sensitive columns before returning.

use anyhow::Result;
use chrono::Utc;
use serde_json::{json, Value};
use sqlx::PgPool;
use std::path::PathBuf;

pub const REDACTED: &str = "[hidden]";
const RESPONSE_BODY_CAP: usize = 2048;

pub const SNAPSHOT_TABLES: &[&str] = &[
    "users", "clusters", "teams", "team_memberships", "systems", "system_owners",
    "system_delegates", "team_system_mappings", "system_owner_pa_mappings", "assets",
    "asset_tags", "breakglass_requests", "request_approval_steps", "request_credential_items",
    "request_asset_custody_runs", "request_asset_custody_run_items", "request_asset_custody_cases",
    "asset_custody_events", "asset_custody_event_evidence_files", "asset_custody_exceptions",
    "asset_custody_exception_checks", "asset_custody_exception_evidence_files", "asset_custody_handoffs",
    "system_workflow_steps", "system_vendor_clusters", "system_custody_stage_configs",
    "organizations", "organization_memberships", "system_organizations", "sessions",
    "login_attempts", "external_identities", "user_invites", "identity_change_requests",
    "idempotency_tokens", "admin_roles", "user_admin_role_grants", "audit_log",
    "audit_log_changes", "access_log", "audit_sensitive_columns", "app_settings",
    "notification_templates", "notification_template_variables", "sent_notifications",
    "notification_recipients", "notification_deliveries", "notification_delivery_attempts",
    "link_mappings", "request_key_material", "aws_tenant_exchanges", "entra_auth_states",
    "entra_handoffs", "slack_auth_states", "job_runs", "request_number_sequences",
    "schema_migrations",
];

fn sensitive_columns(table: &str) -> &'static [&'static str] {
    match table {
        "users" => &["password_hash", "password_salt", "totp_secret"],
        "app_settings" => &["value"],
        "request_key_material" => &["private_key_wrap_key"],
        "entra_handoffs" => &["nonce"],
        "sessions" => &["pending_totp_secret"],
        _ => &[],
    }
}

pub fn bound_response_body(body: Value) -> Value {
    if body.is_null() {
        return Value::Null;
    }
    let serialized = body.to_string();
    if serialized.len() <= RESPONSE_BODY_CAP {
        return body;
    }
    let preview: String = serialized.chars().take(RESPONSE_BODY_CAP - 48).collect();
    json!({ "__truncated": true, "bytes": serialized.len(), "preview": preview })
}

fn redact_rows(table: &str, rows: Vec<Value>) -> Vec<Value> {
    let cols = sensitive_columns(table);
    if cols.is_empty() {
        return rows;
    }
    rows.into_iter()
        .map(|mut row| {
            if let Some(obj) = row.as_object_mut() {
                for col in cols {
                    if let Some(cell) = obj.get_mut(*col) {
                        if !cell.is_null() {
                            *cell = Value::String(REDACTED.to_string());
                        }
                    }
                }
            }
            row
        })
        .collect()
}

pub async fn snapshot_tables(db: &PgPool, tables: &[&str]) -> Result<Value> {
    let mut out = serde_json::Map::new();
    for table in tables {
        let sql = format!("SELECT row_to_json(t) FROM \"{table}\" t LIMIT 200");
        let rows = sqlx::query_scalar::<_, Value>(&sql).fetch_all(db).await?;
        out.insert((*table).to_string(), Value::Array(redact_rows(table, rows)));
    }
    Ok(Value::Object(out))
}

pub fn slugify(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || " >_-".contains(c) { c } else { '_' })
        .collect();
    cleaned.split_whitespace().collect::<Vec<_>>().join("_").chars().take(120).collect()
}

fn artifact_root() -> PathBuf {
    crate::workspace_root().join("test_output/rust/artifacts")
}

pub async fn write_snapshot(db: &PgPool, test_name: &str, label: &str) -> Result<PathBuf> {
    let dir = artifact_root().join(slugify(test_name));
    tokio::fs::create_dir_all(&dir).await?;
    let snap = snapshot_tables(db, SNAPSHOT_TABLES).await?;
    let stamp = Utc::now().format("%Y-%m-%d %H-%M-%S");
    let file = dir.join(format!("{stamp} ({label}).db-snapshot.json"));
    tokio::fs::write(&file, serde_json::to_vec_pretty(&snap)?).await?;
    Ok(file)
}

pub async fn write_failure_artifacts(
    db: &PgPool,
    test_name: &str,
    requests: &[Value],
    error: &str,
) -> Result<PathBuf> {
    let dir = artifact_root().join(slugify(test_name));
    tokio::fs::create_dir_all(&dir).await?;
    let stamp = Utc::now().format("%Y-%m-%d %H-%M-%S");
    let request_log = dir.join(format!("{stamp} (failure).request-log.json"));
    tokio::fs::write(&request_log, serde_json::to_vec_pretty(requests)?).await?;
    let snap = snapshot_tables(db, SNAPSHOT_TABLES).await?;
    let snap_file = dir.join(format!("{stamp} (failure).db-snapshot.json"));
    tokio::fs::write(&snap_file, serde_json::to_vec_pretty(&snap)?).await?;
    let last_step = requests
        .iter()
        .filter(|r| r["type"] == "step")
        .last()
        .and_then(|r| r["path"].as_str());
    let mut md = format!("# {test_name} — FAILED\n\n{error}\n\n");
    if let Some(step) = last_step {
        md.push_str(&format!("Last step marker: **{step}**\n\n"));
    }
    md.push_str("See request-log.json and db-snapshot.json in this directory.\n");
    let md_file = dir.join(format!("{stamp} (failure).md"));
    tokio::fs::write(&md_file, md).await?;
    Ok(dir)
}
