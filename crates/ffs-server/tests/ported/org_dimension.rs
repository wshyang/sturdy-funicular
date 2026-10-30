//! Port of test/backend/deno/org_dimension.test.tsx (71 parity assertions).

use crate::fixtures;
use anyhow::{anyhow, Result};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

async fn admin_session(app: &TestApp) -> Result<(fixtures::FixtureUser, String)> {
    let admin = fixtures::create_admin(app, "OrgDimAdmin!2026").await?;
    let session = fixtures::session_of(&fixtures::login_user(app, &admin).await?)?;
    Ok((admin, session))
}

async fn signup(app: &TestApp, label: &str) -> Result<Uuid> {
    let (status, body) = app.post_json("/auth/signup", json!({
        "fullName": label, "email": fixtures::unique_email(label), "password": "ValidPass!2026"
    })).await?;
    if status != reqwest::StatusCode::CREATED && status != reqwest::StatusCode::OK {
        return Err(anyhow!("signup failed: {status} {body}"));
    }
    body["userId"].as_str().and_then(|s| Uuid::parse_str(s).ok()).ok_or_else(|| anyhow!("signup missing userId"))
}

#[tokio::test]
async fn org_dimension_registry_crud_short_code_and_delete_guards() -> Result<()> {
    TestApp::run("org_dimension_registry", |app| async move {
        fixtures::prepare(&app).await?;
        let (admin, session) = admin_session(&app).await?;
        let org_name = fixtures::unique_name("Org Registry");
        let (status, body) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": org_name, "shortCode": "RG1" })).await?;
        parity_assert_eq!("L:0ff3cdcc5e182a71-1", status, reqwest::StatusCode::CREATED);
        parity_assert!("L:20b0d67ddf9bee6f-1", body["organization"]["id"].as_str().is_some());
        parity_assert_eq!("L:ee1fcdef9aaf27ed-1", body["organization"]["name"], json!(org_name));
        parity_assert!("L:1ca6d1c645b52220-1", body["organization"].get("kind").is_none());
        let org_id = body["organization"]["id"].as_str().unwrap().to_string();
        let (status, list) = app.auth_get_json("/admin/organizations", &session).await?;
        parity_assert_eq!("L:d14f4533cc50045d-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:955e431a20d821fe-1", list["organizations"].as_array().unwrap().iter().any(|o| o["id"] == json!(org_id)));

        let (status, _) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": org_name, "shortCode": "RG2" })).await?;
        parity_assert_eq!("L:db6f77264061d918-1", status, reqwest::StatusCode::BAD_REQUEST);

        let (status, _) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": fixtures::unique_name("No Code") })).await?;
        parity_assert_eq!("L:d99d4cfc955d8de5-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, body) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": fixtures::unique_name("Bad Code"), "shortCode": "bad-code!" })).await?;
        parity_assert_eq!("L:1f6ea92be1e4b9c1-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:81aa687db0794573-1", body["error"], json!("Short code must be 1-10 uppercase alphanumeric characters."));
        let (status, _) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": fixtures::unique_name("Too Long"), "shortCode": "ABCDEFGHIJK" })).await?;
        parity_assert_eq!("L:b880a48d22abf8a5-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, body) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": fixtures::unique_name("Lowered"), "shortCode": "lc9" })).await?;
        parity_assert_eq!("L:7488b9c3a8a62325-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:f2cd3d33bfc7f90f-1", body["organization"]["shortCode"], json!("LC9"));
        let lowered_id = body["organization"]["id"].as_str().unwrap().to_string();
        let (status, body) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": fixtures::unique_name("Dup Code"), "shortCode": "LC9" })).await?;
        parity_assert_eq!("L:a0eb46ba278bd9c0-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:dcfb315801b471d8-1", body["error"], json!("An organisation with short code \"LC9\" already exists."));
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{lowered_id}"), &session,
            json!({ "shortCode": "re9" })).await?;
        parity_assert_eq!("L:d19f0a9aec0a8adc-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:16a818b846b865ef-1", body["organization"]["shortCode"], json!("RE9"));
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{lowered_id}"), &session,
            json!({ "shortCode": null })).await?;
        parity_assert_eq!("L:17d1918faa70973c-1", status, reqwest::StatusCode::BAD_REQUEST);

        let (status, body) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": fixtures::unique_name("Stale Kind"), "shortCode": "SK1", "kind": "vendor" })).await?;
        parity_assert_eq!("L:3686b2829bd8e1ad-1", status, reqwest::StatusCode::CREATED);
        parity_assert!("L:1f8489f74c986984-1", body["organization"].get("kind").is_none());

        let vendor = fixtures::create_active_user(&app, "Org Vendor", &fixtures::unique_email("orgvendor"), "OrgVendor!2026", "vendor", true).await?;
        let vendor_session = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;
        let (status, _) = app.auth_post_json("/admin/organizations", &vendor_session,
            json!({ "name": fixtures::unique_name("Vendor Org"), "shortCode": "VO1" })).await?;
        parity_assert_eq!("L:25f8791aa53fe5b3-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.post_json("/admin/organizations",
            json!({ "name": fixtures::unique_name("Anon Org"), "shortCode": "AO1" })).await?;
        parity_assert_eq!("L:3f1b99af494f182b-1", status, reqwest::StatusCode::FORBIDDEN);

        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org_id}"), &session,
            json!({ "name": format!("{org_name} Updated") })).await?;
        parity_assert_eq!("L:9243352b6c277c53-1", status, reqwest::StatusCode::OK);
        let member = fixtures::create_active_user(&app, "Block Member", &fixtures::unique_email("blockmember"), "BlockMem!2026", "agency", true).await?;
        fixtures::add_org_membership(&app, Uuid::parse_str(&org_id)?, member.id, admin.id).await?;
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org_id}"), &session, json!({})).await?;
        parity_assert_eq!("L:073087734282e004-1", status, reqwest::StatusCode::BAD_REQUEST);
        sqlx::query("UPDATE organization_memberships SET expires_after = now() WHERE organization_id = $1")
            .bind(Uuid::parse_str(&org_id)?).execute(app.db()).await?;
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org_id}"), &session, json!({})).await?;
        parity_assert_eq!("L:e914c514810db1a3-1", status, reqwest::StatusCode::OK);
        let (_, list) = app.auth_get_json("/admin/organizations", &session).await?;
        parity_assert!("L:f70eee5b24b15561-1", !list["organizations"].as_array().unwrap().iter().any(|o| o["id"] == json!(org_id)));
        Ok(())
    }).await
}

#[tokio::test]
async fn org_dimension_default_org_assignment_at_approval_and_invite() -> Result<()> {
    TestApp::run("org_dimension_assignment", |app| async move {
        fixtures::prepare(&app).await?;
        let (_admin, session) = admin_session(&app).await?;
        let default_org = fixtures::create_organization(&app, "Default", &fixtures::unique_short_code(), _admin.id).await?;
        let user_id = signup(&app, "orgapprove").await?;
        parity_assert!("L:0c27ca2b8f63a710-1", true, "signup returned a userId");
        let row = sqlx::query("SELECT name FROM organizations WHERE id = $1").bind(default_org).fetch_one(app.db()).await?;
        let name: String = sqlx::Row::try_get(&row, "name")?;
        parity_assert_eq!("L:c61c378e6cc8fa8a-1", name, "Default");
        let (status, _) = app.auth_post_json(&format!("/admin/users/{user_id}/approve"), &session,
            json!({ "affiliation": "vendor", "organizationIds": [default_org] })).await?;
        parity_assert_eq!("L:ac968ca5f6129734-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:66960660b2776706-1", fixtures::org_member_ids(&app, default_org).await?.contains(&user_id));
        let unknown_user = signup(&app, "orgunknown").await?;
        let (status, _) = app.auth_post_json(&format!("/admin/users/{unknown_user}/approve"), &session,
            json!({ "affiliation": "agency", "organizationIds": ["00000000-0000-0000-0000-000000000999"] })).await?;
        parity_assert_eq!("L:16dc854740745606-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, body) = app.auth_post_json("/admin/users/invite", &session, json!({
            "fullName": "Org Invitee", "email": fixtures::unique_email("orginvitee"),
            "affiliation": "agency", "organizationIds": [default_org]
        })).await?;
        parity_assert_eq!("L:1f046a3daa622169-1", status, reqwest::StatusCode::CREATED);
        let invited = Uuid::parse_str(body["userId"].as_str().unwrap())?;
        parity_assert!("L:ea495e832bdfad66-1", fixtures::org_member_ids(&app, default_org).await?.contains(&invited));
        let zero_user = signup(&app, "orgzero").await?;
        let (status, _) = app.auth_post_json(&format!("/admin/users/{zero_user}/approve"), &session,
            json!({ "affiliation": "agency" })).await?;
        parity_assert_eq!("L:77a126c9ca6a1104-1", status, reqwest::StatusCode::OK);
        Ok(())
    }).await
}

#[tokio::test]
async fn org_dimension_cluster_assignment_and_move_guard() -> Result<()> {
    TestApp::run("org_dimension_cluster", |app| async move {
        fixtures::prepare(&app).await?;
        let (admin, session) = admin_session(&app).await?;
        let default_org = fixtures::create_organization(&app, "Default", &fixtures::unique_short_code(), admin.id).await?;
        let cluster_name = fixtures::unique_name("Org Cluster");
        let (status, _) = app.auth_post_json("/admin/clusters", &session,
            json!({ "name": cluster_name, "type": "agency", "organizationId": default_org })).await?;
        parity_assert_eq!("L:25c1867de04f60d3-1", status, reqwest::StatusCode::CREATED);
        let (_, list) = app.auth_get_json("/admin/clusters", &session).await?;
        let row = list["clusters"].as_array().unwrap().iter().find(|c| c["name"] == json!(cluster_name));
        parity_assert!("L:ba244089f07049aa-1", row.is_some());
        parity_assert_eq!("L:59f5a54b83c42a6a-1", row.unwrap()["organizationId"], json!(default_org));
        let owner = fixtures::create_active_user(&app, "Org Guard Owner", &fixtures::unique_email("orgguard"), "OrgOwner!2026", "agency", true).await?;
        let built = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/clusters/{}", built.agency_cluster_id), &session,
            json!({ "organizationId": default_org })).await?;
        parity_assert_eq!("L:430a14898bdecf57-1", status, reqwest::StatusCode::BAD_REQUEST);
        Ok(())
    }).await
}

#[tokio::test]
async fn org_dimension_member_management_crud_audit_disguise_negatives() -> Result<()> {
    TestApp::run("org_dimension_members", |app| async move {
        fixtures::prepare(&app).await?;
        let (admin, session) = admin_session(&app).await?;
        let (status, body) = app.auth_post_json("/admin/organizations", &session,
            json!({ "name": fixtures::unique_name("Members Org"), "shortCode": "MO" })).await?;
        parity_assert_eq!("L:0030489989252c9d-1", status, reqwest::StatusCode::CREATED);
        let org_id = body["organization"]["id"].as_str().unwrap().to_string();
        let member_a = fixtures::create_active_user(&app, "Member A", &fixtures::unique_email("orgmem-a"), "MemberA!2026", "agency", true).await?;
        let member_b = fixtures::create_active_user(&app, "Member B", &fixtures::unique_email("orgmem-b"), "MemberB!2026", "vendor", true).await?;
        let pending_id = signup(&app, "orgmempending").await?;
        parity_assert!("L:b4dc440163e89f75-1", !pending_id.is_nil());

        let (status, empty) = app.auth_get_json(&format!("/admin/organizations/{org_id}/members"), &session).await?;
        parity_assert_eq!("L:170127d9db77fb17-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:64a4caef6b60736a-1", empty["members"], json!([]));
        let (status, add) = app.auth_post_json(&format!("/admin/organizations/{org_id}/members"), &session,
            json!({ "userId": member_a.id })).await?;
        parity_assert_eq!("L:9f21b0ff9f39d12c-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:d03c3a6f37e2bedd-1", add["membership"]["organizationId"], json!(org_id));
        parity_assert_eq!("L:167ffa74f16dc3a5-1", add["membership"]["userId"], json!(member_a.id));
        let (status, list) = app.auth_get_json(&format!("/admin/organizations/{org_id}/members"), &session).await?;
        parity_assert_eq!("L:64788738dc5bf802-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:cb5803e1c43a0e70-1", list["members"].as_array().unwrap().len(), 1);
        parity_assert_eq!("L:22ce930d54e1b24a-1", list["members"][0]["userId"], json!(member_a.id));
        parity_assert!("L:9aff8fd9c026a014-1", list["members"][0]["email"].as_str().is_some());
        parity_assert!("L:5428c0e0b20d0ff4-1", list["members"][0]["fullName"].as_str().is_some());
        parity_assert!("L:023c319f1e1e0d74-1", fixtures::audit_has(&app, "organization_member.added", admin.id).await?);
        let (status, _) = app.auth_post_json(&format!("/admin/organizations/{org_id}/members"), &session,
            json!({ "userId": member_a.id })).await?;
        parity_assert_eq!("L:bf125181ea199184-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json(&format!("/admin/organizations/{org_id}/members"), &session,
            json!({ "userId": pending_id })).await?;
        parity_assert_eq!("L:c3e53b7f5b493d5f-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json(&format!("/admin/organizations/{org_id}/members"), &session,
            json!({ "userId": member_b.id })).await?;
        parity_assert_eq!("L:b080da7d00be947a-1", status, reqwest::StatusCode::CREATED);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org_id}/members/{}", member_a.id), &session, json!({})).await?;
        parity_assert_eq!("L:cde47b8a45964c35-1", status, reqwest::StatusCode::OK);
        let (_, list) = app.auth_get_json(&format!("/admin/organizations/{org_id}/members"), &session).await?;
        parity_assert_eq!("L:b29b95e60e1ccb69-1", list["members"].as_array().unwrap().len(), 1);
        parity_assert_eq!("L:a617a61ca1629d53-1", list["members"][0]["userId"], json!(member_b.id));
        parity_assert!("L:8a3c2427e118e60c-1", fixtures::audit_has(&app, "organization_member.removed", admin.id).await?);
        let (status, _) = app.auth_post_json(&format!("/admin/organizations/{org_id}/members"), &session,
            json!({ "userId": member_a.id })).await?;
        parity_assert_eq!("L:aa4c651cda40e2f2-1", status, reqwest::StatusCode::CREATED);
        let (_, list) = app.auth_get_json(&format!("/admin/organizations/{org_id}/members"), &session).await?;
        parity_assert_eq!("L:ffc8ba3412ae4a3c-1", list["members"].as_array().unwrap().len(), 2);

        let unknown_org = Uuid::now_v7();
        let unknown_user = Uuid::now_v7();
        let (status, _) = app.auth_get_json(&format!("/admin/organizations/{unknown_org}/members"), &session).await?;
        parity_assert_eq!("L:81a591a1ae5d474b-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_post_json(&format!("/admin/organizations/{unknown_org}/members"), &session, json!({ "userId": member_a.id })).await?;
        parity_assert_eq!("L:971bd8c70f74d44e-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{unknown_org}/members/{}", member_a.id), &session, json!({})).await?;
        parity_assert_eq!("L:229d7079fdb30f2a-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_post_json(&format!("/admin/organizations/{org_id}/members"), &session, json!({ "userId": unknown_user })).await?;
        parity_assert_eq!("L:e1a92156c8859339-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org_id}/members/{unknown_user}"), &session, json!({})).await?;
        parity_assert_eq!("L:aed294db3c49bcd1-1", status, reqwest::StatusCode::NOT_FOUND);

        let vendor_session = fixtures::session_of(&fixtures::login_user(&app, &member_b).await?)?;
        let (status, _) = app.auth_get_json(&format!("/admin/organizations/{org_id}/members"), &vendor_session).await?;
        parity_assert_eq!("L:6c4cb0a1ad8b7aba-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_post_json(&format!("/admin/organizations/{org_id}/members"), &vendor_session, json!({ "userId": member_b.id })).await?;
        parity_assert_eq!("L:5f132084088524e2-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org_id}/members/{}", member_b.id), &vendor_session, json!({})).await?;
        parity_assert_eq!("L:0ef7c9eeb6058140-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.get_json(&format!("/admin/organizations/{org_id}/members")).await?;
        parity_assert_eq!("L:22aade03be884da4-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.post_json(&format!("/admin/organizations/{org_id}/members"), json!({ "userId": member_b.id })).await?;
        parity_assert_eq!("L:b7d4ed21306cade9-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.json_with_headers(Method::DELETE, &format!("/admin/organizations/{org_id}/members/{}", member_b.id), &[], Some(json!({}))).await?;
        parity_assert_eq!("L:fd0d3d8d61addc40-1", status, reqwest::StatusCode::FORBIDDEN);
        Ok(())
    }).await
}
