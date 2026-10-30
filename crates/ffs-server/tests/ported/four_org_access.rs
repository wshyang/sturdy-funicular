//! Port of test/backend/deno/four_org_access.test.tsx (66 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

const PASSWORD: &str = "FourOrg!2026";

async fn actor(app: &TestApp, label: &str, affiliation: &str) -> Result<(fixtures::FixtureUser, String)> {
    let user = fixtures::create_active_user(app, label, &fixtures::unique_email(label), PASSWORD, affiliation, true).await?;
    let session = fixtures::session_of(&fixtures::login_user(app, &user).await?)?;
    Ok((user, session))
}

async fn mapping_live(app: &TestApp, owner_row: Uuid) -> Result<bool> {
    let row = sqlx::query("SELECT 1 FROM system_owner_pa_mappings WHERE system_owner_id = $1 AND expires_after IS NULL LIMIT 1")
        .bind(owner_row).fetch_optional(app.db()).await?;
    Ok(row.is_some())
}

fn ids_of(body: &serde_json::Value) -> Vec<String> {
    body["systems"].as_array().unwrap().iter().filter_map(|s| s["id"].as_str().map(str::to_string)).collect()
}

#[tokio::test]
async fn four_org_access_matrix_r6_d1_scoped_admin_object_access() -> Result<()> {
    TestApp::run("four_org_access", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "FourOrgAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org_a = fixtures::create_organization(&app, &fixtures::unique_name("F4 Org A"), &fixtures::unique_short_code(), admin.id).await?;
        let org_b = fixtures::create_organization(&app, &fixtures::unique_name("F4 Org B"), &fixtures::unique_short_code(), admin.id).await?;
        let org_c = fixtures::create_organization(&app, &fixtures::unique_name("F4 Org C"), &fixtures::unique_short_code(), admin.id).await?;
        let org_d = fixtures::create_organization(&app, &fixtures::unique_name("F4 Org D"), &fixtures::unique_short_code(), admin.id).await?;
        parity_assert!("L:4628bff859786030-1", [org_a, org_b, org_c, org_d].iter().collect::<std::collections::HashSet<_>>().len() == 4);

        let (alice, alice_session) = actor(&app, "f4alice", "agency").await?;
        let (bob, bob_session) = actor(&app, "f4bob", "agency").await?;
        let (carol, carol_session) = actor(&app, "f4carol", "agency").await?;
        let (dave, dave_session) = actor(&app, "f4dave", "vendor").await?;
        let (erin, erin_session) = actor(&app, "f4erin", "vendor").await?;
        let (frank, frank_session) = actor(&app, "f4frank", "agency").await?;
        let (grace, grace_session) = actor(&app, "f4grace", "agency").await?;
        let (ivan, ivan_session) = actor(&app, "f4ivan", "agency").await?;
        let (judy, _judy_session) = actor(&app, "f4judy", "agency").await?;
        let (mason, mason_session) = actor(&app, "f4mason", "vendor").await?;
        let (nora, nora_session) = actor(&app, "f4nora", "vendor").await?;
        let (oscar, oscar_session) = actor(&app, "f4oscar", "agency").await?;
        let (pa_a_member, _) = actor(&app, "f4pa-a-member", "agency").await?;
        let (pa_b_member, _) = actor(&app, "f4pa-b-member", "agency").await?;

        let wire = |owner: fixtures::FixtureUser, org: Uuid| {
            let app = &app; let admin_id = admin.id;
            async move {
                let built = fixtures::create_wired_system(app, admin_id, &owner).await?;
                fixtures::repoint_owner_org_edge(app, built.system_id, org, admin_id).await?;
                Ok::<_, anyhow::Error>(built)
            }
        };
        let s_a = wire(alice.clone(), org_a).await?;
        let s_a2 = wire(bob.clone(), org_a).await?;
        let s_b = wire(bob.clone(), org_b).await?;
        let s_c = wire(ivan.clone(), org_c).await?;
        let s_d = wire(judy.clone(), org_d).await?;
        let backup_row = Uuid::now_v7();
        sqlx::query("INSERT INTO system_owners (id, system_id, user_id, kind, created_by) VALUES ($1,$2,$3,'backup',$4)")
            .bind(backup_row).bind(s_b.system_id).bind(oscar.id).bind(admin.id).execute(app.db()).await?;

        for (org, user) in [(org_a, alice.id), (org_a, bob.id), (org_b, bob.id), (org_b, carol.id), (org_c, carol.id),
            (org_c, dave.id), (org_d, erin.id), (org_a, erin.id), (org_d, frank.id), (org_a, grace.id), (org_c, grace.id),
            (org_c, ivan.id), (org_d, judy.id), (org_b, mason.id), (org_b, nora.id), (org_b, oscar.id), (org_a, pa_a_member.id), (org_b, pa_b_member.id)] {
            fixtures::add_org_membership(&app, org, user, admin.id).await?;
        }
        for (user, org) in [(alice.id, org_a), (carol.id, org_b), (grace.id, org_a), (grace.id, org_c)] {
            fixtures::grant_scoped(&app, user, "org_structure_admin", org, admin.id).await?;
            fixtures::grant_scoped(&app, user, "systems_assets_admin", org, admin.id).await?;
        }
        fixtures::add_member(&app, s_c.vendor_l1, &dave, admin.id, "member").await?;
        fixtures::add_member(&app, s_a.vendor_l1, &dave, admin.id, "member").await?;
        fixtures::add_member(&app, s_d.vendor_l1, &erin, admin.id, "member").await?;
        fixtures::add_member(&app, s_b.vendor_l1, &mason, admin.id, "member").await?;
        fixtures::add_member(&app, s_b.vendor_l2, &nora, admin.id, "member").await?;
        fixtures::add_member(&app, s_b.agency_l1, &oscar, admin.id, "member").await?;
        let pa_cluster_a = fixtures::create_cluster_in_org(&app, "pa", admin.id, org_a).await?;
        let pa_cluster_b = fixtures::create_cluster_in_org(&app, "pa", admin.id, org_b).await?;
        let pa_cluster_c = fixtures::create_cluster_in_org(&app, "pa", admin.id, org_c).await?;
        let pa_a_team = fixtures::create_team_in_cluster(&app, pa_cluster_a, 1, admin.id).await?;
        let pa_b_team = fixtures::create_team_in_cluster(&app, pa_cluster_b, 1, admin.id).await?;
        let pa_c_team = fixtures::create_team_in_cluster(&app, pa_cluster_c, 1, admin.id).await?;
        fixtures::add_member(&app, pa_a_team, &pa_a_member, admin.id, "member").await?;
        fixtures::add_member(&app, pa_b_team, &pa_b_member, admin.id, "member").await?;

        let rows = sqlx::query("SELECT system_id FROM system_owners WHERE user_id = $1 AND expires_after IS NULL")
            .bind(bob.id).fetch_all(app.db()).await?;
        parity_assert_eq!("L:73eb07ac6f344dc4-1", rows.len(), 2);
        let mut system_ids: Vec<Uuid> = rows.iter().filter_map(|r| sqlx::Row::try_get(r, "system_id").ok()).collect();
        system_ids.sort();
        let mut expected = vec![s_a2.system_id, s_b.system_id]; expected.sort();
        parity_assert_eq!("L:5a86a6bad16245a4-1", system_ids, expected);

        let owner_a2 = fixtures::primary_owner_row(&app, s_a2.system_id).await?;
        let owner_b = fixtures::primary_owner_row(&app, s_b.system_id).await?;
        let owner_c = fixtures::primary_owner_row(&app, s_c.system_id).await?;
        let owner_a = fixtures::primary_owner_row(&app, s_a.system_id).await?;
        let (status, _) = app.auth_post_json("/admin/mappings/owner-pa", &admin_session, json!({ "systemOwnerId": owner_a2, "paTeamId": pa_a_team })).await?;
        parity_assert_eq!("L:e3e18cd54dab801f-1", status, reqwest::StatusCode::CREATED);
        let (status, _) = app.auth_post_json("/admin/mappings/owner-pa", &admin_session, json!({ "systemOwnerId": owner_b, "paTeamId": pa_b_team })).await?;
        parity_assert_eq!("L:6779e4d461e0f38a-1", status, reqwest::StatusCode::CREATED);
        let (status, _) = app.auth_post_json("/admin/mappings/owner-pa", &admin_session, json!({ "systemOwnerId": owner_c, "paTeamId": pa_c_team })).await?;
        parity_assert_eq!("L:988e12e541858bbc-1", status, reqwest::StatusCode::CREATED);
        parity_assert!("L:2d48c4ec776dddd3-1", mapping_live(&app, owner_a2).await?);
        parity_assert!("L:e363d0d2a0dc246b-1", mapping_live(&app, owner_b).await?);
        parity_assert!("L:095228afea77fecf-1", mapping_live(&app, owner_c).await?);

        let (status, res) = app.auth_get_json("/my-systems", &bob_session).await?;
        parity_assert_eq!("L:b4ebc6d422112123-1", status, reqwest::StatusCode::OK);
        let mut ids = ids_of(&res); ids.sort();
        let mut expected = vec![s_a2.system_id.to_string(), s_b.system_id.to_string()]; expected.sort();
        parity_assert_eq!("L:35d5c445eebfee1a-1", ids, expected);
        let (status, res) = app.auth_get_json("/my-systems", &alice_session).await?;
        parity_assert_eq!("L:93657d9c2c4bf34e-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:a67e6d51f665a716-1", ids_of(&res), vec![s_a.system_id.to_string()]);
        let (status, res) = app.auth_get_json("/my-systems", &ivan_session).await?;
        parity_assert_eq!("L:d5fcbad369c39d9c-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:6e96e63dbd2042a2-1", ids_of(&res), vec![s_c.system_id.to_string()]);

        let (status, res) = app.auth_get_json("/admin/systems", &carol_session).await?;
        parity_assert_eq!("L:aef88b460bbcedd3-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:4e8d50d50621772f-1", ids_of(&res), vec![s_b.system_id.to_string()]);
        let (status, res) = app.auth_get_json("/admin/systems", &grace_session).await?;
        parity_assert_eq!("L:9e1a6e4fa4cb9ae6-1", status, reqwest::StatusCode::OK);
        let mut ids = ids_of(&res); ids.sort();
        let mut expected = vec![s_a.system_id.to_string(), s_a2.system_id.to_string(), s_c.system_id.to_string()]; expected.sort();
        parity_assert_eq!("L:a811e87f41e33158-1", ids, expected);
        let (status, _) = app.auth_get_json("/admin/systems", &frank_session).await?;
        parity_assert_eq!("L:9c82523a3eba7f2f-1", status, reqwest::StatusCode::FORBIDDEN);

        let (status, _) = app.auth_get_json(&format!("/admin/systems/{}/mappings", s_b.system_id), &carol_session).await?;
        parity_assert_eq!("L:13829fd189f8dff9-1", status, reqwest::StatusCode::OK);
        let (status, out) = app.auth_get_json(&format!("/admin/systems/{}/mappings", s_c.system_id), &carol_session).await?;
        parity_assert_eq!("L:84f6547adb201f58-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:e732de34c268027c-1", out["error"], json!("System not found."));

        let (status, created) = app.auth_post_json("/admin/mappings/owner-pa", &carol_session, json!({ "systemOwnerId": backup_row, "paTeamId": pa_b_team })).await?;
        parity_assert_eq!("L:559b8451daf86013-1", status, reqwest::StatusCode::CREATED);
        let created_mapping = created["mapping"]["id"].as_str().unwrap().to_string();
        let (status, out) = app.auth_post_json("/admin/mappings/owner-pa", &carol_session, json!({ "systemOwnerId": owner_c, "paTeamId": pa_c_team })).await?;
        parity_assert_eq!("L:906f6129ee839ffa-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:29d037f13a3be12a-1", out["error"], json!("System not found."));
        let (status, _) = app.auth_post_json("/admin/mappings/owner-pa", &grace_session, json!({ "systemOwnerId": owner_a, "paTeamId": pa_a_team })).await?;
        parity_assert_eq!("L:437679a4de101b8e-1", status, reqwest::StatusCode::CREATED);
        let (status, _) = app.auth_post_json("/admin/mappings/owner-pa", &grace_session, json!({ "systemOwnerId": owner_b, "paTeamId": pa_b_team })).await?;
        parity_assert_eq!("L:522b5cd19baf63bf-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/mappings/owner-pa/{created_mapping}"), &carol_session, json!({})).await?;
        parity_assert_eq!("L:576f996d7b8dde85-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:c98ed2b643cae07e-1", mapping_live(&app, owner_c).await?);
        let c_mapping = sqlx::query("SELECT id FROM system_owner_pa_mappings WHERE system_owner_id = $1 AND expires_after IS NULL LIMIT 1")
            .bind(owner_c).fetch_one(app.db()).await?;
        let c_mapping_id: Uuid = sqlx::Row::try_get(&c_mapping, "id")?;
        let (status, out) = app.auth_send_json(Method::DELETE, &format!("/admin/mappings/owner-pa/{c_mapping_id}"), &carol_session, json!({})).await?;
        parity_assert_eq!("L:7ba510e30eee7e00-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:445dbc2111243803-1", out["error"], json!("Mapping not found."));

        let (status, _) = app.auth_post_json(&format!("/admin/systems/{}/owners", s_b.system_id), &carol_session, json!({ "userId": frank.id, "kind": "backup" })).await?;
        parity_assert_eq!("L:d307594bed7a852e-1", status, reqwest::StatusCode::CREATED);
        let (status, out) = app.auth_post_json(&format!("/admin/systems/{}/owners", s_c.system_id), &carol_session, json!({ "userId": frank.id, "kind": "backup" })).await?;
        parity_assert_eq!("L:d3914d790ce14b53-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:bc92f17aa6cb18a4-1", out["error"], json!("System not found."));

        let (status, res) = app.auth_get_json("/admin/organizations", &carol_session).await?;
        parity_assert_eq!("L:3ab4c7490d1010ca-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:3d126809299409fc-1", res["organizations"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_string()).collect::<Vec<_>>(), vec![org_b.to_string()]);
        let (status, res) = app.auth_get_json("/admin/organizations", &grace_session).await?;
        parity_assert_eq!("L:adc5c7b0c85fda36-1", status, reqwest::StatusCode::OK);
        let mut org_ids: Vec<String> = res["organizations"].as_array().unwrap().iter().map(|o| o["id"].as_str().unwrap().to_string()).collect(); org_ids.sort();
        let mut expected = vec![org_a.to_string(), org_c.to_string()]; expected.sort();
        parity_assert_eq!("L:8c348e3f1703e453-1", org_ids, expected);
        let (status, res) = app.auth_get_json(&format!("/admin/organizations/{org_b}/members"), &carol_session).await?;
        parity_assert_eq!("L:17284c11c7fe5719-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:5bc992d14a825202-1", res["members"].as_array().unwrap().iter().any(|m| m["userId"] == json!(bob.id)));
        let (status, out) = app.auth_get_json(&format!("/admin/organizations/{org_c}/members"), &carol_session).await?;
        parity_assert_eq!("L:56cff6fc6c51431c-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:78d0e001a14d26ca-1", out["error"], json!("Organisation not found."));
        let (status, _) = app.auth_get_json(&format!("/admin/organizations/{org_d}/members"), &frank_session).await?;
        parity_assert_eq!("L:90115fef3556abba-1", status, reqwest::StatusCode::FORBIDDEN);

        let (status, res) = app.auth_get_json("/my-systems", &dave_session).await?;
        parity_assert_eq!("L:641f32a8a815acbf-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:034f67386b9976a6-1", ids_of(&res), vec![s_c.system_id.to_string()]);
        let asset_c = fixtures::create_asset(&app, s_c.system_id, "f4-c").await?;
        let (status, _) = fixtures::submit_request(&app, &dave_session, s_c.system_id, asset_c, "SR-F4-C").await?;
        parity_assert_eq!("L:f131fd92fe1247a1-1", status, reqwest::StatusCode::CREATED);
        let asset_a = fixtures::create_asset(&app, s_a.system_id, "f4-a").await?;
        let (status, out) = fixtures::submit_request(&app, &dave_session, s_a.system_id, asset_a, "SR-F4-A").await?;
        parity_assert_eq!("L:7dddd21e6a14e22b-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:1d6212b865f4ea19-1", out["error"], json!("You are not authorized to submit requests for this system."));
        let (status, res) = app.auth_get_json("/my-systems", &erin_session).await?;
        parity_assert_eq!("L:e5aeecb596eadd3c-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:81e26970563627aa-1", ids_of(&res), vec![s_d.system_id.to_string()]);
        let (status, _) = fixtures::submit_request(&app, &erin_session, s_a.system_id, asset_a, "SR-F4-EA").await?;
        parity_assert_eq!("L:0906ce1e4748cb79-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_get_json("/admin/systems", &erin_session).await?;
        parity_assert_eq!("L:fe7d918124167b46-1", status, reqwest::StatusCode::FORBIDDEN);

        let (status, submit) = fixtures::submit_request(&app, &dave_session, s_c.system_id, asset_c, "SR-F4-DETAIL").await?;
        parity_assert_eq!("L:d171648278ab8e8c-1", status, reqwest::StatusCode::CREATED);
        let request_id = submit["request"]["id"].as_str().unwrap().to_string();
        let (status, _) = app.auth_get_json(&format!("/requests/{request_id}"), &dave_session).await?;
        parity_assert_eq!("L:2d9ae4ed5d46890f-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_get_json(&format!("/requests/{request_id}"), &ivan_session).await?;
        parity_assert_eq!("L:0d604739134b6931-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, out) = app.auth_get_json(&format!("/requests/{request_id}"), &frank_session).await?;
        parity_assert_eq!("L:5051de2cd828e95c-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:71a0490eec1ca094-1", out["error"], json!("Request not found."));
        let (_status, submit) = fixtures::submit_request(&app, &dave_session, s_c.system_id, asset_c, "SR-F4-SEC").await?;
        let request_id = submit["request"]["id"].as_str().unwrap().to_string();
        let (status, out) = app.auth_get_json(&format!("/requests/{request_id}"), &carol_session).await?;
        parity_assert_eq!("L:52ddd001fc60ae92-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:bfb4ac2e057e79c3-1", out["error"], json!("Request not found."));

        let asset_b = fixtures::create_asset(&app, s_b.system_id, "f4-b").await?;
        let (status, submit) = fixtures::submit_request(&app, &mason_session, s_b.system_id, asset_b, "SR-F4-PA").await?;
        parity_assert_eq!("L:7ea881f253114eb9-1", status, reqwest::StatusCode::CREATED);
        let request_id = submit["request"]["id"].as_str().unwrap().to_string();
        let (status, _) = app.auth_post_json(&format!("/requests/{request_id}/step-decision"), &nora_session, json!({ "decision": "approve" })).await?;
        parity_assert_eq!("L:70ba8a9aeba84732-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_post_json(&format!("/requests/{request_id}/step-decision"), &oscar_session, json!({ "decision": "approve" })).await?;
        parity_assert_eq!("L:138146d7c3b29897-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_post_json(&format!("/requests/{request_id}/owner-decision"), &bob_session, json!({ "decision": "approve" })).await?;
        parity_assert_eq!("L:da472c99295fe0f2-1", status, reqwest::StatusCode::OK);
        let pa_email = fixtures::latest_notification_emails(&app, "request.owner_approved_pa_team").await?;
        parity_assert!("L:d91fbaf2d5231569-1", pa_email.is_some());
        parity_assert_eq!("L:2047e10049de8fd9-1", pa_email.unwrap(), vec![pa_b_member.email.clone()]);
        Ok(())
    }).await
}
