//! Port of test/backend/deno/auth.test.tsx (52 assertions).

use crate::fixtures;

use anyhow::Result;
use ffs_test_support::TestApp;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use sqlx::Row;

async fn signup(app: &TestApp, body: Value) -> Result<(StatusCode, Value)> {
    app.json_with_headers(Method::POST, "/auth/signup", &[], Some(body)).await
}

async fn login_bearer(app: &TestApp, email: &str, password: &str) -> Result<(StatusCode, Value)> {
    app.json_with_headers(
        Method::POST,
        "/auth/login",
        &[("X-Session-Transport", "bearer")],
        Some(json!({ "email": email, "password": password })),
    )
    .await
}

#[tokio::test]
async fn signup_creates_pending_user_and_notifies_admins() -> Result<()> {
    TestApp::run("auth_signup_positive", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "SignupNotifyAdminPass!2026").await?;
        let email = fixtures::unique_email("signup");
        let (status, data) = signup(&app, json!({ "fullName": "New Signup", "email": email, "password": "ValidPass!2026" })).await?;
        // parity-assert: L:767e5435bbb52b16-1
        assert_eq!(status, StatusCode::CREATED);
        // parity-assert: L:d0c795ee30094de8-1
        assert!(!data["userId"].is_null());

        let notif = sqlx::query("SELECT id FROM sent_notifications WHERE trigger_key = 'user.signup_pending_admins' ORDER BY created_at DESC LIMIT 1")
            .fetch_optional(app.db())
            .await?;
        // parity-assert: L:d2bf356306ddf79d-1
        assert!(notif.is_some());
        let notif_id: uuid::Uuid = notif.unwrap().try_get("id")?;
        let rows = sqlx::query("SELECT email_snapshot FROM notification_recipients WHERE notification_id = $1 ORDER BY ordinal")
            .bind(notif_id)
            .fetch_all(app.db())
            .await?;
        let emails: Vec<String> = rows.into_iter().map(|r| r.try_get("email_snapshot")).collect::<std::result::Result<_, _>>()?;
        // parity-assert: L:8c8c469b7bca313f-1
        assert_eq!(emails, vec![admin.email]);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn signup_negatives() -> Result<()> {
    TestApp::run("auth_signup_negatives", |app| async move {
        fixtures::prepare(&app).await?;
        let (status, _) = signup(&app, json!({ "email": "x@test.local" })).await?;
        // parity-assert: L:86e747d3de126d68-1
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, _) = signup(&app, json!({ "fullName": "Bad Email", "email": "not-an-email", "password": "ValidPass!2026" })).await?;
        // parity-assert: L:980cc14773456daa-1
        assert_eq!(status, StatusCode::BAD_REQUEST);

        let (status, data) = signup(&app, json!({ "fullName": "Weak Pw", "email": fixtures::unique_email("weak"), "password": "weak" })).await?;
        // parity-assert: L:0b006ab34c4617db-1
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // parity-assert: L:a81de6acda4abf4e-1
        assert!(!data["error"].is_null());

        let email = fixtures::unique_email("dup");
        let (first_status, _) = signup(&app, json!({ "fullName": "First", "email": email, "password": "ValidPass!2026" })).await?;
        // parity-assert: L:fc1645d8a140fe0c-1
        assert_eq!(first_status, StatusCode::CREATED);
        let (second_status, _) = signup(&app, json!({ "fullName": "Second", "email": email, "password": "ValidPass!2026" })).await?;
        // parity-assert: L:f6052046ec779e63-1
        assert_eq!(second_status, StatusCode::BAD_REQUEST);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn login_negatives() -> Result<()> {
    TestApp::run("auth_login_negatives", |app| async move {
        fixtures::prepare(&app).await?;
        let pending_email = fixtures::unique_email("pending");
        signup(&app, json!({ "fullName": "Pending", "email": pending_email, "password": "ValidPass!2026" })).await?;
        let (status, _) = login_bearer(&app, &pending_email, "ValidPass!2026").await?;
        // parity-assert: L:ddbab5255718eb9d-1
        assert_eq!(status, StatusCode::FORBIDDEN);

        let admin = fixtures::create_admin(&app, "CorrectPass!2026").await?;
        let (status, data) = login_bearer(&app, &admin.email, "WrongPass!2026").await?;
        // parity-assert: L:e3d0bd4e61443ca9-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // parity-assert: L:4576fb31ba367cea-1
        assert_eq!(data["error"], "Invalid email or password.");

        let (status, data) = login_bearer(&app, "nobody@test.local", "Whatever!2026").await?;
        // parity-assert: L:78b4ab3c917ad7bb-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // parity-assert: L:97402a66a99d0a2d-1
        assert_eq!(data["error"], "Invalid email or password.");

        let (status, _) = app.json_with_headers(Method::POST, "/auth/login", &[], Some(json!({ "email": "x@test.local" }))).await?;
        // parity-assert: L:b6e7b15135d428c4-1
        assert_eq!(status, StatusCode::BAD_REQUEST);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn login_transport_shapes() -> Result<()> {
    TestApp::run("auth_login_transport", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "LoginPass!2026").await?;
        let (status, data) = login_bearer(&app, &admin.email, "LoginPass!2026").await?;
        // parity-assert: L:e3e56848edfc4e05-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:3d55a7865d289aa0-1
        assert!(!data["session"].is_null());
        // parity-assert: L:30ed1a5782319de4-1
        assert_eq!(data["user"]["email"], admin.email);
        // parity-assert: L:9fdbc268a616263a-1
        assert_eq!(data["user"]["passwordHash"], Value::Null);
        // parity-assert: L:7ee2d169bf1b64cc-1
        assert_eq!(data["user"]["passwordSalt"], Value::Null);

        let cookie_admin = fixtures::create_admin(&app, "CookieOnlyPass!2026").await?;
        let (status, data) = app.json_with_headers(
            Method::POST,
            "/auth/login",
            &[("X-Session-Transport", "cookie")],
            Some(json!({ "email": cookie_admin.email, "password": "CookieOnlyPass!2026" })),
        ).await?;
        // parity-assert: L:3353260b3cfed244-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:9f5a6302d28bfaae-1
        assert!(!data.as_object().map(|o| o.contains_key("session")).unwrap_or(false));
        // parity-assert: L:52379853c5df25fd-1
        assert_eq!(data["user"]["email"], cookie_admin.email);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn auth_me_session_states() -> Result<()> {
    TestApp::run("auth_me_session_states", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "MePass!2026").await?;
        let login = fixtures::login_user(&app, &admin).await?;
        let session = fixtures::session_of(&login)?;
        let (status, data) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:d6a797dd9043dd2d-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:81a442bed3e8a9dd-1
        assert_eq!(data["user"]["id"], admin.id.to_string());

        let (status, _) = app.get_json("/auth/me").await?;
        // parity-assert: L:e4bf5389fc7dbef7-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        let (status, _) = app.json_with_headers(Method::GET, "/auth/me", &[("X-Session-Token", "not-a-real-session")], None).await?;
        // parity-assert: L:f33541839b784852-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn capability_snapshot_admin_and_tokens() -> Result<()> {
    TestApp::run("auth_capability_snapshot", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "SnapPass!2026").await?;
        let login = fixtures::login_user(&app, &admin).await?;
        let session = fixtures::session_of(&login)?;
        let (status, data) = app.auth_get_json("/me/capability-snapshot", &session).await?;
        // parity-assert: L:848a833cea730a15-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:e9cd436f5224b598-1
        assert_eq!(data["snapshot"]["isAdmin"], true);
        // parity-assert: L:cd23dbaf8667121c-1
        assert_eq!(data["snapshot"]["visibleSystemIds"], "*");

        let (status, _) = app.get_json("/me/capability-snapshot").await?;
        // parity-assert: L:4287ed94e08caebe-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (_, a) = app.auth_get_json("/me/capability-snapshot", &session).await?;
        // parity-assert: L:a248fcaef15f46ed-1
        assert!(!a["idempotencyToken"].is_null());
        let (_, b) = app.auth_get_json("/me/capability-snapshot", &session).await?;
        // parity-assert: L:45a6cc0ec3438fbe-1
        assert!(!b["idempotencyToken"].is_null());
        // parity-assert: L:1649ed236e162d4c-1
        assert_ne!(a["idempotencyToken"], b["idempotencyToken"]);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn logout_destroys_session() -> Result<()> {
    TestApp::run("auth_logout", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "LogoutPass!2026").await?;
        let login = fixtures::login_user(&app, &admin).await?;
        let session = fixtures::session_of(&login)?;
        let (before, _) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:5dd02edbafa1ccf7-1
        assert_eq!(before, StatusCode::OK);
        let (logout, _) = app.json_with_headers(Method::POST, "/auth/logout", &[("X-Session-Token", &session)], None).await?;
        // parity-assert: L:334399a6ef60da3a-1
        assert_eq!(logout, StatusCode::OK);
        let (after, _) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:c55a8ee32c01a642-1
        assert_eq!(after, StatusCode::UNAUTHORIZED);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn login_lockout_after_repeated_failures() -> Result<()> {
    TestApp::run("auth_login_lockout", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "LockoutPass!2026").await?;
        for _ in 0..5 {
            let _ = login_bearer(&app, &admin.email, "WrongPass!2026").await?;
        }
        let (status, _) = login_bearer(&app, &admin.email, "LockoutPass!2026").await?;
        // parity-assert: L:ec034dc4bf9442c1-1
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn password_salt_signup_round_trip() -> Result<()> {
    TestApp::run("auth_password_salt_round_trip", |app| async move {
        fixtures::prepare(&app).await?;
        let email = fixtures::unique_email("salted");
        let password = "SaltedPass!2026";
        let (status, data) = signup(&app, json!({ "fullName": "Salted User", "email": email, "password": password })).await?;
        // parity-assert: L:7170edc0b28f9077-1
        assert_eq!(status, StatusCode::CREATED);
        let user_id = data["userId"].as_str().unwrap_or_default().to_string();
        let row = sqlx::query("SELECT password_salt, password_hash FROM users WHERE id = $1::uuid")
            .bind(&user_id)
            .fetch_optional(app.db())
            .await?;
        // parity-assert: L:d65325acaf61ad60-1
        assert!(row.is_some());
        let row = row.unwrap();
        let salt: String = row.try_get("password_salt")?;
        let hash: String = row.try_get("password_hash")?;
        // parity-assert: L:b0e0cec5aaf39eb5-1
        assert_ne!(salt, "");
        // parity-assert: L:a7342d01a551a8cb-1
        assert_eq!(hash, ffs_server::auth::password::hash_password(password, &salt)?);

        sqlx::query("UPDATE users SET status = 'active', affiliation = 'vendor' WHERE id = $1::uuid")
            .bind(&user_id)
            .execute(app.db())
            .await?;
        let (login_status, _) = login_bearer(&app, &email, password).await?;
        // parity-assert: L:19ac78a79aff8531-1
        assert_eq!(login_status, StatusCode::OK);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn password_salt_distinct_for_same_password() -> Result<()> {
    TestApp::run("auth_password_salt_distinct", |app| async move {
        fixtures::prepare(&app).await?;
        let password = "IdenticalPass!2026";
        let email_a = fixtures::unique_email("same-a");
        let email_b = fixtures::unique_email("same-b");
        signup(&app, json!({ "fullName": "Same A", "email": email_a, "password": password })).await?;
        signup(&app, json!({ "fullName": "Same B", "email": email_b, "password": password })).await?;
        let rows = sqlx::query("SELECT password_salt, password_hash FROM users WHERE email = ANY($1) ORDER BY email")
            .bind(vec![email_a, email_b])
            .fetch_all(app.db())
            .await?;
        // parity-assert: L:812a1bc3a9825200-1
        assert_eq!(rows.len(), 2);
        let salt_a: String = rows[0].try_get("password_salt")?;
        let salt_b: String = rows[1].try_get("password_salt")?;
        let hash_a: String = rows[0].try_get("password_hash")?;
        let hash_b: String = rows[1].try_get("password_hash")?;
        // parity-assert: L:ff3140a49cb88f27-1
        assert_ne!(salt_a, salt_b);
        // parity-assert: L:5df67dfe5f03bf6f-1
        assert_ne!(hash_a, hash_b);
        Ok(())
    })
    .await
}

#[test]
fn password_verify_seam() -> Result<()> {
    let salt = ffs_server::auth::password::generate_salt();
    let hash = ffs_server::auth::password::hash_password("CorrectHorse!2026", &salt)?;
    // parity-assert: L:fb54f88da5b4a108-1
    assert_eq!(ffs_server::auth::password::verify_password("CorrectHorse!2026", &salt, &hash)?, true);
    // parity-assert: L:1fdb5db73a12249d-1
    assert_eq!(ffs_server::auth::password::verify_password("WrongHorse!2026", &salt, &hash)?, false);
    // parity-assert: L:2732f318b7ef7a5b-1
    assert_eq!(ffs_server::auth::password::verify_password("CorrectHorse!2026", &ffs_server::auth::password::generate_salt(), &hash)?, false);

    let salt = ffs_server::auth::password::generate_salt();
    let hash = ffs_server::auth::password::hash_password("BasePass!2026", &salt)?;
    let same_len_wrong: String = hash.chars().rev().collect();
    // parity-assert: L:27a08e106b4ba14a-1
    assert_eq!(same_len_wrong.len(), hash.len());
    // parity-assert: L:105417c0f2378a46-1
    assert_eq!(ffs_server::auth::password::verify_password("BasePass!2026", &salt, &same_len_wrong)?, false);
    Ok(())
}
