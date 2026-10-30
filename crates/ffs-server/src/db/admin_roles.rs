// Admin role grant helpers — capability scope resolution for PORT-2.x routes.

use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

use crate::errors::AppError;

// All 54 capabilities from auth-admin-capabilities.ts ALL_CAPABILITIES.
pub const ALL_CAPABILITIES: &[&str] = &[
    // User Management
    "UserRead", "UserInvite", "UserApprove", "UserReject",
    "UserTombstone", "UserUntombstone", "UserAffiliationChange",
    "UserResetTwofa", "UserResetPassword",
    // Organization Structure
    "OrgRead", "OrgCreate", "OrgUpdate", "OrgDelete",
    "ClusterRead", "ClusterCreate", "ClusterUpdate", "ClusterDelete",
    "TeamRead", "TeamCreate", "TeamUpdate", "TeamDelete",
    "TeamMemberRead", "TeamMemberManage",
    // Systems & Assets
    "SystemRead", "SystemCreate", "SystemUpdate", "SystemDelete",
    "SystemMappingRead", "SystemMappableTeamsRead", "SystemOwnerManage",
    "TeamSystemMappingManage", "OwnerPAMappingManage",
    "AssetRead", "AssetCreate", "AssetUpdate", "AssetDelete", "AssetSync",
    // Data Operations
    "DataExport", "DataImport", "DataResetSeed", "RequestAdminReset",
    // Configuration
    "ConfigAppSettingsRead", "ConfigAppSettingsWrite", "ConfigAppSettingsBulkTransfer",
    "ConfigEmailTemplateRead", "ConfigEmailTemplateWrite",
    // Audit
    "AuditLogRead", "AuditAccessLogRead", "AuditSentNotificationsRead",
    // Organisation-scoped config siblings (addendum-137 §6)
    "OrgAppSettingsRead", "OrgAppSettingsWrite", "OrgTemplateRead", "OrgTemplateWrite",
    // Admin
    "AdminRolesManage",
];

/// In-memory role → capabilities map (mirrors PRECONFIGURED_ROLES in auth-admin-capabilities.ts).
/// Used as authoritative source so DB NULL admin_roles.capabilities doesn't break resolution
/// (Deno does the same in-memory fallback via PRECONFIGURED_ROLES).
pub const ROLE_CAPABILITIES: &[(&str, &[&str])] = &[
    ("user_admin", &[
        "UserRead","UserInvite","UserApprove","UserReject","UserTombstone",
        "UserUntombstone","UserAffiliationChange","UserResetTwofa","UserResetPassword",
    ]),
    ("org_structure_admin", &[
        "OrgRead","OrgCreate","OrgUpdate","OrgDelete",
        "ClusterRead","ClusterCreate","ClusterUpdate","ClusterDelete",
        "TeamRead","TeamCreate","TeamUpdate","TeamDelete",
        "TeamMemberRead","TeamMemberManage",
    ]),
    ("systems_assets_admin", &[
        "SystemRead","SystemCreate","SystemUpdate","SystemDelete",
        "SystemMappingRead","SystemMappableTeamsRead","SystemOwnerManage",
        "TeamSystemMappingManage","OwnerPAMappingManage",
        "AssetRead","AssetCreate","AssetUpdate","AssetDelete","AssetSync",
        "UserRead",
    ]),
    ("data_operator", &[
        "DataExport","DataImport","DataResetSeed","RequestAdminReset",
    ]),
    ("config_audit_admin", &[
        "ConfigAppSettingsRead","ConfigAppSettingsWrite",
        "ConfigEmailTemplateRead","ConfigEmailTemplateWrite",
        "AuditLogRead","AuditAccessLogRead","AuditSentNotificationsRead",
        "OrgAppSettingsRead","OrgAppSettingsWrite","OrgTemplateRead","OrgTemplateWrite",
    ]),
    ("full_admin", &[
        "UserRead","UserInvite","UserApprove","UserReject","UserTombstone",
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
        "AdminRolesManage",
    ]),
];

/// DB-backed capability resolution (addendum-072): custom roles exist only in
/// `admin_roles.capabilities`; system roles fall back to the in-memory catalogue
/// only when their stored array is empty (un-migrated / cleared seed row).
pub async fn role_has_capability<C: ConnectionTrait>(
    db: &C,
    role_key: &str,
    capability: &str,
) -> Result<bool, AppError> {
    Ok(get_role_capabilities(db, role_key).await?.contains(capability))
}

/// Org-scopeable capability strings (from auth-admin-capabilities.ts).
/// Canonical definition — capabilities.rs imports this rather than duplicating.
pub const ORG_SCOPEABLE: &[&str] = &[
    "OrgRead", "OrgUpdate", "OrgDelete", "UserRead", "UserInvite", "UserApprove",
    "UserTombstone", "UserUntombstone", "UserAffiliationChange", "UserResetTwofa",
    "UserResetPassword", "AuditLogRead", "OrgAppSettingsRead", "OrgAppSettingsWrite",
    "OrgTemplateRead", "OrgTemplateWrite", "ClusterRead", "ClusterCreate", "ClusterUpdate",
    "ClusterDelete", "TeamRead", "TeamCreate", "TeamUpdate", "TeamDelete", "TeamMemberRead",
    "TeamMemberManage", "SystemRead", "SystemCreate", "SystemUpdate", "SystemDelete",
    "SystemMappingRead", "SystemMappableTeamsRead", "SystemOwnerManage",
    "TeamSystemMappingManage", "OwnerPAMappingManage", "AssetRead", "AssetCreate",
    "AssetUpdate", "AssetDelete", "AssetSync",
];

/// Result of capability scope resolution.
pub enum ScopeKind {
    /// User has a global (non-org-scoped) grant with this capability.
    Global,
    /// User has only org-scoped grants; vec holds the permitted org IDs.
    Scoped(Vec<Uuid>),
    /// User has no grants with this capability.
    None,
}

/// Resolve the scope of a capability for a given user.
/// Global > Scoped > None — returns the first matching tier.
/// Capabilities are DB-backed (custom roles) with the system-role fallback.
pub async fn resolve_admin_capability_scope(
    db: &DatabaseConnection,
    user_id: Uuid,
    capability: &str,
) -> Result<ScopeKind, AppError> {
    // 1. Check global (organization_id IS NULL) grants via in-memory caps.
    let global_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT role_key FROM user_admin_role_grants
               WHERE user_id = $1 AND revoked_at IS NULL AND organization_id IS NULL"#,
            [user_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;

    for row in &global_rows {
        let role_key = row
            .try_get::<String>("", "role_key")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("read global role_key: {}", e)))?;
        if role_has_capability(db, &role_key, capability).await? {
            return Ok(ScopeKind::Global);
        }
    }

    // 2. Only certain capabilities are org-scopeable.
    if !ORG_SCOPEABLE.contains(&capability) {
        return Ok(ScopeKind::None);
    }

    // 3. Check org-scoped grants.
    let scoped_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT role_key, organization_id FROM user_admin_role_grants
               WHERE user_id = $1 AND revoked_at IS NULL AND organization_id IS NOT NULL"#,
            [user_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;

    let mut org_ids: Vec<Uuid> = Vec::new();
    for r in &scoped_rows {
        let role_key = r
            .try_get::<String>("", "role_key")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("read scoped role_key: {}", e)))?;
        if !role_has_capability(db, &role_key, capability).await? {
            continue;
        }
        let org_id = r
            .try_get::<Uuid>("", "organization_id")
            .map_err(|e| AppError::Internal(anyhow::anyhow!("read organization_id: {}", e)))?;
        org_ids.push(org_id);
    }
    org_ids.dedup();

    if org_ids.is_empty() {
        return Ok(ScopeKind::None);
    }
    Ok(ScopeKind::Scoped(org_ids))
}

/// Returns true if user has any non-revoked admin role grant.
pub async fn user_has_any_admin_role(db: &DatabaseConnection, user_id: Uuid) -> Result<bool, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT 1 FROM user_admin_role_grants
               WHERE user_id = $1 AND revoked_at IS NULL
               LIMIT 1"#,
            [user_id.into()],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;
    Ok(!rows.is_empty())
}

/// Returns all active admin users (id, email) for notification fan-out.
pub async fn get_active_admin_emails(db: &DatabaseConnection) -> Result<Vec<(Uuid, String)>, AppError> {
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT DISTINCT u.id, u.email
               FROM user_admin_role_grants g
               JOIN users u ON u.id = g.user_id
               WHERE g.revoked_at IS NULL
                 AND u.status = 'active'"#,
            [],
        ))
        .await
        .map_err(|e| AppError::Internal(anyhow::anyhow!("DB: {}", e)))?;

    rows.iter()
        .map(|r| {
            let id: Uuid = r.try_get("", "id").map_err(|e| AppError::Internal(anyhow::anyhow!("row: {}", e)))?;
            let email: String = r.try_get("", "email").map_err(|e| AppError::Internal(anyhow::anyhow!("row: {}", e)))?;
            Ok((id, email))
        })
        .collect()
}

// ── Role metadata / grants / CRUD (addendum-066, -072, -137) ─────────────────

use std::collections::{BTreeMap, BTreeSet};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminRole {
    pub id: Uuid,
    pub key: String,
    pub name: String,
    pub description: String,
    pub capabilities: Vec<String>,
    pub is_system_role: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdminRoleGrant {
    pub id: Uuid,
    pub user_id: Uuid,
    pub role_key: String,
    pub granted_by: Uuid,
    pub granted_at: DateTime<Utc>,
    pub revoked_at: Option<DateTime<Utc>>,
    pub revoked_by: Option<Uuid>,
    pub revocation_reason: Option<String>,
    pub organization_id: Option<Uuid>,
}

fn db_err(context: &str) -> impl Fn(sea_orm::DbErr) -> AppError + '_ {
    move |e| AppError::Internal(anyhow::anyhow!("{context}: {e}"))
}

fn row_to_role(r: &sea_orm::QueryResult) -> Result<AdminRole, AppError> {
    Ok(AdminRole {
        id: r.try_get("", "id").map_err(db_err("role id"))?,
        key: r.try_get("", "key").map_err(db_err("role key"))?,
        name: r.try_get("", "name").map_err(db_err("role name"))?,
        description: r.try_get("", "description").map_err(db_err("role description"))?,
        capabilities: r.try_get("", "capabilities").map_err(db_err("role capabilities"))?,
        is_system_role: r.try_get("", "is_system_role").map_err(db_err("role system flag"))?,
        created_at: r.try_get("", "created_at").map_err(db_err("role created_at"))?,
        updated_at: r.try_get("", "updated_at").map_err(db_err("role updated_at"))?,
    })
}

fn row_to_grant(r: &sea_orm::QueryResult) -> Result<AdminRoleGrant, AppError> {
    Ok(AdminRoleGrant {
        id: r.try_get("", "id").map_err(db_err("grant id"))?,
        user_id: r.try_get("", "user_id").map_err(db_err("grant user_id"))?,
        role_key: r.try_get("", "role_key").map_err(db_err("grant role_key"))?,
        granted_by: r.try_get("", "granted_by").map_err(db_err("grant granted_by"))?,
        granted_at: r.try_get("", "granted_at").map_err(db_err("grant granted_at"))?,
        revoked_at: r.try_get("", "revoked_at").map_err(db_err("grant revoked_at"))?,
        revoked_by: r.try_get("", "revoked_by").map_err(db_err("grant revoked_by"))?,
        revocation_reason: r.try_get("", "revocation_reason").map_err(db_err("grant revocation_reason"))?,
        organization_id: r.try_get("", "organization_id").map_err(db_err("grant organization_id"))?,
    })
}

pub fn is_valid_capability(capability: &str) -> bool {
    ALL_CAPABILITIES.contains(&capability)
}

pub fn is_system_role(role_key: &str) -> bool {
    ROLE_CAPABILITIES.iter().any(|(k, _)| *k == role_key)
}

pub fn preconfigured_capabilities(role_key: &str) -> BTreeSet<String> {
    ROLE_CAPABILITIES.iter().find(|(k, _)| *k == role_key)
        .map(|(_, caps)| caps.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}

pub async fn get_admin_role_metadata<C: ConnectionTrait>(db: &C, role_key: &str) -> Result<Option<AdminRole>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT * FROM admin_roles WHERE key = $1",
        [role_key.into()],
    )).await.map_err(db_err("get role"))?;
    rows.first().map(row_to_role).transpose()
}

pub async fn list_admin_roles<C: ConnectionTrait>(db: &C) -> Result<Vec<AdminRole>, AppError> {
    let rows = db.query_all(Statement::from_string(
        DbBackend::Postgres,
        "SELECT * FROM admin_roles ORDER BY is_system_role DESC, name".to_string(),
    )).await.map_err(db_err("list roles"))?;
    rows.iter().map(row_to_role).collect()
}

pub async fn is_valid_role<C: ConnectionTrait>(db: &C, role_key: &str) -> Result<bool, AppError> {
    Ok(is_system_role(role_key) || get_admin_role_metadata(db, role_key).await?.is_some())
}

pub async fn get_role_capabilities<C: ConnectionTrait>(db: &C, role_key: &str) -> Result<BTreeSet<String>, AppError> {
    let db_caps = get_admin_role_metadata(db, role_key).await?.map(|r| r.capabilities).unwrap_or_default();
    if !db_caps.is_empty() {
        return Ok(db_caps.into_iter().collect());
    }
    Ok(preconfigured_capabilities(role_key))
}

pub async fn seed_admin_roles<C: ConnectionTrait>(db: &C) -> Result<(), AppError> {
    for (i, (key, _)) in ROLE_CAPABILITIES.iter().enumerate() {
        let (name, description) = role_display(key);
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO admin_roles (id, key, name, description, is_system_role)
               VALUES ($1::uuid,$2,$3,$4,true) ON CONFLICT (key) DO NOTHING"#,
            [format!("00000000-0000-0000-0000-{:012}", i + 1).into(), (*key).into(), name.into(), description.into()],
        )).await.map_err(db_err("seed role"))?;
    }
    Ok(())
}

fn role_display(key: &str) -> (&'static str, &'static str) {
    match key {
        "user_admin" => ("User Administrator", "Manage user accounts, approvals, and lifecycle operations"),
        "org_structure_admin" => ("Cluster & Team Structure Administrator", "Manage organisations, clusters, teams, and team memberships"),
        "systems_assets_admin" => ("Systems & Assets Administrator", "Manage systems, assets, and their mappings"),
        "data_operator" => ("Data Operator", "Export, import, and reset operational data"),
        "config_audit_admin" => ("Configuration & Audit Administrator", "Manage application configuration and read audit logs"),
        "full_admin" => ("Full Administrator", "Full access to all admin capabilities and role management"),
        _ => ("Custom Role", ""),
    }
}

async fn audit<C: ConnectionTrait>(db: &C, actor: Uuid, action: &str, target_type: &str, target_id: &str, details: Value) -> Result<(), AppError> {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4::audit_target_type,$5,$6)",
        [Uuid::now_v7().into(), actor.into(), action.into(), target_type.into(), target_id.into(), details.into()],
    )).await.map_err(db_err("audit"))?;
    Ok(())
}

pub async fn list_admin_role_grants<C: ConnectionTrait>(db: &C, user_id: Uuid, include_revoked: bool) -> Result<Vec<AdminRoleGrant>, AppError> {
    let sql = if include_revoked {
        "SELECT * FROM user_admin_role_grants WHERE user_id = $1 ORDER BY granted_at, id"
    } else {
        "SELECT * FROM user_admin_role_grants WHERE user_id = $1 AND revoked_at IS NULL ORDER BY granted_at, id"
    };
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, sql, [user_id.into()]))
        .await.map_err(db_err("list grants"))?;
    rows.iter().map(row_to_grant).collect()
}

pub async fn list_all_active_admin_role_grants<C: ConnectionTrait>(db: &C) -> Result<Vec<AdminRoleGrant>, AppError> {
    let rows = db.query_all(Statement::from_string(
        DbBackend::Postgres,
        "SELECT * FROM user_admin_role_grants WHERE revoked_at IS NULL ORDER BY granted_at, id".to_string(),
    )).await.map_err(db_err("list all grants"))?;
    rows.iter().map(row_to_grant).collect()
}

pub async fn get_users_with_role<C: ConnectionTrait>(db: &C, role_key: &str, include_revoked: bool) -> Result<Vec<Uuid>, AppError> {
    let sql = if include_revoked {
        "SELECT DISTINCT user_id FROM user_admin_role_grants WHERE role_key = $1 ORDER BY user_id"
    } else {
        "SELECT DISTINCT user_id FROM user_admin_role_grants WHERE role_key = $1 AND revoked_at IS NULL ORDER BY user_id"
    };
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, sql, [role_key.into()]))
        .await.map_err(db_err("users with role"))?;
    rows.iter().map(|r| r.try_get("", "user_id").map_err(db_err("user_id"))).collect()
}

pub async fn get_effective_admin_capabilities<C: ConnectionTrait>(db: &C, user_id: Uuid) -> Result<BTreeSet<String>, AppError> {
    let mut caps = BTreeSet::new();
    for grant in list_admin_role_grants(db, user_id, false).await? {
        if grant.organization_id.is_none() {
            caps.extend(get_role_capabilities(db, &grant.role_key).await?);
        }
    }
    Ok(caps)
}

pub async fn get_scoped_admin_capabilities<C: ConnectionTrait>(db: &C, user_id: Uuid) -> Result<BTreeMap<Uuid, BTreeSet<String>>, AppError> {
    let mut by_org: BTreeMap<Uuid, BTreeSet<String>> = BTreeMap::new();
    for grant in list_admin_role_grants(db, user_id, false).await? {
        if let Some(org) = grant.organization_id {
            let bucket = by_org.entry(org).or_default();
            for cap in get_role_capabilities(db, &grant.role_key).await? {
                if ORG_SCOPEABLE.contains(&cap.as_str()) { bucket.insert(cap); }
            }
        }
    }
    Ok(by_org)
}

pub async fn has_effective_admin_capability<C: ConnectionTrait>(db: &C, user_id: Uuid, capability: &str) -> Result<bool, AppError> {
    if !is_valid_capability(capability) {
        return Err(AppError::validation(format!("Unknown capability: {capability}")));
    }
    Ok(get_effective_admin_capabilities(db, user_id).await?.contains(capability))
}

pub async fn grant_admin_role<C: ConnectionTrait>(
    db: &C, user_id: Uuid, role_key: &str, granted_by: Uuid, reason: Option<&str>, organization_id: Option<Uuid>,
) -> Result<AdminRoleGrant, AppError> {
    let role = get_admin_role_metadata(db, role_key).await?;
    if !is_system_role(role_key) && role.is_none() {
        return Err(AppError::validation(format!("Unknown admin role: {role_key}")));
    }
    if let Some(org) = organization_id {
        let live = db.query_one(Statement::from_sql_and_values(
            DbBackend::Postgres, "SELECT 1 FROM organizations WHERE id = $1 AND expires_after IS NULL", [org.into()],
        )).await.map_err(db_err("scope org"))?.is_some();
        if !live { return Err(AppError::validation(format!("Unknown organisation: {org}"))); }
        let caps = get_role_capabilities(db, role_key).await?;
        if !caps.iter().any(|c| ORG_SCOPEABLE.contains(&c.as_str())) {
            return Err(AppError::validation(format!("Role {role_key} has no org-scopeable capabilities — it cannot be granted with an organisation scope.")));
        }
    }
    let id = Uuid::now_v7();
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO user_admin_role_grants (id, user_id, role_key, granted_by, granted_at, organization_id)
           VALUES ($1,$2,$3,$4,now(),$5) RETURNING *"#,
        [id.into(), user_id.into(), role_key.into(), granted_by.into(), organization_id.into()],
    )).await.map_err(db_err("grant role"))?;
    let grant = row_to_grant(rows.first().ok_or_else(|| AppError::Internal(anyhow::anyhow!("grant missing returning row")))?)?;
    let role_name = role.map(|r| r.name).unwrap_or_else(|| role_display(role_key).0.to_string());
    audit(db, granted_by, "admin_role_grant", "user", &user_id.to_string(), json!({
        "roleKey": role_key, "roleName": role_name, "grantedBy": granted_by, "reason": reason, "organizationId": organization_id
    })).await?;
    Ok(grant)
}

pub async fn revoke_admin_role<C: ConnectionTrait>(db: &C, grant_id: Uuid, revoked_by: Uuid, reason: Option<&str>) -> Result<Option<AdminRoleGrant>, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"UPDATE user_admin_role_grants SET revoked_at = now(), revoked_by = $2, revocation_reason = $3
           WHERE id = $1 AND revoked_at IS NULL RETURNING *"#,
        [grant_id.into(), revoked_by.into(), reason.into()],
    )).await.map_err(db_err("revoke role"))?;
    let Some(row) = rows.first() else { return Ok(None); };
    let grant = row_to_grant(row)?;
    audit(db, revoked_by, "admin_role_revoke", "admin_role_grant", &grant_id.to_string(), json!({
        "userId": grant.user_id, "roleKey": grant.role_key, "revokedBy": revoked_by, "reason": reason
    })).await?;
    Ok(Some(grant))
}

pub async fn revoke_all_admin_roles<C: ConnectionTrait>(db: &C, user_id: Uuid, revoked_by: Uuid, reason: Option<&str>) -> Result<Vec<AdminRoleGrant>, AppError> {
    let active = list_admin_role_grants(db, user_id, false).await?;
    let mut out = Vec::new();
    for grant in active {
        if let Some(revoked) = revoke_admin_role(db, grant.id, revoked_by, reason).await? { out.push(revoked); }
    }
    Ok(out)
}

fn validate_role_key(key: &str) -> Result<(), AppError> {
    let ok = (1..=64).contains(&key.len())
        && key.as_bytes().first().is_some_and(|b| b.is_ascii_lowercase())
        && key.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_');
    if ok { Ok(()) } else { Err(AppError::validation("Role key must be 1-64 chars, lowercase letters/digits/underscores, starting with a letter.")) }
}

fn validate_role_input(name: &str, description: &str, capabilities: &[String]) -> Result<(), AppError> {
    let n = name.trim().chars().count();
    if n == 0 || n > 100 { return Err(AppError::validation("Role name is required and must be 1-100 characters.")); }
    if description.chars().count() > 500 { return Err(AppError::validation("Role description is required and must be 500 characters or fewer.")); }
    if !capabilities.iter().all(|c| is_valid_capability(c)) { return Err(AppError::validation("capabilities must be an array of known capability names.")); }
    Ok(())
}

pub async fn create_admin_role<C: ConnectionTrait>(db: &C, key: &str, name: &str, description: &str, capabilities: Vec<String>, created_by: Uuid) -> Result<AdminRole, AppError> {
    validate_role_key(key)?;
    validate_role_input(name, description, &capabilities)?;
    if is_system_role(key) { return Err(AppError::validation(format!("Cannot create a role with reserved system-role key: {key}"))); }
    if get_admin_role_metadata(db, key).await?.is_some() { return Err(AppError::validation(format!("Role key already exists: {key}"))); }
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO admin_roles (id, key, name, description, is_system_role, capabilities, created_at, updated_at)
           VALUES ($1,$2,$3,$4,false,$5,now(),now()) RETURNING *"#,
        [Uuid::now_v7().into(), key.into(), name.trim().into(), description.into(), capabilities.clone().into()],
    )).await.map_err(db_err("create role"))?;
    let role = row_to_role(rows.first().ok_or_else(|| AppError::Internal(anyhow::anyhow!("role missing returning row")))?)?;
    audit(db, created_by, "admin_role.created", "admin_role", key, json!({"name": name.trim(), "capabilities": capabilities})).await?;
    Ok(role)
}

#[derive(Default)]
pub struct UpdateAdminRoleInput {
    pub name: Option<String>,
    pub description: Option<String>,
    pub capabilities: Option<Vec<String>>,
}

pub async fn update_admin_role<C: ConnectionTrait>(db: &C, key: &str, input: UpdateAdminRoleInput, updated_by: Uuid) -> Result<Option<AdminRole>, AppError> {
    let existing = get_admin_role_metadata(db, key).await?
        .ok_or_else(|| AppError::validation(format!("Role not found: {key}")))?;
    let mut changed = Vec::new();
    if input.name.is_some() { changed.push("name"); }
    if input.description.is_some() { changed.push("description"); }
    if input.capabilities.is_some() { changed.push("capabilities"); }
    let name = input.name.unwrap_or(existing.name);
    let description = input.description.unwrap_or(existing.description);
    let capabilities = input.capabilities.unwrap_or(existing.capabilities);
    validate_role_input(&name, &description, &capabilities)?;
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE admin_roles SET name=$2, description=$3, capabilities=$4, updated_at=now() WHERE key=$1 RETURNING *",
        [key.into(), name.trim().into(), description.into(), capabilities.clone().into()],
    )).await.map_err(db_err("update role"))?;
    let role = rows.first().map(row_to_role).transpose()?;
    audit(db, updated_by, "admin_role.updated", "admin_role", key, json!({"name": name.trim(), "capabilities": capabilities, "changedFields": changed})).await?;
    Ok(role)
}

pub async fn delete_admin_role<C: ConnectionTrait>(db: &C, key: &str, deleted_by: Uuid) -> Result<(), AppError> {
    let existing = get_admin_role_metadata(db, key).await?
        .ok_or_else(|| AppError::not_found(format!("Role not found: {key}")))?;
    if existing.is_system_role { return Err(AppError::validation(format!("System role {key} cannot be deleted."))); }
    let still = list_all_active_admin_role_grants(db).await?.iter().filter(|g| g.role_key == key).count();
    if still > 0 { return Err(AppError::validation(format!("Role {key} is still granted to {still} user(s). Revoke those grants first."))); }
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "DELETE FROM user_admin_role_grants WHERE role_key=$1", [key.into()]))
        .await.map_err(db_err("purge role grants"))?;
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres, "DELETE FROM admin_roles WHERE key=$1", [key.into()]))
        .await.map_err(db_err("delete role"))?;
    audit(db, deleted_by, "admin_role.deleted", "admin_role", key, json!({"name": existing.name})).await
}

#[derive(Debug, Clone)]
pub struct DesiredRoleGrant { pub role_key: String, pub organization_id: Option<Uuid> }

pub async fn set_user_roles<C: ConnectionTrait>(db: &C, user_id: Uuid, desired: Vec<DesiredRoleGrant>, acting_user_id: Uuid, reason: &str) -> Result<(), AppError> {
    for g in &desired {
        if !is_valid_role(db, &g.role_key).await? { return Err(AppError::validation(format!("Unknown admin role: {}", g.role_key))); }
    }
    let active = list_admin_role_grants(db, user_id, false).await?;
    let key = |role: &str, org: Option<Uuid>| format!("{role}\0{}", org.map(|o| o.to_string()).unwrap_or_default());
    let desired_keys: BTreeSet<String> = desired.iter().map(|g| key(&g.role_key, g.organization_id)).collect();
    for g in &desired {
        if !active.iter().any(|a| a.role_key == g.role_key && a.organization_id == g.organization_id) {
            grant_admin_role(db, user_id, &g.role_key, acting_user_id, Some(reason), g.organization_id).await?;
        }
    }
    for a in active {
        if !desired_keys.contains(&key(&a.role_key, a.organization_id)) {
            revoke_admin_role(db, a.id, acting_user_id, Some(reason)).await?;
        }
    }
    Ok(())
}


/// True when the user holds at least one live GLOBAL admin grant.  Scoped
/// org admins are intentionally excluded: request visibility and other
/// global-only affordances must not leak through a mere org grant (R6).
pub async fn has_global_admin_grant<C: ConnectionTrait>(db: &C, user_id: Uuid) -> Result<bool, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT 1
           FROM user_admin_role_grants
           WHERE user_id = $1 AND revoked_at IS NULL AND organization_id IS NULL
           LIMIT 1"#,
        [user_id.into()],
    )).await?;
    Ok(!rows.is_empty())
}
