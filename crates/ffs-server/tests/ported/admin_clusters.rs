//! Port of test/backend/deno/admin_clusters.test.tsx (33 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn admin_clusters_crud_and_org_anchor() -> Result<()> {
    TestApp::run("admin_clusters", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "ClusterAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
        let vendor = fixtures::create_active_user(&app, "ClusterNonAdmin", &fixtures::unique_email("clusternonadmin"), "VendorPass!2026", "vendor", true).await?;
        let vendor_session = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;

        let (status, _) = app.auth_get_json("/admin/clusters", &vendor_session).await?;
        parity_assert_eq!("L:d6886b76c1629ff3-1", status, reqwest::StatusCode::FORBIDDEN);
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let (status, _) = app.auth_post_json("/admin/clusters", &vendor_session, json!({ "name": fixtures::unique_name("Nope"), "type": "vendor", "organizationId": org })).await?;
        parity_assert_eq!("L:c1946449fc1e12b5-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{}", cluster), &vendor_session, json!({ "name": "Hijacked" })).await?;
        parity_assert_eq!("L:a49b07374f5b7fc5-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/clusters/{}", cluster), &vendor_session, json!({})).await?;
        parity_assert_eq!("L:6ddb0362ba48cf90-1", status, reqwest::StatusCode::FORBIDDEN);
        let (_, list) = app.auth_get_json("/admin/clusters", &admin_session).await?;
        let still = list["clusters"].as_array().unwrap().iter().find(|c| c["id"] == json!(cluster.to_string()));
        parity_assert!("L:6062cda1e693b056-1", still.is_some());
        let original_name: String = sqlx::query_scalar("SELECT name FROM clusters WHERE id = $1").bind(cluster).fetch_one(app.db()).await?;
        parity_assert_eq!("L:6c645b4562d0f9f4-1", still.unwrap()["name"], json!(original_name));

        let name = fixtures::unique_name("Vendor Cluster");
        let (status, data) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": name, "type": "vendor", "description": "desc", "organizationId": org })).await?;
        parity_assert_eq!("L:c0c3ab2dae345a44-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:a1e950dd92977dc8-1", data["cluster"]["type"], json!("vendor"));
        let new_id = data["cluster"]["id"].as_str().unwrap().to_string();
        let (_, list) = app.auth_get_json("/admin/clusters", &admin_session).await?;
        let found = list["clusters"].as_array().unwrap().iter().find(|c| c["id"] == json!(new_id));
        parity_assert!("L:6a6637c8975d17b7-1", found.is_some());
        parity_assert_eq!("L:f1550535222f97cb-1", found.unwrap()["teamCount"], json!(0));

        let (status, _) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "type": "vendor", "organizationId": org })).await?;
        parity_assert_eq!("L:51500b727d94bd74-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": fixtures::unique_name("Bad"), "type": "not-a-type", "organizationId": org })).await?;
        parity_assert_eq!("L:adc2f4a272f33bed-1", status, reqwest::StatusCode::BAD_REQUEST);

        let name = fixtures::unique_name("DupCluster");
        let (first, _) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": name, "type": "agency", "organizationId": org })).await?;
        let (second, _) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": name, "type": "agency", "organizationId": org })).await?;
        parity_assert_eq!("L:87508bdf989f30e3-1", first, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:60b7be7434dc3697-1", second, reqwest::StatusCode::BAD_REQUEST);

        let name = fixtures::unique_name("CrossType");
        let (first, _) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": name, "type": "vendor", "organizationId": org })).await?;
        let (second, _) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": name, "type": "agency", "organizationId": org })).await?;
        parity_assert_eq!("L:86f7209423cd4517-1", first, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:0e46b9b067da1181-1", second, reqwest::StatusCode::CREATED);

        let (no_org, _) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": fixtures::unique_name("NoOrg"), "type": "agency" })).await?;
        parity_assert_eq!("L:59b3584a7673f2fc-1", no_org, reqwest::StatusCode::BAD_REQUEST);
        let (status, data) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": fixtures::unique_name("OrgCluster"), "type": "agency", "organizationId": org })).await?;
        parity_assert_eq!("L:a8b4e6218eee22c6-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:c5eac12913d66ddb-1", data["cluster"]["organizationId"], json!(org.to_string()));
        let anchored_id = data["cluster"]["id"].as_str().unwrap().to_string();

        let src = fixtures::create_organization(&app, &fixtures::unique_name("MoveSrc"), &fixtures::unique_short_code(), admin.id).await?;
        let (plain, data) = app.auth_post_json("/admin/clusters", &admin_session, json!({ "name": fixtures::unique_name("Late"), "type": "vendor", "organizationId": src })).await?;
        parity_assert_eq!("L:1ffff986e5b561fc-1", plain, reqwest::StatusCode::CREATED);
        let plain_id = data["cluster"]["id"].as_str().unwrap().to_string();
        let (put, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{}", plain_id), &admin_session, json!({ "organizationId": org })).await?;
        parity_assert_eq!("L:d5c675adf82a7187-1", put, reqwest::StatusCode::OK);
        let (_, list) = app.auth_get_json("/admin/clusters", &admin_session).await?;
        let clusters = list["clusters"].as_array().unwrap();
        parity_assert_eq!("L:87bf9f0e810dd598-1", clusters.iter().find(|c| c["id"] == json!(anchored_id)).unwrap()["organizationId"], json!(org.to_string()));
        parity_assert_eq!("L:fa304a1602d5b917-1", clusters.iter().find(|c| c["id"] == json!(plain_id)).unwrap()["organizationId"], json!(org.to_string()));

        let pa = fixtures::create_cluster_in_org(&app, "pa", admin.id, org).await?;
        let new_name = fixtures::unique_name("Renamed");
        let (status, data) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{}", pa), &admin_session, json!({ "name": new_name })).await?;
        parity_assert_eq!("L:db04ee5edf46cb0c-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:d52959cacc15cb19-1", data["cluster"]["name"], json!(new_name));
        parity_assert_eq!("L:147d27d6b5827533-1", data["cluster"]["type"], json!("pa"));

        let ghost = "00000000-0000-0000-0000-000000000999";
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{}", ghost), &admin_session, json!({ "name": "X" })).await?;
        parity_assert_eq!("L:5f14e3640619d248-1", status, reqwest::StatusCode::NOT_FOUND);

        let a = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let b = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let a_name: String = sqlx::query_scalar("SELECT name FROM clusters WHERE id = $1").bind(a).fetch_one(app.db()).await?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{}", b), &admin_session, json!({ "name": a_name })).await?;
        parity_assert_eq!("L:b62dcc82761df561-1", status, reqwest::StatusCode::BAD_REQUEST);
        let agency = fixtures::create_cluster_in_org(&app, "agency", admin.id, org).await?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{}", agency), &admin_session, json!({})).await?;
        parity_assert_eq!("L:7a65639fb782bebb-1", status, reqwest::StatusCode::BAD_REQUEST);

        let empty = fixtures::create_cluster_in_org(&app, "pa", admin.id, org).await?;
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/clusters/{}", empty), &admin_session, json!({})).await?;
        parity_assert_eq!("L:65d9e6836bdd7357-1", status, reqwest::StatusCode::OK);
        let (_, list) = app.auth_get_json("/admin/clusters", &admin_session).await?;
        parity_assert!("L:3c58abb11e6cfd97-1", !list["clusters"].as_array().unwrap().iter().any(|c| c["id"] == json!(empty.to_string())));

        let with_team = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        fixtures::create_team_in_cluster(&app, with_team, 1, admin.id).await?;
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/clusters/{}", with_team), &admin_session, json!({})).await?;
        parity_assert_eq!("L:0dc00b01aea0ad1d-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/clusters/{}", ghost), &admin_session, json!({})).await?;
        parity_assert_eq!("L:1343d61736c54a79-1", status, reqwest::StatusCode::NOT_FOUND);
        let _: Uuid = org;
        Ok(())
    }).await
}
