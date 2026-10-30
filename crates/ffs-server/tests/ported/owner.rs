//! PORT-3B — owner self-service module suite (legacy owner.test.tsx, 89 assertions).
use super::fixtures::*;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;

async fn owner_systems(app: &TestApp, session: &str) -> Result<(u16, Value, usize)> {
    let res = app.request_with_headers(Method::GET, "/owner/systems", &[("X-Session-Token", session)], None).await?;
    let st = res.status().as_u16();
    let qc = res.headers().get("x-query-count").and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    Ok((st, res.json().await?, qc))
}
async fn create_request_at(app: &TestApp, system_id: Uuid, vendor_cluster: Uuid, user: Uuid, created_at: chrono::DateTime<chrono::Utc>, hostname: &str) -> Result<Uuid> {
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO breakglass_requests (id, request_number, sr_number, system_id, submitted_by, vendor_cluster_id, status, current_step_ordinal, justification, activity_start_at, activity_end_at, created_at) VALUES ($1,$2,'SR-STATS',$3,$4,$5,'submitted',2,'stats',$6,$7,$8)")
        .bind(id).bind(format!("REQ-{}", &id.simple().to_string()[..12])).bind(system_id).bind(user).bind(vendor_cluster)
        .bind(created_at + chrono::Duration::hours(1)).bind(created_at + chrono::Duration::hours(2)).bind(created_at).execute(app.db()).await?;
    sqlx::query("INSERT INTO request_credential_items (request_id, hostname, credential_type, management_mode) VALUES ($1,$2,'password','api_managed')").bind(id).bind(hostname).execute(app.db()).await?;
    Ok(id)
}

#[tokio::test]
async fn owner_self_service() -> Result<()> {
    TestApp::run("owner-self-service", |app| async move {
        prepare(&app).await?;
        let admin = create_admin(&app, "Admin!2026aa").await?;
        let owner = mk_user(&app, "agency").await?;
        let w = create_wired_system(&app, admin.id, &owner).await?;
        let os = session_of(&login_user(&app, &owner).await?)?;
        // GET /owner/systems basics
        let (st, data, _) = owner_systems(&app, &os).await?; parity_assert_eq!("L:fb2efb49dbecd57e-1", st, 200);
        let found = data["systems"].as_array().unwrap().iter().find(|s| s["id"] == w.system_id.to_string()); parity_assert!("L:d7caf43f0ca7fcc2-1", found.is_some());
        parity_assert_eq!("L:af79639cae9db4ee-1", found.unwrap()["userRole"], "primary_owner"); parity_assert_eq!("L:57f3e87e9710a9d7-1", found.unwrap()["primaryOwner"]["id"], owner.id.to_string());
        let nobody = mk_user(&app, "agency").await?; let ns = session_of(&login_user(&app, &nobody).await?)?;
        let (st, data, _) = owner_systems(&app, &ns).await?; parity_assert_eq!("L:20d6e93c7ae2c5f9-1", st, 200); parity_assert_eq!("L:b99bded5d5df6202-1", data["systems"].as_array().unwrap().len(), 0);
        let (st, _) = app.get_json("/owner/systems").await?; parity_assert_eq!("L:3493beef59f287ae-1", st.as_u16(), 403);
        // enriched two systems
        let backup_a = mk_user(&app, "agency").await?; let delegate_a = mk_user(&app, "agency").await?;
        let delegate_a_name: String = sqlx::query_scalar("SELECT full_name FROM users WHERE id=$1").bind(delegate_a.id).fetch_one(app.db()).await?;
        sqlx::query("INSERT INTO system_owners (system_id,user_id,kind,created_by) VALUES ($1,$2,'backup',$3)").bind(w.system_id).bind(backup_a.id).bind(admin.id).execute(app.db()).await?;
        sqlx::query("INSERT INTO system_delegates (system_id,owner_id,delegate_user_id) VALUES ($1,$2,$3)").bind(w.system_id).bind(owner.id).bind(delegate_a.id).execute(app.db()).await?;
        let owner_b = mk_user(&app, "agency").await?; let wb = create_wired_system(&app, admin.id, &owner_b).await?;
        sqlx::query("UPDATE system_owners SET user_id=$1 WHERE system_id=$2 AND kind='primary'").bind(owner.id).bind(wb.system_id).execute(app.db()).await?;
        let delegate_b = mk_user(&app, "agency").await?;
        let delegate_b_name: String = sqlx::query_scalar("SELECT full_name FROM users WHERE id=$1").bind(delegate_b.id).fetch_one(app.db()).await?;
        sqlx::query("INSERT INTO system_delegates (system_id,owner_id,delegate_user_id) VALUES ($1,$2,$3)").bind(wb.system_id).bind(owner.id).bind(delegate_b.id).execute(app.db()).await?;
        let (st, data, _) = owner_systems(&app, &os).await?; parity_assert_eq!("L:c56070459c737693-1", st, 200); parity_assert_eq!("L:20b7618ee080f977-1", data["systems"].as_array().unwrap().len(), 2);
        let sys_a = data["systems"].as_array().unwrap().iter().find(|s| s["id"] == w.system_id.to_string()).unwrap();
        let sys_b = data["systems"].as_array().unwrap().iter().find(|s| s["id"] == wb.system_id.to_string()).unwrap();
        parity_assert!("L:e8919727e5ac4c80-1", sys_a.is_object()); parity_assert!("L:c10a2c2846f3156c-1", sys_b.is_object());
        parity_assert_eq!("L:d98a073ea3b74e00-1", sys_a["userRole"], "primary_owner"); parity_assert_eq!("L:38d33f086fab73cb-1", sys_a["primaryOwner"]["id"], owner.id.to_string()); parity_assert_eq!("L:8a5c92f1ade86aa3-1", sys_a["backupOwner"]["id"], backup_a.id.to_string());
        parity_assert_eq!("L:654ae834b2a9f59b-1", sys_a["delegates"].as_array().unwrap().len(), 1); parity_assert_eq!("L:50c1a27e264a6eb2-1", sys_a["delegates"][0]["delegateUserId"], delegate_a.id.to_string()); parity_assert_eq!("L:93167aace3fa12a4-1", sys_a["delegates"][0]["fullName"], delegate_a_name.as_str()); parity_assert_eq!("L:65c10ce5d6bfae05-1", sys_a["delegates"][0]["email"], delegate_a.email.as_str());
        parity_assert_eq!("L:58a404439463dcfc-1", sys_b["userRole"], "primary_owner"); parity_assert_eq!("L:5ec51437e9e6f7c4-1", sys_b["primaryOwner"]["id"], owner.id.to_string()); parity_assert_eq!("L:cc873cb1e58bac4b-1", sys_b["backupOwner"], Value::Null);
        parity_assert_eq!("L:1ea4a96ff0c16e28-1", sys_b["delegates"].as_array().unwrap().len(), 1); parity_assert_eq!("L:b5e8f83abc722ef7-1", sys_b["delegates"][0]["delegateUserId"], delegate_b.id.to_string()); parity_assert_eq!("L:a5bdb40135170862-1", sys_b["delegates"][0]["fullName"], delegate_b_name.as_str()); parity_assert_eq!("L:2aee68fd916ebc85-1", sys_b["delegates"][0]["email"], delegate_b.email.as_str());
        // N+1 query-count seam
        let (st, _, count1) = owner_systems(&app, &os).await?; parity_assert_eq!("L:56e9b545aaeac171-1", st, 200);
        let w2 = create_wired_system(&app, admin.id, &owner).await?; let w3 = create_wired_system(&app, admin.id, &owner).await?;
        let (_, data3, count3) = owner_systems(&app, &os).await?; parity_assert_eq!("L:093bcbfc6db19f86-1", data3["systems"].as_array().unwrap().len(), 4);
        parity_assert!("L:e6553d48e6951095-1", data3["systems"].as_array().unwrap().iter().any(|s| s["id"] == w.system_id.to_string())); parity_assert!("L:6d81622f0b3b5dab-1", data3["systems"].as_array().unwrap().iter().any(|s| s["id"] == w2.system_id.to_string())); parity_assert!("L:d553495044514fdc-1", data3["systems"].as_array().unwrap().iter().any(|s| s["id"] == w3.system_id.to_string()));
        parity_assert!("L:79311691c79d6bfa-1", (count3 as i64) - (count1 as i64) < 10);
        // eligible delegates
        let bs = session_of(&login_user(&app, &backup_a).await?)?;
        let candidate = mk_user(&app, "agency").await?; add_org_membership(&app, w.agency_org_id, candidate.id, admin.id).await?;
        let (st, data) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", w.system_id), &os).await?; parity_assert_eq!("L:bd88e688d8ec5fcc-1", st.as_u16(), 200);
        parity_assert!("L:6e8181dee39a7e33-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == candidate.id.to_string())); parity_assert_eq!("L:aa8a5b4daaaaf53d-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == owner.id.to_string()), false);
        let vendor_member = mk_user(&app, "vendor").await?; add_org_membership(&app, w.agency_org_id, vendor_member.id, admin.id).await?;
        let (st, data) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", w.system_id), &os).await?; parity_assert_eq!("L:665c54f85aa0f4bf-1", st.as_u16(), 200); parity_assert_eq!("L:f90cdc6431b655ea-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == vendor_member.id.to_string()), false);
        let other_org = create_organization(&app, &unique_name("Other"), &unique_short_code(), admin.id).await?; let outlander = mk_user(&app, "agency").await?; add_org_membership(&app, other_org, outlander.id, admin.id).await?;
        let (st, data) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", w.system_id), &os).await?; parity_assert_eq!("L:d98ec3ac996c9564-1", st.as_u16(), 200); parity_assert_eq!("L:c54077cc47071f36-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == outlander.id.to_string()), false);
        let participant_org = create_organization(&app, &unique_name("Participant"), &unique_short_code(), admin.id).await?;
        sqlx::query("INSERT INTO system_organizations (system_id,organization_id,role,created_by) VALUES ($1,$2,'participant',$3)").bind(w.system_id).bind(participant_org).bind(admin.id).execute(app.db()).await?;
        let officer = mk_user(&app, "agency").await?; add_org_membership(&app, participant_org, officer.id, admin.id).await?;
        let (st, data) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", w.system_id), &os).await?; parity_assert_eq!("L:a1d23634ce6171bc-1", st.as_u16(), 200); parity_assert!("L:9e9511ca21266b6a-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == officer.id.to_string()));
        let (st, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": officer.id})).await?; parity_assert_eq!("L:52fa66e4250ef904-1", st.as_u16(), 201);
        let (st, data) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": outlander.id})).await?; parity_assert_eq!("L:7d79ce1d562cc008-1", st.as_u16(), 400); parity_assert_eq!("L:5a80dfd367256699-1", data["error"], "Delegate must be an agency user with membership in the same organisation as the system.");
        let rows = sqlx::query("SELECT 1 FROM system_delegates WHERE system_id=$1 AND delegate_user_id=$2 AND expires_after IS NULL").bind(w.system_id).bind(outlander.id).fetch_optional(app.db()).await?; parity_assert_eq!("L:e4a7022b2c91df42-1", rows.is_none(), true);
        let empty_org = create_organization(&app, &unique_name("Empty"), &unique_short_code(), admin.id).await?; let we = create_wired_system(&app, admin.id, &owner).await?; repoint_owner_org_edge(&app, we.system_id, empty_org, admin.id).await?;
        let (st, data) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", we.system_id), &os).await?; parity_assert_eq!("L:7700e10f8a1afd14-1", st.as_u16(), 200); parity_assert_eq!("L:58cf7127886ee9fe-1", data["users"].as_array().unwrap().len(), 0);
        let pending = mk_user(&app, "agency").await?; sqlx::query("UPDATE users SET status='pending_approval' WHERE id=$1").bind(pending.id).execute(app.db()).await?; add_org_membership(&app, w.agency_org_id, pending.id, admin.id).await?;
        let tomb = mk_user(&app, "agency").await?; sqlx::query("UPDATE users SET status='tombstoned' WHERE id=$1").bind(tomb.id).execute(app.db()).await?; add_org_membership(&app, w.agency_org_id, tomb.id, admin.id).await?;
        let (st, data) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", w.system_id), &os).await?; parity_assert_eq!("L:dec3c123949a475a-1", st.as_u16(), 200); parity_assert!("L:9604980f907f6c37-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == candidate.id.to_string())); parity_assert_eq!("L:8b94c4135aec5f5b-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == pending.id.to_string()), false); parity_assert_eq!("L:679bbc2bc9965b17-1", data["users"].as_array().unwrap().iter().any(|u| u["id"] == tomb.id.to_string()), false);
        let (st, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": pending.id})).await?; parity_assert_eq!("L:2f98b85fe163fb07-1", st.as_u16(), 400);
        let (st, _) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", Uuid::now_v7()), &os).await?; parity_assert_eq!("L:4562e0dec722ef10-1", st.as_u16(), 404);
        let (st, _) = app.auth_get_json(&format!("/owner/systems/{}/eligible-delegates", wb.system_id), &bs).await?; parity_assert_eq!("L:0942bebf0a981a55-1", st.as_u16(), 404);
        // add / remove delegate
        let delegate = mk_user(&app, "agency").await?; add_org_membership(&app, w.agency_org_id, delegate.id, admin.id).await?;
        let (st, data) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": delegate.id})).await?; parity_assert_eq!("L:d45701b88472534d-1", st.as_u16(), 201); parity_assert_eq!("L:b2b07c94420e8d3c-1", data["delegate"]["delegateUserId"], delegate.id.to_string());
        let added = latest_notification_emails(&app, "system_delegate.added").await?; parity_assert!("L:7358bb42f4226758-1", added.is_some()); parity_assert_eq!("L:5e86f458c6891915-1", added.unwrap(), vec![delegate.email.clone()]);
        let (st, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": owner.id})).await?; parity_assert_eq!("L:d19dc8e46604f7c7-1", st.as_u16(), 400);
        let rows = sqlx::query("SELECT 1 FROM system_delegates WHERE system_id=$1 AND delegate_user_id=$2 AND expires_after IS NULL").bind(w.system_id).bind(owner.id).fetch_optional(app.db()).await?; parity_assert_eq!("L:7e7e77c56bd91351-1", rows.is_none(), true);
        let (st, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": backup_a.id})).await?; parity_assert_eq!("L:da7365f50d9a39ae-1", st.as_u16(), 400);
        let rows = sqlx::query("SELECT 1 FROM system_delegates WHERE system_id=$1 AND delegate_user_id=$2 AND expires_after IS NULL").bind(w.system_id).bind(backup_a.id).fetch_optional(app.db()).await?; parity_assert_eq!("L:436996518dbb4454-1", rows.is_none(), true);
        let (st, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": delegate.id})).await?; parity_assert_eq!("L:fade5550c4feca93-1", st.as_u16(), 400);
        let del_id = data["delegate"]["id"].as_str().unwrap().to_string();
        let (st, _) = app.auth_send_json(Method::DELETE, &format!("/owner/systems/{}/delegates/{}", w.system_id, del_id), &os, json!({})).await?; parity_assert_eq!("L:190d394329567abe-1", st.as_u16(), 200);
        let removed = latest_notification_emails(&app, "system_delegate.removed").await?; parity_assert!("L:381ca9c5ae0c1176-1", removed.is_some()); parity_assert_eq!("L:09ee8a95b5dc5637-1", removed.unwrap(), vec![delegate.email.clone()]);
        let (st, _) = app.auth_send_json(Method::DELETE, &format!("/owner/systems/{}/delegates/{}", w.system_id, del_id), &os, json!({})).await?; parity_assert_eq!("L:966522ab0b0ca587-1", st.as_u16(), 404);
        let (st, _) = app.auth_send_json(Method::DELETE, &format!("/owner/systems/{}/delegates/{}", w.system_id, del_id), &bs, json!({})).await?; parity_assert_eq!("L:cc66028fd26b254a-1", st.as_u16(), 404);
        let still = sqlx::query("SELECT 1 FROM system_delegates WHERE id=$1").bind(Uuid::parse_str(&del_id)?).fetch_optional(app.db()).await?; parity_assert!("L:f2e744c661215907-1", still.is_some());
        // statistics
        let t0 = chrono::Utc::now();
        for i in 0..3 { create_request_at(&app, w.system_id, w.vendor_cluster_id, owner.id, t0 - chrono::Duration::days(2) + chrono::Duration::minutes(i), "host-a").await?; }
        for i in 0..2 { create_request_at(&app, wb.system_id, wb.vendor_cluster_id, owner.id, t0 - chrono::Duration::days(2) + chrono::Duration::minutes(i), "host-b").await?; }
        let q = format!("/owner/statistics?from={}&to={}", (t0 - chrono::Duration::days(3)).format("%Y-%m-%dT%H:%M:%SZ"), t0.format("%Y-%m-%dT%H:%M:%SZ"));
        let (st, data) = app.auth_get_json(&q, &os).await?; parity_assert_eq!("L:4fd0b830a44cc0d8-1", st.as_u16(), 200); parity_assert_eq!("L:39b6bc6f94226915-1", data["mode"], "by_system");
        let bucket_a = data["data"].as_array().unwrap().iter().find(|d| d["id"] == w.system_id.to_string()); let bucket_b = data["data"].as_array().unwrap().iter().find(|d| d["id"] == wb.system_id.to_string());
        parity_assert!("L:87b16fb1fa7dc01e-1", bucket_a.is_some()); parity_assert!("L:02c07539ceab77ad-1", bucket_b.is_some()); parity_assert_eq!("L:bb28405803c330c8-1", bucket_a.unwrap()["count"], 3); parity_assert_eq!("L:b07c56a60bc7d07b-1", bucket_b.unwrap()["count"], 2);
        create_request_at(&app, w.system_id, w.vendor_cluster_id, owner.id, t0 - chrono::Duration::days(2), "host-b").await?;
        let qh = format!("{}&system_id={}", q, w.system_id);
        let (st, data) = app.auth_get_json(&qh, &os).await?; parity_assert_eq!("L:aba90b7d319c80aa-1", st.as_u16(), 200); parity_assert_eq!("L:ab68a08d1ff1263d-1", data["mode"], "by_hostname");
        let host_a = data["data"].as_array().unwrap().iter().find(|d| d["id"] == "host-a"); parity_assert!("L:dd784cd9aa83d911-1", host_a.is_some()); parity_assert_eq!("L:5012e31c20b73745-1", host_a.unwrap()["count"], 3);
        let host_b = data["data"].as_array().unwrap().iter().find(|d| d["id"] == "host-b"); parity_assert!("L:28d5abcdd9e0b414-1", host_b.is_some()); parity_assert_eq!("L:791354e571712c68-1", host_b.unwrap()["count"], 1);
        let qn = format!("/owner/statistics?from={}&to={}", (t0 - chrono::Duration::days(1)).format("%Y-%m-%dT%H:%M:%SZ"), t0.format("%Y-%m-%dT%H:%M:%SZ"));
        let (_, nd) = app.auth_get_json(&qn, &os).await?; parity_assert_eq!("L:7cd37444c906ae56-1", nd["data"].as_array().unwrap().iter().any(|d| d["id"] == w.system_id.to_string()), false);
        create_request_at(&app, w.system_id, w.vendor_cluster_id, owner.id, t0 - chrono::Duration::hours(1), "host-a").await?;
        let (_, nd) = app.auth_get_json(&qn, &os).await?; let bucket = nd["data"].as_array().unwrap().iter().find(|d| d["id"] == w.system_id.to_string()); parity_assert!("L:2c6bba44d1fe5bf1-1", bucket.is_some()); parity_assert_eq!("L:7e68cb75cd423de6-1", bucket.unwrap()["count"], 1);
        let (st, _) = app.auth_get_json(&format!("{}&system_id={}", q, Uuid::now_v7()), &os).await?; parity_assert_eq!("L:42fe88125b170bcc-1", st.as_u16(), 404);
        let (st, data) = app.auth_get_json(&q, &ns).await?; parity_assert_eq!("L:547210c39a7cce3c-1", st.as_u16(), 200); parity_assert_eq!("L:9484069ac44f22d1-1", data["data"].as_array().unwrap().len(), 0);
        let (st, _) = app.auth_get_json("/owner/statistics", &os).await?; parity_assert_eq!("L:0c4e9a26d3b007d2-1", st.as_u16(), 400);
        let (st, _) = app.auth_get_json("/owner/statistics?from=bad&to=bad", &os).await?; parity_assert_eq!("L:ab6376ee123acc6a-1", st.as_u16(), 400);
        let (st, _) = app.get_json(&q).await?; parity_assert_eq!("L:d8af1229cc4f24f2-1", st.as_u16(), 403);
        Ok(())
    }).await
}
