// IDOR negative tests for GET /admin/teams and POST /admin/teams.
//
// Importers/callers: cargo test --test admin_teams_idor (standalone integration suite).
//   Routes under test registered in main.rs:
//   .route("/admin/teams", get(admin::teams::list_teams).post(admin::teams::create_team))
// Affected API: GET /admin/teams, POST /admin/teams
// Data schemas: teams(id, cluster_id, name, level, description, created_by, ...),
//               clusters(id, organization_id, ...), organizations(id, ...)
// User instruction: "fix the rust port to ensure API and PlayWright suites pass"
//
// Positive (list_live_enriched):
//   A team seeded under org A is returned with correct cluster_type, clusterName, organizationId.
// IDOR negative §1 (cross-org read):
//   A team under org A has organizationId = org A; filtering by org B yields an empty set.
//   (Mirrors the route: ScopeKind::Scoped filters on organization_id.)
// IDOR negative §2 (expired team):
//   A team with expires_after IS NOT NULL is NOT returned by list_live_enriched.
// Bite check §2 (level uniqueness predicate):
//   level_taken returns Some(name) when a live team already holds that level in the cluster.
// Bite check §3 (name uniqueness predicate):
//   name_taken_in_cluster returns true when a live team with that name exists in the cluster.

use ffs_server::db::teams;
use sea_orm::{ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

async fn connect() -> DatabaseConnection {
    let url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "postgres://postgres:postgres@localhost:5432/breakglass_test".to_string());
    Database::connect(&url).await.expect("DB connect")
}

async fn seed_user(db: &DatabaseConnection) -> Uuid {
    let id = Uuid::now_v7();
    let email = format!("atidor-{}@test.local", id);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO users (id, full_name, email, password_hash, password_salt,
           affiliation, status, is_protected, is_system, force_password_rotation, created_at, updated_at)
           VALUES ($1,$2,$3,'hash','salt','agency'::user_affiliation,'active'::user_status,false,false,false,now(),now())"#,
        [id.into(), format!("ATIDOR {id}").into(), email.into()],
    ))
    .await
    .expect("seed user");
    id
}

async fn seed_org(db: &DatabaseConnection, created_by: Uuid) -> Uuid {
    let id = Uuid::now_v7();
    let s = id.to_string().replace('-', "");
    let short = format!("A{}", &s[s.len()-8..]);
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO organizations (id, name, short_code, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, now(), now())"#,
        [id.into(), format!("atidor-org-{id}").into(), short.into(), created_by.into()],
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
        [id.into(), format!("atidor-cluster-{id}").into(), org_id.into(), created_by.into()],
    ))
    .await
    .expect("seed cluster");
    id
}

static LEVEL_CTR: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(1);

async fn seed_team(db: &DatabaseConnection, cluster_id: Uuid, created_by: Uuid, name: &str, level: i16) -> Uuid {
    let id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO teams (id, cluster_id, name, level, created_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, now(), now())"#,
        [id.into(), cluster_id.into(), name.to_string().into(), (level as i32).into(), created_by.into()],
    ))
    .await
    .expect("seed team");
    id
}

async fn seed_team_expired(db: &DatabaseConnection, cluster_id: Uuid, created_by: Uuid, level: i16) -> Uuid {
    let id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO teams (id, cluster_id, name, level, created_by, created_at, updated_at, expires_after)
           VALUES ($1, $2, $3, $4, $5, now(), now(), now() - interval '1 second')"#,
        [id.into(), cluster_id.into(), format!("expired-{id}").into(), (level as i32).into(), created_by.into()],
    ))
    .await
    .expect("seed expired team");
    id
}

async fn cleanup(db: &DatabaseConnection, ids: Vec<(&str, Uuid)>) {
    for (table, id) in ids.into_iter().rev() {
        let sql = format!("DELETE FROM {} WHERE id = $1", table);
        db.execute(Statement::from_sql_and_values(DbBackend::Postgres, &sql, vec![id.into()]))
            .await
            .ok();
    }
}

// ── Positive: list_live_enriched returns enriched team with org from cluster JOIN ─

#[tokio::test]
async fn list_enriched_returns_team_with_correct_org() {
    let db = connect().await;
    let user_id = seed_user(&db).await;
    let org_id = seed_org(&db, user_id).await;
    let cluster_id = seed_cluster(&db, org_id, user_id).await;
    let level = LEVEL_CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as i16;
    let team_id = seed_team(&db, cluster_id, user_id, &format!("team-pos-{}", Uuid::now_v7()), level).await;

    let all = teams::list_live_enriched(&db).await.expect("list_live_enriched");
    let row = all.iter().find(|r| r.team.id == team_id)
        .expect("seeded team must appear in enriched list");

    assert_eq!(row.organization_id, Some(org_id), "organizationId must be derived from cluster JOIN");
    assert!(row.cluster_name.is_some(), "clusterName must be populated");
    assert_eq!(row.cluster_type.as_deref(), Some("agency"), "cluster type must be 'agency'");

    cleanup(&db, vec![("teams", team_id), ("clusters", cluster_id), ("organizations", org_id), ("users", user_id)]).await;
}

// ── IDOR negative §1: team under org A invisible to org B scoped filter ───────

#[tokio::test]
async fn cross_org_team_filtered_out_by_scoped_scope() {
    let db = connect().await;
    let user_id = seed_user(&db).await;
    let org_a = seed_org(&db, user_id).await;
    let org_b = seed_org(&db, user_id).await;
    let cluster_a = seed_cluster(&db, org_a, user_id).await;
    let level = LEVEL_CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as i16;
    let team_id = seed_team(&db, cluster_a, user_id, &format!("team-idor1-{}", Uuid::now_v7()), level).await;

    let all = teams::list_live_enriched(&db).await.expect("list_live_enriched");

    // Simulate ScopeKind::Scoped([org_b]) — team is under org_a.
    let visible_to_org_b: Vec<_> = all.iter().filter(|r| r.organization_id == Some(org_b)).collect();
    assert!(
        visible_to_org_b.iter().all(|r| r.team.id != team_id),
        "IDOR guard: org-A team must NOT appear in org-B scoped filter"
    );

    // org-A scope must still see the team.
    let visible_to_org_a: Vec<_> = all.iter().filter(|r| r.organization_id == Some(org_a)).collect();
    assert!(
        visible_to_org_a.iter().any(|r| r.team.id == team_id),
        "org-A team must be visible to org-A scoped filter"
    );

    cleanup(&db, vec![
        ("teams", team_id),
        ("clusters", cluster_a),
        ("organizations", org_b),
        ("organizations", org_a),
        ("users", user_id),
    ]).await;
}

// ── IDOR negative §2: expired team excluded from list_live_enriched ───────────

#[tokio::test]
async fn expired_team_excluded_from_enriched_list() {
    let db = connect().await;
    let user_id = seed_user(&db).await;
    let org_id = seed_org(&db, user_id).await;
    let cluster_id = seed_cluster(&db, org_id, user_id).await;
    let level = LEVEL_CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as i16;
    let expired_id = seed_team_expired(&db, cluster_id, user_id, level).await;

    let all = teams::list_live_enriched(&db).await.expect("list_live_enriched");
    assert!(
        all.iter().all(|r| r.team.id != expired_id),
        "Bite check §2: expired team must NOT appear in list_live_enriched"
    );

    cleanup(&db, vec![("teams", expired_id), ("clusters", cluster_id), ("organizations", org_id), ("users", user_id)]).await;
}

// ── Bite check §2: level_taken blocks duplicate level in same cluster ─────────

#[tokio::test]
async fn level_taken_blocks_duplicate_level_in_cluster() {
    let db = connect().await;
    let user_id = seed_user(&db).await;
    let org_id = seed_org(&db, user_id).await;
    let cluster_id = seed_cluster(&db, org_id, user_id).await;
    let level = LEVEL_CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as i16;
    let existing_name = format!("lvl-team-{}", Uuid::now_v7());
    let team_id = seed_team(&db, cluster_id, user_id, &existing_name, level).await;

    let taken = teams::level_taken(&db, cluster_id, level).await.expect("level_taken");
    assert_eq!(
        taken.as_deref(),
        Some(existing_name.as_str()),
        "level_taken must return existing team name when level is occupied"
    );

    // Same level in a different cluster must NOT be taken.
    let other_org = seed_org(&db, user_id).await;
    let other_cluster = seed_cluster(&db, other_org, user_id).await;
    let free = teams::level_taken(&db, other_cluster, level).await.expect("level_taken cross-cluster");
    assert!(free.is_none(), "same level in a different cluster must NOT block");

    cleanup(&db, vec![
        ("teams", team_id),
        ("clusters", other_cluster),
        ("organizations", other_org),
        ("clusters", cluster_id),
        ("organizations", org_id),
        ("users", user_id),
    ]).await;
}

// ── Bite check §3: name_taken_in_cluster prevents duplicate name ──────────────

#[tokio::test]
async fn name_taken_blocks_duplicate_name_in_cluster() {
    let db = connect().await;
    let user_id = seed_user(&db).await;
    let org_id = seed_org(&db, user_id).await;
    let cluster_id = seed_cluster(&db, org_id, user_id).await;
    let name = format!("name-team-{}", Uuid::now_v7());
    let level = LEVEL_CTR.fetch_add(1, std::sync::atomic::Ordering::Relaxed) as i16;
    let team_id = seed_team(&db, cluster_id, user_id, &name, level).await;

    assert!(
        teams::name_taken_in_cluster(&db, cluster_id, &name).await.expect("name_taken"),
        "name_taken_in_cluster must be true for an existing live team"
    );
    assert!(
        !teams::name_taken_in_cluster(&db, cluster_id, "nonexistent-team-xyzzy").await.expect("name_taken"),
        "name_taken_in_cluster must be false for an unused name"
    );

    cleanup(&db, vec![("teams", team_id), ("clusters", cluster_id), ("organizations", org_id), ("users", user_id)]).await;
}
