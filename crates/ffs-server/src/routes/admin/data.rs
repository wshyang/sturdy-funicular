//! Admin data export/import/reset-seed (legacy server/routes/admin/data.tsx).
//! Importers/callers: main.rs registers /admin/data/{export,import,reset-seed}.
//! Data schemas: DATA_TABLES bundle registry; users self-referential FK deferral.
//! User instruction: continue the staged Rust port (Stage 2D).

use std::sync::Arc;

use axum::{extract::{Extension, State}, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement, TransactionTrait};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    audit::write_audit_log,
    auth::{privileges::require_admin_privilege, session::Session},
    config::Config,
    db::admin_roles::user_has_any_admin_role,
    errors::{AppError, RouteResult},
};

type RouteState = State<(Config, DatabaseConnection)>;

const DATA_TABLES: &[&str] = &[
    "users","user_admin_role_grants","organizations","organization_memberships","clusters","teams",
    "team_memberships","systems","system_organizations","system_owners","system_delegates",
    "team_system_mappings","system_owner_pa_mappings","breakglass_requests","request_key_material",
    "request_approval_steps","request_credential_items","audit_log",
];
const SELF_REF: &[&str] = &["approved_by","tombstoned_by","untombstoned_by"];
const SYSTEM_ACTORS: &[&str] = &["00000000-0000-7000-8000-000000000001","00000000-0000-7000-8000-000000000002"];

async fn ensure_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    if !user_has_any_admin_role(db, user_id).await? { return Err(AppError::Authorization("You do not have admin access.".into())); }
    Ok(())
}
fn safe_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_') && !s.chars().next().unwrap().is_ascii_digit()
}

pub async fn export_data(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_admin_privilege(&db, session.user_id, "DataExport").await?;
    let mut tables = Vec::new();
    let mut count = 0usize;
    for table in DATA_TABLES {
        let order = if *table == "user_admin_role_grants" { "granted_at" } else { "created_at" };
        let sql = if *table == "users" {
            format!("SELECT row_to_json(t) AS row FROM (SELECT * FROM users WHERE id::text NOT IN ('{}') ORDER BY {order}) t", SYSTEM_ACTORS.join("','"))
        } else { format!("SELECT row_to_json(t) AS row FROM (SELECT * FROM {table} ORDER BY {order}) t") };
        let rows = db.query_all(Statement::from_string(DbBackend::Postgres, sql)).await?;
        let mut arr = Vec::new();
        for r in rows { arr.push(r.try_get::<JsonValue>("", "row")?); }
        count += arr.len();
        tables.push(json!({"table":table,"rows":arr}));
    }
    write_audit_log(&db, session.user_id, "data.exported", "export_bundle", "data-export", None, json!({"entryCount":count}), None).await?;
    Ok(Json(json!({"schema":"breakglass-export-v3","exportedAt":chrono::Utc::now().to_rfc3339(),"exportedBy":session.user_id,"entryCount":count,"tables":tables})))
}

pub async fn import_data(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>, Json(body): Json<JsonValue>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_admin_privilege(&db, session.user_id, "DataImport").await?;
    let bundle = body.get("bundle").ok_or_else(|| AppError::Validation("Invalid bundle.".into()))?;
    let tables = bundle.get("tables").and_then(|v| v.as_array()).ok_or_else(|| AppError::Validation("Invalid bundle shape.".into()))?;
    let wipe_first = body.get("wipeFirst").and_then(|v| v.as_bool()).unwrap_or(false);
    // Validate identifiers up front.
    for t in tables {
        let name = t.get("table").and_then(|v| v.as_str()).unwrap_or("");
        if !DATA_TABLES.contains(&name) { return Err(AppError::Validation(format!("Unknown table: {name}"))); }
        if let Some(rows) = t.get("rows").and_then(|v| v.as_array()) {
            for r in rows { if let Some(obj) = r.as_object() { for k in obj.keys() { if !safe_ident(k) { return Err(AppError::Validation(format!("Invalid column name in bundle: {k}"))); } } } }
        }
    }
    // Preserve acting admin's sessions.
    let sessions = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT row_to_json(s) AS row FROM sessions s WHERE user_id=$1", [session.user_id.into()])).await?;
    let txn = db.begin().await?;
    txn.execute_unprepared("SET LOCAL session_replication_role = replica").await?;
    if wipe_first {
        for table in DATA_TABLES.iter().rev() {
            let sql = if *table == "users" { format!("DELETE FROM users WHERE id::text NOT IN ('{}')", SYSTEM_ACTORS.join("','")) } else { format!("DELETE FROM {table}") };
            txn.execute(Statement::from_string(DbBackend::Postgres, sql)).await?;
        }
    }
    let mut written = 0usize;
    let mut deferred: Vec<(Uuid, JsonValue)> = Vec::new();
    for t in tables {
        let name = t["table"].as_str().unwrap();
        let Some(rows) = t.get("rows").and_then(|v| v.as_array()) else { continue };
        for r in rows {
            let Some(obj) = r.as_object() else { continue };
            let mut row_obj = obj.clone();
            let mut defer = json!({});
            if name == "users" {
                for c in SELF_REF { if let Some(v) = row_obj.remove(*c) { defer[*c] = v; } }
            }
            let cols: Vec<String> = row_obj.keys().cloned().collect();
            let updates: Vec<String> = cols.iter().filter(|c| c.as_str() != "id").map(|c| format!("{c}=EXCLUDED.{c}")).collect();
            let sql = format!("INSERT INTO {name} SELECT * FROM json_populate_record(NULL::{name}, $1::json) ON CONFLICT (id) DO UPDATE SET {}", updates.join(","));
            txn.execute(Statement::from_sql_and_values(DbBackend::Postgres, sql, [JsonValue::Object(row_obj).into()])).await.map_err(|e| AppError::Internal(anyhow::anyhow!("import {name}: {e}")))?;
            if name == "users" && !defer.as_object().unwrap().is_empty() {
                if let Some(id) = obj.get("id").and_then(|v| v.as_str()).and_then(|s| Uuid::parse_str(s).ok()) { deferred.push((id, defer)); }
            }
            written += 1;
        }
    }
    for (id, vals) in deferred {
        let obj = vals.as_object().unwrap();
        let sets: Vec<String> = obj.keys().map(|k| format!("{k}=${}", 0)).collect();
        let _ = sets;
        let mut i = 1; let mut set_parts = Vec::new(); let mut params = Vec::new();
        for (k, v) in obj { set_parts.push(format!("{k}=${i}::uuid")); params.push(json_to_sea(v)); i += 1; }
        params.push(id.into());
        let sql = format!("UPDATE users SET {} WHERE id=${i}", set_parts.join(","));
        txn.execute(Statement::from_sql_and_values(DbBackend::Postgres, sql, params)).await?;
    }
    // Restore sessions.
    for s in sessions {
        let row: JsonValue = s.try_get("", "row")?;
        txn.execute(Statement::from_sql_and_values(DbBackend::Postgres, "INSERT INTO sessions SELECT * FROM json_populate_record(NULL::sessions, $1::json) ON CONFLICT (id) DO NOTHING", [row.into()])).await?;
    }
    txn.commit().await?;
    write_audit_log(&db, session.user_id, "data.imported", "import_operation", "import", None, json!({"entryCount":written,"wipedFirst":wipe_first}), None).await?;
    Ok(Json(json!({"message":"Import complete.","entriesWritten":written})))
}

fn json_to_sea(v: &JsonValue) -> sea_orm::Value {
    match v {
        JsonValue::Null => sea_orm::Value::String(None),
        JsonValue::Bool(b) => sea_orm::Value::Bool(Some(*b)),
        JsonValue::Number(n) => if let Some(i) = n.as_i64() { sea_orm::Value::BigInt(Some(i)) } else { sea_orm::Value::Double(Some(n.as_f64().unwrap_or(0.0))) },
        JsonValue::String(s) => sea_orm::Value::String(Some(Box::new(s.clone()))),
        other => sea_orm::Value::Json(Some(Box::new(other.clone()))),
    }
}

pub async fn reset_seed(State((_, db)): RouteState, Extension(session): Extension<Arc<Session>>) -> RouteResult<Json<JsonValue>> {
    ensure_admin(&db, session.user_id).await?;
    require_admin_privilege(&db, session.user_id, "DataResetSeed").await?;
    let mode = std::env::var("BREAKGLASS_DEV").unwrap_or_else(|_| "PROD".into());
    if mode != "DEV" && mode != "DEMO" {
        return Err(AppError::Authorization("Reset & Seed Demo Data is only available when BREAKGLASS_DEV is DEV or DEMO. It is disabled in this deployment (BREAKGLASS_DEV=PROD or unset).".into()));
    }
    // Snapshot acting admin row + sessions, wipe, re-create admin, run demo seed.
    let admin_row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT row_to_json(u) AS row FROM users u WHERE id=$1", [session.user_id.into()])).await?;
    let sessions = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres,
        "SELECT row_to_json(s) AS row FROM sessions s WHERE user_id=$1", [session.user_id.into()])).await?;
    let txn = db.begin().await?;
    txn.execute_unprepared("SET LOCAL session_replication_role = replica").await?;
    for table in DATA_TABLES.iter().rev() {
        let sql = if *table == "users" { format!("DELETE FROM users WHERE id::text NOT IN ('{}')", SYSTEM_ACTORS.join("','")) } else { format!("DELETE FROM {table}") };
        txn.execute(Statement::from_string(DbBackend::Postgres, sql)).await?;
    }
    if let Some(r) = admin_row {
        let row: JsonValue = r.try_get("", "row")?;
        let _obj = row.as_object().unwrap();
        txn.execute(Statement::from_sql_and_values(DbBackend::Postgres, "INSERT INTO users SELECT * FROM json_populate_record(NULL::users, $1::json)", [row.into()])).await?;
    }
    txn.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        "INSERT INTO user_admin_role_grants (user_id, role_key, granted_by) VALUES ($1,'full_admin',$1) ON CONFLICT DO NOTHING", [session.user_id.into()])).await?;
    for s in sessions {
        let row: JsonValue = s.try_get("", "row")?;
        txn.execute(Statement::from_sql_and_values(DbBackend::Postgres, "INSERT INTO sessions SELECT * FROM json_populate_record(NULL::sessions, $1::json) ON CONFLICT (id) DO NOTHING", [row.into()])).await?;
    }
    let seed = std::fs::read_to_string("setup/sql/002_seed_demo.sql").map_err(|e| AppError::Internal(anyhow::anyhow!("seed read: {e}")))?;
    txn.execute_unprepared(&seed).await?;
    txn.commit().await?;
    let systems = db.query_one(Statement::from_string(DbBackend::Postgres, "SELECT count(*)::int AS n FROM systems".to_string())).await?;
    let n: i32 = systems.map(|r| r.try_get("", "n").unwrap_or(0)).unwrap_or(0);
    write_audit_log(&db, session.user_id, "data.reset_seeded", "import_operation", "reset-seed", None, json!({"systems":n}), None).await?;
    Ok(Json(json!({"message":"Demo data reset and reseeded.","summary":{"systems":n}})))
}
