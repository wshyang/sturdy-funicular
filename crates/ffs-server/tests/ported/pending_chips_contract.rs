//! Port of test/backend/deno/pending_chips_contract.test.tsx (27 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::{json, Value};

async fn my_requests_row(app: &TestApp, session: &str, request_id: &str) -> Result<Option<Value>> {
    let (status, body) = app.auth_get_json("/requests/my-requests", session).await?;
    parity_assert_eq!("L:607f5a485bd51abf-1", status, reqwest::StatusCode::OK);
    Ok(body["requests"].as_array().unwrap().iter().find(|r| r["id"] == json!(request_id)).cloned())
}
async fn sole_action(app: &TestApp, session: &str, request_id: &str) -> Result<Value> {
    let row = my_requests_row(app, session, request_id).await?;
    parity_assert!("L:bd55dd3841e3e586-1", row.is_some());
    let actions = row.unwrap()["pendingActions"].as_array().cloned().unwrap_or_default();
    parity_assert_eq!("L:e1070cddc0b02e4f-1", actions.len(), 1);
    Ok(actions[0].clone())
}

#[tokio::test]
async fn pending_chips_wire_contract() -> Result<()> {
    TestApp::run("pending_chips_contract", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "ChipsAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "Owner Chips", &fixtures::unique_email("chipowner"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system_with_agency_l2(&app, admin.id, &owner).await?;
        let submitter = fixtures::create_active_user(&app, "Submitter Chips", &fixtures::unique_email("chipsub"), "SubmitPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &submitter, admin.id).await?;
        let l2a = fixtures::create_active_user(&app, "VendorL2A Chips", &fixtures::unique_email("chipvl2a"), "VendorL2Pass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l2, &l2a, admin.id).await?;
        let al1a = fixtures::create_active_user(&app, "AgencyL1A Chips", &fixtures::unique_email("chipagl1a"), "AgencyL1Pass!2026", "agency", true).await?;
        fixtures::add_member(&app, wired.agency_l1, &al1a, admin.id, "member").await?;
        let al2 = fixtures::create_active_user(&app, "AgencyL2 Chips", &fixtures::unique_email("chipagl2"), "AgencyL2Pass!2026", "agency", true).await?;
        fixtures::add_member(&app, wired.agency_l2, &al2, admin.id, "member").await?;
        let admin_s = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let sub_s = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let v_s = fixtures::session_of(&fixtures::login_user(&app, &l2a).await?)?;
        let a1_s = fixtures::session_of(&fixtures::login_user(&app, &al1a).await?)?;
        let a2_s = fixtures::session_of(&fixtures::login_user(&app, &al2).await?)?;
        let owner_s = fixtures::session_of(&fixtures::login_user(&app, &owner).await?)?;
        let asset = fixtures::create_asset(&app, wired.system_id, "chip-1").await?;
        let (status, data) = fixtures::submit_request(&app, &sub_s, wired.system_id, asset, "SR-9300").await?;
        parity_assert_eq!("L:85fca0188debb004-1", status, reqwest::StatusCode::CREATED);
        let rid = data["request"]["id"].as_str().unwrap().to_string();
        let action = sole_action(&app, &v_s, &rid).await?;
        parity_assert_eq!("L:d45b8f61a45ad4f9-1", action["workflowType"], json!("pre_approval"));
        parity_assert_eq!("L:dce2ad56e77af289-1", action["kind"], json!("review_step"));
        parity_assert_eq!("L:f9126553f0b1129b-1", action["label"], json!("Review step 1"));
        parity_assert_eq!("L:8b317aa4c419809d-1", action["stepRef"], json!("step:1"));
        parity_assert_eq!("L:bd41803b55dba7bf-1", action["urgency"], json!("normal"));
        parity_assert_eq!("L:9dba118d75e620b4-1", action["key"], json!(format!("pre_approval:review_step:{rid}:step:1")));
        parity_assert_eq!("L:24903fc394a98aa8-1", action["deeplink"], json!(format!("/dashboard/request/{rid}")));
        let row = my_requests_row(&app, &sub_s, &rid).await?;
        parity_assert!("L:c8ed2171268af3bd-1", row.is_some());
        parity_assert_eq!("L:9ae6044f820ea22b-1", row.unwrap()["pendingActions"].as_array().cloned().unwrap_or_default().len(), 0);
        let (status, _) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &v_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:0913b8ea5844adb1-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:12334af3ac2b9a53-1", my_requests_row(&app, &v_s, &rid).await?.is_none());
        let next = sole_action(&app, &a1_s, &rid).await?;
        parity_assert_eq!("L:8cd4270050e87aa0-1", next["label"], json!("Review step 2"));
        parity_assert_eq!("L:141e7649c09b9839-1", next["stepRef"], json!("step:2"));
        for s in [&a1_s, &a2_s] {
            let (status, _) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), s, json!({"decision":"approve"})).await?;
            parity_assert_eq!("L:54a016c7fad7ab1a-1", status, reqwest::StatusCode::OK);
        }
        let action = sole_action(&app, &owner_s, &rid).await?;
        parity_assert_eq!("L:43d43ef5aeb4831b-1", action["workflowType"], json!("pre_approval"));
        parity_assert_eq!("L:8f0377bd4ac801f5-1", action["kind"], json!("owner_decision"));
        parity_assert_eq!("L:75dc0c886b96f0a1-1", action["label"], json!("Owner decision"));
        parity_assert_eq!("L:9f1059836aaa303b-1", action["stepRef"], Value::Null);
        let (status, body) = app.auth_get_json("/admin/pending-actions", &admin_s).await?;
        parity_assert_eq!("L:206e642da76b5688-1", status, reqwest::StatusCode::OK);
        let debtors = body["debtors"].as_array().unwrap();
        let owner_debtor = debtors.iter().find(|d| d["pendingActions"].as_array().unwrap().iter().any(|a| a["key"].as_str().unwrap_or("").contains(&rid)));
        parity_assert!("L:6de8c340efc8d761-1", owner_debtor.is_some());
        let ledger = owner_debtor.unwrap()["pendingActions"].as_array().unwrap().iter().find(|a| a["key"].as_str().unwrap_or("").contains(&rid)).unwrap();
        parity_assert_eq!("L:a0a659a5d336c420-1", ledger["label"], json!("Owner decision"));
        parity_assert_eq!("L:d045bc7c2236f0b3-1", ledger["deeplink"], json!(format!("/dashboard/request/{rid}")));
        let email = owner_debtor.unwrap()["user"]["email"].as_str().unwrap_or("");
        parity_assert_eq!("L:ebd160e87dae72d8-1", [l2a.email.as_str(), al1a.email.as_str()].contains(&email), false);
        Ok(())
    }).await
}
