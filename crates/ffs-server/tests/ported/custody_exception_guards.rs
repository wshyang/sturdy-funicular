//! Frozen custody_exception_guards.test.tsx: 14 HTTP assertions, real Postgres + Rust server.
//! This is the negative validation slice only; positive physical custody is not implemented here.
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};
use reqwest::StatusCode;
use serde_json::Value;
use uuid::Uuid;

use super::fixtures::{add_serving_member, create_active_user, create_admin, create_asset, create_wired_system, login_user, prepare, session_of, submit_request, unique_email};

// Assemble actual multipart bytes; do not use JSON or invoke the validator in-process.
async fn post_exception(app: &TestApp, session: &str, request_id: Uuid,
    fields: &[(&str, String)], attachments: usize) -> Result<(StatusCode, Value)> {
    let boundary = format!("custody-{}", Uuid::now_v7());
    let mut body = Vec::new();
    for (name, value) in fields {
        body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    for i in 0..attachments {
        body.extend(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"attachments\"; filename=\"note-{i}.txt\"\r\nContent-Type: text/plain\r\n\r\nnote {i}\r\n").as_bytes());
    }
    body.extend(format!("--{boundary}--\r\n").as_bytes());
    let response = reqwest::Client::new().post(format!("{}/requests/{request_id}/asset-custody/exceptions", app.base_url()))
        .header("X-Session-Token", session)
        .header("X-Idempotency-Token", app.mint_idempotency_token(session).await?)
        .header("Content-Type", format!("multipart/form-data; boundary={boundary}"))
        .body(body).send().await?;
    let status = response.status();
    Ok((status, response.json().await?))
}

#[tokio::test]
async fn exception_validation_http() -> Result<()> {
    let app = TestApp::spawn().await?;
    prepare(&app).await?;
    let admin = create_admin(&app, "AdminPassword123!").await?;
    let owner = create_active_user(&app, "Custody owner", &unique_email("custody-owner"),
        "TestPassword123!", "agency", false).await?;
    let system = create_wired_system(&app, admin.id, &owner).await?;
    let submitter = create_active_user(&app, "Custody submitter", &unique_email("custody-guards"),
        "TestPassword123!", "vendor", true).await?;
    add_serving_member(&app, system.vendor_l1, &submitter, admin.id).await?;
    let asset = create_asset(&app, system.system_id, "custody-guard-host").await?;
    let session = session_of(&login_user(&app, &submitter).await?)?;
    let (status, submitted) = submit_request(&app, &session, system.system_id, asset, "CUSTODY-GUARD").await?;
    parity_assert_eq!("L:bb5b814fe45ed853-1", status, StatusCode::CREATED);
    let request_id = submitted["request"]["id"].as_str().and_then(|s| s.parse::<Uuid>().ok());
    parity_assert_eq!("L:b3926b0fcdf56ccc-1", request_id.is_some(), true);
    let request_id = request_id.expect("submitted request id");

    let base = || vec![
        ("custodyCaseId", Uuid::now_v7().to_string()),
        ("exceptionType", "missing".to_string()),
        ("description", "Checked Cabinet C2 thoroughly, item absent.".to_string()),
        ("checkedExpectedLocation", "true".to_string()),
        ("checkedRegister", "true".to_string()),
    ];
    let (status, body) = post_exception(&app, &session, Uuid::now_v7(), &base(), 0).await?;
    parity_assert_eq!("L:9f2b75fa8401af83-1", status, StatusCode::NOT_FOUND);
    parity_assert_eq!("L:f0e2f56c999dc688-1", body["error"], "Request not found.");

    let mut fields = base(); fields[1].1 = "exploded".into();
    let (status, body) = post_exception(&app, &session, request_id, &fields, 0).await?;
    parity_assert_eq!("L:7a4e21869404122b-1", status, StatusCode::BAD_REQUEST);
    parity_assert_eq!("L:f9fff9a3f1870952-1", body["error"], "Invalid custody exception report.");

    let fields = base().into_iter().filter(|(name, _)| *name != "description").collect::<Vec<_>>();
    let (status, body) = post_exception(&app, &session, request_id, &fields, 0).await?;
    parity_assert_eq!("L:cbbd190017edf237-1", status, StatusCode::BAD_REQUEST);
    parity_assert_eq!("L:0be2ce4424155a11-1", body["error"], "Invalid custody exception report.");

    let mut fields = base(); fields[2].1 = "x".repeat(4001);
    let (status, body) = post_exception(&app, &session, request_id, &fields, 0).await?;
    parity_assert_eq!("L:7c93bd565d34618c-1", status, StatusCode::BAD_REQUEST);
    parity_assert_eq!("L:c7a90e823fde107c-1", body["error"], "Invalid custody exception report.");

    let mut fields = base(); fields[0].1 = "not-a-uuid".into();
    let (status, body) = post_exception(&app, &session, request_id, &fields, 0).await?;
    parity_assert_eq!("L:fd5cc65f0fdbb214-1", status, StatusCode::BAD_REQUEST);
    parity_assert_eq!("L:bd93a431eacdd22b-1", body["error"], "Invalid custody exception report.");

    let (status, body) = post_exception(&app, &session, request_id, &base(), 21).await?;
    parity_assert_eq!("L:54459bdd27436400-1", status, StatusCode::BAD_REQUEST);
    parity_assert_eq!("L:853274c605a3f01c-1", body["error"], "Attachments must be files (maximum 20).");
    app.close().await?;
    Ok(())
}
