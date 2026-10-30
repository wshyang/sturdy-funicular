//! Port of test/backend/deno/mapping_droplist_repro.test.tsx (9 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};
use serde_json::json;

#[tokio::test]
async fn mapping_droplist_repro_auto_map() -> Result<()> {
    TestApp::run("mapping_droplist_repro", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "MapRepro!2026").await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
        let owner = fixtures::create_active_user(&app, "Demo Owner", &fixtures::unique_email("demo-owner"), "OwnerPass!2026", "agency", true).await?;
        let (status, data) = app.auth_post_json("/admin/clusters", &session, json!({"name":"Vendor Cluster Demo","type":"vendor","organizationId":org.to_string()})).await?;
        parity_assert_eq!("L:bb7e4f5c7dccbf89-1", status, reqwest::StatusCode::CREATED);
        let vc = data["cluster"]["id"].as_str().unwrap().to_string();
        let (status, data) = app.auth_post_json("/admin/clusters", &session, json!({"name":"Agency Cluster Demo","type":"agency","organizationId":org.to_string()})).await?;
        parity_assert_eq!("L:3536ce4b360e1a10-1", status, reqwest::StatusCode::CREATED);
        let ac = data["cluster"]["id"].as_str().unwrap().to_string();
        let mut teams = Vec::new();
        for (name, cluster, level) in [("Vendor L1 Team demo",&vc,1),("Vendor L2 Team demo",&vc,2),("Agency L1 Team demo",&ac,1),("Agency L2 Team demo",&ac,2)] {
            let (status, data) = app.auth_post_json("/admin/teams", &session, json!({"name":name,"clusterId":cluster,"level":level})).await?;
            parity_assert_eq!("L:31b218daa95e2eae-1", status, reqwest::StatusCode::CREATED);
            teams.push(data["team"]["id"].as_str().unwrap().to_string());
        }
        let (status, data) = app.auth_post_json("/admin/systems", &session, json!({
            "shortCode": fixtures::unique_short_code(), "name":"Demo Showcase System", "primaryOwnerId":owner.id.to_string(),
            "vendorClusterIds":[vc], "agencyClusterId":ac,
            "workflowDefinition":[
                {"ordinal":1,"clusterId":vc,"level":1,"stepKind":"hierarchical","notes":null},
                {"ordinal":2,"clusterId":vc,"level":2,"stepKind":"hierarchical","notes":null},
                {"ordinal":3,"clusterId":ac,"level":1,"stepKind":"hierarchical","notes":null},
                {"ordinal":4,"clusterId":ac,"level":2,"stepKind":"hierarchical","notes":null}
            ]
        })).await?;
        parity_assert_eq!("L:8f53b76ea7987e97-1", status, reqwest::StatusCode::CREATED);
        let sid = data["system"]["id"].as_str().unwrap().to_string();
        let (status, data) = app.auth_get_json(&format!("/admin/systems/{sid}/mappable-teams"), &session).await?;
        parity_assert_eq!("L:a88c9f16de070e81-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:08065248fdb4d1a6-1", data["teams"].as_array().unwrap().len(), 0);
        let (status, data) = app.auth_get_json(&format!("/admin/systems/{sid}/mappings"), &session).await?;
        parity_assert_eq!("L:440a4268c70346b1-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:7454fa7b14ce1921-1", data["mappings"].as_array().unwrap().len(), 4);
        parity_assert_eq!("L:5cf4a52ac59cc216-1", data["unmappedClusters"].as_array().unwrap().len(), 0);
        Ok(())
    }).await
}
