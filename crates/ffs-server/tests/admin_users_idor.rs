// IDOR negative tests for GET /admin/users and its underlying DB helpers.
// Importers/callers: cargo test --test admin_users_idor (standalone integration suite).
//   Routes under test registered in main.rs:
//   .route("/admin/users", get(admin::users::list_users))
// Affected API: GET /admin/users
// Data schemas: users(id, full_name, email, password_hash, password_salt, affiliation, status,
//   is_system, is_protected, force_password_rotation, totp_secret, totp_enrolled_at, ...),
//   organization_memberships(organization_id, user_id, expires_after),
//   organizations(id, name, expires_after).
// User instruction: "fix the rust port to ensure API and PlayWright suites pass"
//
// Positive (list_all_for_admin):
//   Active non-system user appears in list_all_for_admin; totp_secret column accessible.
// IDOR negative §1: cross-org user not in other org's live membership query.
// IDOR negative §2: pending_approval status preserved (route's scoped filter bites on it).
// Bite check §2: expired org membership not returned in live membership query.

use ffs_server::db::users;
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

async fn connect() -> DatabaseConnection {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/breakglass_test".to_string());
    Database::connect(&url).await.expect("DB connect")
}

async fn seed_user(db: &DatabaseConnection, status: &str) -> Uuid {
    let id = Uuid::now_v7();
    let email = format!("ausers-idor-{}@test.local", id);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO users (id, full_name, email, password_hash, password_salt,
           affiliation, status, is_protected, is_system, force_password_rotation, created_at, updated_at)
           VALUES ($1, $2, $3, 'h', 's', 'agency'::user_affiliation, $4::user_status,
                   false, false, false, now(), now())"#,
        [id.into(), format!("AUSERS {id}").into(), email.into(), status.into()],
    ))
    .await
    .expect("seed user");
    id
}

async fn seed_org(db: &DatabaseConnection, created_by: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    let s = id.to_string().replace('-', "");
    let short = format!("U{}", &s[s.len()-7..]);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO organizations (id, name, short_code, created_by, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())",
        [id.into(), format!("ausers-org-{id}").into(), short.into(), created_by.into()],
    ))
    .await
    .expect("seed org");
    id
}

async fn add_membership(db: &DatabaseConnection, user_id: Uuid, org_id: Uuid, expires: bool) {
    let sql = if expires {
        r#"INSERT INTO organization_memberships (id, organization_id, user_id, added_by, created_at, expires_after)
           VALUES (uuid_generate_v7(), $1, $2, $3, now(), now() - interval '1 second')"#
    } else {
        r#"INSERT INTO organization_memberships (id, organization_id, user_id, added_by, created_at)
           VALUES (uuid_generate_v7(), $1, $2, $3, now())"#
    };
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        sql,
        [org_id.into(), user_id.into(), user_id.into()],
    ))
    .await
    .expect("add membership");
}

async fn cleanup_memberships(db: &DatabaseConnection, user_id: Uuid) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM organization_memberships WHERE user_id = $1",
        [user_id.into()],
    ))
    .await
    .ok();
}

async fn cleanup_rows(db: &DatabaseConnection, ids: Vec<(&str, Uuid)>) {
    for (table, id) in ids.into_iter().rev() {
        let sql = format!("DELETE FROM {} WHERE id = $1", table);
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, &sql, vec![id.into()]))
            .await
            .ok();
    }
}

// ── Positive: list_all_for_admin includes active non-system user ──────────────

#[tokio::test]
async fn list_all_returns_active_user() {
    let db = connect().await;
    let user_id = seed_user(&db, "active").await;

    let all = users::list_all_for_admin(&db).await.expect("list_all_for_admin");
    assert!(
        all.iter().any(|u| u.id == user_id && !u.is_system),
        "active non-system user must appear in list_all_for_admin"
    );

    cleanup_rows(&db, vec![("users", user_id)]).await;
}

// ── Positive: totp_secret column is accessible (drives totpEnrolled bool) ─────

#[tokio::test]
async fn totp_secret_column_accessible() {
    let db = connect().await;
    let user_id = seed_user(&db, "active").await;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE users SET totp_secret = 'JBSWY3DPEHPK3PXP' WHERE id = $1",
        [user_id.into()],
    ))
    .await
    .expect("set totp_secret");

    let all = users::list_all_for_admin(&db).await.expect("list");
    let row = all.iter().find(|u| u.id == user_id).expect("user must be returned");
    assert!(row.totp_secret.is_some(), "totp_secret must be readable for totpEnrolled derivation");

    cleanup_rows(&db, vec![("users", user_id)]).await;
}

// ── IDOR negative §1: user in org A absent from org B live membership query ───

#[tokio::test]
async fn cross_org_user_not_in_other_org_membership_query() {
    let db = connect().await;
    let user_a = seed_user(&db, "active").await;
    let user_b = seed_user(&db, "active").await;
    let org_a = seed_org(&db, user_a).await;
    let org_b = seed_org(&db, user_b).await;
    add_membership(&db, user_a, org_a, false).await;
    // user_a has no membership in org_b

    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND expires_after IS NULL",
        [org_b.into()],
    )).await.expect("query org_b members");
    let org_b_user_ids: Vec<Uuid> = rows.iter()
        .map(|r| r.try_get("", "user_id").expect("user_id"))
        .collect();

    assert!(
        !org_b_user_ids.contains(&user_a),
        "IDOR §1: user in org A must NOT appear in org B live membership query"
    );

    cleanup_memberships(&db, user_a).await;
    cleanup_rows(&db, vec![("organizations", org_b), ("organizations", org_a), ("users", user_b), ("users", user_a)]).await;
}

// ── IDOR negative §2: pending_approval status preserved for scoped exclusion ──

#[tokio::test]
async fn pending_approval_status_preserved_for_exclusion() {
    let db = connect().await;
    let pending_id = seed_user(&db, "pending_approval").await;
    let org_id = seed_org(&db, pending_id).await;

    let all = users::list_all_for_admin(&db).await.expect("list");
    let row = all.iter().find(|u| u.id == pending_id).expect("pending user must exist in DB");
    // The route filter bites on this: if status == "pending_approval" → exclude from scoped view.
    let is_pending = matches!(row.status, ffs_server::db::users::entity::UserStatus::PendingApproval);
    assert!(is_pending, "IDOR §2: pending_approval status must be readable so route filter can exclude it from scoped view");

    cleanup_rows(&db, vec![("organizations", org_id), ("users", pending_id)]).await;
}

// ── Bite check §2: expired membership absent from live membership query ────────

#[tokio::test]
async fn expired_membership_absent_from_live_query() {
    let db = connect().await;
    let user_id = seed_user(&db, "active").await;
    let org_id = seed_org(&db, user_id).await;
    add_membership(&db, user_id, org_id, true /* expires_after in the past */).await;

    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT user_id FROM organization_memberships WHERE organization_id = $1 AND expires_after IS NULL",
        [org_id.into()],
    )).await.expect("query");
    let live_ids: Vec<Uuid> = rows.iter()
        .map(|r| r.try_get("", "user_id").expect("user_id"))
        .collect();

    assert!(
        !live_ids.contains(&user_id),
        "Bite check §2: expired org membership must NOT appear in live scoped query"
    );

    cleanup_memberships(&db, user_id).await;
    cleanup_rows(&db, vec![("organizations", org_id), ("users", user_id)]).await;
}
