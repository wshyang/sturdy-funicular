// GET /setup — schema bootstrap and default admin creation.
// Mirrors server/app.tsx:259-329, server/schema-bootstrap.tsx, server/bootstrap.tsx.
//
// Critical path for health.test.tsx: it runs DROP SCHEMA public CASCADE then
// calls GET /setup expecting the DB to self-heal. Without this the cascade
// destroys the DB for all subsequent test suites.

use std::fs;

use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::{
    auth::password::{generate_salt, hash_password},
    config::Config,
    errors::AppError,
};

#[derive(Deserialize)]
pub struct SetupQuery {
    pub file: Option<String>,
}

pub async fn setup_handler(
    State((config, db)): State<(Config, DatabaseConnection)>,
    Query(params): Query<SetupQuery>,
) -> Result<impl IntoResponse, AppError> {
    let schema_just_bootstrapped = ensure_schema_applied(&db).await?;

    // Always re-seed admin roles on every GET /setup — idempotent via ON CONFLICT DO UPDATE.
    // Deno's seedAdminRoles() inserts role rows without capabilities; this ensures the
    // capabilities column stays populated regardless of seeding order across test runs.
    seed_admin_roles(&db).await?;

    let available_sql_files = list_available_sql_files();

    let user_count = count_real_users(&db).await?;

    if user_count > 0 {
        if params.file.is_some() {
            return Err(AppError::Validation(
                "Users already exist. Cannot apply a SQL file to a populated database.".to_string(),
            ));
        }
        return Ok(Json(json!({
            "message": "Users already exist. No setup needed.",
            "userCount": user_count,
            "availableSqlFiles": available_sql_files,
            "schemaJustBootstrapped": schema_just_bootstrapped,
        })));
    }

    if let Some(ref file_name) = params.file {
        // Guard: reject path separators and non-.sql files to prevent directory traversal.
        if file_name.contains('/') || file_name.contains('\\') || file_name.starts_with('.')
            || !file_name.ends_with(".sql")
        {
            return Err(AppError::Validation(format!(
                "Invalid SQL file name: '{}'", file_name
            )));
        }
        let path = std::path::Path::new("setup/sql").join(file_name);
        let sql = fs::read_to_string(&path).map_err(|e| {
            AppError::Validation(format!("Cannot read SQL file '{}': {}", file_name, e))
        })?;
        db.execute_unprepared(&sql)
            .await
            .map_err(|e| AppError::Internal(anyhow::anyhow!("apply SQL file: {}", e)))?;
        return Ok(Json(json!({
            "appliedFile": file_name,
            "availableSqlFiles": available_sql_files,
            "schemaJustBootstrapped": schema_just_bootstrapped,
        })));
    }

    let (admin_email, admin_password) = create_default_admin(&config, &db).await?;
    let admin_id = get_user_id_by_email(&db, &admin_email).await?;
    grant_full_admin(&db, admin_id).await?;

    Ok(Json(json!({
        "message": "Default admin created!",
        "email": admin_email,
        "password": admin_password,
        "warning": "Change this password immediately!",
        "availableSqlFiles": available_sql_files,
        "schemaJustBootstrapped": schema_just_bootstrapped,
    })))
}

async fn ensure_schema_applied(db: &DatabaseConnection) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT to_regclass('public.users') IS NOT NULL AS exists"#,
            [],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("schema check: {}", e)))?;

    let schema_exists: bool = rows
        .first()
        .and_then(|r| r.try_get::<bool>("", "exists").ok())
        .unwrap_or(false);

    if schema_exists {
        return Ok(false);
    }

    let sql = fs::read_to_string("setup/sql/001_schema.sql")
        .map_err(|e| AppError::Internal(anyhow::anyhow!("read schema: {}", e)))?;
    db.execute_unprepared(&sql)
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("apply schema: {}", e)))?;
    Ok(true)
}

fn list_available_sql_files() -> Vec<String> {
    let dir = std::path::Path::new("setup/sql");
    let mut files: Vec<String> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|entry| {
                let entry = entry.ok()?;
                let name = entry.file_name().into_string().ok()?;
                if name.ends_with(".sql") && !name.ends_with(".auto") {
                    Some(name)
                } else {
                    None
                }
            })
            .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

async fn count_real_users(db: &DatabaseConnection) -> Result<i64, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT COUNT(*)::bigint AS cnt FROM users WHERE is_system = false"#,
            [],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("count users: {}", e)))?;
    let cnt: i64 = rows
        .first()
        .and_then(|r| r.try_get::<i64>("", "cnt").ok())
        .unwrap_or(0);
    Ok(cnt)
}

async fn create_default_admin(
    _config: &Config,
    db: &DatabaseConnection,
) -> Result<(String, String), AppError> {
    let email = "admin@breakglass.local".to_string();
    let password = crate::bootstrap::get_breakglass_admin_password();
    let salt = generate_salt();
    let hash = hash_password(&password, &salt)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("hash password: {}", e)))?;
    let id = Uuid::now_v7();

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO users (id, full_name, email, password_hash, password_salt, affiliation, status, is_protected, is_system, force_password_rotation, created_at, updated_at)
           SELECT $1, $2, $3, $4, $5, $6::user_affiliation, $7::user_status, $8, $9, $10, now(), now()
           WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = $3)"#,
        [
            id.into(),
            "System Administrator".into(),
            email.clone().into(),
            hash.into(),
            salt.into(),
            "agency".into(),
            "active".into(),
            true.into(),
            false.into(),
            false.into(),
        ],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("create admin: {}", e)))?;

    Ok((email, password))
}

async fn get_user_id_by_email(db: &DatabaseConnection, email: &str) -> Result<Uuid, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT id FROM users WHERE email = $1 LIMIT 1"#,
            [email.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("get user id: {}", e)))?;
    rows.first()
        .and_then(|r| r.try_get::<Uuid>("", "id").ok())
        .ok_or_else(|| AppError::Internal(anyhow::anyhow!("admin user not found after insert")))
}

async fn seed_admin_roles(db: &DatabaseConnection) -> Result<(), AppError> {
    // Mirrors PRECONFIGURED_ROLES in auth-admin-capabilities.ts.
    // capabilities arrays must stay in sync with that file.
    // DO UPDATE ensures existing rows get the correct capabilities on re-seed.
    let roles: &[(&str, &str, &str, &str, &[&str])] = &[
        (
            "00000000-0000-0000-0000-000000000001",
            "user_admin",
            "User Administrator",
            "Manage user accounts, approvals, and lifecycle operations",
            &["UserRead","UserInvite","UserApprove","UserReject","UserTombstone",
              "UserUntombstone","UserAffiliationChange","UserResetTwofa","UserResetPassword"],
        ),
        (
            "00000000-0000-0000-0000-000000000002",
            "org_structure_admin",
            "Cluster & Team Structure Administrator",
            "Manage organisations, clusters, teams, and team memberships",
            &["OrgRead","OrgCreate","OrgUpdate","OrgDelete",
              "ClusterRead","ClusterCreate","ClusterUpdate","ClusterDelete",
              "TeamRead","TeamCreate","TeamUpdate","TeamDelete",
              "TeamMemberRead","TeamMemberManage"],
        ),
        (
            "00000000-0000-0000-0000-000000000003",
            "systems_assets_admin",
            "Systems & Assets Administrator",
            "Manage systems, assets, and their mappings",
            &["SystemRead","SystemCreate","SystemUpdate","SystemDelete",
              "SystemMappingRead","SystemMappableTeamsRead","SystemOwnerManage",
              "TeamSystemMappingManage","OwnerPAMappingManage",
              "AssetRead","AssetCreate","AssetUpdate","AssetDelete","AssetSync",
              "UserRead"],
        ),
        (
            "00000000-0000-0000-0000-000000000004",
            "data_operator",
            "Data Operator",
            "Perform data operations including exports, imports, and resets",
            &["DataExport","DataImport","DataResetSeed","RequestAdminReset"],
        ),
        (
            "00000000-0000-0000-0000-000000000005",
            "config_audit_admin",
            "Configuration & Audit Administrator",
            "Manage application settings, notification templates, and view audit logs",
            &["ConfigAppSettingsRead","ConfigAppSettingsWrite",
              "ConfigEmailTemplateRead","ConfigEmailTemplateWrite",
              "AuditLogRead","AuditAccessLogRead","AuditSentNotificationsRead",
              "OrgAppSettingsRead","OrgAppSettingsWrite","OrgTemplateRead","OrgTemplateWrite"],
        ),
        (
            "00000000-0000-0000-0000-000000000006",
            "full_admin",
            "Full Administrator",
            "Full access to all admin capabilities and role management",
            &["UserRead","UserInvite","UserApprove","UserReject","UserTombstone",
              "UserUntombstone","UserAffiliationChange","UserResetTwofa","UserResetPassword",
              "OrgRead","OrgCreate","OrgUpdate","OrgDelete",
              "ClusterRead","ClusterCreate","ClusterUpdate","ClusterDelete",
              "TeamRead","TeamCreate","TeamUpdate","TeamDelete",
              "TeamMemberRead","TeamMemberManage",
              "SystemRead","SystemCreate","SystemUpdate","SystemDelete",
              "SystemMappingRead","SystemMappableTeamsRead","SystemOwnerManage",
              "TeamSystemMappingManage","OwnerPAMappingManage",
              "AssetRead","AssetCreate","AssetUpdate","AssetDelete","AssetSync",
              "DataExport","DataImport","DataResetSeed","RequestAdminReset",
              "ConfigAppSettingsRead","ConfigAppSettingsWrite","ConfigAppSettingsBulkTransfer",
              "ConfigEmailTemplateRead","ConfigEmailTemplateWrite",
              "AuditLogRead","AuditAccessLogRead","AuditSentNotificationsRead",
              "OrgAppSettingsRead","OrgAppSettingsWrite","OrgTemplateRead","OrgTemplateWrite",
              "AdminRolesManage"],
        ),
    ];

    for (id, key, name, description, caps) in roles {
        // Pass capabilities as a JSON array parameter; PostgreSQL expands to text[].
        let caps_json = serde_json::to_string(caps)
            .map_err(|e| AppError::Internal(anyhow::anyhow!("serialize caps for {}: {}", key, e)))?;
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO admin_roles (id, key, name, description, capabilities, is_system_role, created_at, updated_at)
               VALUES ($1, $2, $3, $4, ARRAY(SELECT jsonb_array_elements_text($5::jsonb)), $6, now(), now())
               ON CONFLICT (key) DO UPDATE SET capabilities = EXCLUDED.capabilities,
                 name = EXCLUDED.name, description = EXCLUDED.description"#,
            [
                id.parse::<Uuid>()
                    .expect("all role IDs are hardcoded valid UUID literals")
                    .into(),
                (*key).into(),
                (*name).into(),
                (*description).into(),
                caps_json.into(),
                true.into(),
            ],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("seed role {}: {}", key, e)))?;
    }
    Ok(())
}

async fn grant_full_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<(), AppError> {
    let grant_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO user_admin_role_grants (id, user_id, role_key, granted_by, granted_at)
           VALUES ($1, $2, $3, $4, now())
           ON CONFLICT DO NOTHING"#,
        [
            grant_id.into(),
            user_id.into(),
            "full_admin".into(),
            user_id.into(),
        ],
    ))
    .await
    .map_err(|e| AppError::Internal(anyhow::anyhow!("grant full_admin: {}", e)))?;
    Ok(())
}
