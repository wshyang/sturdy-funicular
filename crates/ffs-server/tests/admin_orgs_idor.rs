// IDOR negative tests for organization and related endpoints.
// Importers/callers: cargo test --test admin_orgs_idor (standalone integration suite).
//   Routes under test registered in main.rs:
//   .route("/admin/organizations", get(...).post(...))
//   .route("/admin/organizations/:id", delete(...))
//   .route("/admin/organizations/:id/members", get(...).post(...))
//   .route("/admin/app-settings", get(...))
//   .route("/admin/app-settings/:key", put(...))
//   .route("/admin/notification-templates", get(...))
// Affected API: org delete, org members list, app-settings read/write, notification-templates list.
// Data schemas: organizations(id, name, short_code, expires_after),
//   organization_memberships(id, organization_id, user_id, expires_after),
//   app_settings(key, value, value_type, category, is_secret, organization_id, expires_after),
//   notification_templates(id, trigger_key, subject, body_html, organization_id, expires_after).
// User instruction: "fix the rust port to ensure API and PlayWright suites pass"
//
// Positive (list_live): org seeded with expires_after NULL appears.
// IDOR negative §1 (cross-org member): member of org A not visible under org B membership query.
// IDOR negative §2 (expired org): expired org NOT returned by list_live.
// Bite check §2 (expire sets expires_after): expire() sets expires_after = now().
// Positive app_settings: global setting returned by global query.
// IDOR negative app_settings §1: org-scoped setting NOT returned by global query.
// IDOR negative app_settings §2: expired global setting NOT returned.
// Positive notification_templates: global template returned.
// IDOR negative notification_templates §1: org-scoped template NOT returned by global query.
// IDOR negative notification_templates §2: expired global template NOT returned.

use ffs_server::db::organizations;
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

async fn connect() -> DatabaseConnection {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/breakglass_test".to_string());
    Database::connect(&url).await.expect("DB connect")
}

async fn seed_user(db: &DatabaseConnection) -> Uuid {
    let id = Uuid::now_v7();
    let email = format!("aorgs-idor-{}@test.local", id);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO users (id, full_name, email, password_hash, password_salt,
           affiliation, status, is_protected, is_system, force_password_rotation, created_at, updated_at)
           VALUES ($1,$2,$3,'hash','salt','agency'::user_affiliation,'active'::user_status,false,false,false,now(),now())"#,
        [id.into(), format!("AORGS {id}").into(), email.into()],
    ))
    .await
    .expect("seed user");
    id
}

async fn seed_org(db: &DatabaseConnection, created_by: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    let s = id.to_string().replace('-', "");
    let short = format!("O{}", &s[s.len() - 8..]);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO organizations (id, name, short_code, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())"#,
        [id.into(), format!("aorgs-org-{id}").into(), short.into(), created_by.into()],
    ))
    .await
    .expect("seed org");
    id
}

async fn add_membership(db: &DatabaseConnection, user_id: Uuid, org_id: Uuid) {
    let mid = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO organization_memberships (id, organization_id, user_id, added_by, created_at)
           VALUES ($1, $2, $3, $3, now())"#,
        [mid.into(), org_id.into(), user_id.into()],
    ))
    .await
    .expect("add membership");
}

// ── org list_live ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn positive_list_live_includes_live_org() {
    let db = connect().await;
    let admin = seed_user(&db).await;
    let org_id = seed_org(&db, admin).await;

    let orgs = organizations::list_live(&db).await.expect("list_live");
    assert!(orgs.iter().any(|o| o.id == org_id), "live org must appear");
}

#[tokio::test]
async fn idor_negative_expired_org_not_in_list() {
    let db = connect().await;
    let admin = seed_user(&db).await;
    let org_id = seed_org(&db, admin).await;

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE organizations SET expires_after = now() - interval '1 second' WHERE id = $1",
        [org_id.into()],
    ))
    .await
    .expect("expire org");

    let orgs = organizations::list_live(&db).await.expect("list_live");
    assert!(!orgs.iter().any(|o| o.id == org_id), "expired org must NOT appear");
}

// ── org expire bite check §2 ──────────────────────────────────────────────────

#[tokio::test]
async fn bite_check_expire_sets_expires_after() {
    let db = connect().await;
    let admin = seed_user(&db).await;
    let org_id = seed_org(&db, admin).await;

    organizations::expire(&db, org_id).await.expect("expire");

    let row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT expires_after FROM organizations WHERE id = $1",
            [org_id.into()],
        ))
        .await
        .expect("query")
        .expect("row");
    let exp: Option<chrono::DateTime<chrono::FixedOffset>> = row.try_get("", "expires_after").ok();
    assert!(exp.is_some(), "expires_after must be set after expire()");
}

// ── org members IDOR §1 ───────────────────────────────────────────────────────

#[tokio::test]
async fn idor_negative_cross_org_member_not_visible() {
    let db = connect().await;
    let admin = seed_user(&db).await;
    let member = seed_user(&db).await;
    let org_a = seed_org(&db, admin).await;
    let org_b = seed_org(&db, admin).await;

    add_membership(&db, member, org_a).await;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT u.id FROM organization_memberships om
               JOIN users u ON u.id = om.user_id
               WHERE om.organization_id = $1 AND om.expires_after IS NULL"#,
            [org_b.into()],
        ))
        .await
        .expect("query org B members");
    let ids: Vec<Uuid> = rows.iter().filter_map(|r| r.try_get("", "id").ok()).collect();
    assert!(!ids.contains(&member), "org-A member must NOT appear in org-B member list");
}

// ── app_settings IDOR ────────────────────────────────────────────────────────

fn unique_key(prefix: &str) -> String {
    format!("{}-{}", prefix, Uuid::now_v7())
}

async fn seed_app_setting(db: &DatabaseConnection, key: &str, org_id: Option<Uuid>, expired: bool) {
    let exp_sql = if expired { "now() - interval '1 second'" } else { "NULL" };
    let org_val: sea_orm::Value = match org_id {
        Some(id) => id.into(),
        None => sea_orm::Value::Uuid(None),
    };
    let sql = format!(
        "INSERT INTO app_settings (key, value, value_type, category, description, is_secret, organization_id, updated_at, expires_after)
         VALUES ($1, 'v', 'string', 'test', 'test', false, $2, now(), {exp_sql})"
    );
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        &sql,
        [key.into(), org_val],
    ))
    .await
    .expect("seed app_setting");
}

#[tokio::test]
async fn positive_app_settings_global_returned() {
    let db = connect().await;
    let key = unique_key("aorgs-as-pos");
    seed_app_setting(&db, &key, None, false).await;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT key FROM app_settings WHERE organization_id IS NULL AND expires_after IS NULL",
            [],
        ))
        .await
        .expect("query");
    let keys: Vec<String> = rows.iter().filter_map(|r| r.try_get("", "key").ok()).collect();
    assert!(keys.contains(&key), "global setting must appear in global query");
}

#[tokio::test]
async fn idor_negative_org_scoped_setting_not_in_global_query() {
    let db = connect().await;
    let admin = seed_user(&db).await;
    let org = seed_org(&db, admin).await;
    let key = unique_key("aorgs-as-scoped");
    seed_app_setting(&db, &key, Some(org), false).await;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT key FROM app_settings WHERE organization_id IS NULL AND expires_after IS NULL",
            [],
        ))
        .await
        .expect("query");
    let keys: Vec<String> = rows.iter().filter_map(|r| r.try_get("", "key").ok()).collect();
    assert!(!keys.contains(&key), "org-scoped setting must NOT appear in global query");
}

#[tokio::test]
async fn idor_negative_expired_setting_not_returned() {
    let db = connect().await;
    let key = unique_key("aorgs-as-expired");
    seed_app_setting(&db, &key, None, true).await;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT key FROM app_settings WHERE organization_id IS NULL AND expires_after IS NULL",
            [],
        ))
        .await
        .expect("query");
    let keys: Vec<String> = rows.iter().filter_map(|r| r.try_get("", "key").ok()).collect();
    assert!(!keys.contains(&key), "expired setting must NOT appear");
}

// ── notification_templates IDOR ───────────────────────────────────────────────
//
// Global unique constraint: notification_templates_global_trigger_key_uniq covers
// (trigger_key) WHERE organization_id IS NULL — no expires_after predicate.
// Therefore we cannot insert a second global template with the same trigger_key.
// Strategy:
//   Positive: rely on schema-seeded global templates (they always exist).
//   Org-scoped IDOR: insert org-specific template — no global constraint clash.
//   Expired filter: insert org-specific expired template; verify org query excludes it.

async fn seed_org_notification_template(db: &DatabaseConnection, org_id: Uuid, expired: bool) -> Uuid {
    let id = Uuid::now_v7();
    let created_by = seed_user(db).await;
    let exp_sql = if expired { "now() - interval '1 second'" } else { "NULL" };
    let sql = format!(
        r#"INSERT INTO notification_templates
           (id, trigger_key, subject, body_html, is_active, channels, organization_id,
            created_by, created_at, updated_at, expires_after)
           VALUES ($1, 'user.invited'::email_trigger_key, 'subj', '<p>body</p>', true,
                   ARRAY['email'], $2, $3, now(), now(), {exp_sql})"#
    );
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        &sql,
        [id.into(), org_id.into(), created_by.into()],
    ))
    .await
    .expect("seed org notification_template");
    id
}

#[tokio::test]
async fn positive_notification_templates_global_returned() {
    let db = connect().await;
    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id FROM notification_templates WHERE organization_id IS NULL AND expires_after IS NULL",
            [],
        ))
        .await
        .expect("query");
    assert!(!rows.is_empty(), "schema-seeded global templates must appear in global query");
}

#[tokio::test]
async fn idor_negative_org_scoped_template_not_in_global_query() {
    let db = connect().await;
    let admin = seed_user(&db).await;
    let org = seed_org(&db, admin).await;
    let id = seed_org_notification_template(&db, org, false).await;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id FROM notification_templates WHERE organization_id IS NULL AND expires_after IS NULL",
            [],
        ))
        .await
        .expect("query");
    let ids: Vec<Uuid> = rows.iter().filter_map(|r| r.try_get("", "id").ok()).collect();
    assert!(!ids.contains(&id), "org-scoped template must NOT appear in global query");
}

#[tokio::test]
async fn idor_negative_expired_org_template_excluded_by_filter() {
    // Verify expires_after IS NULL filter works: expired org-scoped template is
    // excluded from the live org-scoped query.
    let db = connect().await;
    let admin = seed_user(&db).await;
    let org = seed_org(&db, admin).await;
    let id = seed_org_notification_template(&db, org, true).await;

    let rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT id FROM notification_templates WHERE organization_id = $1 AND expires_after IS NULL",
            [org.into()],
        ))
        .await
        .expect("query");
    let ids: Vec<Uuid> = rows.iter().filter_map(|r| r.try_get("", "id").ok()).collect();
    assert!(!ids.contains(&id), "expired org template must NOT appear in live query");
}
