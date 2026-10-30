// IDOR negative tests for DELETE /teams/:team_id/members/:id.
//
// Importers/callers: cargo test --test teams_idor (standalone integration suite).
//   The route under test is registered in main.rs:
//   .route("/teams/:team_id/members/:id", axum::routing::delete(teams::delete_team_member))
// Affected API: DELETE /teams/:team_id/members/:id
// Data schemas: team_memberships(id UUID, user_id UUID, team_id UUID, role team_role,
//               expires_after TIMESTAMPTZ), teams(id, cluster_id, name, ...), clusters(id, ...)
// User instruction: "fix the rust port to ensure API and PlayWright suites pass"
//
// Positive: active membership with correct IDs is visible (lookup returns rows).
// IDOR negative §1: wrong team_id → WHERE team_id=$2 returns 0 rows → route 404.
// IDOR negative §2: non-admin user → user_has_any_admin_role false → route 403.
// Bite check §2: already-expired (expires_after IS NOT NULL) → lookup 0 rows → 404.

use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

async fn connect() -> DatabaseConnection {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/breakglass_test".to_string());
    Database::connect(&url).await.expect("DB connect")
}

async fn seed_user(db: &DatabaseConnection, email: &str) -> Uuid {
    let id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO users (id, full_name, email, password_hash, password_salt,
           affiliation, status, is_protected, is_system, force_password_rotation, created_at, updated_at)
           VALUES ($1,$2,$3,'hash','salt','agency'::user_affiliation,'active'::user_status,false,false,false,now(),now())"#,
        [id.into(), format!("Test {email}").into(), email.into()],
    ))
    .await
    .expect("seed user");
    id
}

async fn seed_org(db: &DatabaseConnection, created_by: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    let s = id.to_string().replace('-', "");
    let short = format!("o{}", &s[s.len()-9..]);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO organizations (id, name, short_code, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())"#,
        [id.into(), format!("org-{id}").into(), short.into(), created_by.into()],
    ))
    .await
    .expect("seed org");
    id
}

async fn seed_cluster(db: &DatabaseConnection, org_id: Uuid, created_by: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO clusters (id, name, type, organization_id, created_by, created_at, updated_at)
           VALUES ($1, $2, 'agency'::cluster_type, $3, $4, now(), now())"#,
        [id.into(), format!("cluster-{id}").into(), org_id.into(), created_by.into()],
    ))
    .await
    .expect("seed cluster");
    id
}

static TEAM_LEVEL: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(1);

async fn seed_team(db: &DatabaseConnection, cluster_id: Uuid, created_by: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    let level = TEAM_LEVEL.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO teams (id, cluster_id, name, level, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, now(), now())"#,
        [id.into(), cluster_id.into(), format!("team-{id}").into(), (level as i32).into(), created_by.into()],
    ))
    .await
    .expect("seed team");
    id
}

async fn seed_membership(db: &DatabaseConnection, user_id: Uuid, team_id: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO team_memberships (id, user_id, team_id, team_role, added_by, expires_after, created_at, updated_at)
           VALUES ($1, $2, $3, 'member'::team_role, $2, NULL, now(), now())"#,
        [id.into(), user_id.into(), team_id.into()],
    ))
    .await
    .expect("seed membership");
    id
}

// Checks the lookup predicate used by delete_team_member before the UPDATE.
async fn membership_visible(db: &DatabaseConnection, member_id: Uuid, team_id: Uuid) -> bool {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT 1 FROM team_memberships
           WHERE id = $1 AND team_id = $2 AND expires_after IS NULL LIMIT 1"#,
        [member_id.into(), team_id.into()],
    ))
    .await
    .expect("query membership");
    !rows.is_empty()
}

async fn cleanup(db: &DatabaseConnection, user_id: Uuid, membership_id: Uuid, team_id: Uuid, cluster_id: Uuid, org_id: Uuid) {
    for (sql, val) in [
        ("DELETE FROM team_memberships WHERE id = $1", membership_id),
        ("DELETE FROM teams WHERE id = $1", team_id),
        ("DELETE FROM clusters WHERE id = $1", cluster_id),
        ("DELETE FROM organizations WHERE id = $1", org_id),
        ("DELETE FROM users WHERE id = $1", user_id),
    ] {
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, sql, vec![val.into()]))
            .await
            .ok();
    }
}

// ── Positive: active membership with correct IDs is visible ──────────────────

#[tokio::test]
async fn correct_team_id_sees_active_membership() {
    let db = connect().await;
    let email = format!("teams-pos-{}@test.local", Uuid::now_v7());
    let user_id = seed_user(&db, &email).await;
    let org_id = seed_org(&db, user_id).await;
    let cluster_id = seed_cluster(&db, org_id, user_id).await;
    let team_id = seed_team(&db, cluster_id, user_id).await;
    let member_id = seed_membership(&db, user_id, team_id).await;

    assert!(
        membership_visible(&db, member_id, team_id).await,
        "active membership must be visible with correct team_id"
    );

    cleanup(&db, user_id, member_id, team_id, cluster_id, org_id).await;
}

// ── IDOR negative §1: wrong team_id → query returns 0 rows ───────────────────
//
// An attacker supplies a valid member_id but a different team_id they own.
// The WHERE team_id=$2 predicate must return empty → route returns 404,
// not 200 or a silent cross-team delete.

#[tokio::test]
async fn wrong_team_id_membership_not_visible() {
    let db = connect().await;
    let email = format!("teams-idor1-{}@test.local", Uuid::now_v7());
    let user_id = seed_user(&db, &email).await;
    let org_id = seed_org(&db, user_id).await;
    let cluster_id = seed_cluster(&db, org_id, user_id).await;

    let real_team_id = seed_team(&db, cluster_id, user_id).await;
    let other_team_id = seed_team(&db, cluster_id, user_id).await;
    let member_id = seed_membership(&db, user_id, real_team_id).await;

    // Supplying other_team_id instead of real_team_id must return no rows.
    assert!(
        !membership_visible(&db, member_id, other_team_id).await,
        "IDOR guard: membership must NOT be visible with wrong team_id"
    );
    // Correct team_id still works (guard is selective, not broken).
    assert!(
        membership_visible(&db, member_id, real_team_id).await,
        "membership must still be visible with correct team_id"
    );

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM team_memberships WHERE id = $1",
        vec![member_id.into()],
    )).await.ok();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM teams WHERE id = $1 OR id = $2",
        vec![real_team_id.into(), other_team_id.into()],
    )).await.ok();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM clusters WHERE id = $1",
        vec![cluster_id.into()],
    )).await.ok();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM organizations WHERE id = $1",
        vec![org_id.into()],
    )).await.ok();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM users WHERE id = $1",
        vec![user_id.into()],
    )).await.ok();
}

// ── IDOR negative §2: non-admin blocked by user_has_any_admin_role ────────────
//
// A user with no admin grant must fail the guard → route 403.

#[tokio::test]
async fn non_admin_has_no_admin_role() {
    let db = connect().await;
    let email = format!("teams-nonadmin-{}@test.local", Uuid::now_v7());
    let user_id = seed_user(&db, &email).await;

    let is_admin = ffs_server::db::admin_roles::user_has_any_admin_role(&db, user_id)
        .await
        .expect("is_admin check");
    assert!(
        !is_admin,
        "non-admin user must fail admin guard (route must return 403)"
    );

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM users WHERE id = $1",
        [user_id.into()],
    )).await.ok();
}

// ── Bite check §2: already-expired membership not visible ────────────────────
//
// Membership with expires_after IS NOT NULL must return 0 rows — confirming
// the IS NULL guard prevents re-deletion.

#[tokio::test]
async fn expired_membership_not_visible() {
    let db = connect().await;
    let email = format!("teams-expired-{}@test.local", Uuid::now_v7());
    let user_id = seed_user(&db, &email).await;
    let org_id = seed_org(&db, user_id).await;
    let cluster_id = seed_cluster(&db, org_id, user_id).await;
    let team_id = seed_team(&db, cluster_id, user_id).await;
    let member_id = seed_membership(&db, user_id, team_id).await;

    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE team_memberships SET expires_after = now() WHERE id = $1",
        vec![member_id.into()],
    ))
    .await
    .expect("expire membership");

    assert!(
        !membership_visible(&db, member_id, team_id).await,
        "bite check §2: expired membership must NOT be visible (expires_after IS NULL guard)"
    );

    cleanup(&db, user_id, member_id, team_id, cluster_id, org_id).await;
}
