//! Port of test/backend/deno/pending_actions_admin.test.tsx (16 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::json;

#[tokio::test]
async fn admin_pending_actions_report_scoping() -> Result<()> {
    TestApp::run("pending_actions_admin", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "Q12Admin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org_a = fixtures::create_organization(&app, &fixtures::unique_name("Q12 Org A"), "QA", admin.id).await?;
        let org_b = fixtures::create_organization(&app, &fixtures::unique_name("Q12 Org B"), "QB", admin.id).await?;
        let owner = fixtures::create_active_user(&app, "Q12 Owner", &fixtures::unique_email("q12owner"), "Q12Owner!2026", "agency", true).await?;
        let built = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let reviewer = fixtures::create_active_user(&app, "Q12 Reviewer", &fixtures::unique_email("q12rev"), "Q12Rev!2026", "agency", true).await?;
        fixtures::add_member(&app, built.agency_l1, &reviewer, admin.id, "member").await?;
        fixtures::add_member(&app, built.vendor_l2, &reviewer, admin.id, "member").await?;
        fixtures::add_org_membership(&app, org_a, reviewer.id, admin.id).await?;
        let debtor_b = fixtures::create_active_user(&app, "Q12 Debtor B", &fixtures::unique_email("q12debb"), "Q12DebB!2026", "agency", true).await?;
        fixtures::add_member(&app, built.agency_l1, &debtor_b, admin.id, "member").await?;
        fixtures::add_member(&app, built.vendor_l2, &debtor_b, admin.id, "member").await?;
        fixtures::add_org_membership(&app, org_b, debtor_b.id, admin.id).await?;
        let isolated = fixtures::create_active_user(&app, "Q12 Isolated", &fixtures::unique_email("q12iso"), "Q12Iso!2026", "agency", true).await?;
        let scoped_admin = fixtures::create_active_user(&app, "Q12 Scoped Admin", &fixtures::unique_email("q12scoped"), "Q12Report!2026", "agency", true).await?;
        fixtures::add_org_membership(&app, org_a, scoped_admin.id, admin.id).await?;
        fixtures::grant_scoped(&app, scoped_admin.id, "user_admin", org_a, admin.id).await?;
        let ss = fixtures::session_of(&fixtures::login_user(&app, &scoped_admin).await?)?;
        let submitter = fixtures::create_active_user(&app, "Q12 Submitter", &fixtures::unique_email("q12sub"), "Q12Sub!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, built.vendor_l1, &submitter, admin.id).await?;
        let subs = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let asset = fixtures::create_asset(&app, built.system_id, &fixtures::unique_name("q12host")).await?;
        let (status, _) = fixtures::submit_request(&app, &subs, built.system_id, asset, &fixtures::unique_name("SR-Q12")).await?;
        parity_assert_eq!("L:134e8be8025290aa-1", status, reqwest::StatusCode::CREATED);
        let (status, data) = app.auth_get_json("/admin/pending-actions", &admin_session).await?;
        parity_assert_eq!("L:34b93084f595429f-1", status, reqwest::StatusCode::OK);
        let debtors = data["debtors"].as_array().unwrap();
        let reviewer_row = debtors.iter().find(|d| d["user"]["id"] == json!(reviewer.id.to_string()));
        parity_assert!("L:b6a7f51be7f07c3a-1", reviewer_row.is_some());
        parity_assert!("L:1511f404b0342735-1", reviewer_row.unwrap()["pendingActions"].as_array().unwrap().len() > 0);
        parity_assert!("L:7ba2017b66dac841-1", reviewer_row.unwrap()["user"]["organizations"].as_array().unwrap().iter().any(|o| o["id"] == json!(org_a.to_string())));
        parity_assert!("L:01afc37f7e7df22e-1", debtors.iter().any(|d| d["user"]["id"] == json!(debtor_b.id.to_string())));
        let (status, data) = app.auth_get_json("/admin/pending-actions", &ss).await?;
        parity_assert_eq!("L:975fbbb0ea6132b8-1", status, reqwest::StatusCode::OK);
        let debtors = data["debtors"].as_array().unwrap();
        let ids: Vec<&str> = debtors.iter().map(|d| d["user"]["id"].as_str().unwrap()).collect();
        parity_assert!("L:f7eaea41a8695d94-1", ids.contains(&reviewer.id.to_string().as_str()));
        parity_assert!("L:1e318636c7a6ded2-1", !debtors.iter().any(|d| d["user"]["id"] == json!(debtor_b.id.to_string())));
        parity_assert!("L:a599f208d6688503-1", !ids.contains(&isolated.id.to_string().as_str()));
        parity_assert!("L:a6ade0e97d5d25cd-1", !ids.contains(&scoped_admin.id.to_string().as_str()) || debtors.iter().find(|d| d["user"]["id"]==json!(scoped_admin.id.to_string())).unwrap()["pendingActions"].as_array().unwrap().len() > 0);
        let grantless = fixtures::create_active_user(&app, "Q12 Grantless", &fixtures::unique_email("q12grant"), "Q12Report!2026", "agency", true).await?;
        fixtures::add_org_membership(&app, org_a, grantless.id, admin.id).await?;
        let gls = fixtures::session_of(&fixtures::login_user(&app, &grantless).await?)?;
        let (status, body) = app.auth_get_json("/admin/pending-actions", &gls).await?;
        parity_assert_eq!("L:033590afce0eb0cb-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert!("L:02f5c4892cc44b80-1", body["error"].as_str().unwrap_or("").contains("UserRead"));
        let (status, data) = app.auth_get_json("/admin/capabilities", &ss).await?;
        parity_assert_eq!("L:9751140289328310-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:840eddf4f323d52f-1", data["scopedCapabilities"].as_array().map(|a| a.iter().any(|c| c=="UserRead")).unwrap_or(false));
        parity_assert!("L:ad278174a40fbd67-1", !data["capabilities"].as_array().map(|a| a.iter().any(|c| c=="UserRead")).unwrap_or(false));
        Ok(())
    }).await
}
