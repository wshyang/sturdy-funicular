//! Port of test/backend/deno/sessions.test.tsx — session lifecycle + central
//! session gate, including browser-navigation pass-through (addendum-108/128).
use anyhow::Result;
use chrono::{DateTime, Utc};
use ffs_server::auth::session::{
    create_session, create_session_exclusive, destroy_session, get_session, touch_session,
    CreateSessionOpts,
};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use sea_orm::Database;
use serde_json::{json, Value};

use crate::fixtures;

const BROWSER_ACCEPT: &str =
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

fn cookie_name() -> &'static str {
    ffs_server::security_headers::session_cookie_name(&ffs_server::config::AppEnv::Dev, false)
}

async fn raw_login(app: &TestApp, email: &str, password: &str) -> Result<(u16, Value)> {
    let resp = app
        .request_with_headers(
            Method::POST,
            "/auth/login",
            &[("X-Session-Transport", "bearer")],
            Some(json!({ "email": email, "password": password })),
        )
        .await?;
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await?;
    Ok((status, body))
}

async fn session_count(app: &TestApp, user_id: uuid::Uuid) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT count(*)::bigint FROM sessions WHERE user_id = $1")
        .bind(user_id)
        .fetch_one(app.db())
        .await?)
}

async fn token_row_count(app: &TestApp, token: &str) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT count(*)::bigint FROM sessions WHERE id = $1")
        .bind(token)
        .fetch_one(app.db())
        .await?)
}

async fn idle_out(app: &TestApp, token: &str) -> Result<()> {
    sqlx::query("UPDATE sessions SET last_activity_at = now() - interval '16 minutes' WHERE id = $1")
        .bind(token)
        .execute(app.db())
        .await?;
    Ok(())
}

// ── session CRUD ─────────────────────────────────────────────────────────────

#[tokio::test]
async fn get_session_resolves_active_session() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SessResolvePass!2026").await?;
    let sea = Database::connect(app.db_url()).await?;
    let token = create_session(&sea, admin.id, CreateSessionOpts::default()).await?;
    let s = get_session(&sea, &token).await?;
    parity_assert!("L:899820ac55048e5f-1", s.is_some());
    let s = s.unwrap();
    parity_assert_eq!("L:119fdcce1c821e66-1", s.user_id, admin.id);
    parity_assert!("L:5ffcac0bd3587ef6-1", s.twofa_verified_at.is_none());
    Ok(())
}

#[tokio::test]
async fn session_token_is_64_char_hex_not_uuid() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SessTokenShapePass!2026").await?;
    let sea = Database::connect(app.db_url()).await?;
    let token = create_session(&sea, admin.id, CreateSessionOpts::default()).await?;
    parity_assert_eq!("L:be8c5f90fab43c17-1", token.len(), 64);
    parity_assert_eq!("L:a4ea775be72f821f-1", token.contains('-'), false);
    Ok(())
}

#[tokio::test]
async fn get_session_deletes_past_absolute_ttl() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SessTtlPass!2026").await?;
    let sea = Database::connect(app.db_url()).await?;
    let token = create_session(&sea, admin.id, CreateSessionOpts::default()).await?;
    sqlx::query("UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE id = $1")
        .bind(&token)
        .execute(app.db())
        .await?;
    parity_assert!("L:6b126fbb172f8c45-1", get_session(&sea, &token).await?.is_none());
    parity_assert_eq!("L:c84381f8b7510ae2-1", token_row_count(&app, &token).await?, 0);
    Ok(())
}

#[tokio::test]
async fn get_session_deletes_past_inactivity_timeout() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SessIdlePass!2026").await?;
    let sea = Database::connect(app.db_url()).await?;
    let token = create_session(&sea, admin.id, CreateSessionOpts::default()).await?;
    idle_out(&app, &token).await?;
    parity_assert!("L:e780ecc7039a8a41-1", get_session(&sea, &token).await?.is_none());
    parity_assert_eq!("L:7738889a643a576f-1", token_row_count(&app, &token).await?, 0);
    Ok(())
}

#[tokio::test]
async fn touch_session_slides_inactivity_window() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SessTouchPass!2026").await?;
    let sea = Database::connect(app.db_url()).await?;
    let token = create_session(&sea, admin.id, CreateSessionOpts::default()).await?;
    sqlx::query("UPDATE sessions SET last_activity_at = now() - interval '10 minutes' WHERE id = $1")
        .bind(&token)
        .execute(app.db())
        .await?;
    let before: DateTime<Utc> =
        sqlx::query_scalar("SELECT last_activity_at FROM sessions WHERE id = $1")
            .bind(&token)
            .fetch_one(app.db())
            .await?;
    touch_session(&sea, &token).await?;
    let after: DateTime<Utc> =
        sqlx::query_scalar("SELECT last_activity_at FROM sessions WHERE id = $1")
            .bind(&token)
            .fetch_one(app.db())
            .await?;
    parity_assert!("L:14243d286238cbc3-1", after > before);
    Ok(())
}

#[tokio::test]
async fn destroy_session_deletes_row() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "SessDestroyPass!2026").await?;
    let sea = Database::connect(app.db_url()).await?;
    let token = create_session(&sea, admin.id, CreateSessionOpts::default()).await?;
    destroy_session(&sea, &token).await?;
    parity_assert_eq!("L:35f3473803842021-1", token_row_count(&app, &token).await?, 0);
    parity_assert!("L:2afbc0e90f36e71b-1", get_session(&sea, &token).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn single_session_sign_in_invalidates_first_session() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("singleneck");
    let user = fixtures::create_active_user(
        &app, "Single Session User", &email, "SingleSess!2026", "agency", true,
    )
    .await?;
    let login_a = fixtures::login_as(&app, &user.email, &user.password).await?;
    let session_a = fixtures::session_of(&login_a)?;
    parity_assert!("L:55984872695c089b-1", !session_a.is_empty());
    let (ok_status, _) = app.auth_get_json("/requests/my-requests", &session_a).await?;
    parity_assert_eq!("L:2e7a5d7e3492b1c1-1", ok_status.as_u16(), 200);

    let login_b = fixtures::login_as(&app, &user.email, &user.password).await?;
    let session_b = fixtures::session_of(&login_b)?;
    parity_assert!("L:7d70fc5c9934c20e-1", !session_b.is_empty());
    parity_assert!("L:12e32ce9774b402f-1", session_a != session_b);

    let (first_status, first_body) = app.auth_get_json("/requests/my-requests", &session_a).await?;
    parity_assert_eq!("L:45f1217b764d3ce3-1", first_status.as_u16(), 401);
    parity_assert_eq!("L:ad323c10b2f95ca6-1", first_body["code"], "session_expired");
    parity_assert_eq!("L:849aa8d829bce047-1", token_row_count(&app, &session_a).await?, 0);
    let (second_status, _) = app.auth_get_json("/requests/my-requests", &session_b).await?;
    parity_assert_eq!("L:c37e88fdbdf8f110-1", second_status.as_u16(), 200);
    Ok(())
}

#[tokio::test]
async fn create_session_exclusive_keeps_only_fresh_token() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("exclmint");
    let user = fixtures::create_active_user(
        &app, "Exclusive Mint User", &email, "ExclMint!2026", "vendor", false,
    )
    .await?;
    let sea = Database::connect(app.db_url()).await?;
    let older = create_session(&sea, user.id, CreateSessionOpts::default()).await?;
    let stale = create_session(&sea, user.id, CreateSessionOpts::default()).await?;
    parity_assert_eq!("L:dbfe95d40e629a9e-1", session_count(&app, user.id).await?, 2);
    let fresh = create_session_exclusive(&sea, user.id, CreateSessionOpts::default()).await?;
    parity_assert_eq!("L:c2e86f9c2193d4e2-1", session_count(&app, user.id).await?, 1);
    let remaining: String = sqlx::query_scalar("SELECT id FROM sessions WHERE user_id = $1")
        .bind(user.id)
        .fetch_one(app.db())
        .await?;
    parity_assert_eq!("L:8e573591d323595c-1", remaining, fresh);
    parity_assert!("L:b0d58a0cf6d205b4-1", get_session(&sea, &older).await?.is_none());
    parity_assert!("L:8a601fac4505dd08-1", get_session(&sea, &stale).await?.is_none());
    parity_assert_eq!(
        "L:83a8a72bc6cf2588-1",
        get_session(&sea, &fresh).await?.unwrap().user_id,
        user.id
    );
    Ok(())
}

// ── central session gate ─────────────────────────────────────────────────────

#[tokio::test]
async fn gate_rejects_inactive_session_with_session_expired() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("gate");
    let user = fixtures::create_active_user(
        &app, "Gate Vendor", &email, "GatePass!2026", "vendor", true,
    )
    .await?;
    let login = fixtures::login_as(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    parity_assert!("L:fedf7d9e872a520f-1", !session.is_empty());
    let (ok_status, _) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:dbf4f92f6e5d0866-1", ok_status.as_u16(), 200);
    idle_out(&app, &session).await?;
    let (status, body) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:62c8845e1eefcb38-1", status.as_u16(), 401);
    parity_assert_eq!("L:74ed20a6d1df608b-1", body["code"], "session_expired");
    Ok(())
}

#[tokio::test]
async fn gate_touches_active_session_on_each_request() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "GateTouchPass!2026").await?;
    let login = fixtures::login_user(&app, &admin).await?;
    let session = fixtures::session_of(&login)?;
    sqlx::query("UPDATE sessions SET last_activity_at = now() - interval '10 minutes' WHERE id = $1")
        .bind(&session)
        .execute(app.db())
        .await?;
    let (status, _) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:d6c3c24b022979e6-1", status.as_u16(), 200);
    let last: DateTime<Utc> =
        sqlx::query_scalar("SELECT last_activity_at FROM sessions WHERE id = $1")
            .bind(&session)
            .fetch_one(app.db())
            .await?;
    parity_assert!(
        "L:cd2b259cb7396e15-1",
        Utc::now().signed_duration_since(last).num_milliseconds() < 60_000
    );
    Ok(())
}

#[tokio::test]
async fn gate_allowlisted_auth_me_resolves_for_active_session() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "GateMePass!2026").await?;
    let login = fixtures::login_user(&app, &admin).await?;
    let session = fixtures::session_of(&login)?;
    let (status, _) = app.auth_get_json("/auth/me", &session).await?;
    parity_assert_eq!("L:cbd7bda88c34fd00-1", status.as_u16(), 200);
    Ok(())
}

#[tokio::test]
async fn gate_no_token_passes_through_to_route_auth_rejection() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (status, body) = app.get_json("/requests/my-requests").await?;
    let code = status.as_u16();
    parity_assert!("L:b367f91d8d71a8e9-1", (400..500).contains(&code));
    parity_assert!("L:c61b29904b05ebae-1", body["code"] != "session_expired");
    Ok(())
}

// ── browser-navigation pass-through (addendum-108) ───────────────────────────

async fn dead_session_for(app: &TestApp, password: &str) -> Result<String> {
    let email = fixtures::unique_email("gatenav");
    let user = fixtures::create_active_user(
        app, "Nav Gate User", &email, password, "vendor", true,
    )
    .await?;
    let login = fixtures::login_as(app, &user.email, password).await?;
    let session = fixtures::session_of(&login)?;
    parity_assert!("L:8ed8768f51e445bf-1", !session.is_empty());
    idle_out(app, &session).await?;
    let sea = Database::connect(app.db_url()).await?;
    parity_assert!(
        "L:98c06f96ad6efc02-1",
        get_session(&sea, &session).await?.is_none()
    );
    Ok(session)
}

fn cleared_cookie(resp: &reqwest::Response) -> bool {
    let prefix = format!("{}=;", cookie_name());
    resp.headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .any(|c| c.starts_with(&prefix) && c.to_lowercase().contains("max-age=0"))
}

#[tokio::test]
async fn browser_document_navigation_dead_cookie_passes_through_and_clears_cookie() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let dead = dead_session_for(&app, "GateNavA!2026").await?;
    let cookie = format!("{}={}", cookie_name(), dead);
    let resp = app
        .request_with_headers(
            Method::GET,
            "/",
            &[("Cookie", &cookie), ("Accept", BROWSER_ACCEPT)],
            None,
        )
        .await?;
    let status = resp.status().as_u16();
    let cleared = cleared_cookie(&resp);
    let text = resp.text().await?;
    parity_assert!("L:7dbcaf8e1554ffb7-1", status != 401);
    parity_assert_eq!("L:977137dc55e60fc1-1", text.contains("session_expired"), false);
    parity_assert_eq!("L:9fdbba672fd48eda-1", cleared, true);
    Ok(())
}

#[tokio::test]
async fn dead_cookie_api_shaped_request_keeps_session_expired() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let dead = dead_session_for(&app, "GateNavB!2026").await?;
    let cookie = format!("{}={}", cookie_name(), dead);
    let (status, body) = app
        .json_with_headers(
            Method::GET,
            "/requests/my-requests",
            &[("Cookie", &cookie), ("Accept", "application/json")],
            None,
        )
        .await?;
    parity_assert_eq!("L:cc3aa8450ef6b606-1", status.as_u16(), 401);
    parity_assert_eq!("L:82a31c5da765c5f3-1", body["code"], "session_expired");
    Ok(())
}

#[tokio::test]
async fn explicit_session_token_keeps_session_expired_even_with_browser_accept() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let dead = dead_session_for(&app, "GateNavC!2026").await?;
    let (status, body) = app
        .json_with_headers(
            Method::GET,
            "/requests/my-requests",
            &[("X-Session-Token", &dead), ("Accept", BROWSER_ACCEPT)],
            None,
        )
        .await?;
    parity_assert_eq!("L:1a3ddaed5bfb1e0b-1", status.as_u16(), 401);
    parity_assert_eq!("L:8ad117e92eef9552-1", body["code"], "session_expired");
    Ok(())
}

// ── twofa_required browser-navigation analog (addendum-128) ──────────────────

async fn pending_verification_session_for(app: &TestApp, password: &str) -> Result<String> {
    let email = fixtures::unique_email("gate2fav");
    let user = fixtures::create_active_user(
        app, "2FA Nav User", &email, password, "vendor", true,
    )
    .await?;
    let (status, data) = raw_login(app, &user.email, password).await?;
    parity_assert_eq!("L:bcc850797bad8046-1", status, 200);
    parity_assert_eq!("L:ea80083f054a1de1-1", data["needs2faVerification"], true);
    fixtures::session_of(&data)
}

async fn pending_enrollment_session_for(app: &TestApp, password: &str) -> Result<String> {
    let email = fixtures::unique_email("gate2fae");
    let user = fixtures::create_active_user(
        app, "2FA Enroll Nav User", &email, password, "vendor", false,
    )
    .await?;
    let (status, data) = raw_login(app, &user.email, password).await?;
    parity_assert_eq!("L:bcc850797bad8046-2", status, 200);
    parity_assert_eq!("L:31089f8cfeb56942-1", data["needs2faEnrollment"], true);
    fixtures::session_of(&data)
}

#[tokio::test]
async fn browser_navigation_mid_enrollment_passes_through_without_clearing_cookie() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let pending = pending_enrollment_session_for(&app, "Gate2faA!2026").await?;
    let cookie = format!("{}={}", cookie_name(), pending);
    let resp = app
        .request_with_headers(
            Method::GET,
            "/",
            &[("Cookie", &cookie), ("Accept", BROWSER_ACCEPT)],
            None,
        )
        .await?;
    let status = resp.status().as_u16();
    let cleared = cleared_cookie(&resp);
    let text = resp.text().await?;
    parity_assert!("L:f725971f2cd35981-1", status != 403);
    parity_assert_eq!("L:92317c75273322ee-1", text.contains("twofa_required"), false);
    parity_assert_eq!("L:f60741e0e9accbef-1", cleared, false);
    Ok(())
}

#[tokio::test]
async fn mid_2fa_api_shaped_request_keeps_twofa_required() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let pending = pending_verification_session_for(&app, "Gate2faB!2026").await?;
    let cookie = format!("{}={}", cookie_name(), pending);
    let (status, body) = app
        .json_with_headers(
            Method::GET,
            "/requests/my-requests",
            &[("Cookie", &cookie), ("Accept", "application/json")],
            None,
        )
        .await?;
    parity_assert_eq!("L:0f0274d584d975c1-1", status.as_u16(), 403);
    parity_assert_eq!("L:4e29f2098c117d38-1", body["code"], "twofa_required");
    Ok(())
}

#[tokio::test]
async fn explicit_session_token_keeps_twofa_required_even_with_browser_accept() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let pending = pending_verification_session_for(&app, "Gate2faC!2026").await?;
    let (status, body) = app
        .json_with_headers(
            Method::GET,
            "/requests/my-requests",
            &[("X-Session-Token", &pending), ("Accept", BROWSER_ACCEPT)],
            None,
        )
        .await?;
    parity_assert_eq!("L:ddc30a9bc3393a41-1", status.as_u16(), 403);
    parity_assert_eq!("L:b7f45a6708aae51d-1", body["code"], "twofa_required");
    Ok(())
}
