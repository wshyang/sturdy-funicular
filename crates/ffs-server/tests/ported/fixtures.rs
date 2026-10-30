//! Shared fixtures for ported legacy suites.
//! Fixture builders write directly to Postgres (mirroring test/backend/deno/helpers.tsx);
//! the endpoints under test are still exercised over HTTP against the real binary.

#![allow(dead_code)]

use anyhow::{anyhow, bail, Result};
use ffs_test_support::TestApp;
use reqwest::Method;
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

pub const TOTP_SECRET: &str = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

#[derive(Clone, Debug)]
pub struct FixtureUser {
    pub id: Uuid,
    pub email: String,
    pub password: String,
}

#[derive(Clone, Debug)]
pub struct WiredSystem {
    pub system_id: Uuid,
    pub vendor_cluster_id: Uuid,
    pub agency_cluster_id: Uuid,
    pub agency_org_id: Uuid,
    pub vendor_l1: Uuid,
    pub vendor_l2: Uuid,
    pub agency_l1: Uuid,
}

pub async fn prepare(app: &TestApp) -> Result<()> {
    let (status, body) = app.get_json("/setup?file=001_schema.sql").await?;
    if status != reqwest::StatusCode::OK {
        bail!("fixture schema preparation failed: {status} {body}");
    }
    Ok(())
}

pub fn unique_email(label: &str) -> String {
    format!("{}-{}@test.local", label, Uuid::now_v7().simple())
}

pub async fn create_active_user(
    app: &TestApp,
    full_name: &str,
    email: &str,
    password: &str,
    affiliation: &str,
    enroll_2fa: bool,
) -> Result<FixtureUser> {
    let salt = ffs_server::auth::password::generate_salt();
    let hash = ffs_server::auth::password::hash_password(password, &salt)?;
    let id = Uuid::now_v7();
    let secret = if enroll_2fa { Some(TOTP_SECRET) } else { None };
    sqlx::query(
        r#"INSERT INTO users
           (id, full_name, email, password_hash, password_salt, affiliation, status,
            approved_at, totp_secret, totp_enrolled_at, force_password_rotation, is_protected, is_system)
           VALUES ($1,$2,$3,$4,$5,$6::user_affiliation,'active',now(),$7,
            CASE WHEN $7::text IS NULL THEN NULL ELSE now() END,false,false,false)"#,
    )
    .bind(id)
    .bind(full_name)
    .bind(email)
    .bind(hash)
    .bind(salt)
    .bind(affiliation)
    .bind(secret)
    .execute(app.db())
    .await?;
    Ok(FixtureUser { id, email: email.to_string(), password: password.to_string() })
}

pub async fn create_admin(app: &TestApp, password: &str) -> Result<FixtureUser> {
    let email = unique_email("admin");
    let user = create_active_user(app, "Test Admin", &email, password, "agency", true).await?;
    sqlx::query(
        r#"INSERT INTO user_admin_role_grants (id, user_id, role_key, granted_by, granted_at)
           VALUES ($1,$2,'full_admin',$2,now())"#,
    )
    .bind(Uuid::now_v7())
    .bind(user.id)
    .execute(app.db())
    .await?;
    Ok(user)
}

pub async fn login_as(app: &TestApp, email: &str, password: &str) -> Result<Value> {
    let (status, data) = app
        .json_with_headers(
            Method::POST,
            "/auth/login",
            &[("X-Session-Transport", "bearer")],
            Some(json!({ "email": email, "password": password })),
        )
        .await?;
    if status != reqwest::StatusCode::OK {
        bail!("login failed for {email}: {status} {data}");
    }
    let mut data = data;
    if data["needs2faVerification"] == true {
        let row = sqlx::query("SELECT totp_secret FROM users WHERE email = $1")
            .bind(email)
            .fetch_optional(app.db())
            .await?;
        let secret: Option<String> = row.and_then(|r| r.try_get("totp_secret").ok());
        if let Some(secret) = secret {
            let session = data["session"].as_str().ok_or_else(|| anyhow!("login missing session"))?;
            let code = ffs_server::auth::totp::generate_totp_code(&secret)?;
            let (vstatus, vbody) = app
                .json_with_headers(
                    Method::POST,
                    "/auth/2fa/verify",
                    &[("X-Session-Token", session)],
                    Some(json!({ "code": code })),
                )
                .await?;
            if vstatus != reqwest::StatusCode::OK {
                bail!("2FA verify failed for {email}: {vstatus} {vbody}");
            }
            if let Some(sess) = vbody["session"].as_str() { data["session"] = serde_json::json!(sess); }
        }
    }
    Ok(data)
}

pub async fn login_user(app: &TestApp, user: &FixtureUser) -> Result<Value> {
    login_as(app, &user.email, &user.password).await
}

pub fn session_of(login: &Value) -> Result<String> {
    login["session"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| anyhow!("login response missing session"))
}

pub async fn fixture_fallback_org_id(app: &TestApp, created_by: Uuid) -> Result<Uuid> {
    fallback_org(app, created_by).await
}

pub fn unique_name(label: &str) -> String {
    format!("{}-{}", label, Uuid::now_v7().simple())
}

async fn fallback_org(app: &TestApp, created_by: Uuid) -> Result<Uuid> {
    if let Some(row) = sqlx::query("SELECT id FROM organizations WHERE name = 'Fixture Fallback Org' AND expires_after IS NULL")
        .fetch_optional(app.db())
        .await?
    {
        return Ok(row.try_get("id")?);
    }
    let id = Uuid::now_v7();
    sqlx::query(
        "INSERT INTO organizations (id, name, short_code, created_by) VALUES ($1,'Fixture Fallback Org','FFA',$2)",
    )
    .bind(id)
    .bind(created_by)
    .execute(app.db())
    .await?;
    Ok(id)
}

async fn create_cluster(app: &TestApp, kind: &str, created_by: Uuid, org_id: Uuid) -> Result<Uuid> {
    let id = Uuid::now_v7();
    let name = format!("{kind}-cluster-{}", &id.simple().to_string()[24..]);
    sqlx::query(
        "INSERT INTO clusters (id, name, type, created_by, organization_id) VALUES ($1,$2,$3::cluster_type,$4,$5)",
    )
    .bind(id)
    .bind(name)
    .bind(kind)
    .bind(created_by)
    .bind(org_id)
    .execute(app.db())
    .await?;
    Ok(id)
}

async fn create_team(app: &TestApp, cluster_id: Uuid, level: i16, created_by: Uuid) -> Result<Uuid> {
    let id = Uuid::now_v7();
    let name = format!("team-l{level}-{}", &id.simple().to_string()[..8]);
    sqlx::query("INSERT INTO teams (id, cluster_id, name, level, created_by) VALUES ($1,$2,$3,$4,$5)")
        .bind(id)
        .bind(cluster_id)
        .bind(name)
        .bind(level)
        .bind(created_by)
        .execute(app.db())
        .await?;
    Ok(id)
}

pub async fn create_wired_system(app: &TestApp, created_by: Uuid, owner: &FixtureUser) -> Result<WiredSystem> {
    let org_id = fallback_org(app, created_by).await?;
    let vendor_cluster_id = create_cluster(app, "vendor", created_by, org_id).await?;
    let agency_cluster_id = create_cluster(app, "agency", created_by, org_id).await?;
    let vendor_l1 = create_team(app, vendor_cluster_id, 1, created_by).await?;
    let vendor_l2 = create_team(app, vendor_cluster_id, 2, created_by).await?;
    let agency_l1 = create_team(app, agency_cluster_id, 1, created_by).await?;

    let system_id = Uuid::now_v7();
    let short_code = format!("S{}", &system_id.simple().to_string()[24..].to_uppercase());
    let name = format!("Test System {}", &system_id.simple().to_string()[24..]);

    let mut tx = app.db().begin().await?;
    sqlx::query("INSERT INTO systems (id, short_code, name, agency_cluster_id, created_by) VALUES ($1,$2,$3,$4,$5)")
        .bind(system_id)
        .bind(short_code)
        .bind(name)
        .bind(agency_cluster_id)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO system_organizations (id, system_id, organization_id, role, created_by) VALUES ($1,$2,$3,'owner',$4)",
    )
    .bind(Uuid::now_v7())
    .bind(system_id)
    .bind(org_id)
    .bind(created_by)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO system_vendor_clusters (id, system_id, cluster_id, ordinal) VALUES ($1,$2,$3,1)")
        .bind(Uuid::now_v7())
        .bind(system_id)
        .bind(vendor_cluster_id)
        .execute(&mut *tx)
        .await?;
    for (ordinal, cluster_id, level) in [
        (1_i16, vendor_cluster_id, 1_i16),
        (2, vendor_cluster_id, 2),
        (3, agency_cluster_id, 1),
    ] {
        sqlx::query(
            "INSERT INTO system_workflow_steps (id, system_id, ordinal, cluster_id, level, step_kind) VALUES ($1,$2,$3,$4,$5,'hierarchical')",
        )
        .bind(Uuid::now_v7())
        .bind(system_id)
        .bind(ordinal)
        .bind(cluster_id)
        .bind(level)
        .execute(&mut *tx)
        .await?;
    }
    for team_id in [vendor_l1, vendor_l2, agency_l1] {
        sqlx::query("INSERT INTO team_system_mappings (id, team_id, system_id, created_by) VALUES ($1,$2,$3,$4)")
            .bind(Uuid::now_v7())
            .bind(team_id)
            .bind(system_id)
            .bind(created_by)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("INSERT INTO system_owners (id, system_id, user_id, kind, created_by) VALUES ($1,$2,$3,'primary',$4)")
        .bind(Uuid::now_v7())
        .bind(system_id)
        .bind(owner.id)
        .bind(created_by)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    Ok(WiredSystem { system_id, vendor_cluster_id, agency_cluster_id, agency_org_id: org_id, vendor_l1, vendor_l2, agency_l1 })
}

pub async fn add_org_membership(app: &TestApp, organization_id: Uuid, user_id: Uuid, added_by: Uuid) -> Result<()> {
    sqlx::query(
        r#"INSERT INTO organization_memberships (id, organization_id, user_id, added_by)
           VALUES ($1,$2,$3,$4)
           ON CONFLICT (organization_id, user_id) WHERE expires_after IS NULL DO NOTHING"#,
    )
    .bind(Uuid::now_v7())
    .bind(organization_id)
    .bind(user_id)
    .bind(added_by)
    .execute(app.db())
    .await?;
    Ok(())
}

pub async fn add_member(app: &TestApp, team_id: Uuid, user: &FixtureUser, added_by: Uuid, team_role: &str) -> Result<()> {
    sqlx::query(
        "INSERT INTO team_memberships (id, user_id, team_id, team_role, added_by) VALUES ($1,$2,$3,$4::team_role,$5)",
    )
    .bind(Uuid::now_v7())
    .bind(user.id)
    .bind(team_id)
    .bind(team_role)
    .bind(added_by)
    .execute(app.db())
    .await?;
    Ok(())
}

pub async fn add_serving_member(app: &TestApp, team_id: Uuid, user: &FixtureUser, added_by: Uuid) -> Result<()> {
    add_member(app, team_id, user, added_by, "member").await?;
    let row = sqlx::query("SELECT organization_id FROM clusters WHERE id = (SELECT cluster_id FROM teams WHERE id = $1)")
        .bind(team_id)
        .fetch_one(app.db())
        .await?;
    let org_id: Uuid = row.try_get("organization_id")?;
    add_org_membership(app, org_id, user.id, added_by).await?;
    Ok(())
}

pub async fn create_asset(app: &TestApp, system_id: Uuid, hostname: &str) -> Result<Uuid> {
    let id = Uuid::now_v7();
    let credential_name = format!("svc-{}", &id.simple().to_string()[..8]);
    sqlx::query(
        "INSERT INTO assets (id, system_id, system_managed, management_mode, credential_type, hostname, credential_name) VALUES ($1,$2,false,'api_managed','password',$3,$4)",
    )
    .bind(id)
    .bind(system_id)
    .bind(hostname)
    .bind(credential_name)
    .execute(app.db())
    .await?;
    Ok(id)
}

pub async fn submit_request(app: &TestApp, session: &str, system_id: Uuid, asset_id: Uuid, sr: &str) -> Result<(reqwest::StatusCode, Value)> {
    let start = chrono::Utc::now() + chrono::Duration::hours(1);
    let end = chrono::Utc::now() + chrono::Duration::hours(4);
    app.auth_post_json(
        "/requests",
        session,
        json!({
            "systemId": system_id,
            "justification": "Investigate a production incident requiring elevated access.",
            "srNumber": sr,
            "activityStartAt": start.to_rfc3339(),
            "activityEndAt": end.to_rfc3339(),
            "credentialItems": [{ "assetId": asset_id }],
        }),
    )
    .await
}

pub fn role_keys(body: &Value) -> Vec<String> {
    body["roles"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|r| r["key"].as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

pub fn role_by_key<'a>(body: &'a Value, key: &str) -> Option<&'a Value> {
    body["roles"].as_array()?.iter().find(|r| r["key"].as_str() == Some(key))
}

// ── Stage 2B org-topology fixtures ──────────────────────────────────────────

pub fn unique_short_code() -> String {
    let id = Uuid::now_v7().simple().to_string().to_uppercase();
    format!("X{}", &id[24..31])
}

pub async fn create_organization(app: &TestApp, name: &str, short_code: &str, created_by: Uuid) -> Result<Uuid> {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO organizations (id, name, short_code, created_by) VALUES ($1,$2,$3,$4)")
        .bind(id).bind(name).bind(short_code).bind(created_by)
        .execute(app.db()).await?;
    Ok(id)
}

pub async fn create_cluster_in_org(app: &TestApp, kind: &str, created_by: Uuid, org_id: Uuid) -> Result<Uuid> {
    create_cluster(app, kind, created_by, org_id).await
}

pub async fn create_team_in_cluster(app: &TestApp, cluster_id: Uuid, level: i16, created_by: Uuid) -> Result<Uuid> {
    create_team(app, cluster_id, level, created_by).await
}

pub async fn repoint_owner_org_edge(app: &TestApp, system_id: Uuid, org_id: Uuid, created_by: Uuid) -> Result<()> {
    let mut tx = app.db().begin().await?;
    sqlx::query("UPDATE system_organizations SET expires_after = now() WHERE system_id = $1 AND role = 'owner' AND expires_after IS NULL")
        .bind(system_id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO system_organizations (id, system_id, organization_id, role, created_by) VALUES ($1,$2,$3,'owner',$4)")
        .bind(Uuid::now_v7()).bind(system_id).bind(org_id).bind(created_by)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn grant_scoped(app: &TestApp, user_id: Uuid, role_key: &str, org_id: Uuid, granted_by: Uuid) -> Result<()> {
    sqlx::query("INSERT INTO user_admin_role_grants (id, user_id, role_key, granted_by, organization_id) VALUES ($1,$2,$3,$4,$5)")
        .bind(Uuid::now_v7()).bind(user_id).bind(role_key).bind(granted_by).bind(org_id)
        .execute(app.db()).await?;
    Ok(())
}

pub async fn primary_owner_row(app: &TestApp, system_id: Uuid) -> Result<Uuid> {
    let row = sqlx::query("SELECT id FROM system_owners WHERE system_id = $1 AND kind = 'primary' AND expires_after IS NULL LIMIT 1")
        .bind(system_id).fetch_one(app.db()).await?;
    Ok(row.try_get("id")?)
}

pub async fn latest_notification_emails(app: &TestApp, trigger_key: &str) -> Result<Option<Vec<String>>> {
    let row = sqlx::query("SELECT id FROM sent_notifications WHERE trigger_key = $1::email_trigger_key ORDER BY created_at DESC LIMIT 1")
        .bind(trigger_key).fetch_optional(app.db()).await?;
    let Some(row) = row else { return Ok(None); };
    let id: Uuid = row.try_get("id")?;
    let rows = sqlx::query("SELECT email_snapshot FROM notification_recipients WHERE notification_id = $1 ORDER BY ordinal")
        .bind(id).fetch_all(app.db()).await?;
    Ok(Some(rows.iter().filter_map(|r| r.try_get::<String, _>("email_snapshot").ok()).collect()))
}

pub async fn audit_has(app: &TestApp, action: &str, actor_id: Uuid) -> Result<bool> {
    let row = sqlx::query("SELECT 1 FROM audit_log WHERE action = $1 AND actor_id = $2 LIMIT 1")
        .bind(action).bind(actor_id).fetch_optional(app.db()).await?;
    Ok(row.is_some())
}

pub async fn latest_audit_detail(app: &TestApp, action: &str) -> Result<Option<Value>> {
    let row = sqlx::query("SELECT details FROM audit_log WHERE action = $1 ORDER BY created_at DESC LIMIT 1")
        .bind(action).fetch_optional(app.db()).await?;
    Ok(row.and_then(|r| r.try_get::<Value, _>("details").ok()))
}

pub async fn org_member_ids(app: &TestApp, org_id: Uuid) -> Result<Vec<Uuid>> {
    let rows = sqlx::query("SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND expires_after IS NULL")
        .bind(org_id).fetch_all(app.db()).await?;
    Ok(rows.iter().filter_map(|r| r.try_get("user_id").ok()).collect())
}

pub struct WiredSystemWithAgencyL2 {
    pub system_id: Uuid,
    pub vendor_cluster_id: Uuid,
    pub agency_cluster_id: Uuid,
    pub agency_org_id: Uuid,
    pub vendor_l1: Uuid,
    pub vendor_l2: Uuid,
    pub agency_l1: Uuid,
    pub agency_l2: Uuid,
}

pub async fn create_wired_system_with_agency_l2(app: &TestApp, created_by: Uuid, owner: &FixtureUser) -> Result<WiredSystemWithAgencyL2> {
    let w = create_wired_system(app, created_by, owner).await?;
    let agency_l2 = create_team(app, w.agency_cluster_id, 2, created_by).await?;
    sqlx::query("INSERT INTO system_workflow_steps (id, system_id, ordinal, cluster_id, level, step_kind) VALUES ($1,$2,4,$3,2,'hierarchical')")
        .bind(Uuid::now_v7()).bind(w.system_id).bind(w.agency_cluster_id).execute(app.db()).await?;
    sqlx::query("INSERT INTO team_system_mappings (id, team_id, system_id, created_by) VALUES ($1,$2,$3,$4)")
        .bind(Uuid::now_v7()).bind(agency_l2).bind(w.system_id).bind(created_by).execute(app.db()).await?;
    Ok(WiredSystemWithAgencyL2 { system_id: w.system_id, vendor_cluster_id: w.vendor_cluster_id, agency_cluster_id: w.agency_cluster_id, agency_org_id: w.agency_org_id, vendor_l1: w.vendor_l1, vendor_l2: w.vendor_l2, agency_l1: w.agency_l1, agency_l2 })
}

// ── Stage 3B fixtures ───────────────────────────────────────────────────────

pub async fn mk_user(app: &TestApp, affiliation: &str) -> Result<FixtureUser> {
    create_active_user(app, &unique_name("User"), &unique_email("u3b"), "Pass!2026aa", affiliation, true).await
}

pub struct FourStepSystem {
    pub system_id: Uuid,
    pub owner: FixtureUser,
    pub backup_owner: FixtureUser,
    pub submitter: FixtureUser,
    pub vendor_approver: FixtureUser,
    pub agency_approver: FixtureUser,
    pub vendor_l3_approver: FixtureUser,
    pub agency_l2_approver: FixtureUser,
    pub outsider: FixtureUser,
    pub agency_off_step: FixtureUser,
    pub asset_id: Uuid,
    pub sessions: std::collections::HashMap<String, String>,
}

pub async fn create_four_step_system(app: &TestApp, admin_id: Uuid, owner: &FixtureUser) -> Result<FourStepSystem> {
    let w = create_wired_system(app, admin_id, owner).await?;
    let vendor_l3 = create_team_in_cluster(app, w.vendor_cluster_id, 3, admin_id).await?;
    let agency_l2 = create_team_in_cluster(app, w.agency_cluster_id, 2, admin_id).await?;
    let vendor_l3_approver = mk_user(app, "vendor").await?;
    let agency_l2_approver = mk_user(app, "agency").await?;
    add_serving_member(app, vendor_l3, &vendor_l3_approver, admin_id).await?;
    add_serving_member(app, agency_l2, &agency_l2_approver, admin_id).await?;
    for (ord, team, cluster) in [(4i16, vendor_l3, w.vendor_cluster_id), (5, agency_l2, w.agency_cluster_id)] {
        sqlx::query("INSERT INTO system_workflow_steps (system_id, step_kind, ordinal, cluster_id, level) VALUES ($1,'hierarchical',$2,$3,(SELECT level FROM teams WHERE id=$4))")
            .bind(w.system_id).bind(ord).bind(cluster).bind(team).execute(app.db()).await?;
    }
    let backup = mk_user(app, "agency").await?;
    sqlx::query("INSERT INTO system_owners (system_id, user_id, kind, created_by) VALUES ($1,$2,'backup',$3)").bind(w.system_id).bind(backup.id).bind(admin_id).execute(app.db()).await?;
    let submitter = mk_user(app, "vendor").await?;
    add_serving_member(app, w.vendor_l1, &submitter, admin_id).await?;
    let vendor_approver = mk_user(app, "vendor").await?;
    add_serving_member(app, w.vendor_l2, &vendor_approver, admin_id).await?;
    let agency_approver = mk_user(app, "agency").await?;
    add_serving_member(app, w.agency_l1, &agency_approver, admin_id).await?;
    let outsider = mk_user(app, "vendor").await?;
    let agency_off_step = mk_user(app, "agency").await?;
    add_serving_member(app, agency_l2, &agency_off_step, admin_id).await?;
    let asset_id = create_asset(app, w.system_id, &format!("host-{}", &Uuid::now_v7().simple().to_string()[..8])).await?;
    let mut sessions = std::collections::HashMap::new();
    for (k, u) in [("owner", owner), ("backupOwner", &backup), ("submitter", &submitter), ("vendorApprover", &vendor_approver), ("agencyApprover", &agency_approver), ("vendorL3Approver", &vendor_l3_approver), ("agencyL2Approver", &agency_l2_approver), ("outsider", &outsider), ("agencyOffStep", &agency_off_step)] {
        sessions.insert(k.to_string(), session_of(&login_user(app, u).await?)?);
    }
    Ok(FourStepSystem { system_id: w.system_id, owner: owner.clone(), backup_owner: backup, submitter, vendor_approver, agency_approver, vendor_l3_approver, agency_l2_approver, outsider, agency_off_step, asset_id, sessions })
}

pub async fn submit_four_step(app: &TestApp, s: &FourStepSystem, session: &str, justification: &str) -> Result<(reqwest::StatusCode, Value)> {
    let now = chrono::Utc::now();
    app.auth_post_json("/requests", session, json!({
        "systemId": s.system_id, "justification": justification, "srNumber": "SR-3B",
        "activityStartAt": (now + chrono::Duration::hours(1)).to_rfc3339(),
        "activityEndAt": (now + chrono::Duration::hours(2)).to_rfc3339(),
        "credentialItems": [{"assetId": s.asset_id, "hostnameDescription": "host"}]
    })).await
}
