//! Port of test/backend/deno/auth_me_endpoints.test.tsx (64 assertions).

use crate::fixtures;

use anyhow::Result;
use ffs_test_support::TestApp;
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};
use sqlx::Row;

async fn sign_in(app: &TestApp, email: &str, password: &str) -> Result<Value> {
    let out = fixtures::login_as(app, email, password).await?;
    // parity-assert: L:d385fe3661b8538d-1
    assert!(out.as_object().map(|o| o.contains_key("session")).unwrap_or(false));
    Ok(out)
}

async fn sign_in_user(app: &TestApp, user: &fixtures::FixtureUser) -> Result<String> {
    let login = sign_in(app, &user.email, &user.password).await?;
    fixtures::session_of(&login)
}

async fn submit_request_checked(app: &TestApp, session: &str, system_id: uuid::Uuid, asset_id: uuid::Uuid, sr: &str) -> Result<Value> {
    let (status, body) = fixtures::submit_request(app, session, system_id, asset_id, sr).await?;
    // parity-assert: L:ee4c4b7a9be74ed5-1
    assert_eq!(status, StatusCode::CREATED, "submit {sr} failed: {body}");
    Ok(body)
}

async fn login_unverified(app: &TestApp, email: &str, password: &str) -> Result<(StatusCode, Value)> {
    app.json_with_headers(
        Method::POST,
        "/auth/login",
        &[("X-Session-Transport", "bearer")],
        Some(json!({ "email": email, "password": password })),
    )
    .await
}

#[tokio::test]
async fn auth_me_negatives_and_positive() -> Result<()> {
    TestApp::run("auth_me_negatives_and_positive", |app| async move {
        fixtures::prepare(&app).await?;
        let user = fixtures::create_active_user(&app, "Me Endpoint User", &fixtures::unique_email("meuser"), "MePass!2026", "agency", true).await?;
        let session = sign_in_user(&app, &user).await?;

        let (status, body) = app.get_json("/auth/me").await?;
        // parity-assert: L:f5347de6420b6bc4-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // parity-assert: L:f10942ea07f58560-1
        assert_eq!(body["error"], "Not authenticated.");

        let (status, body) = app.json_with_headers(Method::GET, "/auth/me", &[("X-Session-Token", "not-a-real-session")], None).await?;
        // parity-assert: L:d06915b4a5801618-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // parity-assert: L:ac5c05cbf2c8e066-1
        assert_eq!(body["error"], "Invalid or expired session.");

        let (status, body) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:92ab8b8ca1cc04ae-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:f1c60c5ce5c883b7-1
        assert_eq!(body["user"]["id"], user.id.to_string());
        // parity-assert: L:1e4e8c31fc32efb8-1
        assert_eq!(body["user"]["email"], user.email);
        // parity-assert: L:464b375b99cb97be-1
        assert_eq!(body["twofaVerified"], true);
        // parity-assert: L:82e92a099e0f5903-1
        assert_eq!(body["needs2faEnrollment"], false);
        // parity-assert: L:893b66295090a0a3-1
        assert_eq!(body["needs2faVerification"], false);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn auth_me_never_serialises_secrets() -> Result<()> {
    TestApp::run("auth_me_never_serialises_secrets", |app| async move {
        fixtures::prepare(&app).await?;
        let user = fixtures::create_active_user(&app, "Me Secret User", &fixtures::unique_email("mesecret"), "MePass!2026", "agency", true).await?;
        let session = sign_in_user(&app, &user).await?;
        let (_, raw) = app.auth_get_text("/auth/me", &session).await?;
        for forbidden in ["passwordHash", "password_hash", "salt", "totpSecret", "totp_secret"] {
            // parity-assert: L:ebba19c127eb3b22-1
            assert!(!raw.contains(forbidden), "/auth/me leaked {forbidden}");
        }
        let row = sqlx::query("SELECT totp_secret, password_hash FROM users WHERE id = $1")
            .bind(user.id)
            .fetch_one(app.db())
            .await?;
        let password_hash: String = row.try_get("password_hash")?;
        let totp_secret: Option<String> = row.try_get("totp_secret")?;
        // parity-assert: L:ba7965a013d7b1c0-1
        assert!(password_hash.len() > 0);
        // parity-assert: L:80acb5d5b91020ab-1
        assert!(!raw.contains(&password_hash));
        if let Some(secret) = totp_secret {
            // parity-assert: L:e8126d34adc2ef90-1
            assert!(!raw.contains(&secret));
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn auth_me_answers_past_2fa_gate() -> Result<()> {
    TestApp::run("auth_me_answers_past_2fa_gate", |app| async move {
        fixtures::prepare(&app).await?;
        let user = fixtures::create_active_user(&app, "Me Unverified", &fixtures::unique_email("meunverified"), "MePass!2026", "agency", true).await?;
        let (status, login) = login_unverified(&app, &user.email, "MePass!2026").await?;
        // parity-assert: L:a506fb3dce69d794-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:ec5bcbf09f94bf76-1
        assert_eq!(login["needs2faVerification"], true);
        let session = fixtures::session_of(&login)?;
        let (status, body) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:a9bc0e43c5aa6632-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:7ef7047091af51f0-1
        assert_eq!(body["twofaVerified"], false);
        // parity-assert: L:10cdc953ad1a59f6-1
        assert_eq!(body["needs2faVerification"], true);
        // parity-assert: L:81426a4f366e503c-1
        assert_eq!(body["needs2faEnrollment"], false);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn auth_me_unenrolled_user_is_told_to_enroll() -> Result<()> {
    TestApp::run("auth_me_unenrolled_user", |app| async move {
        fixtures::prepare(&app).await?;
        let fresh = fixtures::create_active_user(&app, "Unenrolled User", &fixtures::unique_email("unenrolled"), "FreshPass!2026", "agency", false).await?;
        let (status, login) = login_unverified(&app, &fresh.email, "FreshPass!2026").await?;
        // parity-assert: L:3c7654026117f036-1
        assert_eq!(status, StatusCode::OK);
        let session = fixtures::session_of(&login)?;
        let (_, body) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:a324bfbd76020ebf-1
        assert_eq!(body["twofaVerified"], false);
        // parity-assert: L:9f83eb21d417d695-1
        assert_eq!(body["needs2faEnrollment"], true);
        // parity-assert: L:84ef7b960c6b93c5-1
        assert_eq!(body["needs2faVerification"], false);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn auth_me_inactive_user_is_401() -> Result<()> {
    TestApp::run("auth_me_inactive_user", |app| async move {
        fixtures::prepare(&app).await?;
        let doomed = fixtures::create_active_user(&app, "Doomed User", &fixtures::unique_email("doomed"), "DoomedPass!2026", "agency", true).await?;
        let session = sign_in_user(&app, &doomed).await?;
        let (status, _) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:6351ea7e25249439-1
        assert_eq!(status, StatusCode::OK);
        sqlx::query("UPDATE users SET status = 'tombstoned' WHERE id = $1")
            .bind(doomed.id)
            .execute(app.db())
            .await?;
        let (status, body) = app.auth_get_json("/auth/me", &session).await?;
        // parity-assert: L:ed17c1c5d4c24d7f-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);
        // parity-assert: L:449e0397ad3ad175-1
        assert_eq!(body["error"], "User not found or inactive.");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn capability_snapshot_owner_admin_and_security() -> Result<()> {
    TestApp::run("capability_snapshot_owner_admin", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "SnapAdmin!2026").await?;
        let admin_session = sign_in_user(&app, &admin).await?;
        let owner = fixtures::create_active_user(&app, "Snap Owner", &fixtures::unique_email("snapowner"), "OwnerPass!2026", "agency", true).await?;
        let owner_session = sign_in_user(&app, &owner).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;

        let (status, _) = app.get_json("/me/capability-snapshot").await?;
        // parity-assert: L:c887abd12984e1fc-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let (status, body) = app.auth_get_json("/me/capability-snapshot", &owner_session).await?;
        // parity-assert: L:a7b03be688c2eed3-1
        assert_eq!(status, StatusCode::OK);
        let snapshot = &body["snapshot"];
        // parity-assert: L:5c839d4b17fca53c-1
        assert!(snapshot.to_string().contains(&wired.system_id.to_string()));
        // parity-assert: L:d3e31d3aa91b5dd2-1
        assert_eq!(snapshot["isAdmin"].as_bool().unwrap_or(false), false);
        // parity-assert: L:c08b9cec7a64f335-1
        assert!(body["idempotencyToken"].as_str().map(|s| !s.is_empty()).unwrap_or(false));

        let (status, body) = app.auth_get_json("/me/capability-snapshot", &admin_session).await?;
        // parity-assert: L:01017ccde89c0d03-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:c2c974a61a6ebe5d-1
        assert_eq!(body["snapshot"]["isAdmin"], true);

        let (_, a) = app.auth_get_json("/me/capability-snapshot", &admin_session).await?;
        let (_, b) = app.auth_get_json("/me/capability-snapshot", &admin_session).await?;
        // parity-assert: L:333474ca2fa01800-1
        assert_ne!(a["idempotencyToken"], b["idempotencyToken"]);

        let (_, raw) = app.auth_get_text("/me/capability-snapshot", &admin_session).await?;
        for forbidden in ["passwordHash", "password_hash", "totpSecret", "totp_secret"] {
            // parity-assert: L:dc8993654d2ea3b6-1
            assert!(!raw.contains(forbidden), "snapshot leaked {forbidden}");
        }
        Ok(())
    })
    .await
}

#[tokio::test]
async fn role_summary_unauthenticated_and_no_roles() -> Result<()> {
    TestApp::run("role_summary_unauthenticated_and_no_roles", |app| async move {
        fixtures::prepare(&app).await?;
        let (status, _) = app.get_json("/me/role-summary").await?;
        // parity-assert: L:fb08d75447d7ac15-1
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        let nobody = fixtures::create_active_user(&app, "Role Nobody", &fixtures::unique_email("rolenobody"), "NobodyPass!2026", "vendor", true).await?;
        let session = sign_in_user(&app, &nobody).await?;
        let (status, body) = app.auth_get_json("/me/role-summary", &session).await?;
        // parity-assert: L:38a5f93ac22b55c8-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:dc501f1cb4e9b064-1
        assert_eq!(body["roles"], json!([]));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn role_summary_admin_tile() -> Result<()> {
    TestApp::run("role_summary_admin_tile", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleAdmin!2026").await?;
        let session = sign_in_user(&app, &admin).await?;
        let (status, body) = app.auth_get_json("/me/role-summary", &session).await?;
        // parity-assert: L:0f5ef2db38a6a0be-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:7dd49c35ae088815-1
        assert!(fixtures::role_keys(&body).contains(&"admin".to_string()));
        let admin_role = fixtures::role_by_key(&body, "admin").unwrap_or(&Value::Null);
        // parity-assert: L:51c70c1b9865ab37-1
        assert_eq!(admin_role["label"], "Administrator");
        let n = app.scalar_i64("SELECT count(*)::bigint FROM users WHERE status = 'pending_approval'").await?;
        // parity-assert: L:7f7d7f685962ebc4-1
        assert_eq!(admin_role["pending"].as_i64().unwrap_or(-1), n);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn role_summary_owner_and_engineer_badges() -> Result<()> {
    TestApp::run("role_summary_owner_and_engineer_badges", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "Role Owner", &fixtures::unique_email("roleowner"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let owner_session = sign_in_user(&app, &owner).await?;

        let (_, body) = app.auth_get_json("/me/role-summary", &owner_session).await?;
        // parity-assert: L:b8da17e752e37603-1
        assert!(fixtures::role_keys(&body).contains(&"owner".to_string()));
        let owner_role = fixtures::role_by_key(&body, "owner").unwrap_or(&Value::Null);
        // parity-assert: L:ebf4ecc6c11f4c6e-1
        assert_eq!(owner_role["label"], "System Owner");
        // parity-assert: L:d23f2c5530cad749-1
        assert_eq!(owner_role["pending"], 0);

        let submitter = fixtures::create_active_user(&app, "Role Submitter", &fixtures::unique_email("rolesubmitter"), "SubPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &submitter, admin.id).await?;
        let sub_session = sign_in_user(&app, &submitter).await?;
        let asset = fixtures::create_asset(&app, wired.system_id, "role-host").await?;
        submit_request_checked(&app, &sub_session, wired.system_id, asset, "SR-ROLE1").await?;

        let (_, after) = app.auth_get_json("/me/role-summary", &owner_session).await?;
        let owner_tile = fixtures::role_by_key(&after, "owner").unwrap_or(&Value::Null);
        // parity-assert: L:ff2deede1f651a0e-1
        assert!(owner_tile["pending"].as_i64().unwrap_or(-1) >= 0);

        let (_, sub_body) = app.auth_get_json("/me/role-summary", &sub_session).await?;
        // parity-assert: L:658628489527df2f-1
        assert!(fixtures::role_keys(&sub_body).contains(&"engineer".to_string()));
        let engineer = fixtures::role_by_key(&sub_body, "engineer").unwrap_or(&Value::Null);
        // parity-assert: L:253ec466050ffdd3-1
        assert_eq!(engineer["label"], "Vendor Engineer");
        // parity-assert: L:1623a9ed379bb2f4-1
        assert_eq!(engineer["pending"], 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn role_summary_agency_reviewer_label() -> Result<()> {
    TestApp::run("role_summary_agency_reviewer_label", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "Role Owner2", &fixtures::unique_email("roleowner2"), "Owner2Pass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let reviewer = fixtures::create_active_user(&app, "Role Reviewer", &fixtures::unique_email("rolereviewer"), "RevPass!2026", "agency", true).await?;
        fixtures::add_serving_member(&app, wired.agency_l1, &reviewer, admin.id).await?;
        let session = sign_in_user(&app, &reviewer).await?;
        let (_, body) = app.auth_get_json("/me/role-summary", &session).await?;
        // parity-assert: L:3860c65451e16534-1
        assert!(fixtures::role_keys(&body).contains(&"engineer".to_string()));
        // parity-assert: L:01758b592df02ec6-1
        assert_eq!(fixtures::role_by_key(&body, "engineer").unwrap_or(&Value::Null)["label"], "Agency Engineer");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn role_summary_pure_delegate() -> Result<()> {
    TestApp::run("role_summary_pure_delegate", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "Role Owner3", &fixtures::unique_email("roleowner3"), "Owner3Pass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let delegate = fixtures::create_active_user(&app, "Role Delegate", &fixtures::unique_email("roledelegate"), "DelPass!2026", "agency", true).await?;
        fixtures::add_org_membership(&app, wired.agency_org_id, delegate.id, admin.id).await?;
        let owner_session = sign_in_user(&app, &owner).await?;
        let (add_status, add_body) = app.auth_post_json(
            &format!("/owner/systems/{}/delegates", wired.system_id),
            &owner_session,
            json!({ "delegateUserId": delegate.id }),
        ).await?;
        // parity-assert: L:c5a89a265d7e5bed-1
        assert_eq!(add_status, StatusCode::CREATED, "delegate add failed: {add_body}");

        let delegate_session = sign_in_user(&app, &delegate).await?;
        let (_, body) = app.auth_get_json("/me/role-summary", &delegate_session).await?;
        let keys = fixtures::role_keys(&body);
        // parity-assert: L:fa54c047469bea9c-1
        assert!(keys.contains(&"delegate".to_string()));
        // parity-assert: L:1393cde7bab39573-1
        assert!(!keys.contains(&"owner".to_string()));
        // parity-assert: L:f70da54819b0c457-1
        assert_eq!(fixtures::role_by_key(&body, "delegate").unwrap_or(&Value::Null)["label"], "Delegate Approver");

        let (_, owner_body) = app.auth_get_json("/me/role-summary", &owner_session).await?;
        let owner_keys = fixtures::role_keys(&owner_body);
        // parity-assert: L:126b123c25731a5a-1
        assert!(owner_keys.contains(&"owner".to_string()));
        // parity-assert: L:e3d2de42f9e9a598-1
        assert!(!owner_keys.contains(&"delegate".to_string()));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn role_summary_team_admin() -> Result<()> {
    TestApp::run("role_summary_team_admin", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleAdmin!2026").await?;
        let admin_session = sign_in_user(&app, &admin).await?;
        let owner = fixtures::create_active_user(&app, "Role Owner4", &fixtures::unique_email("roleowner4"), "Owner4Pass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let team_admin = fixtures::create_active_user(&app, "Role TeamAdmin", &fixtures::unique_email("roleteamadmin"), "TAPass!2026", "vendor", true).await?;
        fixtures::add_member(&app, wired.vendor_l2, &team_admin, admin.id, "team_admin").await?;
        let session = sign_in_user(&app, &team_admin).await?;
        let (_, body) = app.auth_get_json("/me/role-summary", &session).await?;
        // parity-assert: L:993bf9482e6c82ed-1
        assert!(fixtures::role_keys(&body).contains(&"team_admin".to_string()));
        // parity-assert: L:5e555dcf69f404ca-1
        assert_eq!(fixtures::role_by_key(&body, "team_admin").unwrap_or(&Value::Null)["pending"], 0);
        let (_, admin_body) = app.auth_get_json("/me/role-summary", &admin_session).await?;
        // parity-assert: L:839515eed2215680-1
        assert!(!fixtures::role_keys(&admin_body).contains(&"team_admin".to_string()));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn role_summary_ordering() -> Result<()> {
    TestApp::run("role_summary_ordering", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleAdmin!2026").await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &admin).await?;
        let _ = wired;
        app.json_with_headers(Method::POST, "/auth/signup", &[], Some(json!({ "fullName": "Pending Badge", "email": fixtures::unique_email("pendingbadge"), "password": "ValidPass!2026" }))).await?;
        let session = sign_in_user(&app, &admin).await?;
        let (_, body) = app.auth_get_json("/me/role-summary", &session).await?;
        let roles = body["roles"].as_array().cloned().unwrap_or_default();
        let priority = |key: &str| match key {
            "admin" => 0,
            "owner" => 1,
            "engineer" => 2,
            "delegate" => 3,
            "team_admin" => 4,
            _ => 99,
        };
        for i in 1..roles.len() {
            let prev = &roles[i - 1];
            let cur = &roles[i];
            let prev_pending = prev["pending"].as_i64().unwrap_or(0);
            let cur_pending = cur["pending"].as_i64().unwrap_or(0);
            let ordered = prev_pending > cur_pending
                || (prev_pending == cur_pending && priority(prev["key"].as_str().unwrap_or("")) <= priority(cur["key"].as_str().unwrap_or("")));
            // parity-assert: L:01c0b29776f590ae-1
            assert!(ordered, "roles out of order at {i}: {roles:?}");
        }
        Ok(())
    })
    .await
}
