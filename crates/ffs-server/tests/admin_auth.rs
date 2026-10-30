// Real-DB integration tests for admin capability scope resolution.
// Covers the security core used by GET /admin/capabilities and
// GET /admin/clusters (and all other admin routes).
//
// Positive test: full_admin grant → ScopeKind::Global for ClusterRead.
// IDOR negative: user with no grant → ScopeKind::None (route returns 403).
// Bite check §2: same user, same DB, revoked grant → confirms None, not Global.

use ffs_server::db::admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind};
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

async fn seed_full_admin_role(db: &DatabaseConnection) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO admin_roles (id,key,name,description,capabilities,is_system_role,created_at,updated_at)
           VALUES ('00000000-0000-0000-0000-000000000006','full_admin','Full Administrator','All caps',
                   ARRAY['ClusterRead','ClusterCreate','ClusterUpdate','ClusterDelete',
                         'UserRead','UserInvite','AdminRolesManage'],
                   true,now(),now())
           ON CONFLICT (key) DO UPDATE SET capabilities = EXCLUDED.capabilities"#,
        [],
    ))
    .await
    .expect("seed full_admin role");
}

async fn grant_role(db: &DatabaseConnection, user_id: Uuid, role_key: &str) -> Uuid {
    let grant_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO user_admin_role_grants (id,user_id,role_key,granted_by,granted_at)
           VALUES ($1,$2,$3,$2,now()) ON CONFLICT DO NOTHING"#,
        [grant_id.into(), user_id.into(), role_key.into()],
    ))
    .await
    .expect("grant role");
    grant_id
}

async fn revoke_grant(db: &DatabaseConnection, grant_id: Uuid) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE user_admin_role_grants SET revoked_at = now() WHERE id = $1",
        [grant_id.into()],
    ))
    .await
    .expect("revoke grant");
}

async fn cleanup_user(db: &DatabaseConnection, user_id: Uuid) {
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM user_admin_role_grants WHERE user_id = $1",
        [user_id.into()],
    ))
    .await
    .ok();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "DELETE FROM users WHERE id = $1",
        [user_id.into()],
    ))
    .await
    .ok();
}

// ── Positive: full_admin sees Global scope ────────────────────────────────────

#[tokio::test]
async fn full_admin_has_global_cluster_read() {
    let db = connect().await;
    let email = format!("admin-pos-{}@test.local", Uuid::now_v7());
    let user_id = seed_user(&db, &email).await;
    seed_full_admin_role(&db).await;
    grant_role(&db, user_id, "full_admin").await;

    let scope = resolve_admin_capability_scope(&db, user_id, "ClusterRead")
        .await
        .expect("resolve scope");
    assert!(
        matches!(scope, ScopeKind::Global),
        "full_admin with ClusterRead must resolve to Global, not Scoped/None"
    );

    let is_admin = user_has_any_admin_role(&db, user_id).await.expect("is_admin");
    assert!(is_admin, "full_admin must have an active admin role grant");

    cleanup_user(&db, user_id).await;
}

// ── IDOR negative: no grant → None (route returns 403) ───────────────────────

#[tokio::test]
async fn no_grant_user_has_no_capability() {
    let db = connect().await;
    let email = format!("nonadmin-{}@test.local", Uuid::now_v7());
    let user_id = seed_user(&db, &email).await;

    let scope = resolve_admin_capability_scope(&db, user_id, "ClusterRead")
        .await
        .expect("resolve scope");
    assert!(
        matches!(scope, ScopeKind::None),
        "user with no grant must resolve to None (route must return 403)"
    );

    let is_admin = user_has_any_admin_role(&db, user_id).await.expect("is_admin");
    assert!(!is_admin, "user with no grant must not be admin");

    cleanup_user(&db, user_id).await;
}

// ── Bite check §2: revoked grant must not satisfy capability ─────────────────

#[tokio::test]
async fn revoked_grant_returns_none() {
    let db = connect().await;
    let email = format!("revoked-{}@test.local", Uuid::now_v7());
    let user_id = seed_user(&db, &email).await;
    seed_full_admin_role(&db).await;
    let grant_id = grant_role(&db, user_id, "full_admin").await;

    // Confirm active grant gives Global.
    let before = resolve_admin_capability_scope(&db, user_id, "ClusterRead")
        .await
        .expect("before revoke");
    assert!(matches!(before, ScopeKind::Global), "must be Global before revoke");

    // Revoke.
    revoke_grant(&db, grant_id).await;

    // After revoke: must be None — bite check proves the revoked_at guard works.
    let after = resolve_admin_capability_scope(&db, user_id, "ClusterRead")
        .await
        .expect("after revoke");
    assert!(
        matches!(after, ScopeKind::None),
        "revoked grant must NOT satisfy capability (bite check §2)"
    );

    let is_admin = user_has_any_admin_role(&db, user_id).await.expect("is_admin");
    assert!(!is_admin, "revoked grant must not count as admin");

    cleanup_user(&db, user_id).await;
}

// ── Capabilities count matches ALL_CAPABILITIES ───────────────────────────────

#[test]
fn all_capabilities_count_is_54() {
    // Ensures Rust constant stays in sync with auth-admin-capabilities.ts.
    assert_eq!(
        ffs_server::routes::admin::capabilities::ALL_CAPABILITIES.len(),
        54,
        "ALL_CAPABILITIES must have 54 entries matching auth-admin-capabilities.ts"
    );
}
