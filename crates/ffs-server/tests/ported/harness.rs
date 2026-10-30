//! Port of test/backend/deno/harness/harness.test.tsx — Rust harness self-test
//! (time seam, seeded context, keyed world builders, DB assertions, artifacts,
//! snapshot drift/redaction, bounded response bodies, failure bundles).
use anyhow::Result;
use ffs_test_support::{
    artifacts::{self, bound_response_body, REDACTED, SNAPSHOT_TABLES},
    parity_assert, parity_assert_eq, time, TestApp,
};
use reqwest::Method;
use serde_json::{json, Value};
use sqlx::Row;
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

use crate::fixtures::{self, FixtureUser, WiredSystem};

async fn seed_context(app: &TestApp) -> Result<(FixtureUser, String, FixtureUser, String)> {
    let admin = fixtures::create_admin(app, "HarnessAdmin!2026").await?;
    let vendor_email = fixtures::unique_email("harness-vendor");
    let vendor = fixtures::create_active_user(app, "Harness Vendor", &vendor_email, "HarnessVendor!2026", "vendor", true).await?;
    let admin_login = fixtures::login_user(app, &admin).await?;
    let vendor_login = fixtures::login_user(app, &vendor).await?;
    Ok((admin, fixtures::session_of(&admin_login)?, vendor, fixtures::session_of(&vendor_login)?))
}

struct WorldBuilder<'a> {
    app: &'a TestApp,
    admins: HashMap<String, FixtureUser>,
    users: HashMap<String, FixtureUser>,
    clusters: HashMap<String, Uuid>,
    teams: HashMap<String, Uuid>,
    systems: HashMap<String, WiredSystem>,
}

impl<'a> WorldBuilder<'a> {
    fn new(app: &'a TestApp) -> Self {
        Self { app, admins: HashMap::new(), users: HashMap::new(), clusters: HashMap::new(), teams: HashMap::new(), systems: HashMap::new() }
    }
    async fn admin(&mut self, key: &str, password: &str) -> Result<FixtureUser> {
        if let Some(u) = self.admins.get(key) { return Ok(u.clone()); }
        let u = fixtures::create_admin(self.app, password).await?;
        self.admins.insert(key.into(), u.clone());
        Ok(u)
    }
    async fn user(&mut self, key: &str, affiliation: &str) -> Result<FixtureUser> {
        if let Some(u) = self.users.get(key) { return Ok(u.clone()); }
        let email = fixtures::unique_email(key);
        let u = fixtures::create_active_user(self.app, "World User", &email, "WorldUser!2026", affiliation, true).await?;
        self.users.insert(key.into(), u.clone());
        Ok(u)
    }
    async fn cluster(&mut self, key: &str, kind: &str, created_by: Uuid) -> Result<Uuid> {
        if let Some(id) = self.clusters.get(key) { return Ok(*id); }
        let org_id = fixtures::fixture_fallback_org_id(self.app, created_by).await?;
        let id = Uuid::now_v7();
        sqlx::query(r#"INSERT INTO clusters (id, name, "type", organization_id, created_by) VALUES ($1,$2,$3::cluster_type,$4,$5)"#)
            .bind(id).bind(key).bind(kind).bind(org_id).bind(created_by)
            .execute(self.app.db()).await?;
        self.clusters.insert(key.into(), id);
        Ok(id)
    }
    async fn team(&mut self, key: &str, cluster_key: &str, level: i16, created_by: Uuid) -> Result<Uuid> {
        if let Some(id) = self.teams.get(key) { return Ok(*id); }
        let cluster_id = *self.clusters.get(cluster_key).expect("cluster key");
        let id = Uuid::now_v7();
        sqlx::query("INSERT INTO teams (id, cluster_id, name, level, created_by) VALUES ($1,$2,$3,$4,$5)")
            .bind(id).bind(cluster_id).bind(key).bind(level).bind(created_by)
            .execute(self.app.db()).await?;
        self.teams.insert(key.into(), id);
        Ok(id)
    }
    async fn member(&mut self, team_key: &str, user_key: &str, added_by: Uuid) -> Result<Uuid> {
        let team_id = *self.teams.get(team_key).expect("team key");
        let user = self.users.get(user_key).expect("user key").clone();
        fixtures::add_member(self.app, team_id, &user, added_by, "member").await?;
        Ok(sqlx::query_scalar("SELECT id FROM team_memberships WHERE team_id=$1 AND user_id=$2")
            .bind(team_id).bind(user.id).fetch_one(self.app.db()).await?)
    }
    async fn single_step_system(&mut self, key: &str, created_by: Uuid, owner: &FixtureUser) -> Result<WiredSystem> {
        if let Some(s) = self.systems.get(key) { return Ok(s.clone()); }
        let s = fixtures::create_wired_system(self.app, created_by, owner).await?;
        self.systems.insert(key.into(), s.clone());
        Ok(s)
    }
}

#[tokio::test]
async fn f6_time_seam_freezes_and_resets() -> Result<()> {
    let frozen = "2026-01-01T00:00:00.000Z";
    time::set_test_now(Some(frozen));
    parity_assert_eq!("L:927d4d0937fa4f9c-1", time::now(), frozen);
    time::set_test_now(None);
    parity_assert!("L:fd7849b985cbdce7-1", time::now() != frozen);
    Ok(())
}

#[tokio::test]
async fn f2_context_seeds_admin_vendor_with_live_sessions() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, admin_session, vendor, _vendor_session) = seed_context(&app).await?;
    parity_assert!("L:4259f29ea5ea960f-1", !admin.id.is_nil());
    parity_assert!("L:7ebb9c7b097d21d1-1", !vendor.id.is_nil());
    let (status, _) = app.auth_get_json("/requests/my-requests", &admin_session).await?;
    parity_assert_eq!("L:2173b78ac076e15c-1", status.as_u16(), 200);
    Ok(())
}

#[tokio::test]
async fn f4_world_builders_are_keyed_and_idempotent() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let mut world = WorldBuilder::new(&app);
    let admin = world.admin("a", "WorldA!2026").await?;
    let again = world.admin("a", "WorldA!2026").await?;
    parity_assert_eq!("L:784dd58e312104ca-1", again.id, admin.id);
    let user = world.user("v1", "vendor").await?;
    let vc = world.cluster("vendor-1", "vendor", admin.id).await?;
    let team = world.team("t1", "vendor-1", 1, admin.id).await?;
    let membership = world.member("t1", "v1", admin.id).await?;
    parity_assert!("L:c562cb55887fb4ec-1", !membership.is_nil());
    parity_assert!("L:99d958031c01c25a-1", !vc.is_nil());
    parity_assert!("L:a1298d6355db5def-1", !team.is_nil());
    parity_assert!("L:4380c410947ad009-1", !user.id.is_nil());
    let sys = world.single_step_system("s1", admin.id, &admin).await?;
    parity_assert!("L:43cd853d7e269709-1", !sys.system_id.is_nil());
    let sys_again = world.single_step_system("s1", admin.id, &admin).await?;
    parity_assert_eq!("L:4b9613f655e3d8c6-1", sys_again.system_id, sys.system_id);
    Ok(())
}

#[tokio::test]
async fn f5_db_assertions_row_count_session_valid_audit_has() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, _session, _vendor, _vs) = seed_context(&app).await?;
    let n: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM users WHERE is_system=false").fetch_one(app.db()).await?;
    parity_assert_eq!("L:14c521810ef16c78-1", n, 2);
    let n: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM users WHERE is_system=false AND status='active'").fetch_one(app.db()).await?;
    parity_assert_eq!("L:491e6a10b835fc08-1", n, 2);
    let login = fixtures::login_as(&app, &admin.email, "HarnessAdmin!2026").await?;
    let session = fixtures::session_of(&login)?;
    let valid: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM sessions WHERE id=$1").bind(&session).fetch_one(app.db()).await?;
    parity_assert_eq!("L:874594467b141833-1", valid > 0, true);
    let audit: i64 = sqlx::query_scalar("SELECT count(*)::bigint FROM audit_log WHERE action='user.login_success' AND target_id=$1")
        .bind(admin.id.to_string()).fetch_one(app.db()).await?;
    parity_assert_eq!("L:e8cebe1d866b62b2-1", audit > 0, true);
    Ok(())
}

#[tokio::test]
async fn f3_artifacts_snapshot_write_path() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let snap = artifacts::snapshot_tables(app.db(), &["users"]).await?;
    parity_assert!("L:e1dbd2daa15d6481-1", snap["users"].is_array());
    let file = artifacts::write_snapshot(app.db(), "harness-self-test", "probe").await?;
    let parent = file.parent().expect("parent").to_path_buf();
    let _ = std::fs::read_dir(&parent);
    let _ = tokio::fs::remove_dir_all(&parent).await;
    Ok(())
}

#[tokio::test]
async fn drift_guard_snapshot_tables_is_exact_public_schema_set() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let rows = sqlx::query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'")
        .fetch_all(app.db()).await?;
    let actual: HashSet<String> = rows.iter().map(|r| r.try_get::<String, _>("table_name").unwrap()).collect();
    let listed: HashSet<String> = SNAPSHOT_TABLES.iter().map(|s| s.to_string()).collect();
    let mut missing: Vec<String> = actual.difference(&listed).cloned().collect();
    let mut stale: Vec<String> = listed.difference(&actual).cloned().collect();
    missing.sort();
    stale.sort();
    parity_assert_eq!("L:29577ee91766c329-1", missing, Vec::<String>::new());
    parity_assert_eq!("L:925989069eecc30a-1", stale, Vec::<String>::new());
    Ok(())
}

#[tokio::test]
async fn redaction_registry_columns_never_reach_snapshot_in_plaintext() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, _s, _v, _vs) = seed_context(&app).await?;
    sqlx::query(
        "INSERT INTO app_settings (key, value, value_type, category, description) \
         VALUES ('harness_redaction_probe', 'SENTINEL-SECRET-9f8e7d', 'string', 'security', 'harness redaction probe') \
         ON CONFLICT (key) WHERE organization_id IS NULL DO UPDATE SET value = EXCLUDED.value",
    ).execute(app.db()).await?;
    let snap = artifacts::snapshot_tables(app.db(), &["users", "app_settings", "clusters"]).await?;
    let text = snap.to_string();
    parity_assert!("L:9a5359eca566117b-1", !text.contains("SENTINEL-SECRET-9f8e7d"));
    let probe = snap["app_settings"].as_array().unwrap().iter().find(|r| r["key"] == "harness_redaction_probe");
    parity_assert_eq!("L:930a27a0d26d0d4f-1", probe.map(|r| r["value"].as_str().unwrap_or_default()), Some(REDACTED));
    let users = snap["users"].as_array().unwrap();
    let admin_row = users.iter().find(|r| r["email"] == admin.email);
    parity_assert!("L:44b9a8bbb9386ac8-1", admin_row.is_some());
    let admin_row = admin_row.unwrap();
    parity_assert_eq!("L:260364d4d9151b51-1", admin_row["password_hash"], REDACTED);
    parity_assert_eq!("L:5bd542bdd17366f9-1", admin_row["password_salt"], REDACTED);
    for u in users {
        parity_assert!("L:ea430c5f3279dd34-1", u["password_hash"].is_null() || u["password_hash"] == REDACTED);
        parity_assert!("L:dd5c650735a39202-1", u["totp_secret"].is_null() || u["totp_secret"] == REDACTED);
    }
    parity_assert!("L:371d7d85875a7e51-1", admin_row["email"].is_string());
    let raw = sqlx::query_scalar::<_, Value>("SELECT row_to_json(t) FROM clusters t LIMIT 200").fetch_all(app.db()).await?;
    parity_assert_eq!("L:1d196847dc78c1c2-1", snap["clusters"].clone(), Value::Array(raw));
    Ok(())
}

#[test]
fn b3_bound_response_body_verbatim_or_enveloped() {
    parity_assert_eq!("L:4395b5a35f62dbb2-1", bound_response_body(json!({ "ok": true })), json!({ "ok": true }));
    parity_assert_eq!("L:52cdcd012e4fa408-1", bound_response_body(Value::Null), Value::Null);
    parity_assert_eq!("L:3c44f5c0bc35b92e-1", bound_response_body(json!("short")), json!("short"));
    let big = json!({ "s": "x".repeat(4000) });
    let bounded = bound_response_body(big);
    parity_assert_eq!("L:88ed59610ef9d7c3-1", bounded["__truncated"], true);
    parity_assert!("L:52e9651efbef8956-1", bounded["bytes"].as_u64().unwrap_or(0) > 2048);
    parity_assert!("L:a90b41c7951b29c4-1", bounded["preview"].as_str().unwrap_or_default().starts_with("{\"s\":\"xxxx"));
    parity_assert!("L:89228e7c2bd8cdb9-1", bounded["preview"].as_str().unwrap_or_default().len() <= 2048);
}

#[tokio::test]
async fn b4_failure_artifacts_carry_test_name_steps_and_responses() -> Result<()> {
    let app = TestApp::start("b4-probe").await?;
    fixtures::prepare(&app).await?;
    let mut log: Vec<Value> = Vec::new();
    log.push(json!({ "type": "step", "path": "phase-1" }));
    let resp = app.request_with_headers(Method::GET, "/health", &[], None).await?;
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await.unwrap_or(Value::Null);
    log.push(json!({ "type": "request", "method": "GET", "path": "/health", "status": status, "response": bound_response_body(body) }));
    log.push(json!({ "type": "step", "path": "phase-2" }));
    let dir = artifacts::write_failure_artifacts(app.db(), "b4-probe", &log, "b4 probe error").await?;
    let dir_str = dir.to_string_lossy().to_string();
    parity_assert!("L:2cf7fe4276edb988-1", dir_str.contains("b4-probe"));
    let files: Vec<String> = std::fs::read_dir(&dir)?.filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string())).collect();
    let log_name = files.iter().find(|f| f.ends_with("(failure).request-log.json"));
    parity_assert!("L:610b8a86d88963c8-1", log_name.is_some());
    let recorded: Vec<Value> = serde_json::from_str(&std::fs::read_to_string(dir.join(log_name.unwrap()))?)?;
    let step1 = recorded.iter().position(|e| e["type"] == "step" && e["path"] == "phase-1").unwrap_or(0);
    let health = recorded.iter().position(|e| e["type"] == "request" && e["path"] == "/health").unwrap_or(0);
    let step2 = recorded.iter().position(|e| e["type"] == "step" && e["path"] == "phase-2").unwrap_or(0);
    parity_assert!("L:f984de9a6267ff97-1", health > step1);
    parity_assert!("L:328ef86a6eb6de5b-1", step2 > health);
    parity_assert!("L:97aac700607f4769-1", !recorded[health]["response"].is_null());
    let md_name = files.iter().find(|f| f.ends_with("(failure).md"));
    parity_assert!("L:49e66770067602a6-1", md_name.is_some());
    let md = std::fs::read_to_string(dir.join(md_name.unwrap()))?;
    parity_assert!("L:18c9601b75ccecc0-1", md.contains("b4-probe — FAILED"));
    parity_assert!("L:d6630ad3d51fc8b9-1", md.contains("phase-2"));
    parity_assert!("L:bb54688f41b7a836-1", md.contains("b4 probe error"));
    let _ = tokio::fs::remove_dir_all(&dir).await;
    Ok(())
}
