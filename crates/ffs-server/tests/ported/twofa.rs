//! Port of test/backend/deno/twofa.test.tsx — real TOTP codes throughout, no
//! mocks (addendum-046). Covers the pure verifier, login flags, enrollment,
//! returning-user verification, auth negatives, session scoping, the central
//! twofa_required gate, and the five-attempt session invalidation rule.
use anyhow::Result;
use chrono::{DateTime, Utc};
use ffs_server::auth::totp::{generate_totp_code, generate_totp_secret, verify_totp};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::{json, Value};
use sqlx::Row;

use crate::fixtures;

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

async fn enroll(app: &TestApp, session: &str) -> Result<(reqwest::StatusCode, Value)> {
    app.json_with_headers(
        Method::GET,
        "/auth/2fa/enroll",
        &[("X-Session-Token", session)],
        None,
    )
    .await
}

async fn verify(app: &TestApp, session: &str, code: &str) -> Result<(reqwest::StatusCode, Value)> {
    app.json_with_headers(
        Method::POST,
        "/auth/2fa/verify",
        &[("X-Session-Token", session)],
        Some(json!({ "code": code })),
    )
    .await
}

fn secret_from_uri(uri: &str) -> Option<&str> {
    uri.split("secret=").nth(1).and_then(|s| s.split('&').next())
}

fn wrong_code(secret: &str) -> Result<String> {
    let live = generate_totp_code(secret)?;
    Ok(if live == "000000" { "999999".into() } else { "000000".into() })
}

async fn user_totp_secret(app: &TestApp, email: &str) -> Result<Option<String>> {
    let row = sqlx::query("SELECT totp_secret FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(app.db())
        .await?;
    Ok(row.and_then(|r| r.try_get("totp_secret").ok()))
}

async fn user_enrolled_at(app: &TestApp, email: &str) -> Result<Option<DateTime<Utc>>> {
    let row = sqlx::query("SELECT totp_enrolled_at FROM users WHERE email = $1")
        .bind(email)
        .fetch_optional(app.db())
        .await?;
    Ok(row.and_then(|r| r.try_get("totp_enrolled_at").ok()))
}

async fn session_pending_secret(app: &TestApp, session: &str) -> Result<Option<String>> {
    let row = sqlx::query("SELECT pending_totp_secret FROM sessions WHERE id = $1")
        .bind(session)
        .fetch_optional(app.db())
        .await?;
    Ok(row.and_then(|r| r.try_get("pending_totp_secret").ok()))
}

async fn session_verified_at(app: &TestApp, session: &str) -> Result<Option<DateTime<Utc>>> {
    let row = sqlx::query("SELECT twofa_verified_at FROM sessions WHERE id = $1")
        .bind(session)
        .fetch_optional(app.db())
        .await?;
    Ok(row.and_then(|r| r.try_get("twofa_verified_at").ok()))
}

async fn session_row_count(app: &TestApp, session: &str) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT count(*)::bigint FROM sessions WHERE id = $1")
        .bind(session)
        .fetch_one(app.db())
        .await?)
}

// ── pure verifier ────────────────────────────────────────────────────────────

#[test]
fn verify_totp_accepts_live_code_rejects_wrong_one() -> Result<()> {
    let secret = generate_totp_secret()?;
    let live = generate_totp_code(&secret)?;
    parity_assert_eq!("L:68616d9b9aad884b-1", verify_totp(&secret, &live)?, true);
    parity_assert_eq!("L:0703036fd6d9c600-1", verify_totp(&secret, "000000")?, false);
    parity_assert_eq!("L:a8cafbee96390580-1", verify_totp(&secret, "")?, false);
    parity_assert_eq!("L:ed6bc7194fb7f055-1", verify_totp("", "123456")?, false);
    Ok(())
}

// ── login flags ──────────────────────────────────────────────────────────────

#[tokio::test]
async fn login_unenrolled_user_gets_needs_enrollment() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("enroll-flag");
    let user = fixtures::create_active_user(
        &app, "Enroll Flag", &email, "EnrollFlag!2026", "vendor", false,
    )
    .await?;
    let (status, data) = raw_login(&app, &user.email, &user.password).await?;
    parity_assert_eq!("L:95aba85c542f7ec9-1", status, 200);
    parity_assert_eq!("L:dc164c4ed2fa3bd6-1", data["needs2faEnrollment"], true);
    parity_assert_eq!("L:8aa81585f2dbd4b7-1", data["needs2faVerification"], false);
    parity_assert!("L:17b9372e249dd555-1", data["user"]["totpSecret"].is_null());
    Ok(())
}

#[tokio::test]
async fn login_enrolled_user_gets_needs_verification() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("verify-flag");
    let user = fixtures::create_active_user(
        &app, "Verify Flag", &email, "VerifyFlag!2026", "vendor", true,
    )
    .await?;
    let (status, data) = raw_login(&app, &user.email, &user.password).await?;
    parity_assert_eq!("L:d0d1712ee3160904-1", status, 200);
    parity_assert_eq!("L:178e761371414246-1", data["needs2faEnrollment"], false);
    parity_assert_eq!("L:fc2fc21b737a4b2a-1", data["needs2faVerification"], true);
    Ok(())
}

// ── enrollment flow ──────────────────────────────────────────────────────────

#[tokio::test]
async fn enroll_returns_qr_uri_secret_and_stashes_provisional_secret() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("enroll");
    let user = fixtures::create_active_user(
        &app, "Enroll User", &email, "EnrollUser!2026", "vendor", false,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    let (status, data) = enroll(&app, &session).await?;
    parity_assert_eq!("L:d9c1be358a07bd78-1", status.as_u16(), 200);
    let qr = data["qrDataUrl"].as_str().unwrap_or_default();
    let uri = data["otpauthUri"].as_str().unwrap_or_default();
    let secret = data["secretBase32"].as_str().unwrap_or_default();
    parity_assert!("L:86b5e4058ae634fb-1", !qr.is_empty());
    parity_assert_eq!("L:85a78515d1c567c4-1", qr.starts_with("data:image/png;base64,"), true);
    parity_assert!("L:806da9a1e381e93e-1", !uri.is_empty());
    parity_assert_eq!("L:ca42b0a11b14b40a-1", uri.starts_with("otpauth://totp/"), true);
    parity_assert!("L:ac05a0e4b8461db2-1", !secret.is_empty());
    parity_assert_eq!("L:6445b2e3deb399aa-1", secret_from_uri(uri), Some(secret));
    parity_assert_eq!(
        "L:4f2f21f7dc392c45-1",
        session_pending_secret(&app, &session).await?.as_deref(),
        Some(secret)
    );
    parity_assert!("L:b988d7b2379a48b6-1", user_totp_secret(&app, &email).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn verify_enrollment_confirms_secret_and_verifies_session() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("enroll-verify");
    let user = fixtures::create_active_user(
        &app, "Enroll Verify", &email, "EnrollVerify!2026", "vendor", false,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    let (_es, enroll_data) = enroll(&app, &session).await?;
    let secret = enroll_data["secretBase32"].as_str().expect("secretBase32");
    let code = generate_totp_code(secret)?;
    let (status, data) = verify(&app, &session, &code).await?;
    parity_assert_eq!("L:dbf33251423476e0-1", status.as_u16(), 200);
    parity_assert_eq!("L:2c0d902b49be420b-1", data["verified"], true);
    parity_assert_eq!("L:51cb482348dc428a-1", data["enrolled"], true);
    parity_assert_eq!(
        "L:c0d586919593184d-1",
        user_totp_secret(&app, &email).await?.as_deref(),
        Some(secret)
    );
    parity_assert!("L:39ae2fad09c1f220-1", user_enrolled_at(&app, &email).await?.is_some());
    parity_assert!("L:77c78d4f6b713071-1", session_pending_secret(&app, &session).await?.is_none());
    parity_assert!("L:6eab433afc44a6e5-1", session_verified_at(&app, &session).await?.is_some());
    Ok(())
}

#[tokio::test]
async fn verify_enrollment_wrong_code_rejected_nothing_confirmed() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("enroll-wrong");
    let user = fixtures::create_active_user(
        &app, "Enroll Wrong", &email, "EnrollWrong!2026", "vendor", false,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    let (_es, enroll_data) = enroll(&app, &session).await?;
    let secret = enroll_data["secretBase32"].as_str().expect("secretBase32");
    let (status, _body) = verify(&app, &session, &wrong_code(secret)?).await?;
    parity_assert_eq!("L:4952ca9521460c54-1", status.as_u16(), 400);
    parity_assert!("L:8b608ffddae39395-1", user_totp_secret(&app, &email).await?.is_none());
    Ok(())
}

#[tokio::test]
async fn verify_malformed_code_rejected() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("badcode");
    let user = fixtures::create_active_user(
        &app, "Bad Code", &email, "BadCode!2026", "vendor", false,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    enroll(&app, &session).await?;
    for bad in ["123", "12345a", "1234567", ""] {
        let (status, _body) = verify(&app, &session, bad).await?;
        parity_assert_eq!("L:a888831bfa92dea0-1", status.as_u16(), 400);
    }
    Ok(())
}

#[tokio::test]
async fn verify_without_enrollment_in_progress_rejected() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("noenroll");
    let user = fixtures::create_active_user(
        &app, "No Enroll", &email, "NoEnroll!2026", "vendor", false,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    let (status, _body) = verify(&app, &session, "123456").await?;
    parity_assert_eq!("L:bcf79c086dffb32a-1", status.as_u16(), 400);
    Ok(())
}

// ── returning-user flow ──────────────────────────────────────────────────────

#[tokio::test]
async fn verify_returning_user_against_stored_secret() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("returning");
    let user = fixtures::create_active_user(
        &app, "Returning User", &email, "Returning!2026", "vendor", true,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    parity_assert_eq!("L:28e2c29ef8a6408b-1", login["needs2faVerification"], true);
    let session = fixtures::session_of(&login)?;
    let secret = user_totp_secret(&app, &email).await?.expect("stored secret");
    let (status, data) = verify(&app, &session, &generate_totp_code(&secret)?).await?;
    parity_assert_eq!("L:6b5def96f40dc163-1", status.as_u16(), 200);
    parity_assert_eq!("L:8388992fbe249b04-1", data["verified"], true);
    parity_assert_eq!("L:0fcc2343f19ba2ad-1", data["enrolled"], false);
    parity_assert!("L:7b39b97b286e8f24-1", session_verified_at(&app, &session).await?.is_some());
    Ok(())
}

#[tokio::test]
async fn verify_returning_wrong_code_session_stays_unverified() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("returning-wrong");
    let user = fixtures::create_active_user(
        &app, "Returning Wrong", &email, "ReturningWrong!2026", "vendor", true,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    let secret = user_totp_secret(&app, &email).await?.expect("stored secret");
    let (status, _body) = verify(&app, &session, &wrong_code(&secret)?).await?;
    parity_assert_eq!("L:802758ef8e99dc8f-1", status.as_u16(), 400);
    parity_assert!("L:4567d5559b990ee4-1", session_verified_at(&app, &session).await?.is_none());
    Ok(())
}

// ── auth negatives ───────────────────────────────────────────────────────────

#[tokio::test]
async fn enroll_unauthenticated_rejected() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (status, _body) = app.get_json("/auth/2fa/enroll").await?;
    parity_assert_eq!("L:64e6e31ed133a1ca-1", status.as_u16(), 401);
    Ok(())
}

#[tokio::test]
async fn verify_unauthenticated_rejected() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let (status, _body) = app
        .json_with_headers(
            Method::POST,
            "/auth/2fa/verify",
            &[("X-Idempotency-Token", "x")],
            Some(json!({ "code": "123456" })),
        )
        .await?;
    parity_assert_eq!("L:8b853a1849561571-1", status.as_u16(), 401);
    Ok(())
}

#[tokio::test]
async fn verify_is_session_scoped_and_does_not_touch_other_users_session() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email_a = fixtures::unique_email("scope-a");
    let email_b = fixtures::unique_email("scope-b");
    let user_a = fixtures::create_active_user(
        &app, "Scope A", &email_a, "ScopeA!2026", "vendor", true,
    )
    .await?;
    let user_b = fixtures::create_active_user(
        &app, "Scope B", &email_b, "ScopeB!2026", "vendor", true,
    )
    .await?;
    let (_bs, login_b) = raw_login(&app, &user_b.email, &user_b.password).await?;
    let session_b = fixtures::session_of(&login_b)?;
    let (_as, login_a) = raw_login(&app, &user_a.email, &user_a.password).await?;
    let session_a = fixtures::session_of(&login_a)?;
    let secret_a = user_totp_secret(&app, &email_a).await?.expect("secret A");
    let (status, _body) = verify(&app, &session_a, &generate_totp_code(&secret_a)?).await?;
    parity_assert_eq!("L:7939ee3bb2ce98a5-1", status.as_u16(), 200);
    parity_assert!("L:f0862725d132e718-1", session_verified_at(&app, &session_b).await?.is_none());
    Ok(())
}

// ── central gate + attempt limit ─────────────────────────────────────────────

#[tokio::test]
async fn gate_rejects_unverified_session_but_allows_capability_snapshot() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("gate-unverified");
    let user = fixtures::create_active_user(
        &app, "Gate Unverified", &email, "GateUnverified!2026", "vendor", true,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    parity_assert_eq!("L:e6e5607dbe7cf8c5-1", login["needs2faVerification"], true);
    let session = fixtures::session_of(&login)?;
    let (status, body) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:d244632d5bca9d76-1", status.as_u16(), 403);
    parity_assert_eq!("L:142600813365fca7-1", body["code"], "twofa_required");
    let (snapshot_status, _) = app.auth_get_json("/me/capability-snapshot", &session).await?;
    parity_assert_eq!("L:009f121dfc9a33b3-1", snapshot_status.as_u16(), 200);
    Ok(())
}

#[tokio::test]
async fn five_incorrect_totp_codes_atomically_invalidate_session() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("twofa-attempt-limit");
    let user = fixtures::create_active_user(
        &app, "2FA Attempt Limit", &email, "AttemptLimit!2026", "vendor", true,
    )
    .await?;
    let wrong = wrong_code(fixtures::TOTP_SECRET)?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    for _attempt in 1..=4 {
        let (status, _body) = verify(&app, &session, &wrong).await?;
        parity_assert_eq!("L:afe5022be8cd5a7a-1", status.as_u16(), 400);
    }
    let (blocked_status, blocked_body) = verify(&app, &session, &wrong).await?;
    parity_assert_eq!("L:472d84eb937dcc4f-1", blocked_status.as_u16(), 429);
    parity_assert_eq!("L:df019f379a0ccfea-1", blocked_body["code"], "twofa_attempts_exceeded");
    parity_assert_eq!("L:008050421a381eb7-1", session_row_count(&app, &session).await?, 0);
    Ok(())
}

#[tokio::test]
async fn gate_same_session_passes_once_2fa_verified() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("gate-verified");
    let user = fixtures::create_active_user(
        &app, "Gate Verified", &email, "GateVerified!2026", "vendor", true,
    )
    .await?;
    let (_status, login) = raw_login(&app, &user.email, &user.password).await?;
    let session = fixtures::session_of(&login)?;
    let (before_status, _) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:d304859cb5f9b847-1", before_status.as_u16(), 403);
    let secret = user_totp_secret(&app, &email).await?.expect("stored secret");
    let (verify_status, _) = verify(&app, &session, &generate_totp_code(&secret)?).await?;
    parity_assert_eq!("L:8eaac5ed0e3704d2-1", verify_status.as_u16(), 200);
    let (after_status, _) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:751d9d23f1ee90fa-1", after_status.as_u16(), 200);
    Ok(())
}
