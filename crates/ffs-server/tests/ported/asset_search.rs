//! Port of test/backend/deno/asset_search.test.tsx (10 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn asset_search_submitter_autocomplete() -> Result<()> {
    TestApp::run("asset_search", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "AssetSearchAdmin!2026").await?;

        // positive: >=4-char prefix, active only
        let owner = fixtures::create_active_user(&app, "SearchOwner1", &fixtures::unique_email("searchowner1"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let submitter = fixtures::create_active_user(&app, "SearchSubmitter1", &fixtures::unique_email("searchsub1"), "SubmitPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &submitter, admin.id).await?;
        fixtures::create_asset(&app, wired.system_id, "prod-db-01").await?;
        fixtures::create_asset(&app, wired.system_id, "prod-web-01").await?;
        fixtures::create_asset(&app, wired.system_id, "staging-db-01").await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let (status, data) = app.auth_get_json(&format!("/systems/{}/assets/search?q=prod", wired.system_id), &session).await?;
        parity_assert_eq!("L:d87c636246429e43-1", status, reqwest::StatusCode::OK);
        let assets = data["assets"].as_array().unwrap();
        parity_assert_eq!("L:677a521195d018c4-1", assets.len(), 2);
        parity_assert!("L:37f470d8bfb3fbfd-1", assets.iter().all(|a| a["hostname"].as_str().unwrap_or("").starts_with("prod")));

        // invalidated excluded
        let owner = fixtures::create_active_user(&app, "SearchOwner2", &fixtures::unique_email("searchowner2"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let submitter = fixtures::create_active_user(&app, "SearchSubmitter2", &fixtures::unique_email("searchsub2"), "SubmitPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &submitter, admin.id).await?;
        fixtures::create_asset(&app, wired.system_id, "active-host-01").await?;
        let invalidated = fixtures::create_asset(&app, wired.system_id, "active-host-02").await?;
        sqlx::query("UPDATE assets SET expires_after = now() WHERE id = $1").bind(invalidated).execute(app.db()).await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let (status, data) = app.auth_get_json(&format!("/systems/{}/assets/search?q=active", wired.system_id), &session).await?;
        parity_assert_eq!("L:e0870fe5f1e17b9a-1", status, reqwest::StatusCode::OK);
        let assets = data["assets"].as_array().unwrap();
        parity_assert_eq!("L:3fd57a9b573e1139-1", assets.len(), 1);
        parity_assert_eq!("L:38b911af0b37105f-1", assets[0]["hostname"], json!("active-host-01"));

        // q too short
        let owner = fixtures::create_active_user(&app, "SearchOwner3", &fixtures::unique_email("searchowner3"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let submitter = fixtures::create_active_user(&app, "SearchSubmitter3", &fixtures::unique_email("searchsub3"), "SubmitPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &submitter, admin.id).await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let (status, _) = app.auth_get_json(&format!("/systems/{}/assets/search?q=abc", wired.system_id), &session).await?;
        parity_assert_eq!("L:0afe37d81b0a12a3-1", status, reqwest::StatusCode::BAD_REQUEST);

        // outsider forbidden
        let owner = fixtures::create_active_user(&app, "SearchOwner4", &fixtures::unique_email("searchowner4"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let outsider = fixtures::create_active_user(&app, "SearchOutsider", &fixtures::unique_email("searchoutsider"), "OutPass!2026", "vendor", true).await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &outsider).await?)?;
        let (status, _) = app.auth_get_json(&format!("/systems/{}/assets/search?q=unrelated", wired.system_id), &session).await?;
        parity_assert_eq!("L:8556230053cc5053-1", status, reqwest::StatusCode::FORBIDDEN);

        // unauthenticated
        let (status, _) = app.get_json(&format!("/systems/{}/assets/search?q=whatever", wired.system_id)).await?;
        parity_assert_eq!("L:6583ccc7e3c58939-1", status, reqwest::StatusCode::FORBIDDEN);

        // unknown system
        let owner = fixtures::create_active_user(&app, "SearchOwner6", &fixtures::unique_email("searchowner6"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let submitter = fixtures::create_active_user(&app, "SearchSubmitter6", &fixtures::unique_email("searchsub6"), "SubmitPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &submitter, admin.id).await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let ghost = Uuid::parse_str("00000000-0000-0000-0000-000000000999")?;
        let (status, _) = app.auth_get_json(&format!("/systems/{}/assets/search?q=whatever", ghost), &session).await?;
        parity_assert_eq!("L:f76b764d49370f05-1", status, reqwest::StatusCode::NOT_FOUND);
        Ok(())
    }).await
}
