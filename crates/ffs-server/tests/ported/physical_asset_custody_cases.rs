//! Stage 5C: frozen physical_asset_custody approval/read-model and issue guards.
//! Actual manual assets, real owner approval, relational run/cases, HTTP read.
//! Custody actions/evidence/automatic fulfillment are NOT implemented here.
use anyhow::{Context, Result};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::{Method, StatusCode};
use serde_json::json;
use uuid::Uuid;
use super::fixtures::{create_active_user, create_admin, create_asset, create_four_step_system, prepare, unique_email};

#[tokio::test]
async fn approval_creates_manual_cases_and_scopes_initial_actions() -> Result<()> {
    TestApp::run("physical_custody_cases", |app| async move {
        prepare(&app).await?;
        let admin = create_admin(&app, "CustodyCaseAdmin!2026").await?;
        let owner = create_active_user(&app, "Custody Owner", &unique_email("cust-case-owner"),
            "CustodyOwner!2026", "agency", true).await?;
        let fixture = create_four_step_system(&app, admin.id, &owner).await?;
        let session = |who: &str| fixture.sessions[who].as_str();
        let agency_team: Uuid = sqlx::query_scalar(
            "SELECT id FROM teams WHERE cluster_id=$1 AND level=1 AND expires_after IS NULL")
            .bind(sqlx::query_scalar::<_, Uuid>("SELECT agency_cluster_id FROM systems WHERE id=$1")
                .bind(fixture.system_id).fetch_one(app.db()).await?)
            .fetch_one(app.db()).await?;
        let stages = ["prepare", "initiate_handover", "verify_return", "return_to_inventory", "investigate_exception"];
        let configs = stages.iter().map(|stage| json!({"stage":stage,"agencyTeamId":agency_team,
            "instructions":format!("{stage} instructions"),"dueInHours":24})).collect::<Vec<_>>();
        let admin_session = super::fixtures::session_of(&super::fixtures::login_user(&app, &admin).await?)?;
        let (config_status, config_body) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}",fixture.system_id),
            &admin_session, json!({"custodyStageConfigs":configs})).await?;
        anyhow::ensure!(config_status == StatusCode::OK, "configure stages: {config_status} {config_body}");

        let phone = fixture.asset_id;
        let laptop = create_asset(&app, fixture.system_id, "custody-laptop").await?;
        for asset in [phone, laptop] {
            sqlx::query("UPDATE assets SET credential_type='device', management_mode='manual' WHERE id=$1")
                .bind(asset).execute(app.db()).await?;
        }
        let now = chrono::Utc::now();
        let (status, submitted) = app.auth_post_json("/requests", session("submitter"), json!({
            "systemId":fixture.system_id, "justification":"Physical custody backend contract.",
            "srNumber":"SR-CUSTODY-1", "activityStartAt":(now+chrono::Duration::hours(1)).to_rfc3339(),
            "activityEndAt":(now+chrono::Duration::hours(4)).to_rfc3339(),
            "credentialItems":[{"assetId":phone},{"assetId":laptop}]
        })).await?;
        parity_assert_eq!("L:788d4ff44bc47ca8-1", status, StatusCode::CREATED);
        let id = submitted["request"]["id"].as_str().context("request id missing")?;
        let path = format!("/requests/{id}/step-decision");
        let (status, _) = app.auth_post_json(&path, session("vendorApprover"), json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:b3cce20851c3c74c-1", status, StatusCode::OK);
        for approver in ["agencyApprover", "vendorL3Approver", "agencyL2Approver"] {
            let (status, body) = app.auth_post_json(&path, session(approver), json!({"decision":"approve"})).await?;
            anyhow::ensure!(status == StatusCode::OK, "approval by {approver}: {status} {body}");
        }
        let (status, body) = app.auth_post_json(&format!("/requests/{id}/owner-decision"), session("owner"), json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:406adf92e10aca05-1", status, StatusCode::OK);
        let (status, detail) = app.auth_get_json(&format!("/requests/{id}"), session("agencyApprover")).await?;
        parity_assert_eq!("L:6776059c4a101f15-1", status, StatusCode::OK);
        parity_assert!("L:337c9769aae192e9-1", detail["assetCustody"].is_object());
        let cases = detail["assetCustody"]["cases"].as_array().context("custody cases missing")?;
        parity_assert_eq!("L:0270e9df3cd17947-1", cases.len(), 2);
        let phone_case = cases.iter().find(|case| case["assetId"] == json!(phone));
        let laptop_case = cases.iter().find(|case| case["assetId"] == json!(laptop));
        parity_assert!("L:0249be5bdd75d2c6-1", phone_case.is_some());
        parity_assert!("L:53c6aa1a4519d3ba-1", laptop_case.is_some());
        let phone_case = phone_case.context("phone case")?;
        parity_assert_eq!("L:e07b17656e483e23-1", phone_case["state"], "awaiting_preparation");
        parity_assert!("L:4e5970cd70875273-1", phone_case["availableActions"].as_array()
            .is_some_and(|actions| actions.contains(&json!("prepare_and_handover"))));
        // Keep the server-side approval semantics observable without claiming
        // parity IDs for assertions outside this frozen stage's two steps.
        anyhow::ensure!(body["message"] == "Request approved.", "owner decision body: {body}");

        // The legacy second scenario uses a distinct custody-only request and
        // checks direct issue cannot bypass the persisted physical handover.
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}", fixture.system_id),
            &admin_session, json!({"custodyStageConfigs":configs})).await?;
        parity_assert_eq!("L:9e62a5691c34fde1-1", status, StatusCode::OK);
        let single = create_asset(&app, fixture.system_id, "custody-single-device").await?;
        sqlx::query("UPDATE assets SET credential_type='device', management_mode='manual' WHERE id=$1")
            .bind(single).execute(app.db()).await?;
        let now = chrono::Utc::now();
        let (status, submitted) = app.auth_post_json("/requests", session("submitter"), json!({
            "systemId":fixture.system_id, "justification":"Custody lifecycle contract.",
            "srNumber":"SR-CUSTODY-LIFECYCLE", "activityStartAt":(now+chrono::Duration::hours(1)).to_rfc3339(),
            "activityEndAt":(now+chrono::Duration::hours(4)).to_rfc3339(),
            "credentialItems":[{"assetId":single}]
        })).await?;
        anyhow::ensure!(status == StatusCode::CREATED, "lifecycle submit: {status} {}", submitted["error"]);
        let id = submitted["request"]["id"].as_str().context("lifecycle request id")?;
        let path = format!("/requests/{id}/step-decision");
        let (status, _) = app.auth_post_json(&path, session("vendorApprover"), json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:ae829a78891a9d2d-1", status, StatusCode::OK);
        let (status, _) = app.auth_post_json(&path, session("agencyApprover"), json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:195521327a519f63-1", status, StatusCode::OK);
        for approver in ["vendorL3Approver", "agencyL2Approver"] {
            let (status, body) = app.auth_post_json(&path, session(approver), json!({"decision":"approve"})).await?;
            anyhow::ensure!(status == StatusCode::OK, "later approval {approver}: {status} {body}");
        }
        let (status, _) = app.auth_post_json(&format!("/requests/{id}/owner-decision"), session("owner"), json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:c5fe2531642bb926-1", status, StatusCode::OK);
        let (_, detail) = app.auth_get_json(&format!("/requests/{id}"), session("agencyApprover")).await?;
        parity_assert_eq!("L:c934cecff603ef48-1", detail["request"]["status"], "approved");
        let (status, issue) = app.auth_post_json(&format!("/requests/{id}/issue-credential"), session("agencyApprover"), json!({})).await?;
        parity_assert_eq!("L:734bc38a2690da74-1", status, StatusCode::CONFLICT);
        parity_assert!("L:2e72ace4a28db9ac-1", issue["error"].as_str().is_some_and(|text| text.contains("physical custody")));
        let (_, detail) = app.auth_get_json(&format!("/requests/{id}"), session("submitter")).await?;
        parity_assert_eq!("L:353d6b2f9d310d6f-1", detail["request"]["status"], "approved");
        Ok(())
    }).await
}

mod config_roundtrip {
//! Stage 5B: the first two frozen physical_asset_custody.test.tsx assertions.
//! System-stage configuration setup is grouped with Stage 5C in the same
//! suite module so the exact 20/45 suite mapping remains machine-checkable.
use anyhow::{Context, Result};
use ffs_test_support::{parity_assert_eq, TestApp};
use reqwest::{Method, StatusCode};
use serde_json::{json, Value};

use crate::fixtures::{create_active_user, create_admin, create_wired_system, login_user, prepare, session_of, unique_email};

#[tokio::test]
async fn stage_configuration_round_trips_over_http() -> Result<()> {
    TestApp::run("physical_custody_configs", |app| async move {
        prepare(&app).await?;
        let admin = create_admin(&app, "CustodyAdmin!2026").await?;
        let admin_session = session_of(&login_user(&app, &admin).await?)?;
        let owner = create_active_user(&app, "Custody Owner", &unique_email("cust-config-owner"),
            "CustodyOwner!2026", "agency", true).await?;
        let wired = create_wired_system(&app, admin.id, &owner).await?;
        let stages = ["prepare", "initiate_handover", "verify_return", "return_to_inventory", "investigate_exception"];
        let configs: Vec<Value> = stages.iter().map(|stage| json!({
            "stage": stage, "agencyTeamId": wired.agency_l1,
            "instructions": format!("{stage} instructions"), "dueInHours": 24,
        })).collect();
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}", wired.system_id),
            &admin_session, json!({"custodyStageConfigs":configs})).await?;
        parity_assert_eq!("L:617312427d565db0-1", status, StatusCode::OK);
        let (_, list) = app.auth_get_json("/admin/systems", &admin_session).await?;
        let row = list["systems"].as_array().context("systems list missing")?.iter()
            .find(|row| row["id"] == json!(wired.system_id)).context("configured system missing")?;
        let projected: Vec<Value> = row["custodyStageConfigs"].as_array()
            .context("custody stage configs missing")?.iter()
            .map(|r| json!({"stage":r["stage"],"agencyTeamId":r["agencyTeamId"],
                "instructions":r["instructions"],"dueInHours":r["dueInHours"]})).collect();
        parity_assert_eq!("L:5d541663d480d88c-1", projected, configs);
        Ok(())
    }).await
}

}
