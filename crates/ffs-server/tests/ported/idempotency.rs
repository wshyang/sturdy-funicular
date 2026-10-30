//! Port of test/backend/deno/idempotency.test.tsx — global idempotency-token
//! enforcement, request-wide transaction rollback, concurrent consumption, and
//! the hourly expired-token sweep (addenda 008 / 014 / 019).
use anyhow::{bail, Result};
use chrono::{DateTime, Utc};
use ffs_server::{idempotency::sweep_expired_idempotency_tokens, tx::run_in_transaction};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

use crate::fixtures;

async fn admin_session(app: &TestApp, password: &str) -> Result<(fixtures::FixtureUser, String)> {
    let admin = fixtures::create_admin(app, password).await?;
    let login = fixtures::login_user(app, &admin).await?;
    let session = fixtures::session_of(&login)?;
    Ok((admin, session))
}

fn cluster_body(name: &str, org_id: Uuid) -> Value {
    json!({ "name": name, "type": "vendor", "organizationId": org_id.to_string() })
}

async fn post_cluster(
    app: &TestApp,
    session: &str,
    token: &str,
    body: Value,
) -> Result<reqwest::Response> {
    app.request_with_headers(
        Method::POST,
        "/admin/clusters",
        &[("X-Session-Token", session), ("X-Idempotency-Token", token)],
        Some(body),
    )
    .await
}

async fn cluster_count(app: &TestApp, name: &str) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT count(*)::bigint FROM clusters WHERE name = $1")
        .bind(name)
        .fetch_one(app.db())
        .await?)
}

async fn token_used_at(app: &TestApp, token: &str) -> Result<Option<Option<DateTime<Utc>>>> {
    let row = sqlx::query("SELECT used_at FROM idempotency_tokens WHERE token = $1::uuid")
        .bind(token)
        .fetch_optional(app.db())
        .await?;
    Ok(row.map(|r| r.try_get("used_at").ok().flatten()))
}

async fn token_exists(app: &TestApp, token: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT count(*)::bigint FROM idempotency_tokens WHERE token = $1::uuid")
        .bind(token)
        .fetch_one(app.db())
        .await?
        > 0)
}

async fn insert_token(app: &TestApp, user_id: Uuid, token: Uuid, expires_interval: &str) -> Result<()> {
    sqlx::query(&format!(
        "INSERT INTO idempotency_tokens (id, user_id, token, created_at, used_at, expires_at) \
         VALUES ($1, $2, $3, now(), NULL, now() + interval '{expires_interval}')"
    ))
    .bind(Uuid::now_v7())
    .bind(user_id)
    .bind(token)
    .execute(app.db())
    .await?;
    Ok(())
}

// ── middleware negatives / positives ─────────────────────────────────────────

#[tokio::test]
async fn missing_idempotency_header_on_mutating_route_is_409() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, session) = admin_session(&app, "IdemPass!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let resp = post_cluster(
        &app,
        &session,
        "",
        cluster_body(&fixtures::unique_name("cluster"), org_id),
    )
    .await?;
    parity_assert_eq!("L:0ffc64727e659c00-1", resp.status().as_u16(), 409);
    let data = resp.json::<Value>().await?;
    parity_assert!("L:c2923933a62e25d8-1", data.get("error").is_some());
    Ok(())
}

#[tokio::test]
async fn invalid_never_issued_token_is_409() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, session) = admin_session(&app, "IdemPass2!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let resp = post_cluster(
        &app,
        &session,
        &Uuid::now_v7().to_string(),
        cluster_body(&fixtures::unique_name("cluster"), org_id),
    )
    .await?;
    parity_assert_eq!("L:6c7788d032f8fafa-1", resp.status().as_u16(), 409);
    Ok(())
}

#[tokio::test]
async fn already_used_token_rejected_on_second_request() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, session) = admin_session(&app, "IdemPass3!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let token = app.mint_idempotency_token(&session).await?;
    let first = post_cluster(
        &app,
        &session,
        &token,
        cluster_body(&fixtures::unique_name("cluster"), org_id),
    )
    .await?;
    parity_assert_eq!("L:74e8777d2bbd8c42-1", first.status().as_u16(), 201);
    let second = post_cluster(
        &app,
        &session,
        &token,
        cluster_body(&fixtures::unique_name("cluster"), org_id),
    )
    .await?;
    parity_assert_eq!("L:774114933c74c1b3-1", second.status().as_u16(), 409);
    Ok(())
}

#[tokio::test]
async fn token_minted_for_different_user_is_rejected() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin1, session1) = admin_session(&app, "IdemPass4!2026").await?;
    let (_admin2, session2) = admin_session(&app, "IdemPass5!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin1.id).await?;
    let token_for_other = app.mint_idempotency_token(&session2).await?;
    let resp = post_cluster(
        &app,
        &session1,
        &token_for_other,
        cluster_body(&fixtures::unique_name("cluster"), org_id),
    )
    .await?;
    parity_assert_eq!("L:2813fa5bff8a6ff0-1", resp.status().as_u16(), 409);
    Ok(())
}

#[tokio::test]
async fn valid_token_succeeds_and_rotates_fresh_usable_token() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, session) = admin_session(&app, "IdemPass6!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let token = app.mint_idempotency_token(&session).await?;
    let resp = post_cluster(
        &app,
        &session,
        &token,
        cluster_body(&fixtures::unique_name("cluster"), org_id),
    )
    .await?;
    parity_assert_eq!("L:66afd14b111cc5b3-1", resp.status().as_u16(), 201);
    let rotated = resp
        .headers()
        .get("X-Idempotency-Token")
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    parity_assert!("L:aec7850c258648da-1", rotated.is_some());
    let rotated = rotated.unwrap();
    parity_assert_eq!("L:68037e9553a5e9d4-1", rotated == token, false);
    let follow_up = post_cluster(
        &app,
        &session,
        &rotated,
        cluster_body(&fixtures::unique_name("cluster"), org_id),
    )
    .await?;
    parity_assert_eq!("L:a0a1b2cf801e0e51-1", follow_up.status().as_u16(), 201);
    Ok(())
}

#[tokio::test]
async fn token_rotates_even_on_validation_error() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (_admin, session) = admin_session(&app, "IdemPass7!2026").await?;
    let token = app.mint_idempotency_token(&session).await?;
    let resp = post_cluster(&app, &session, &token, json!({ "type": "vendor" })).await?;
    parity_assert_eq!("L:77b1f79548e114e3-1", resp.status().as_u16(), 400);
    parity_assert!(
        "L:c5177cc7e82ac478-1",
        resp.headers().get("X-Idempotency-Token").is_some()
    );
    Ok(())
}

#[tokio::test]
async fn get_requests_are_never_gated_by_idempotency() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (_admin, session) = admin_session(&app, "IdemPass8!2026").await?;
    let (status, _body) = app.auth_get_json("/admin/clusters", &session).await?;
    parity_assert_eq!("L:71a700955333ed0d-1", status.as_u16(), 200);
    Ok(())
}

#[tokio::test]
async fn unauthenticated_mutating_request_gets_route_auth_failure_not_409() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let resp = app
        .request_with_headers(
            Method::POST,
            "/admin/clusters",
            &[],
            Some(json!({ "name": fixtures::unique_name("cluster"), "type": "vendor" })),
        )
        .await?;
    parity_assert_eq!("L:b0fab2de3fbe6a98-1", resp.status().as_u16(), 403);
    Ok(())
}

#[tokio::test]
async fn auth_signup_is_excluded_from_enforcement() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("idem-excl");
    let resp = app
        .request_with_headers(
            Method::POST,
            "/auth/signup",
            &[],
            Some(json!({ "fullName": "Idem Exclusion", "email": email, "password": "ValidPass!2026" })),
        )
        .await?;
    parity_assert_eq!("L:294856b9c957fc45-1", resp.status().as_u16(), 201);
    Ok(())
}

// ── real transaction support ─────────────────────────────────────────────────

async fn insert_cluster_txn(
    txn: &sea_orm::DatabaseTransaction,
    name: &str,
    org_id: Uuid,
    created_by: Uuid,
) -> Result<()> {
    txn.execute(Statement::from_sql_and_values(
        DatabaseBackend::Postgres,
        r#"INSERT INTO clusters (id, name, "type", description, organization_id, created_by, created_at, updated_at)
           VALUES ($1, $2, 'vendor', NULL, $3, $4, now(), now())"#,
        [Uuid::now_v7().into(), name.into(), org_id.into(), created_by.into()],
    ))
    .await?;
    Ok(())
}

#[tokio::test]
async fn run_in_transaction_rolls_back_write_on_thrown_error() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "TxnPass1!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let probe = fixtures::unique_name("txn-probe-cluster");
    let sea = Database::connect(app.db_url()).await?;
    let probe_name = probe.clone();
    let result: Result<()> = run_in_transaction(&sea, move |txn| {
        Box::pin(async move {
            insert_cluster_txn(txn, &probe_name, org_id, admin.id).await?;
            let row = txn
                .query_one(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "SELECT count(*)::bigint AS n FROM clusters WHERE name = $1",
                    [probe_name.clone().into()],
                ))
                .await?
                .expect("count row");
            let n: i64 = row.try_get("", "n")?;
            parity_assert_eq!("L:7c4998d6c03242ef-1", n, 1);
            bail!("deliberate failure to force rollback");
        })
    })
    .await;
    parity_assert_eq!("L:3cd24ef05764d928-1", result.is_err(), true);
    parity_assert_eq!("L:9db50b89a02f3626-1", cluster_count(&app, &probe).await?, 0);
    Ok(())
}

#[tokio::test]
async fn run_in_transaction_commits_write_on_success() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "TxnPass2!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let probe = fixtures::unique_name("txn-commit-cluster");
    let sea = Database::connect(app.db_url()).await?;
    let probe_name = probe.clone();
    run_in_transaction(&sea, move |txn| {
        Box::pin(async move {
            insert_cluster_txn(txn, &probe_name, org_id, admin.id).await?;
            Ok(())
        })
    })
    .await?;
    parity_assert_eq!("L:f9de3ef7ca6b38f6-1", cluster_count(&app, &probe).await?, 1);
    Ok(())
}

#[tokio::test]
async fn concurrent_requests_same_token_exactly_one_succeeds() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, session) = admin_session(&app, "TxnPass3!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let token = app.mint_idempotency_token(&session).await?;
    let body_a = cluster_body(&fixtures::unique_name("concurrent-cluster"), org_id);
    let body_b = cluster_body(&fixtures::unique_name("concurrent-cluster"), org_id);
    let (a, b) = tokio::join!(
        post_cluster(&app, &session, &token, body_a),
        post_cluster(&app, &session, &token, body_b)
    );
    let mut statuses = vec![a?.status().as_u16(), b?.status().as_u16()];
    statuses.sort();
    parity_assert_eq!("L:9f77cf8795c9cd3e-1", statuses, vec![201, 409]);
    Ok(())
}

#[tokio::test]
async fn mid_handler_db_failure_rolls_back_write_and_unconsumes_loser_token() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (admin, session) = admin_session(&app, "TxnPass4!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let clash = fixtures::unique_name("race-cluster");
    let token_winner = app.mint_idempotency_token(&session).await?;
    let token_loser = app.mint_idempotency_token(&session).await?;

    // Force the legacy unique-index race deterministically: both requests pass
    // the app-level check while no row is committed, then the second INSERT
    // fails inside the handler with a unique-violation-shaped DB error. The
    // contract under test is rollback + token un-consumption on that 5xx.
    let suffix = Uuid::now_v7().simple().to_string();
    let seq = format!("idem_race_seq_{suffix}");
    let fn_name = format!("idem_race_fail_{suffix}");
    sqlx::query(&format!("CREATE SEQUENCE {seq}")).execute(app.db()).await?;
    sqlx::query(&format!(
        "CREATE FUNCTION {fn_name}() RETURNS trigger LANGUAGE plpgsql AS $$ \
         DECLARE n bigint; \
         BEGIN \
           IF NEW.name = '{clash}' THEN \
             n := nextval('{seq}'); \
             IF n > 1 THEN \
               RAISE EXCEPTION 'forced race failure' USING ERRCODE = '23505'; \
             ELSE \
               PERFORM pg_sleep(1); \
             END IF; \
           END IF; \
           RETURN NEW; \
         END $$"
    ))
    .execute(app.db())
    .await?;
    sqlx::query(&format!(
        "CREATE TRIGGER {fn_name}_trg BEFORE INSERT ON clusters \
         FOR EACH ROW EXECUTE FUNCTION {fn_name}()"
    ))
    .execute(app.db())
    .await?;

    let (r1, r2) = tokio::join!(
        post_cluster(&app, &session, &token_winner, cluster_body(&clash, org_id)),
        post_cluster(&app, &session, &token_loser, cluster_body(&clash, org_id))
    );
    let r1 = r1?;
    let r2 = r2?;
    let s1 = r1.status().as_u16();
    let (winner_status, loser_status, loser_token) = if s1 == 201 {
        (s1, r2.status().as_u16(), token_loser)
    } else {
        (r2.status().as_u16(), s1, token_winner)
    };
    parity_assert_eq!("L:c92c98013a369085-1", winner_status, 201);
    parity_assert_eq!("L:90ba9f828891c2c2-1", loser_status, 500);
    parity_assert_eq!("L:3ee21f02c6c5cebe-1", cluster_count(&app, &clash).await?, 1);
    let used_at = token_used_at(&app, &loser_token).await?;
    parity_assert!("L:a36c6552b968dbd2-1", used_at.is_some());
    parity_assert!("L:1b0f4dddd60b0067-1", used_at.unwrap().is_none());
    Ok(())
}

// ── hourly cron sweep ────────────────────────────────────────────────────────

#[tokio::test]
async fn sweep_deletes_long_expired_but_keeps_grace_and_unexpired_tokens() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SweepPass1!2026").await?;
    let expired_long_ago = Uuid::now_v7();
    let expired_within_grace = Uuid::now_v7();
    let not_yet_expired = Uuid::now_v7();
    insert_token(&app, admin.id, expired_long_ago, "-2 hours").await?;
    insert_token(&app, admin.id, expired_within_grace, "-30 minutes").await?;
    insert_token(&app, admin.id, not_yet_expired, "10 minutes").await?;
    let sea = Database::connect(app.db_url()).await?;
    sweep_expired_idempotency_tokens(&sea).await?;
    parity_assert_eq!(
        "L:69d16b241b43e1e3-1",
        token_exists(&app, &expired_long_ago.to_string()).await?,
        false
    );
    parity_assert!(
        "L:59500b65aa24fbfc-1",
        token_exists(&app, &expired_within_grace.to_string()).await?
    );
    parity_assert!(
        "L:bb86bb3a23b12a55-1",
        token_exists(&app, &not_yet_expired.to_string()).await?
    );
    Ok(())
}

#[tokio::test]
async fn sweep_no_op_when_only_unexpired_tokens_exist() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SweepPass2!2026").await?;
    let token = Uuid::now_v7();
    insert_token(&app, admin.id, token, "15 minutes").await?;
    let sea = Database::connect(app.db_url()).await?;
    sweep_expired_idempotency_tokens(&sea).await?;
    parity_assert!("L:6c13581f0b788b0f-1", token_exists(&app, &token.to_string()).await?);
    Ok(())
}
