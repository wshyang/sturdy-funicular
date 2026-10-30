//! Port of test/backend/deno/team_admin_plane.test.tsx (25 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;

async fn membership_of(app: &TestApp, session: &str, team: Uuid, user: Uuid) -> Result<String> {
    let (_, body) = app.auth_get_json(&format!("/teams/{}/members", team), session).await?;
    Ok(body["members"].as_array().unwrap().iter()
        .find(|m| m["user"]["id"] == json!(user.to_string()))
        .and_then(|m| m["membershipId"].as_str()).unwrap().to_string())
}

async fn two_admin_team(app: &TestApp, admin_id: Uuid, org: Uuid) -> Result<(Uuid, fixtures::FixtureUser, fixtures::FixtureUser)> {
    let cluster = fixtures::create_cluster_in_org(app, "vendor", admin_id, org).await?;
    let team = fixtures::create_team_in_cluster(app, cluster, 1, admin_id).await?;
    let a = fixtures::create_active_user(app, "A", &fixtures::unique_email("tp-a"), "APass!2026", "vendor", true).await?;
    let b = fixtures::create_active_user(app, "B", &fixtures::unique_email("tp-b"), "BPass!2026", "vendor", true).await?;
    fixtures::add_member(app, team, &a, admin_id, "team_admin").await?;
    fixtures::add_member(app, team, &b, admin_id, "team_admin").await?;
    Ok((team, a, b))
}

#[tokio::test]
async fn team_admin_plane_validation_and_self_locks() -> Result<()> {
    TestApp::run("team_admin_plane", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "TeamPlaneAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org = fixtures::fixture_fallback_org_id(&app, admin.id).await?;

        // 01: missing userId
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let team = fixtures::create_team_in_cluster(&app, cluster, 1, admin.id).await?;
        let (status, _) = app.auth_post_json(&format!("/teams/{}/members", team), &admin_session, json!({})).await?;
        parity_assert_eq!("L:444e8b34277c2361-1", status, reqwest::StatusCode::BAD_REQUEST);

        // unknown user
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let team = fixtures::create_team_in_cluster(&app, cluster, 1, admin.id).await?;
        let (status, body) = app.auth_post_json(&format!("/teams/{}/members", team), &admin_session, json!({ "userId": Uuid::now_v7() })).await?;
        parity_assert_eq!("L:555f4c75ca6d6fd7-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:56c16c0c96d44a5b-1", body["error"], json!("The specified user does not exist or is not active."));

        // affiliation mismatch
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let team = fixtures::create_team_in_cluster(&app, cluster, 1, admin.id).await?;
        let agency = fixtures::create_active_user(&app, "Agency", &fixtures::unique_email("tp-agency"), "AgencyPass!2026", "agency", true).await?;
        let (status, body) = app.auth_post_json(&format!("/teams/{}/members", team), &admin_session, json!({ "userId": agency.id })).await?;
        parity_assert_eq!("L:fa077e68923228be-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:9b4ca0fd8282a910-1", body["error"], json!("A user with affiliation agency cannot be added to a vendor team."));

        // duplicate
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let team = fixtures::create_team_in_cluster(&app, cluster, 1, admin.id).await?;
        let user = fixtures::create_active_user(&app, "Dup", &fixtures::unique_email("tp-dup"), "DupPass!2026", "vendor", true).await?;
        let (first, _) = app.auth_post_json(&format!("/teams/{}/members", team), &admin_session, json!({ "userId": user.id })).await?;
        let (status, body) = app.auth_post_json(&format!("/teams/{}/members", team), &admin_session, json!({ "userId": user.id })).await?;
        parity_assert_eq!("L:d28f2046f0fd1aa2-1", first, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:beffb11b54ef9fcc-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:935c34cec42d01d4-1", body["error"], json!("This user is already a member of this team."));

        // one team per cluster
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let team_a = fixtures::create_team_in_cluster(&app, cluster, 1, admin.id).await?;
        let team_b = fixtures::create_team_in_cluster(&app, cluster, 2, admin.id).await?;
        let user = fixtures::create_active_user(&app, "Clu", &fixtures::unique_email("tp-clu"), "CluPass!2026", "vendor", true).await?;
        let (first, _) = app.auth_post_json(&format!("/teams/{}/members", team_a), &admin_session, json!({ "userId": user.id })).await?;
        let (status, body) = app.auth_post_json(&format!("/teams/{}/members", team_b), &admin_session, json!({ "userId": user.id })).await?;
        parity_assert_eq!("L:d1547902423b526f-1", first, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:904d04a236dee162-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:10513efcb2e75811-1", body["error"], json!("This user already belongs to another team in this cluster."));

        // unknown team
        let user = fixtures::create_active_user(&app, "NoTeam", &fixtures::unique_email("tp-noteam"), "NoTeamPass!2026", "vendor", true).await?;
        let (status, body) = app.auth_post_json(&format!("/teams/{}/members", Uuid::now_v7()), &admin_session, json!({ "userId": user.id })).await?;
        parity_assert_eq!("L:ee45a1516cfd6a88-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:c8fd6b2d4784b489-1", body["error"], json!("Team not found."));

        // own team_admin manages roster
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let team = fixtures::create_team_in_cluster(&app, cluster, 1, admin.id).await?;
        let team_admin = fixtures::create_active_user(&app, "TAdmin", &fixtures::unique_email("tp-tadmin"), "TAdminPass!2026", "vendor", true).await?;
        fixtures::add_member(&app, team, &team_admin, admin.id, "team_admin").await?;
        let ta_session = fixtures::session_of(&fixtures::login_user(&app, &team_admin).await?)?;
        let recruit = fixtures::create_active_user(&app, "Recruit", &fixtures::unique_email("tp-recruit"), "RecruitPass!2026", "vendor", true).await?;
        let (status, body) = app.auth_post_json(&format!("/teams/{}/members", team), &ta_session, json!({ "userId": recruit.id })).await?;
        parity_assert_eq!("L:e1868b27af97ba2f-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:8d160b324c4bd132-1", body["membership"]["teamRole"], json!("member"));

        // 02: two-admin self-lock helpers
        let (team, a, _b) = two_admin_team(&app, admin.id, org).await?;
        let admin_session2 = admin_session.clone();
        let a_session = fixtures::session_of(&fixtures::login_user(&app, &a).await?)?;
        let mid = membership_of(&app, &admin_session2, team, a.id).await?;
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/teams/{}/members/{}/role", team, mid), &a_session, json!({ "teamRole": "member" })).await?;
        parity_assert_eq!("L:69a44b3b98b824db-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:d541ca2e0ccb606a-1", body["error"], json!("You cannot demote yourself. Ask another team admin or a global admin."));

        let (team, _a, b) = two_admin_team(&app, admin.id, org).await?;
        let mid = membership_of(&app, &admin_session, team, b.id).await?;
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/teams/{}/members/{}/role", team, mid), &admin_session, json!({ "teamRole": "team_admin" })).await?;
        parity_assert_eq!("L:cc34ff4252518d3c-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:56b399ca51103f32-1", body["membership"]["teamRole"], json!("team_admin"));

        let (team, _a, _b) = two_admin_team(&app, admin.id, org).await?;
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/teams/{}/members/{}/role", team, Uuid::now_v7()), &admin_session, json!({ "teamRole": "member" })).await?;
        parity_assert_eq!("L:e8cb606908821151-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:d559a6cc77c86aaa-1", body["error"], json!("Membership not found."));

        let (team, a, _b) = two_admin_team(&app, admin.id, org).await?;
        let a_session = fixtures::session_of(&fixtures::login_user(&app, &a).await?)?;
        let mid = membership_of(&app, &admin_session, team, a.id).await?;
        let (status, body) = app.auth_send_json(Method::DELETE, &format!("/teams/{}/members/{}", team, mid), &a_session, json!({})).await?;
        parity_assert_eq!("L:c551a9b67ad3319d-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:41c26af4def6d38e-1", body["error"], json!("You cannot remove yourself from a team you administer. Ask another team admin or a global admin."));

        let (team, _a, _b) = two_admin_team(&app, admin.id, org).await?;
        let (status, body) = app.auth_send_json(Method::DELETE, &format!("/teams/{}/members/{}", team, Uuid::now_v7()), &admin_session, json!({})).await?;
        parity_assert_eq!("L:71a136d5a7525044-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:0c3980ca1af55d68-1", body["error"], json!("Membership not found."));
        let _: Value = json!({});
        Ok(())
    }).await
}
