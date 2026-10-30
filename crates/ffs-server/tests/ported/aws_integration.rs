//! Legacy AWS message shapes, executed against production Rust payload builders.
use ffs_server::aws::payload::*;
use ffs_test_support::parity_assert_eq;
use serde_json::json;

#[test]
fn delivery_payload_contracts() {
    let request = DeliveryRequest {
        id:"req-1", number:"BG-SYS-20260721-001", created_at:"2026-07-21T04:00:00.000Z",
        owner_decision_at:"2026-07-21T05:30:00.000Z", activity_start_at:"2026-07-21T06:00:00.000Z",
        activity_end_at:"2026-07-21T10:00:00.000Z", closed_at:Some("2026-07-21T12:00:00.000Z"),
        closed_by:Some("owner-1"),
    };
    let system = DeliverySystem { id:"sys-1", short_code:"SYS", aws_role_arn_note:Some("arn:aws:iam::123456789012:role/fixture-role") };
    let items = [CredentialItem { userid:"svc_account", hostname:"host-01", credential_type:"password", management_mode:None }];
    let outbound = build_outbound_payload(&request, &system, "ZmFrZS1wdWJsaWMta2V5", "RSA-OAEP-2048-SHA256", &items);
    let closed = build_request_close_notification(&request, &system, &items, "2026-07-21T12:01:00.000Z");
    parity_assert_eq!("L:b2f73784ca13b997-1", outbound["schemaVersion"], "1.0");
    parity_assert_eq!("L:79ba2f23870527aa-1", outbound["requestId"], request.id);
    parity_assert_eq!("L:2c1e45ee94980253-1", outbound["requestNumber"], request.number);
    parity_assert_eq!("L:cfa027d89c90f325-1", outbound["systemId"], system.id);
    parity_assert_eq!("L:5f81f1a54917f73c-1", outbound["systemShortCode"], system.short_code);
    parity_assert_eq!("L:37c70e2bf3a88b15-1", outbound["awsRoleArnNote"], system.aws_role_arn_note.unwrap());
    parity_assert_eq!("L:22d91d41452d8780-1", outbound["publicKey"], "ZmFrZS1wdWJsaWMta2V5");
    parity_assert_eq!("L:cf97a90fb381ebf8-1", outbound["keyAlgorithm"], "RSA-OAEP-2048-SHA256");
    parity_assert_eq!("L:ea0c244889b66fb9-1", outbound["credentialItems"].as_array().unwrap().len().to_string(), "1");
    parity_assert_eq!("L:33fa66d6b8bedcb5-1", outbound["credentialItems"][0], json!({"userid":"svc_account","hostname":"host-01","credentialType":"password"}));
    parity_assert_eq!("L:2a007c41cb58ccc1-1", outbound["requestedAt"], request.created_at);
    parity_assert_eq!("L:48ed6473392cc433-1", outbound["approvedAt"], request.owner_decision_at);
    parity_assert_eq!("L:a29ef41a869f8190-1", outbound["activityStartAt"], request.activity_start_at);
    parity_assert_eq!("L:7e455da513deaaef-1", outbound["activityEndAt"], request.activity_end_at);
    parity_assert_eq!("L:8df0631e911d8451-1", closed["schemaVersion"], "1.0");
    parity_assert_eq!("L:9d940391c5ddac39-1", closed["kind"], "request_close");
    parity_assert_eq!("L:381157396e6f1d0b-1", closed["requestId"], request.id);
    parity_assert_eq!("L:dbca33e6c3e99e9b-1", closed["requestNumber"], request.number);
    parity_assert_eq!("L:d0de0a8b1423c913-1", closed["systemId"], system.id);
    parity_assert_eq!("L:ea1016f8e01e35ef-1", closed["systemShortCode"], system.short_code);
    parity_assert_eq!("L:53aa3e722722e3f3-1", closed["awsRoleArnNote"], system.aws_role_arn_note.unwrap());
    parity_assert_eq!("L:1850a79b858f1103-1", closed["credentialItems"].as_array().unwrap().len().to_string(), "1");
    parity_assert_eq!("L:23ac7f4bf052925e-1", closed["credentialItems"][0], json!({"userid":"svc_account","hostname":"host-01","credentialType":"password"}));
    parity_assert_eq!("L:24b4675c6b9d2ea2-1", closed["activityStartAt"], request.activity_start_at);
    parity_assert_eq!("L:6c150fe71edabcae-1", closed["activityEndAt"], request.activity_end_at);
    parity_assert_eq!("L:8c156a358a0ac7b6-1", closed["closedAt"], request.closed_at.unwrap());
    parity_assert_eq!("L:5135f56fd3ca0b9a-1", closed["closedByUserId"], request.closed_by.unwrap());
}

#[tokio::test]
async fn credential_strategy_branches() -> anyhow::Result<()> {
    use ffs_server::aws::credentials::{parse_strategy, resolve_base_credentials, CredentialStrategy};
    // Parse the same strings used by the env-backed production entry point,
    // without mutating a process-global env var shared by parallel Rust tests.
    parity_assert_eq!("L:0eeccf73faa44c57-1", parse_strategy(None).map_err(anyhow::Error::msg)?, CredentialStrategy::Ambient);
    parity_assert_eq!("L:7cfc2a65218405c8-1", parse_strategy(Some("static")).map_err(anyhow::Error::msg)?, CredentialStrategy::Static);
    parity_assert_eq!("L:4bc73dc0a04f76ae-1", parse_strategy(Some("x509")).map_err(anyhow::Error::msg)?, CredentialStrategy::X509);
    parity_assert_eq!("L:f7b28ff98482f061-1", parse_strategy(Some("carrier-pigeon")).is_err(), true);
    parity_assert_eq!("L:6dc03da4c0cbd819-1", resolve_base_credentials(CredentialStrategy::Static).await.is_ok(), true);
    parity_assert_eq!("L:fb78de7400c8b61c-1", resolve_base_credentials(CredentialStrategy::Ambient).await.is_ok(), true);
    parity_assert_eq!("L:1c2398b625879540-1", resolve_base_credentials(CredentialStrategy::X509).await.err().unwrap().contains("not yet implemented"), true);
    parity_assert_eq!("L:4b128cd2cc878422-1", parse_strategy(Some("bogus")).unwrap_err().contains("Unknown AWS_CREDENTIAL_STRATEGY \"bogus\""), true);
    Ok(())
}

// Run flag overrides in isolated test processes: AWS_INTEGRATION_ENABLED is
// process-global, and toggling it in a shared parallel test process could
// make unrelated request suites contact AWS unexpectedly.
#[tokio::test]
async fn aws_flag_child() -> anyhow::Result<()> {
    if std::env::var("FFS_AWS_FLAG_CHILD").as_deref() != Ok("1") { return Ok(()); }
    let db = sea_orm::Database::connect(std::env::var("FFS_AWS_FLAG_DB")?).await?;
    let expected = std::env::var("FFS_AWS_FLAG_EXPECTED")? == "true";
    let actual = ffs_server::app_settings::get_aws_integration_enabled(&db).await?;
    anyhow::ensure!(actual == expected, "AWS flag: expected {expected}, observed {actual}");
    Ok(())
}

#[tokio::test]
async fn aws_enablement_env_and_db() -> anyhow::Result<()> {
    use ffs_test_support::TestApp;
    TestApp::run("aws_flag", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let child = |override_value: Option<&str>, expected: &str| -> anyhow::Result<bool> {
            let mut command = std::process::Command::new(std::env::current_exe()?);
            command.args(["--exact", "aws_integration::aws_flag_child", "--nocapture"])
                .env("FFS_AWS_FLAG_CHILD", "1")
                .env("FFS_AWS_FLAG_DB", app.db_url())
                .env("FFS_AWS_FLAG_EXPECTED", expected)
                .env_remove("AWS_INTEGRATION_ENABLED");
            if let Some(value) = override_value { command.env("AWS_INTEGRATION_ENABLED", value); }
            let output = command.output()?;
            anyhow::ensure!(output.status.success(), "flag child failed: {}", String::from_utf8_lossy(&output.stdout));
            Ok(output.status.success())
        };
        parity_assert_eq!("L:fc17bcb1e64ffdcf-1", child(None, "false")?, true);
        parity_assert_eq!("L:78b81e4bf05f7f3a-1", child(Some("1"), "false")?, true);
        parity_assert_eq!("L:89a2f9d552b70012-1", child(Some("true"), "true")?, true);
        Ok(())
    }).await
}

/// Disabled-AWS owner-decision flow against the real Rust HTTP server. The
/// four-step Rust fixture needs every approval before the owner terminal;
/// this checks request behavior, not a completed S3 publish implementation.
#[tokio::test]
async fn aws_disabled_request_approval_flow() -> anyhow::Result<()> {
    use ffs_test_support::TestApp;
    use serde_json::json;
    use sqlx::Row;
    TestApp::run("aws_disabled_approval", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let admin = crate::fixtures::create_admin(&app, "AwsIntAdmin!2026").await?;
        let owner = crate::fixtures::create_active_user(&app, "AwsIntOwner", &crate::fixtures::unique_email("awsintowner"), "OwnerPass!2026", "agency", true).await?;
        let fixture = crate::fixtures::create_four_step_system(&app, admin.id, &owner).await?;
        let session = |name: &str| fixture.sessions[name].as_str();
        let now = chrono::Utc::now();
        let request_body = json!({
            "systemId":fixture.system_id,
            "justification":"Investigate a production incident requiring elevated access.",
            "srNumber":"SR-2001",
            "activityStartAt":(now+chrono::Duration::hours(1)).to_rfc3339(),
            "activityEndAt":(now+chrono::Duration::hours(4)).to_rfc3339(),
            "credentialItems":[{"assetId":fixture.asset_id,"hostnameDescription":"host-awsint"}],
        });
        let (status, data) = app.auth_post_json("/requests", session("submitter"), request_body).await?;
        parity_assert_eq!("L:1dbc96600dc1c85d-1", status.as_u16(), 201);
        let id = uuid::Uuid::parse_str(data["request"]["id"].as_str().ok_or_else(|| anyhow::anyhow!("missing request id"))?)?;
        let key_material = sqlx::query("SELECT id FROM request_key_material WHERE request_id=$1").bind(id).fetch_optional(app.db()).await?;
        parity_assert_eq!("L:86714f349c39b148-1", key_material.as_ref().map(|r| r.get::<uuid::Uuid,_>("id")).is_some(), true);
        let path = format!("/requests/{id}/step-decision");
        let (status, _) = app.auth_post_json(&path, session("vendorApprover"), json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:8153f1eb7ca06a6d-1", status.as_u16(), 200);
        for approver in ["agencyApprover", "vendorL3Approver", "agencyL2Approver"] {
            let (status, body) = app.auth_post_json(&path, session(approver), json!({"decision":"approve"})).await?;
            anyhow::ensure!(status.is_success(), "additional step {approver}: {status} {body}");
        }
        let (status, _) = app.auth_post_json(&format!("/requests/{id}/owner-decision"), session("owner"), json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:ac6306a61aa0970f-1", status.as_u16(), 200);
        let (_, detail) = app.auth_get_json(&format!("/requests/{id}"), session("owner")).await?;
        parity_assert_eq!("L:e5d1018b03d2b001-1", detail["request"]["status"], "approved");
        Ok(())
    }).await
}
