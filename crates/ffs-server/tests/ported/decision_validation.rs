//! Port of test/backend/deno/decision_validation.test.tsx (32 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn decision_validation_step_and_owner() -> Result<()> {
    TestApp::run("decision_validation", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "DecValAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "Owner", &fixtures::unique_email("dv-owner"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let owner_s = fixtures::session_of(&fixtures::login_user(&app, &owner).await?)?;
        let submitter = fixtures::create_active_user(&app, "Submitter", &fixtures::unique_email("dv-sub"), "SubmitPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &submitter, admin.id).await?;
        let vapp = fixtures::create_active_user(&app, "VendorApprover", &fixtures::unique_email("dv-vappr"), "VendorApprPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l2, &vapp, admin.id).await?;
        let aapp = fixtures::create_active_user(&app, "AgencyApprover", &fixtures::unique_email("dv-aappr"), "AgencyApprPass!2026", "agency", true).await?;
        fixtures::add_member(&app, wired.agency_l1, &aapp, admin.id, "member").await?;
        let stranger = fixtures::create_active_user(&app, "Stranger", &fixtures::unique_email("dv-stranger"), "StrangerPass!2026", "vendor", true).await?;
        let delegate = fixtures::create_active_user(&app, "Delegate", &fixtures::unique_email("dv-delegate"), "DelegatePass!2026", "agency", true).await?;
        let sub_s = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let v_s = fixtures::session_of(&fixtures::login_user(&app, &vapp).await?)?;
        let a_s = fixtures::session_of(&fixtures::login_user(&app, &aapp).await?)?;
        let str_s = fixtures::session_of(&fixtures::login_user(&app, &stranger).await?)?;
        let del_s = fixtures::session_of(&fixtures::login_user(&app, &delegate).await?)?;
        let asset = fixtures::create_asset(&app, wired.system_id, "dv-vault-01").await?;
        let (status, submitted) = fixtures::submit_request(&app, &sub_s, wired.system_id, asset, "SR-DV-001").await?;
        parity_assert_eq!("L:0eee5fad6ef7e11d-1", status, reqwest::StatusCode::CREATED);
        parity_assert!("L:66790ac012030865-1", submitted["request"]["id"].as_str().is_some());
        let rid = submitted["request"]["id"].as_str().unwrap().to_string();
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &str_s, json!({"decision":"approve-ish"})).await?;
        parity_assert_eq!("L:7b3c4ee58ac4f1e2-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:de828b7df77d0678-1", body["error"], json!("decision must be 'approve', 'return', or 'reject'."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &v_s, json!({"decision":"return"})).await?;
        parity_assert_eq!("L:02e06b200fdfcc99-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:22dfb9e37297a4b6-1", body["error"], json!("Notes are required when returning or rejecting a request."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &v_s, json!({"decision":"reject"})).await?;
        parity_assert_eq!("L:be975bde00be24fb-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:8bc986bc3276480e-1", body["error"], json!("Notes are required when returning or rejecting a request."));
        let (status, body) = app.auth_post_json(&format!("/requests/{}/step-decision", Uuid::now_v7()), &v_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:43b46fe972ecc1e3-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:7ae1bc7ff58a797e-1", body["error"], json!("Request not found."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &a_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:5e12c3a17a242277-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:642833a2de769233-1", body["error"], json!("You are not authorized to act on the current approval step."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &str_s, json!({"decision":"approve","notes":"Trying the emergency lane.","override":true})).await?;
        parity_assert_eq!("L:1b5523efed5ea1f1-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:df46bc1349fc8f09-1", body["error"], json!("You are not authorized to override this step."));
        let (status, _) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &a_s, json!({"decision":"approve","notes":"Emergency override: vendor L2 unreachable.","override":true})).await?;
        parity_assert_eq!("L:059a891b7718e6e4-1", status, reqwest::StatusCode::OK);
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/step-decision"), &a_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:e7fa9e360990ba2e-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:a86cefd69669956c-1", body["message"], json!("Step approved; routed to system owner."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/owner-decision"), &owner_s, json!({"decision":"approve-ish"})).await?;
        parity_assert_eq!("L:e296064871a2170f-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:d16c1eff253181f3-1", body["error"], json!("decision must be 'approve', 'return', or 'reject'."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/owner-decision"), &owner_s, json!({"decision":"return"})).await?;
        parity_assert_eq!("L:2424cf041e2f3aff-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:e13cb7e5ad9b22ef-1", body["error"], json!("Notes are required when returning or rejecting a request."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/owner-decision"), &owner_s, json!({"decision":"reject"})).await?;
        parity_assert_eq!("L:ddeec3c85e8ba2b7-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:f4db237406a037fa-1", body["error"], json!("Notes are required when returning or rejecting a request."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/owner-decision"), &str_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:b600c4817c0ab59f-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:fcc47a6421bf351c-1", body["error"], json!("You are not authorized to make the owner decision for this system."));
        let (status, body) = app.auth_post_json(&format!("/requests/{}/owner-decision", Uuid::now_v7()), &owner_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:7fd357dafe8cb894-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:408d14c264ab68e7-1", body["error"], json!("Request not found."));
        let org = fixtures::create_organization(&app, &fixtures::unique_name("DV Org"), &fixtures::unique_short_code(), admin.id).await?;
        fixtures::repoint_owner_org_edge(&app, wired.system_id, org, admin.id).await?;
        fixtures::add_org_membership(&app, org, delegate.id, admin.id).await?;
        let (status, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", wired.system_id), &owner_s, json!({"delegateUserId":delegate.id.to_string()})).await?;
        parity_assert_eq!("L:796c89b556eb71d6-1", status, reqwest::StatusCode::CREATED);
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/owner-decision"), &del_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:09bd391c4df899f8-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:8e5ce377aebf7670-1", body["message"], json!("Request approved."));
        let (status, body) = app.auth_post_json(&format!("/requests/{rid}/owner-decision"), &owner_s, json!({"decision":"approve"})).await?;
        parity_assert_eq!("L:9d190cf9ccbe3edf-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:c4c84c50785158e2-1", body["error"], json!("This request is not awaiting the owner's terminal decision."));
        Ok(())
    }).await
}
