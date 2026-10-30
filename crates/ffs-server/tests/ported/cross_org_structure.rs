//! Port of test/backend/deno/cross_org_structure.test.tsx (40 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;


async fn actor(app: &TestApp, label: &str) -> Result<(fixtures::FixtureUser, String)> {
    let user = fixtures::create_active_user(app, label, &fixtures::unique_email(label), "XStruct!2026", "agency", true).await?;
    let session = fixtures::session_of(&fixtures::login_user(app, &user).await?)?;
    Ok((user, session))
}

#[tokio::test]
async fn cross_org_structure_clusters_teams_roster_scoping() -> Result<()> {
    TestApp::run("cross_org_structure_cut2", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "XStructAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org_a = fixtures::create_organization(&app, &fixtures::unique_name("XS Org A"), &fixtures::unique_short_code(), admin.id).await?;
        let org_b = fixtures::create_organization(&app, &fixtures::unique_name("XS Org B"), &fixtures::unique_short_code(), admin.id).await?;
        let (status, body) = app.auth_post_json("/admin/clusters", &admin_session,
            json!({ "name": fixtures::unique_name("XS Cluster A"), "type": "agency", "organizationId": org_a })).await?;
        parity_assert_eq!("L:e85c4b2cfa37c6c3-1", status, reqwest::StatusCode::CREATED);
        let cluster_a = body["cluster"]["id"].as_str().unwrap().to_string();
        let (_, body) = app.auth_post_json("/admin/clusters", &admin_session,
            json!({ "name": fixtures::unique_name("XS Cluster B"), "type": "agency", "organizationId": org_b })).await?;
        let cluster_b = body["cluster"]["id"].as_str().unwrap().to_string();
        let (status, body) = app.auth_post_json("/admin/teams", &admin_session,
            json!({ "name": fixtures::unique_name("XS Team A"), "clusterId": cluster_a, "level": 1 })).await?;
        parity_assert_eq!("L:6e862e759361cf12-1", status, reqwest::StatusCode::CREATED);
        let team_a = body["team"]["id"].as_str().unwrap().to_string();
        let (scoped, scoped_session) = actor(&app, "xsstructureadmin").await?;
        fixtures::add_org_membership(&app, org_a, scoped.id, admin.id).await?;
        fixtures::grant_scoped(&app, scoped.id, "org_structure_admin", org_a, admin.id).await?;

        let (status, cls) = app.auth_get_json("/admin/clusters", &scoped_session).await?;
        parity_assert_eq!("L:41b9ac7a0006ef2d-1", status, reqwest::StatusCode::OK);
        let cluster_ids: Vec<String> = cls["clusters"].as_array().unwrap().iter().filter_map(|c| c["id"].as_str().map(str::to_string)).collect();
        parity_assert!("L:dcbb33f4db9215c9-1", cluster_ids.contains(&cluster_a));
        parity_assert!("L:d4a3e43bd19361f7-1", !cluster_ids.contains(&cluster_b));
        let (status, teams) = app.auth_get_json("/admin/teams", &scoped_session).await?;
        parity_assert_eq!("L:32c290c190a83674-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:0ae745db2a77d2e9-1", teams["teams"].as_array().unwrap().iter().any(|t| t["id"] == json!(team_a)));

        let (status, _) = app.auth_post_json("/admin/clusters", &scoped_session,
            json!({ "name": fixtures::unique_name("XS No-Anchor"), "type": "agency", "organizationId": null })).await?;
        parity_assert_eq!("L:b150e370309da528-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json("/admin/clusters", &scoped_session,
            json!({ "name": fixtures::unique_name("XS Foreign"), "type": "agency", "organizationId": org_b })).await?;
        parity_assert_eq!("L:21c50ec484e8b1b0-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json("/admin/clusters", &scoped_session,
            json!({ "name": fixtures::unique_name("XS Own"), "type": "agency", "organizationId": org_a })).await?;
        parity_assert_eq!("L:b0d2c016369140bd-1", status, reqwest::StatusCode::CREATED);

        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{cluster_b}"), &scoped_session,
            json!({ "name": fixtures::unique_name("XS Renamed B") })).await?;
        parity_assert_eq!("L:a7ebdebafdfcf5be-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/clusters/{cluster_b}"), &scoped_session, json!({})).await?;
        parity_assert_eq!("L:673ae10e69c46a0d-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{cluster_a}"), &scoped_session,
            json!({ "organizationId": org_b })).await?;
        parity_assert_eq!("L:3f428aa11c1e55da-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{cluster_a}"), &scoped_session,
            json!({ "name": fixtures::unique_name("XS Cluster A2") })).await?;
        parity_assert_eq!("L:58030fd40da09493-1", status, reqwest::StatusCode::OK);

        let (status, _) = app.auth_post_json("/admin/teams", &scoped_session,
            json!({ "name": fixtures::unique_name("XS Team Under B"), "clusterId": cluster_b, "level": 1 })).await?;
        parity_assert_eq!("L:8218cebc552fe206-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json("/admin/teams", &scoped_session,
            json!({ "name": fixtures::unique_name("XS Team Under A"), "clusterId": cluster_a, "level": 2 })).await?;
        parity_assert_eq!("L:cff5aba00997df7a-1", status, reqwest::StatusCode::CREATED);
        let member = fixtures::create_active_user(&app, "XS Member", &fixtures::unique_email("xsmember"), "XMember!2026", "agency", true).await?;
        let (status, _) = app.auth_post_json(&format!("/teams/{}/members", Uuid::now_v7()), &scoped_session, json!({ "userId": member.id })).await?;
        parity_assert_eq!("L:756393f7b387cbc2-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_post_json(&format!("/teams/{team_a}/members"), &scoped_session, json!({ "userId": member.id })).await?;
        parity_assert_eq!("L:221b9c29789d6c93-1", status, reqwest::StatusCode::CREATED);
        let (status, roster) = app.auth_get_json(&format!("/teams/{team_a}/members"), &scoped_session).await?;
        parity_assert_eq!("L:c8d587671ceb8d2f-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:4376e5529732b18e-1", roster["members"].as_array().unwrap().iter().any(|m| m["userId"] == json!(member.id) || m["user"]["id"] == json!(member.id)));
        parity_assert!("L:e3e3c58b06a80bf5-1", roster["members"].is_array());

        let (status, body) = app.auth_post_json("/admin/clusters", &admin_session,
            json!({ "name": fixtures::unique_name("XS Vendor Anch"), "type": "vendor", "organizationId": org_a })).await?;
        parity_assert_eq!("L:2ba7d7fe3729cbf1-1", status, reqwest::StatusCode::CREATED);
        let vendor_cluster_a = body["cluster"]["id"].as_str().unwrap().to_string();
        let (status, body) = app.auth_post_json("/admin/teams", &admin_session,
            json!({ "name": fixtures::unique_name("XS Vendor Team A"), "clusterId": vendor_cluster_a, "level": 1 })).await?;
        parity_assert_eq!("L:38887073546db485-1", status, reqwest::StatusCode::CREATED);
        let vendor_team_a = body["team"]["id"].as_str().unwrap().to_string();
        let vendor_user = fixtures::create_active_user(&app, "XS Vendor", &fixtures::unique_email("xsvendor"), "XVendor!2026", "vendor", true).await?;
        let (status, _) = app.auth_post_json(&format!("/teams/{vendor_team_a}/members"), &scoped_session, json!({ "userId": vendor_user.id })).await?;
        parity_assert_eq!("L:bb6178916b8619cc-1", status, reqwest::StatusCode::CREATED);
        let (status, _) = app.auth_get_json(&format!("/teams/{vendor_team_a}/members"), &scoped_session).await?;
        parity_assert_eq!("L:a2fc9f41b89e39d3-1", status, reqwest::StatusCode::OK);
        let (_, body) = app.auth_post_json("/admin/clusters", &admin_session,
            json!({ "name": fixtures::unique_name("XS Vendor Foreign"), "type": "vendor", "organizationId": org_b })).await?;
        let vendor_cluster_b = body["cluster"]["id"].as_str().unwrap().to_string();
        let (_, body) = app.auth_post_json("/admin/teams", &admin_session,
            json!({ "name": fixtures::unique_name("XS Vendor Team B"), "clusterId": vendor_cluster_b, "level": 1 })).await?;
        let vendor_team_b = body["team"]["id"].as_str().unwrap();
        let (status, _) = app.auth_post_json(&format!("/teams/{vendor_team_b}/members"), &scoped_session, json!({ "userId": vendor_user.id })).await?;
        parity_assert_eq!("L:f9c886cf829e4cd8-1", status, reqwest::StatusCode::NOT_FOUND);
        Ok(())
    }).await
}

#[tokio::test]
async fn cross_org_structure_systems_assets_keyed_through_owner_edge() -> Result<()> {
    TestApp::run("cross_org_structure_cut3", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "X3Admin!2026").await?;
        let org_a = fixtures::create_organization(&app, &fixtures::unique_name("X3 Org A"), &fixtures::unique_short_code(), admin.id).await?;
        let org_b = fixtures::create_organization(&app, &fixtures::unique_name("X3 Org B"), &fixtures::unique_short_code(), admin.id).await?;
        let owner_a = fixtures::create_active_user(&app, "X3 Owner A", &fixtures::unique_email("x3owner-a"), "X3Owner!2026", "agency", true).await?;
        let built_a = fixtures::create_wired_system(&app, admin.id, &owner_a).await?;
        fixtures::repoint_owner_org_edge(&app, built_a.system_id, org_a, admin.id).await?;
        let owner_b = fixtures::create_active_user(&app, "X3 Owner B", &fixtures::unique_email("x3owner-b"), "X3Owner!2026", "agency", true).await?;
        let built_b = fixtures::create_wired_system(&app, admin.id, &owner_b).await?;
        fixtures::repoint_owner_org_edge(&app, built_b.system_id, org_b, admin.id).await?;
        let asset_a = fixtures::create_asset(&app, built_a.system_id, "x3-host-a").await?;
        let (scoped, scoped_session) = actor(&app, "x3systemsadmin").await?;
        fixtures::add_org_membership(&app, org_a, scoped.id, admin.id).await?;
        fixtures::grant_scoped(&app, scoped.id, "systems_assets_admin", org_a, admin.id).await?;
        fixtures::grant_scoped(&app, scoped.id, "user_admin", org_a, admin.id).await?;

        let (status, res) = app.auth_get_json("/admin/systems", &scoped_session).await?;
        parity_assert_eq!("L:cb4c48d8aa579f8c-1", status, reqwest::StatusCode::OK);
        let ids: Vec<String> = res["systems"].as_array().unwrap().iter().filter_map(|s| s["id"].as_str().map(str::to_string)).collect();
        parity_assert!("L:8a057ef1245d42e8-1", ids.contains(&built_a.system_id.to_string()));
        parity_assert!("L:349c5ac2ff62c7a0-1", !ids.contains(&built_b.system_id.to_string()));

        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}", built_b.system_id), &scoped_session, json!({ "description": "tampered" })).await?;
        parity_assert_eq!("L:c040ed9fb0a0b264-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}", built_b.system_id), &scoped_session, json!({})).await?;
        parity_assert_eq!("L:eed0c51fd01b6ba7-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_get_json(&format!("/admin/systems/{}/assets", built_b.system_id), &scoped_session).await?;
        parity_assert_eq!("L:3db888a517d68a62-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}", built_a.system_id), &scoped_session, json!({ "description": "X3 updated" })).await?;
        parity_assert_eq!("L:9a262846ed69cc7a-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_get_json(&format!("/admin/systems/{}/assets", built_a.system_id), &scoped_session).await?;
        parity_assert_eq!("L:62113158e66301ba-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}/assets/{asset_a}", built_a.system_id), &scoped_session, json!({ "description": "in-scope asset note" })).await?;
        parity_assert_eq!("L:f86a3877696001ac-1", status, reqwest::StatusCode::OK);

        let foreign_asset = fixtures::create_asset(&app, built_b.system_id, "x3-host-b").await?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}/assets/{foreign_asset}", built_a.system_id), &scoped_session, json!({ "description": "cross-keyed tamper" })).await?;
        parity_assert_eq!("L:43fe8b704078fb41-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}/assets/{foreign_asset}", built_a.system_id), &scoped_session, json!({})).await?;
        parity_assert_eq!("L:8c2c32652992eb0d-1", status, reqwest::StatusCode::NOT_FOUND);

        let (status, res) = app.auth_get_json("/admin/users", &scoped_session).await?;
        parity_assert_eq!("L:abab3ba5fae8e453-1", status, reqwest::StatusCode::OK);
        let rows = res["users"].as_array().unwrap();
        parity_assert!("L:623d8ff530587eea-1", !rows.iter().any(|u| u["status"] == "pending_approval"));
        let user_ids: Vec<Uuid> = rows.iter().filter_map(|u| u["id"].as_str().and_then(|s| Uuid::parse_str(s).ok())).collect();
        let memberships = sqlx::query("SELECT organization_id FROM organization_memberships WHERE user_id = ANY($1) AND expires_after IS NULL")
            .bind(&user_ids).fetch_all(app.db()).await?;
        parity_assert!("L:35467d0da678ff30-1", memberships.iter().all(|m| sqlx::Row::try_get::<Uuid, _>(m, "organization_id").map(|o| o == org_a).unwrap_or(false)));
        Ok(())
    }).await
}
