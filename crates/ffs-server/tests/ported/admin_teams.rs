//! Port of test/backend/deno/admin_teams.test.tsx (76 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

async fn mid(app: &TestApp, session: &str, team: Uuid, user: Uuid) -> Result<String> {
    let (_, body) = app.auth_get_json(&format!("/teams/{}/members", team), session).await?;
    Ok(body["members"].as_array().unwrap().iter().find(|m| m["user"]["id"] == json!(user.to_string()))
        .and_then(|m| m["membershipId"].as_str()).unwrap().to_string())
}

async fn cross_team(app: &TestApp, admin_id: Uuid, org: Uuid) -> Result<(String, Uuid, Uuid)> {
    let ca = fixtures::create_cluster_in_org(app, "vendor", admin_id, org).await?;
    let ta = fixtures::create_team_in_cluster(app, ca, 1, admin_id).await?;
    let cb = fixtures::create_cluster_in_org(app, "vendor", admin_id, org).await?;
    let tb = fixtures::create_team_in_cluster(app, cb, 1, admin_id).await?;
    let outsider = fixtures::create_active_user(app, "Outsider", &fixtures::unique_email("outsider"), "OutsiderPass!2026", "vendor", true).await?;
    fixtures::add_member(app, ta, &outsider, admin_id, "team_admin").await?;
    let session = fixtures::session_of(&fixtures::login_user(app, &outsider).await?)?;
    let victim = fixtures::create_active_user(app, "Victim", &fixtures::unique_email("victim"), "VictimPass!2026", "vendor", true).await?;
    fixtures::add_member(app, tb, &victim, admin_id, "member").await?;
    Ok((session, tb, victim.id))
}

#[tokio::test]
async fn admin_teams_crud_roster_and_workflow_guard() -> Result<()> {
    TestApp::run("admin_teams", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "TeamAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org = fixtures::fixture_fallback_org_id(&app, admin.id).await?;

        let vendor = fixtures::create_active_user(&app, "V", &fixtures::unique_email("v"), "VendorPass!2026", "vendor", true).await?;
        let vsession: String = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;
        let (status, _) = app.auth_get_json("/admin/teams", &vsession).await?;
        parity_assert_eq!("L:66b83f7429213d1e-1", status, reqwest::StatusCode::FORBIDDEN);
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let team = fixtures::create_team_in_cluster(&app, cluster, 1, admin.id).await?;
        let team_name: String = sqlx::query_scalar("SELECT name FROM teams WHERE id=$1").bind(team).fetch_one(app.db()).await?;
        let (status, _) = app.auth_post_json("/admin/teams", &vsession, json!({"name":fixtures::unique_name("No"),"clusterId":cluster,"level":2})).await?;
        parity_assert_eq!("L:328df097295cd2cf-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/teams/{team}"), &vsession, json!({"name":"Hijacked"})).await?;
        parity_assert_eq!("L:c896a949e990074c-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/teams/{team}"), &vsession, json!({})).await?;
        parity_assert_eq!("L:cc018f2af62b7e66-1", status, reqwest::StatusCode::FORBIDDEN);
        let (_, list) = app.auth_get_json("/admin/teams", &admin_session).await?;
        let still = list["teams"].as_array().unwrap().iter().find(|t| t["id"]==json!(team.to_string()));
        parity_assert!("L:20c8c418bd7e1102-1", still.is_some());
        parity_assert_eq!("L:48e6a5ebe485fea5-1", still.unwrap()["name"], json!(team_name));

        let cluster_name: String = sqlx::query_scalar("SELECT name FROM clusters WHERE id=$1").bind(cluster).fetch_one(app.db()).await?;
        let (status, data) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":fixtures::unique_name("T"),"clusterId":cluster,"level":2})).await?;
        parity_assert_eq!("L:dbbb4d6ddfad55ce-1", status, reqwest::StatusCode::CREATED);
        let new_id = data["team"]["id"].as_str().unwrap().to_string();
        let (_, list) = app.auth_get_json("/admin/teams", &admin_session).await?;
        let found = list["teams"].as_array().unwrap().iter().find(|t| t["id"]==json!(new_id));
        parity_assert!("L:4370f82a9a39894f-1", found.is_some());
        parity_assert_eq!("L:5ea9d198e13ae7d3-1", found.unwrap()["type"], json!("vendor"));
        parity_assert_eq!("L:1b8ee89177d03bf9-1", found.unwrap()["clusterName"], json!(cluster_name));
        let (status, data) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":fixtures::unique_name("OrgT"),"clusterId":cluster,"level":3})).await?;
        parity_assert_eq!("L:3ab4c75938398b21-1", status, reqwest::StatusCode::CREATED);
        let (_, list) = app.auth_get_json("/admin/teams", &admin_session).await?;
        let found = list["teams"].as_array().unwrap().iter().find(|t| t["id"]==data["team"]["id"]);
        parity_assert!("L:acd9842ca6fbd33f-1", found.is_some());
        parity_assert_eq!("L:3b3ea7ed85084467-1", found.unwrap()["organizationId"], json!(org.to_string()));

        // Legacy order: missing fields, unknown cluster, invalidated cluster,
        // level range, then (cluster, level) uniqueness.
        let c0 = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let (missing_name,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"clusterId":c0,"level":4})).await?;
        let (missing_cluster,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":"x","level":4})).await?;
        let (missing_level,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":"x","clusterId":c0})).await?;
        let (s1,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":fixtures::unique_name("Missing"),"clusterId":c0})).await?;
        let (s2,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":"x","clusterId":Uuid::now_v7(),"level":4})).await?;
        let expired_cluster = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        sqlx::query("UPDATE clusters SET expires_after=now() WHERE id=$1").bind(expired_cluster).execute(app.db()).await?;
        let (s3,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":"x","clusterId":expired_cluster,"level":1})).await?;
        let (s4,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":"x","clusterId":c0,"level":9})).await?;
        fixtures::create_team_in_cluster(&app,c0,1,admin.id).await?;
        let (s5,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":fixtures::unique_name("Clash"),"clusterId":c0,"level":1})).await?;
        // One legacy static assertion site covers the missing-field loop; keep
        // the Rust mapping one-to-one while exercising all three missing fields.
        parity_assert_eq!("L:3480054d1b98257a-1", missing_name == reqwest::StatusCode::BAD_REQUEST && missing_cluster == reqwest::StatusCode::BAD_REQUEST && missing_level == reqwest::StatusCode::BAD_REQUEST && s1 == reqwest::StatusCode::BAD_REQUEST, true);
        parity_assert_eq!("L:7ec9b95d20bbd2eb-1", s2, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:b398453ba81a9bd6-1", s3, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:d738774dd008ee98-1", s4, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:c8717050b6251e0e-1", s5, reqwest::StatusCode::BAD_REQUEST);

        // duplicate name within cluster
        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let dup_name = fixtures::unique_name("SameName");
        let (first,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":dup_name,"clusterId":c,"level":1})).await?;
        let (second,_) = app.auth_post_json("/admin/teams", &admin_session, json!({"name":dup_name,"clusterId":c,"level":2})).await?;
        parity_assert_eq!("L:b88658258ecbcd81-1", first, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:eff6e0649eb17c3a-1", second, reqwest::StatusCode::BAD_REQUEST);

        let c = fixtures::create_cluster_in_org(&app,"agency",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let new_name = fixtures::unique_name("Renamed");
        let (status,data) = app.auth_send_json(Method::PUT,&format!("/admin/teams/{t}"),&admin_session,json!({"name":new_name})).await?;
        parity_assert_eq!("L:fbb69e91814c0ff6-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:e05e0848c77a510f-1", data["team"]["name"], json!(new_name));
        parity_assert_eq!("L:876abfbdd72aa577-1", data["team"]["clusterId"], json!(c.to_string()));
        parity_assert_eq!("L:0d8ac3570f7b327f-1", data["team"]["level"], json!(1));
        let (status,_) = app.auth_send_json(Method::PUT,"/admin/teams/00000000-0000-0000-0000-000000000999",&admin_session,json!({"name":"X"})).await?;
        parity_assert_eq!("L:5546142263bebbb7-1", status, reqwest::StatusCode::NOT_FOUND);

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let m = fixtures::create_active_user(&app,"M",&fixtures::unique_email("m"),"MemberPass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&m,admin.id,"member").await?;
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/admin/teams/{t}"),&admin_session,json!({})).await?;
        parity_assert_eq!("L:522515adc731649f-1", status, reqwest::StatusCode::OK);
        let (status,_) = app.auth_get_json(&format!("/teams/{t}/members"),&admin_session).await?;
        parity_assert_eq!("L:6762924743bb19ed-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status,_) = app.auth_send_json(Method::DELETE,"/admin/teams/00000000-0000-0000-0000-000000000999",&admin_session,json!({})).await?;
        parity_assert_eq!("L:143eb712bd5d8482-1", status, reqwest::StatusCode::NOT_FOUND);

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let vu = fixtures::create_active_user(&app,"EligibleVendor",&fixtures::unique_email("elig"),"EligPass!2026","vendor",true).await?;
        let au = fixtures::create_active_user(&app,"WrongAff",&fixtures::unique_email("wrongaff"),"WrongPass!2026","agency",true).await?;
        let (status,data) = app.auth_get_json(&format!("/teams/{t}/eligible-members"),&admin_session).await?;
        parity_assert_eq!("L:973c525374d9012a-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:107f73e2ab08a4f1-1", data["users"].as_array().unwrap().iter().any(|u| u["id"]==json!(vu.id.to_string())));
        parity_assert!("L:f93125ed1ac66aa0-1", !data["users"].as_array().unwrap().iter().any(|u| u["id"]==json!(au.id.to_string())));

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let first_user = fixtures::create_active_user(&app,"First",&fixtures::unique_email("first"),"FirstPass!2026","vendor",true).await?;
        let (status,data) = app.auth_post_json(&format!("/teams/{t}/members"),&admin_session,json!({"userId":first_user.id})).await?;
        parity_assert_eq!("L:fa3f830b1d694c87-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:55c49a2d6118c2ac-1", data["membership"]["teamRole"], json!("team_admin"));
        let added = fixtures::latest_notification_emails(&app,"team_membership.added").await?;
        parity_assert!("L:5304be2c3d24d855-1", added.is_some());
        parity_assert_eq!("L:99290f38f6ebf7f5-1", added.unwrap(), vec![first_user.email.clone()]);

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let f = fixtures::create_active_user(&app,"First2",&fixtures::unique_email("first2"),"FirstPass!2026","vendor",true).await?;
        let s = fixtures::create_active_user(&app,"Second2",&fixtures::unique_email("second2"),"SecondPass!2026","vendor",true).await?;
        app.auth_post_json(&format!("/teams/{t}/members"),&admin_session,json!({"userId":f.id})).await?;
        let (status,data) = app.auth_post_json(&format!("/teams/{t}/members"),&admin_session,json!({"userId":s.id})).await?;
        parity_assert_eq!("L:873e2b273a63eea0-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:af8c2d6e76acfc26-1", data["membership"]["teamRole"], json!("member"));

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let au = fixtures::create_active_user(&app,"Mismatch",&fixtures::unique_email("mismatch"),"MismatchPass!2026","agency",true).await?;
        let (status,_) = app.auth_post_json(&format!("/teams/{t}/members"),&admin_session,json!({"userId":au.id})).await?;
        parity_assert_eq!("L:931c624ad37f3082-1", status, reqwest::StatusCode::BAD_REQUEST);
        let du = fixtures::create_active_user(&app,"Dup",&fixtures::unique_email("dup"),"DupPass!2026","vendor",true).await?;
        app.auth_post_json(&format!("/teams/{t}/members"),&admin_session,json!({"userId":du.id})).await?;
        let (status,_) = app.auth_post_json(&format!("/teams/{t}/members"),&admin_session,json!({"userId":du.id})).await?;
        parity_assert_eq!("L:6d40a920d2bf0506-1", status, reqwest::StatusCode::BAD_REQUEST);
        let tb = fixtures::create_team_in_cluster(&app,c,2,admin.id).await?;
        let (status,_) = app.auth_post_json(&format!("/teams/{tb}/members"),&admin_session,json!({"userId":du.id})).await?;
        parity_assert_eq!("L:a2b69aca867320fc-1", status, reqwest::StatusCode::BAD_REQUEST);

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let lu = fixtures::create_active_user(&app,"Listed",&fixtures::unique_email("listed"),"ListedPass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&lu,admin.id,"member").await?;
        let (status,data) = app.auth_get_json(&format!("/teams/{t}/members"),&admin_session).await?;
        parity_assert_eq!("L:f0e5b38a83d1791e-1", status, reqwest::StatusCode::OK);
        let found = data["members"].as_array().unwrap().iter().find(|m| m["user"]["id"]==json!(lu.id.to_string()));
        parity_assert!("L:5dd64267218246a4-1", found.is_some());
        parity_assert!("L:d8d4d5770ef3fedb-1", found.unwrap()["user"].get("passwordHash").is_none());
        parity_assert!("L:85a0305436371336-1", found.unwrap()["user"].get("passwordSalt").is_none());
        parity_assert_eq!("L:302402c5f9f75330-1", found.unwrap()["teamRole"], json!("member"));

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let ta = fixtures::create_active_user(&app,"TA",&fixtures::unique_email("ta"),"TaPass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&ta,admin.id,"team_admin").await?;
        let ta_session = fixtures::session_of(&fixtures::login_user(&app,&ta).await?)?;
        let m_id = mid(&app,&admin_session,t,ta.id).await?;
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/teams/{t}/members/{m_id}"),&ta_session,json!({})).await?;
        parity_assert_eq!("L:eb42810ea17c3c66-1", status, reqwest::StatusCode::BAD_REQUEST);

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let ru = fixtures::create_active_user(&app,"Removable",&fixtures::unique_email("removable"),"RemovablePass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&ru,admin.id,"member").await?;
        let m_id = mid(&app,&admin_session,t,ru.id).await?;
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/teams/{t}/members/{m_id}"),&admin_session,json!({})).await?;
        parity_assert_eq!("L:24b2a4561cbe0d73-1", status, reqwest::StatusCode::OK);
        let removed = fixtures::latest_notification_emails(&app,"team_membership.removed").await?;
        parity_assert!("L:7ff8b9f22dd8fbb5-1", removed.is_some());
        parity_assert_eq!("L:ceab19b89dd27e39-1", removed.unwrap(), vec![ru.email.clone()]);

        let (os, tb, victim) = cross_team(&app, admin.id, org).await?;
        let m_id = mid(&app,&admin_session,tb,victim).await?;
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/teams/{tb}/members/{m_id}"),&os,json!({})).await?;
        parity_assert_eq!("L:c3bb2b855753cb7e-1", status, reqwest::StatusCode::FORBIDDEN);
        let (os, tb, _) = cross_team(&app, admin.id, org).await?;
        let (status,_) = app.auth_get_json(&format!("/teams/{tb}/members"),&os).await?;
        parity_assert_eq!("L:7495ab4590ab1f06-1", status, reqwest::StatusCode::FORBIDDEN);
        let (os, tb, _) = cross_team(&app, admin.id, org).await?;
        let (status,_) = app.auth_get_json(&format!("/teams/{tb}/eligible-members"),&os).await?;
        parity_assert_eq!("L:f568a901eb3f2d65-1", status, reqwest::StatusCode::FORBIDDEN);
        let (os, tb, _) = cross_team(&app, admin.id, org).await?;
        let candidate = fixtures::create_active_user(&app,"AddCandidate",&fixtures::unique_email("addcandidate"),"CandidatePass!2026","vendor",true).await?;
        let (status,_) = app.auth_post_json(&format!("/teams/{tb}/members"),&os,json!({"userId":candidate.id,"teamRole":"member"})).await?;
        parity_assert_eq!("L:199b2bada64ca343-1", status, reqwest::StatusCode::FORBIDDEN);
        let (_, md) = app.auth_get_json(&format!("/teams/{tb}/members"),&admin_session).await?;
        parity_assert!("L:08c9735789352d28-1", !md["members"].as_array().unwrap().iter().any(|m| m["user"]["id"]==json!(candidate.id.to_string())));
        let (os, tb, victim) = cross_team(&app, admin.id, org).await?;
        let m_id = mid(&app,&admin_session,tb,victim).await?;
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/teams/{tb}/members/{m_id}/role"),&os,json!({"teamRole":"team_admin"})).await?;
        parity_assert_eq!("L:cf9b078a7680db4f-1", status, reqwest::StatusCode::FORBIDDEN);

        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let sole = fixtures::create_active_user(&app,"Sole",&fixtures::unique_email("sole"),"SolePass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&sole,admin.id,"team_admin").await?;
        let m_id = mid(&app,&admin_session,t,sole.id).await?;
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/teams/{t}/members/{m_id}/role"),&admin_session,json!({"teamRole":"member"})).await?;
        parity_assert_eq!("L:89c72f751e54463f-1", status, reqwest::StatusCode::BAD_REQUEST);
        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let f = fixtures::create_active_user(&app,"F",&fixtures::unique_email("f"),"FPass!2026","vendor",true).await?;
        let s = fixtures::create_active_user(&app,"S",&fixtures::unique_email("s"),"SPass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&f,admin.id,"team_admin").await?;
        fixtures::add_member(&app,t,&s,admin.id,"member").await?;
        let m_id = mid(&app,&admin_session,t,s.id).await?;
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/teams/{t}/members/{m_id}/role"),&admin_session,json!({"teamRole":"team_admin"})).await?;
        parity_assert_eq!("L:fc5f4efe43c6581f-1", status, reqwest::StatusCode::OK);
        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let iu = fixtures::create_active_user(&app,"Inv",&fixtures::unique_email("inv"),"InvPass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&iu,admin.id,"member").await?;
        let m_id = mid(&app,&admin_session,t,iu.id).await?;
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/teams/{t}/members/{m_id}/role"),&admin_session,json!({"teamRole":"superadmin"})).await?;
        parity_assert_eq!("L:b7bae7d1efa5b188-1", status, reqwest::StatusCode::BAD_REQUEST);

        let (status,data) = app.auth_get_json("/me/managed-teams",&admin_session).await?;
        parity_assert_eq!("L:693f186b5cc52129-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:9b0e2876d4074e84-1", data["teams"].is_array());
        let c = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let t = fixtures::create_team_in_cluster(&app,c,1,admin.id).await?;
        let mgd = fixtures::create_active_user(&app,"MgdTA",&fixtures::unique_email("mgdta"),"MgdPass!2026","vendor",true).await?;
        fixtures::add_member(&app,t,&mgd,admin.id,"team_admin").await?;
        let mgd_session = fixtures::session_of(&fixtures::login_user(&app,&mgd).await?)?;
        let (status,data) = app.auth_get_json("/me/managed-teams",&mgd_session).await?;
        parity_assert_eq!("L:4194ea915c211a89-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:5ad9b1182b277cdb-1", data["teams"].as_array().unwrap().len(), 1);
        parity_assert_eq!("L:255f9431687efc23-1", data["teams"][0]["id"], json!(t.to_string()));
        let (status,_) = app.get_json("/me/managed-teams").await?;
        parity_assert_eq!("L:74b6c5a00da08b09-1", status, reqwest::StatusCode::UNAUTHORIZED);

        // Addendum-204 F3 workflow-reference guard
        let owner = fixtures::create_active_user(&app,"F3 Owner",&fixtures::unique_email("f3owner"),"F3Owner!2026","agency",true).await?;
        let wired = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (blocked,body) = app.auth_send_json(Method::DELETE,&format!("/admin/teams/{}",wired.vendor_l1),&admin_session,json!({})).await?;
        parity_assert_eq!("L:8795b49080b279b1-1", blocked, reqwest::StatusCode::BAD_REQUEST);
        parity_assert!("L:640281cd78b8a77a-1", body["error"].as_str().unwrap_or("").contains("1 live system workflow"));
        let alive: Option<Uuid> = sqlx::query_scalar("SELECT id FROM teams WHERE cluster_id=$1 AND level=1 AND expires_after IS NULL").bind(wired.vendor_cluster_id).fetch_optional(app.db()).await?;
        parity_assert!("L:74b0809cc8246c01-1", alive.is_some());
        let (forced,_) = app.auth_send_json(Method::DELETE,&format!("/admin/teams/{}",wired.vendor_l1),&admin_session,json!({"force":true})).await?;
        parity_assert_eq!("L:07fcdef51a5e3372-1", forced, reqwest::StatusCode::OK);
        let alive: Option<Uuid> = sqlx::query_scalar("SELECT id FROM teams WHERE cluster_id=$1 AND level=1 AND expires_after IS NULL").bind(wired.vendor_cluster_id).fetch_optional(app.db()).await?;
        parity_assert!("L:52d8438dae941772-1", alive.is_none());

        let owner2 = fixtures::create_active_user(&app,"F3 Owner Two",&fixtures::unique_email("f3owner2"),"F3Owner!2026","agency",true).await?;
        let w2 = fixtures::create_wired_system(&app,admin.id,&owner2).await?;
        // second system sharing w2.vendor_cluster level 1
        let second_system = Uuid::now_v7();
        // The schema checks the live owner edge at transaction commit. Keep
        // this fixture's system, edge, and shared workflow step atomic rather
        // than autocommitting a transiently unowned system.
        let mut fixture_tx = app.db().begin().await?;
        sqlx::query("INSERT INTO systems (id,short_code,name,agency_cluster_id,created_by) VALUES ($1,$2,$3,$4,$5)")
            .bind(second_system).bind(fixtures::unique_short_code()).bind(fixtures::unique_name("F3 Second")).bind(w2.agency_cluster_id).bind(admin.id).execute(&mut *fixture_tx).await?;
        sqlx::query("INSERT INTO system_organizations (id,system_id,organization_id,role,created_by) VALUES ($1,$2,$3,'owner',$4)")
            .bind(Uuid::now_v7()).bind(second_system).bind(w2.agency_org_id).bind(admin.id).execute(&mut *fixture_tx).await?;
        sqlx::query("INSERT INTO system_workflow_steps (id,system_id,ordinal,cluster_id,level,step_kind) VALUES ($1,$2,1,$3,1,'hierarchical')")
            .bind(Uuid::now_v7()).bind(second_system).bind(w2.vendor_cluster_id).execute(&mut *fixture_tx).await?;
        fixture_tx.commit().await?;
        let (status,body) = app.auth_send_json(Method::DELETE,&format!("/admin/teams/{}",w2.vendor_l1),&admin_session,json!({})).await?;
        parity_assert_eq!("L:43543d002d1d1f07-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert!("L:a9f27d33b6997fd2-1", body["error"].as_str().unwrap_or("").contains("2 live system workflow"));

        let free_cluster = fixtures::create_cluster_in_org(&app,"vendor",admin.id,org).await?;
        let free_team = fixtures::create_team_in_cluster(&app,free_cluster,4,admin.id).await?;
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/admin/teams/{free_team}"),&admin_session,json!({})).await?;
        parity_assert_eq!("L:616d269c7c535a4d-1", status, reqwest::StatusCode::OK);

        let scoped_org = fixtures::create_organization(&app,&fixtures::unique_name("F3 Org A"),&fixtures::unique_short_code(),admin.id).await?;
        let scoped = fixtures::create_active_user(&app,"F3 Scoped",&fixtures::unique_email("f3scoped"),"F3Scoped!2026","agency",true).await?;
        fixtures::add_org_membership(&app,scoped_org,scoped.id,admin.id).await?;
        fixtures::grant_scoped(&app,scoped.id,"org_structure_admin",scoped_org,admin.id).await?;
        let scoped_session = fixtures::session_of(&fixtures::login_user(&app,&scoped).await?)?;
        parity_assert!("L:533e6aa0ce8fce40-1", !scoped_session.is_empty());
        let owner3 = fixtures::create_active_user(&app,"F3 Owner Scoped",&fixtures::unique_email("f3ownerscoped"),"F3Owner!2026","agency",true).await?;
        let w3 = fixtures::create_wired_system(&app,admin.id,&owner3).await?;
        // Team reachable in scoped org; referencing system's owner edge remains outside it.
        sqlx::query("UPDATE clusters SET organization_id=$1 WHERE id=$2").bind(scoped_org).bind(w3.vendor_cluster_id).execute(app.db()).await?;
        let (status,body) = app.auth_send_json(Method::DELETE,&format!("/admin/teams/{}",w3.vendor_l1),&scoped_session,json!({})).await?;
        parity_assert_eq!("L:9e7dba1bb8cf0b78-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert!("L:c83db92c59654265-1", body["error"].as_str().unwrap_or("").contains("1 live system workflow"));
        let alive: Option<Uuid> = sqlx::query_scalar("SELECT id FROM teams WHERE cluster_id=$1 AND level=1 AND expires_after IS NULL").bind(w3.vendor_cluster_id).fetch_optional(app.db()).await?;
        parity_assert!("L:3162610bfeabee5f-1", alive.is_some());
        Ok(())
    }).await
}
