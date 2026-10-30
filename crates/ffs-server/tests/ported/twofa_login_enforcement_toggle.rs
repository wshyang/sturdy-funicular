//! Port of test/backend/deno/twofa_login_enforcement_toggle.test.tsx (addendum-212).
//! Enrollment is never optional; only the exact env value "false" suppresses
//! the login-time verify prompt for an already-enrolled user. Each case spawns
//! its own server with the env override so parallel tests never race on env.
use ffs_test_support::{parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::{json, Value};

use crate::fixtures;

const ENV: &str = "TOTP_LOGIN_ENFORCEMENT_ENABLED";
const PASSWORD: &str = "EnforceToggle!2026";

async fn login_raw(app: &TestApp, email: &str) -> anyhow::Result<(u16, Value)> {
    let resp = app
        .request_with_headers(
            Method::POST,
            "/auth/login",
            &[("X-Session-Transport", "bearer")],
            Some(json!({ "email": email, "password": PASSWORD })),
        )
        .await?;
    let status = resp.status().as_u16();
    let body = resp.json::<Value>().await?;
    Ok((status, body))
}

async fn enrolled_user(app: &TestApp, label: &str) -> anyhow::Result<fixtures::FixtureUser> {
    let email = fixtures::unique_email(label);
    fixtures::create_active_user(app, "Enforcement Toggle", &email, PASSWORD, "vendor", true).await
}

#[tokio::test]
async fn enforcement_disabled_enrolled_user_skips_verify_prompt() -> anyhow::Result<()> {
    let app = TestApp::start_with_env("enforce-off-enrolled", &[(ENV, "false")]).await?;
    fixtures::prepare(&app).await?;
    let user = enrolled_user(&app, "enforce-off-enrolled").await?;
    let (status, data) = login_raw(&app, &user.email).await?;
    parity_assert_eq!("L:39ffb48e42d8cc5b-1", status, 200);
    parity_assert_eq!("L:6c9d506b2e15c7fa-1", data["needs2faEnrollment"], false);
    parity_assert_eq!("L:892cc98e99e2b6a6-1", data["needs2faVerification"], false);
    let session = fixtures::session_of(&data)?;
    let (op_status, _) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:81b27be54b5fc6b3-1", op_status.as_u16(), 200);
    Ok(())
}

#[tokio::test]
async fn enforcement_disabled_unenrolled_user_still_must_enroll() -> anyhow::Result<()> {
    let app = TestApp::start_with_env("enforce-off-unenrolled", &[(ENV, "false")]).await?;
    fixtures::prepare(&app).await?;
    let email = fixtures::unique_email("enforce-off-unenrolled");
    let user = fixtures::create_active_user(
        &app, "Enforce Off Unenrolled", &email, PASSWORD, "vendor", false,
    )
    .await?;
    let (status, data) = login_raw(&app, &user.email).await?;
    parity_assert_eq!("L:06f776a5e911abcd-1", status, 200);
    parity_assert_eq!("L:4855bae463db21ed-1", data["needs2faEnrollment"], true);
    parity_assert_eq!("L:65e4e69a216340f9-1", data["needs2faVerification"], false);
    let session = fixtures::session_of(&data)?;
    let (op_status, body) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:bccb7e4522b767ba-1", op_status.as_u16(), 403);
    parity_assert_eq!("L:e57f158e23009594-1", body["code"], "twofa_required");
    Ok(())
}

#[tokio::test]
async fn enforcement_enabled_default_unset_demands_verify() -> anyhow::Result<()> {
    let app = TestApp::start_with_env("enforce-on-enrolled", &[]).await?;
    fixtures::prepare(&app).await?;
    let user = enrolled_user(&app, "enforce-on-enrolled").await?;
    let (status, data) = login_raw(&app, &user.email).await?;
    parity_assert_eq!("L:fe4f213131e1e66c-1", status, 200);
    parity_assert_eq!("L:e2ad544f211ee2e3-1", data["needs2faVerification"], true);
    let session = fixtures::session_of(&data)?;
    let (op_status, body) = app.auth_get_json("/requests/my-requests", &session).await?;
    parity_assert_eq!("L:2935913534326d94-1", op_status.as_u16(), 403);
    parity_assert_eq!("L:701b5514bee73877-1", body["code"], "twofa_required");
    Ok(())
}

#[tokio::test]
async fn enforcement_enabled_explicit_true_same_as_default() -> anyhow::Result<()> {
    let app = TestApp::start_with_env("enforce-on-explicit", &[(ENV, "true")]).await?;
    fixtures::prepare(&app).await?;
    let user = enrolled_user(&app, "enforce-on-explicit").await?;
    let (_status, data) = login_raw(&app, &user.email).await?;
    parity_assert_eq!("L:6e6b4014e9441b1a-1", data["needs2faVerification"], true);
    Ok(())
}

#[tokio::test]
async fn enforcement_empty_env_is_unset_fail_closed() -> anyhow::Result<()> {
    let app = TestApp::start_with_env("enforce-empty", &[(ENV, "")]).await?;
    fixtures::prepare(&app).await?;
    let user = enrolled_user(&app, "enforce-empty").await?;
    let (_status, data) = login_raw(&app, &user.email).await?;
    parity_assert_eq!("L:652c6c7c7280466d-1", data["needs2faVerification"], true);
    Ok(())
}

#[tokio::test]
async fn enforcement_any_value_other_than_false_is_enforced() -> anyhow::Result<()> {
    for raw in ["1", "FALSE", "no", "off", "garbage"] {
        let app = TestApp::start_with_env("enforce-garbage", &[(ENV, raw)]).await?;
        fixtures::prepare(&app).await?;
        let user = enrolled_user(&app, "enforce-garbage").await?;
        let (_status, data) = login_raw(&app, &user.email).await?;
        parity_assert_eq!("L:e90deee0070f0956-1", data["needs2faVerification"], true);
    }
    Ok(())
}
