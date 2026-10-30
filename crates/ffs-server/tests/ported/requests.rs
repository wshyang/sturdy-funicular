//! PORT-3B — request lifecycle user-flow suite (legacy test/backend/deno/requests.test.tsx, 204 assertions).
//! Drives the real Rust HTTP app + real Postgres; fixtures mirror the legacy helpers.

use super::fixtures::*;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::{json, Value};

async fn setup(app: &TestApp) -> Result<(FixtureUser, FourStepSystem)> {
    fixtures_prepare(app).await?;
    let admin = create_admin(app, "Admin!2026aa").await?;
    let owner = mk_user(app, "agency").await?;
    let s = create_four_step_system(app, admin.id, &owner).await?;
    Ok((admin, s))
}
async fn fixtures_prepare(app: &TestApp) -> Result<()> { prepare(app).await }
async fn post(app: &TestApp, session: &str, path: &str, body: Value) -> Result<(u16, Value)> {
    let (st, v) = app.auth_post_json(path, session, body).await?; Ok((st.as_u16(), v))
}
async fn get(app: &TestApp, session: &str, path: &str) -> Result<(u16, Value)> {
    let (st, v) = app.auth_get_json(path, session).await?; Ok((st.as_u16(), v))
}
fn sess(s: &FourStepSystem, k: &str) -> String { s.sessions[k].clone() }
async fn approve_all_steps(app: &TestApp, s: &FourStepSystem, id: &str) -> Result<()> {
    for k in ["vendorApprover","agencyApprover","vendorL3Approver","agencyL2Approver"] {
        post(app, &sess(s,k), &format!("/requests/{id}/step-decision"), json!({"decision":"approve"})).await?;
    }
    Ok(())
}
fn resubmit_body(s: &FourStepSystem, justification: &str) -> Value {
    let now = chrono::Utc::now();
    json!({"justification": justification, "srNumber":"SR-3B", "activityStartAt": (now+chrono::Duration::hours(1)).to_rfc3339(), "activityEndAt": (now+chrono::Duration::hours(2)).to_rfc3339(), "credentialItems":[{"assetId":s.asset_id,"hostnameDescription":"host"}]})
}

#[tokio::test]
async fn requests_submission_visibility_decisions() -> Result<()> {
    TestApp::run("requests-submission", |app| async move {
        let (admin, s) = setup(&app).await?;
        let sub = sess(&s, "submitter");
        let now = chrono::Utc::now();
        let start = (now + chrono::Duration::hours(1)).to_rfc3339();
        let end = (now + chrono::Duration::hours(2)).to_rfc3339();
        let base = json!({"systemId": s.system_id, "justification": "Need access for maintenance", "srNumber":"SR-1", "activityStartAt": start, "activityEndAt": end, "credentialItems":[{"assetId":s.asset_id,"hostnameDescription":"h"}]});
        // unauthenticated + validation negatives
        let (st, _) = app.post_json("/requests", base.clone()).await?; parity_assert_eq!("L:13ebf80bdaec24cf-1", st.as_u16(), 403);
        let mut b = base.clone(); b["justification"] = json!("short"); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:0796a21fc0d050a6-1", st, 400);
        let mut b = base.clone(); b["justification"] = json!("x".repeat(2001)); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:5a112ee038052a04-1", st, 400);
        let mut b = base.clone(); b["srNumber"] = json!(""); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:44affe2f170f4024-1", st, 400);
        let mut b = base.clone(); b["credentialItems"] = json!([]); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:aae6eeebb6e8ca14-1", st, 400);
        let mut b = base.clone(); b["credentialItems"] = json!([{"assetId": uuid::Uuid::now_v7()}]); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:26a1c65ffb193a62-1", st, 400);
        let mut b = base.clone(); b["activityEndAt"] = json!(start); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:c5856116c350ed23-1", st, 400);
        let mut b = base.clone(); b["activityStartAt"] = json!("not-a-date"); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:54cabf03a57ebf81-1", st, 400);
        let mut b = base.clone(); b["systemId"] = json!(uuid::Uuid::now_v7()); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:b8c218715d944f35-1", st, 400);
        let mut b = base.clone(); b["systemId"] = json!("not-a-uuid"); let (st,_) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:3a7625784d33ac63-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"outsider"),"/requests",base.clone()).await?; parity_assert_eq!("L:5e56df0e0ba1206f-1", st, 403);
        // happy path
        let (st, data) = post(&app,&sub,"/requests",base.clone()).await?; parity_assert_eq!("L:35d2a6321af3291b-1", st, 201);
        parity_assert!("L:95addd51b0a44c23-1", data["request"]["requestNumber"].is_string());
        parity_assert_eq!("L:38cb812b2242ff9d-1", data["request"]["status"], "submitted");
        parity_assert_eq!("L:2bda5d6739cb2d23-1", data["request"]["currentStepOrdinal"], 2);
        parity_assert_eq!("L:805a5f7c68486a26-1", data["credentialItems"].as_array().unwrap().len(), 1);
        let reviewer_email = latest_notification_emails(&app, "request.submitted").await?; parity_assert!("L:091fef7c323d66a0-1", reviewer_email.is_some());
        parity_assert!("L:5949c233475eae2b-1", reviewer_email.unwrap().contains(&s.vendor_approver.email.clone()));
        let conf = latest_notification_emails(&app, "request.submitted_confirmation").await?; parity_assert!("L:9bccc879720c1268-1", conf.is_some());
        parity_assert!("L:322ed1e5a3b13c7a-1", conf.unwrap().contains(&s.submitter.email.clone()));
        let rid = data["request"]["id"].as_str().unwrap().to_string();
        // key material
        let (st, data2) = post(&app,&sub,"/requests",base.clone()).await?; parity_assert_eq!("L:bf9fcf54f31bdd9c-1", st, 201);
        let rid2 = data2["request"]["id"].as_str().unwrap().to_string();
        let km = sqlx::query("SELECT key_algorithm, public_key, private_key_wrap_key FROM request_key_material WHERE request_id=$1").bind(uuid::Uuid::parse_str(&rid2)?).fetch_optional(app.db()).await?;
        parity_assert!("L:c0f2738647ab0349-1", km.is_some());
        let km = km.unwrap(); use sqlx::Row;
        parity_assert_eq!("L:bae87647bfcfd06f-1", km.try_get::<String,_>("key_algorithm")?, "RSA-OAEP-2048-SHA256");
        let pk: String = km.try_get("public_key")?; parity_assert!("L:236f9d439cfba04c-1", pk.starts_with("MI"));
        let wk: String = km.try_get("private_key_wrap_key")?; parity_assert_eq!("L:eeb6ada80bd81ec6-1", wk.len(), 44);
        // credential types / multiple items
        let mut b = base.clone(); b["credentialItems"] = json!([{"assetId":s.asset_id,"hostnameDescription":"h"}]); let (st,data3) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:e3658ddbcba98bde-1", st, 201);
        parity_assert_eq!("L:74a2bbabccb00544-1", data3["credentialItems"][0]["credentialType"], "password");
        let a2 = create_asset(&app, s.system_id, "tok-host").await?; let a3 = create_asset(&app, s.system_id, "dev-host").await?;
        sqlx::query("UPDATE assets SET credential_type='token', credential_name='tok-abc123' WHERE id=$1").bind(a2).execute(app.db()).await?;
        sqlx::query("UPDATE assets SET credential_type='device' WHERE id=$1").bind(a3).execute(app.db()).await?;
        let mut b = base.clone(); b["credentialItems"] = json!([{"assetId":a2},{"assetId":a3}]); let (st,data4) = post(&app,&sub,"/requests",b).await?; parity_assert_eq!("L:a61745a9dc30e76f-1", st, 201);
        parity_assert_eq!("L:2c387efc070a69c0-1", data4["credentialItems"].as_array().unwrap().len(), 2);
        parity_assert_eq!("L:a8192e2b9a814a87-1", data4["credentialItems"][0]["credentialType"], "token");
        parity_assert_eq!("L:e666d5fedf2d0968-1", data4["credentialItems"][1]["credentialType"], "device");
        let rid4 = data4["request"]["id"].as_str().unwrap();
        let (_, gd) = get(&app,&sub,&format!("/requests/{rid4}")).await?; parity_assert_eq!("L:af2102c65831716a-1", gd["credentialItems"][0]["credentialType"], "token");
        // GET detail + visibility
        let (st, d) = get(&app,&sub,&format!("/requests/{rid}")).await?; parity_assert_eq!("L:7e569d66ea82cc96-1", st, 200);
        parity_assert_eq!("L:b30ce1f7719f2874-1", d["request"]["id"], rid.as_str());
        parity_assert_eq!("L:3d667beebbcf2414-1", d["approvalSteps"].as_array().unwrap().len(), 5);
        parity_assert_eq!("L:990c6da15bb76be4-1", d["approvalSteps"][0]["stepStatus"], "submitted");
        parity_assert_eq!("L:7818cbfa7d817891-1", d["submitter"]["id"], s.submitter.id.to_string());
        let (st,_) = get(&app,&sess(&s,"outsider"),&format!("/requests/{rid}")).await?; parity_assert_eq!("L:d7266343bc57bf04-1", st, 404);
        let (st,_) = get(&app,&sess(&s,"owner"),&format!("/requests/{rid}")).await?; parity_assert_eq!("L:d309a16c920d28d8-1", st, 404);
        let (st,d) = get(&app,&sess(&s,"agencyApprover"),&format!("/requests/{rid}")).await?; parity_assert_eq!("L:804e36bad6bf3248-1", st, 200);
        parity_assert_eq!("L:4a4370391d9c673e-1", d["request"]["viewerIsCurrentStepReviewer"], false);
        parity_assert_eq!("L:b7ad924123f7add4-1", d["request"]["viewerCanOverride"], true);
        let (st,_) = get(&app,&sess(&s,"backupOwner"),&format!("/requests/{rid}")).await?; parity_assert_eq!("L:6e2cb58801e00c6d-1", st, 404);
        let (st,d) = get(&app,&sess(&s,"vendorApprover"),&format!("/requests/{rid}")).await?; parity_assert_eq!("L:efa1442013a0f549-1", st, 200);
        parity_assert_eq!("L:50bb004a6d69cd67-1", d["request"]["viewerIsCurrentStepReviewer"], true);
        let (st,d) = get(&app,&sub,&format!("/requests/{rid}")).await?; parity_assert_eq!("L:6326d97398556177-1", st, 200);
        parity_assert_eq!("L:ccf3275ea71d8495-1", d["request"]["viewerIsCurrentStepReviewer"], false);
        parity_assert_eq!("L:5fe6a8faf050455b-1", d["request"]["viewerCanOverride"], false);
        // my-requests
        let (st,_) = get(&app,&sess(&s,"outsider"),"/requests/my-requests").await?; parity_assert_eq!("L:54193031229795d6-1", st, 200);
        let (_, mr) = get(&app,&sess(&s,"outsider"),"/requests/my-requests").await?; parity_assert_eq!("L:f8eb620f29928285-1", mr["requests"].as_array().unwrap().len(), 0);
        let (_, mr) = get(&app,&sub,"/requests/my-requests").await?; parity_assert!("L:e9c5e61bcdef16bd-1", mr["requests"].as_array().unwrap().iter().any(|r| r["id"]==rid.as_str()));
        let (_, va) = get(&app,&sub,"/requests/my-requests").await?;
        let sr = va["requests"].as_array().unwrap().iter().find(|r| r["id"]==rid.as_str()); parity_assert!("L:0c7ea537defd41bd-1", sr.is_some()); parity_assert_eq!("L:d1c85e75034df814-1", sr.unwrap()["viewerIsCurrentStepReviewer"], false);
        let (_, aa) = get(&app,&sess(&s,"vendorApprover"),"/requests/my-requests").await?;
        let ar = aa["requests"].as_array().unwrap().iter().find(|r| r["id"]==rid.as_str()); parity_assert!("L:1d31d0e6e5b2b44c-1", ar.is_some()); parity_assert_eq!("L:db051d48b41515e7-1", ar.unwrap()["viewerIsCurrentStepReviewer"], true);
        grant_scoped(&app, s.agency_off_step.id, "full_admin", { let r=sqlx::query("SELECT organization_id FROM system_organizations WHERE system_id=$1 AND role='owner' AND expires_after IS NULL LIMIT 1").bind(s.system_id).fetch_one(app.db()).await?; use sqlx::Row; r.try_get::<uuid::Uuid,_>("organization_id")? }, admin.id).await?;
        let (_, off) = get(&app,&sess(&s,"agencyOffStep"),"/requests/my-requests").await?;
        let orow = off["requests"].as_array().unwrap().iter().find(|r| r["id"]==rid.as_str()); parity_assert!("L:0b64b1b7f3aaea99-1", orow.is_some()); parity_assert_eq!("L:4d7abd19b70eca85-1", orow.unwrap()["viewerIsCurrentStepReviewer"], false);
        // step decisions: unauthorized / bad decision / approve / return / reject
        let (st,_) = post(&app,&sess(&s,"outsider"),&format!("/requests/{rid}/step-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:f6c3f6eaa5cc55c0-1", st, 403);
        let (st,_) = post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{rid}/step-decision"),json!({"decision":"maybe"})).await?; parity_assert_eq!("L:938d1e3208fc1a87-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{rid}/step-decision"),json!({"decision":"reject"})).await?; parity_assert_eq!("L:4f1e7b2f87826440-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{rid}/step-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:ab2186538f5af654-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{rid}")).await?; parity_assert_eq!("L:feca07dd99dda29b-1", d["request"]["currentStepOrdinal"], 3); parity_assert_eq!("L:c783374c95288f00-1", d["request"]["status"], "under_review");
        let nre = latest_notification_emails(&app,"request.step_approved_next_reviewer").await?; parity_assert!("L:7a81d588d20f3ab3-1", nre.is_some()); parity_assert!("L:04087e110e85c79c-1", nre.unwrap().contains(&s.agency_approver.email.clone()));
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{rid}/step-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:3172b7a57ae11545-1", st, 200);
        post(&app,&sess(&s,"vendorL3Approver"),&format!("/requests/{rid}/step-decision"),json!({"decision":"approve"})).await?;
        post(&app,&sess(&s,"agencyL2Approver"),&format!("/requests/{rid}/step-decision"),json!({"decision":"approve"})).await?;
        let (_, d) = get(&app,&sub,&format!("/requests/{rid}")).await?; parity_assert_eq!("L:78c163c57d2e51a6-1", d["request"]["currentStepOrdinal"], 0);
        let one = latest_notification_emails(&app,"request.step_approved_owner").await?; parity_assert!("L:384c70b89e20ce8b-1", one.is_some()); parity_assert!("L:54f4b4d9b30c244d-1", one.unwrap().contains(&s.owner.email.clone()));
        // fresh requests for return / reject
        let (_, rret) = submit_four_step(&app,&s,&sub,"Return flow justification").await?; let rret_id = rret["request"]["id"].as_str().unwrap().to_string();
        let (st,_) = post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{rret_id}/step-decision"),json!({"decision":"return","notes":"please clarify"})).await?; parity_assert_eq!("L:6818284c62d365ba-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{rret_id}")).await?; parity_assert_eq!("L:d5e76f31c7bda4e9-1", d["request"]["status"], "returned_to_vendor"); parity_assert_eq!("L:a5e080a8eb26adb2-1", d["request"]["returnCount"], 1);
        let re = latest_notification_emails(&app,"request.step_returned").await?; parity_assert!("L:d1687e34cace1b8a-1", re.is_some()); parity_assert!("L:33de1f05e81ad9f0-1", re.unwrap().contains(&s.submitter.email.clone()));
        let (_, rrej) = submit_four_step(&app,&s,&sub,"Reject flow justification").await?; let rrej_id = rrej["request"]["id"].as_str().unwrap().to_string();
        let (st,_) = post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{rrej_id}/step-decision"),json!({"decision":"reject","notes":"not allowed"})).await?; parity_assert_eq!("L:ac61c388e1b0153c-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{rrej_id}")).await?; parity_assert_eq!("L:9275378c28f0757c-1", d["request"]["status"], "rejected");
        let je = latest_notification_emails(&app,"request.step_rejected").await?; parity_assert!("L:07cc2ab3df57a826-1", je.is_some()); parity_assert!("L:b3250e90d1ab7977-1", je.unwrap().contains(&s.submitter.email.clone()));
        // owner decision negatives
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{rret_id}/owner-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:9fea7fe8bf884788-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"outsider"),&format!("/requests/{rret_id}/owner-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:8b473b65b96b04dd-1", st, 403);
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{rret_id}/owner-decision"),json!({"decision":"return"})).await?; parity_assert_eq!("L:de3224a7c2f37571-1", st, 400);
        Ok(())
    }).await
}

#[tokio::test]
async fn requests_owner_delivery_reset() -> Result<()> {
    TestApp::run("requests-owner-delivery", |app| async move {
        let (admin, s) = setup(&app).await?; let sub = sess(&s,"submitter");
        // resubmit keeps key material + returnCount 2
        let (_, rr) = submit_four_step(&app,&s,&sub,"Resubmit flow justification").await?; let id = rr["request"]["id"].as_str().unwrap().to_string();
        post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{id}/step-decision"),json!({"decision":"return","notes":"clarify"})).await?;
        use sqlx::Row;
        let before = sqlx::query("SELECT id, public_key FROM request_key_material WHERE request_id=$1").bind(uuid::Uuid::parse_str(&id)?).fetch_one(app.db()).await?;
        parity_assert!("L:d22c0212b655c962-1", !before.try_get::<uuid::Uuid,_>("id")?.is_nil());
        let (st,_) = app.auth_send_json(reqwest::Method::PUT, &format!("/requests/{id}/resubmit"), &sub, resubmit_body(&s,"Updated justification with more detail.")).await.map(|(st,v)|(st.as_u16(),v))?; parity_assert_eq!("L:fa3808bc83963a79-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{id}")).await?; parity_assert_eq!("L:4aca88e3f23e756c-1", d["request"]["status"], "submitted"); parity_assert_eq!("L:3e3da01b4e25ebbe-1", d["request"]["currentStepOrdinal"], 2); parity_assert_eq!("L:bfedff41a4be3652-1", d["request"]["returnCount"], 2); parity_assert_eq!("L:5c56738bbd2c516c-1", d["request"]["justification"], "Updated justification with more detail.");
        let after = sqlx::query("SELECT id, public_key FROM request_key_material WHERE request_id=$1").bind(uuid::Uuid::parse_str(&id)?).fetch_one(app.db()).await?; parity_assert!("L:2e2acc08b2cfa361-1", !after.try_get::<uuid::Uuid,_>("id")?.is_nil()); parity_assert_eq!("L:fe73042e11b04ed1-1", after.try_get::<uuid::Uuid,_>("id")?, before.try_get::<uuid::Uuid,_>("id")?); parity_assert_eq!("L:0b12014addb28daa-1", after.try_get::<String,_>("public_key")?, before.try_get::<String,_>("public_key")?);
        let re = latest_notification_emails(&app,"request.resubmitted_step2").await?; parity_assert!("L:305e6bd787f74358-1", re.is_some()); parity_assert!("L:be56d3acbdf11247-1", re.unwrap().contains(&s.vendor_approver.email.clone()));
        let (st,_) = app.auth_send_json(reqwest::Method::PUT, &format!("/requests/{id}/resubmit"), &sub, resubmit_body(&s,"Again with enough characters to pass.")).await.map(|(st,_)|(st.as_u16(),()))?; parity_assert_eq!("L:47acde1d43f8ee50-1", st, 400);
        let (st,_) = app.auth_send_json(reqwest::Method::PUT, &format!("/requests/{id}/resubmit"), &sess(&s,"outsider"), resubmit_body(&s,"Nope with enough characters to pass.")).await.map(|(st,_)|(st.as_u16(),()))?; parity_assert_eq!("L:3fd950bcdf2c1e0a-1", st, 403);
        // drive to owner and approve
        approve_all_steps(&app,&s,&id).await?;
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{id}/owner-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:05d0cf9ca5446c5a-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{id}")).await?; parity_assert_eq!("L:bfdaf4df69961232-1", d["request"]["status"], "approved");
        let a1 = latest_notification_emails(&app,"request.owner_approved_agency_l1").await?; parity_assert!("L:be333371fc169dea-1", a1.is_some()); parity_assert!("L:cd1a399497157deb-1", !a1.unwrap().is_empty());
        let a2 = latest_notification_emails(&app,"request.owner_approved_submitter").await?; parity_assert!("L:23fdb0e2efc105f2-1", a2.is_some()); parity_assert!("L:b5236a75acdbbce6-1", a2.unwrap().contains(&s.submitter.email.clone()));
        // backup owner approve / reject / return on fresh requests
        for (dec, expected) in [("approve","approved"),("reject","rejected")] {
            let (_, r) = submit_four_step(&app,&s,&sub,"Backup owner flow justification").await?; let rid = r["request"]["id"].as_str().unwrap().to_string();
            approve_all_steps(&app,&s,&rid).await?;
            let body = if dec=="reject" { json!({"decision":"reject","notes":"no"}) } else { json!({"decision":"approve"}) };
            let (st,_) = post(&app,&sess(&s,"backupOwner"),&format!("/requests/{rid}/owner-decision"),body).await?; parity_assert_eq!("L:62269434b30021a9-1", st, 200);
            let (_, d) = get(&app,&sub,&format!("/requests/{rid}")).await?; parity_assert_eq!("L:72902b7318d885d5-1", d["request"]["status"], expected); parity_assert_eq!("L:b42d96682eeb3895-1", d["request"]["ownerDecisionBy"], s.backup_owner.id.to_string());
            if dec=="reject" { let e=latest_notification_emails(&app,"request.owner_rejected").await?; parity_assert!("L:54d4ebb59f1047d1-1", e.is_some()); parity_assert!("L:379660d3e460e5aa-1", e.unwrap().contains(&s.submitter.email.clone())); }
        }
        let (_, r) = submit_four_step(&app,&s,&sub,"Owner return flow justification").await?; let rid = r["request"]["id"].as_str().unwrap().to_string();
        approve_all_steps(&app,&s,&rid).await?;
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{rid}/owner-decision"),json!({"decision":"return","notes":"rework"})).await?; parity_assert_eq!("L:96d2ad6e91d92823-1", st, 200);
        let e=latest_notification_emails(&app,"request.owner_returned").await?; parity_assert!("L:eb46b4f5b3d7e754-1", e.is_some()); parity_assert!("L:a2f6a0b8c1d61a04-1", e.unwrap().contains(&s.submitter.email.clone()));
        // PA-team notify audit (owner approve) — use the approved request id
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{id}/owner-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:ee9531fbc31fce11-1", st, 400); // already decided
        let (_, dd) = get(&app,&sub,&format!("/requests/{id}")).await?;
        parity_assert_eq!("L:31ff58fbb81bbefa-1", dd["request"]["status"], "approved"); parity_assert_eq!("L:7a958e7cf86b184f-1", dd["request"]["ownerDecisionBy"], s.owner.id.to_string());
        parity_assert_eq!("L:8522e1832ab62a25-1", dd["request"]["currentStepOrdinal"], 0); parity_assert!("L:88a18d216eb56237-1", dd["request"]["requestNumber"].is_string());
        // issue / close
        let (st,_) = post(&app,&sub,&format!("/requests/{id}/issue-credential"),json!({})).await?; parity_assert_eq!("L:b192825653257047-1", st, 403);
        let (_, d) = get(&app,&sub,&format!("/requests/{id}")).await?; parity_assert_eq!("L:a1fcdc15ca6e9305-1", d["request"]["status"], "approved");
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{rid}/issue-credential"),json!({})).await?; parity_assert_eq!("L:879a9759fbee2f6f-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{id}/issue-credential"),json!({})).await?; parity_assert_eq!("L:e69fc55aca3a91f5-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{id}")).await?; parity_assert_eq!("L:a7d0ff1c0d510a2c-1", d["request"]["status"], "credential_issued");
        let ie = latest_notification_emails(&app,"request.credential_issued").await?; parity_assert!("L:9563bc7799077900-1", ie.is_some()); parity_assert!("L:947583ced403bf38-1", ie.unwrap().contains(&s.submitter.email.clone()));
        let (st,_) = post(&app,&sess(&s,"outsider"),&format!("/requests/{id}/close"),json!({})).await?; parity_assert_eq!("L:17f31fa892650e6f-1", st, 403);
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{rid}/close"),json!({})).await?; parity_assert_eq!("L:0eda89944d150d33-1", st, 400);
        let (st,_) = post(&app,&sub,&format!("/requests/{id}/close"),json!({"closingNotes":"done"})).await?; parity_assert_eq!("L:b89c83b683ae2c31-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{id}")).await?; parity_assert_eq!("L:677397dab3a43291-1", d["request"]["status"], "closed");
        let cs = latest_notification_emails(&app,"request.closed_submitter").await?; parity_assert!("L:f0d15e75b27fbca7-1", cs.is_some()); parity_assert!("L:f64c64f973115de5-1", cs.unwrap().contains(&s.submitter.email.clone()));
        let co = latest_notification_emails(&app,"request.closed_system_owner").await?; parity_assert!("L:a4a9653e7c10e2e9-1", co.is_some()); parity_assert!("L:e316de38b81f36d4-1", co.unwrap().contains(&s.owner.email.clone()));
        // admin reset
        let (_, r) = submit_four_step(&app,&s,&sub,"Reset flow justification here").await?; let reset_id = r["request"]["id"].as_str().unwrap().to_string();
        post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{reset_id}/step-decision"),json!({"decision":"approve"})).await?;
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{reset_id}/admin-reset"),json!({})).await?; parity_assert_eq!("L:fbfc9dbdc8cc63b8-1", st, 403);
        let (st,_) = post(&app,&admin_session(&app,&admin).await?,&format!("/requests/{reset_id}/admin-reset"),json!({})).await?; parity_assert_eq!("L:f7b4e1f258dbf33c-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{reset_id}")).await?; parity_assert_eq!("L:4133befd0092113b-1", d["request"]["status"], "returned_to_vendor"); parity_assert_eq!("L:5892517044c5802d-1", d["request"]["returnCount"], 1);
        parity_assert_eq!("L:0306539409f07521-1", d["approvalSteps"][0]["stepStatus"], "submitted"); parity_assert_eq!("L:83b2000a52b90d0e-1", d["approvalSteps"][1]["stepStatus"], "pending");
        let re = latest_notification_emails(&app,"request.admin_reset").await?; parity_assert!("L:5d6fdeae9e859b29-1", re.is_some()); parity_assert!("L:8e8846f88923d391-1", re.unwrap().contains(&s.submitter.email.clone()));
        let (st, d) = get(&app,&sub,"/requests/my-requests").await?; parity_assert_eq!("L:1c267d218918b541-1", st, 200); parity_assert!("L:a7863726eeec3249-1", !d["requests"].as_array().unwrap().is_empty());
        let (_, od) = get(&app,&sess(&s,"owner"),"/requests/my-requests").await?; parity_assert!("L:d90d7bfbf5e16ec2-1", od["requests"].is_array());
        Ok(())
    }).await
}
async fn admin_session(app:&TestApp, admin:&FixtureUser)->Result<String>{ session_of(&login_user(app,admin).await?) }

#[tokio::test]
async fn requests_search_override_topology() -> Result<()> {
    TestApp::run("requests-search-override", |app| async move {
        let (admin, s) = setup(&app).await?; let sub = sess(&s,"submitter");
        let (st,_) = app.get_json("/requests/my-requests").await?; parity_assert_eq!("L:849e1b490273a41d-1", st.as_u16(), 403);
        let (_, rr) = submit_four_step(&app,&s,&sub,"Search flow justification").await?; let id = rr["request"]["id"].as_str().unwrap().to_string();
        let partial = rr["request"]["requestNumber"].as_str().unwrap()[3..10].to_string();
        let (st,d) = get(&app,&sub,&format!("/requests/search?q={partial}")).await?; parity_assert_eq!("L:9ae23298ef65b951-1", st, 200); parity_assert!("L:7d493f3e27718e27-1", d["requests"].as_array().unwrap().iter().any(|r| r["id"]==id.as_str()));
        let (st,d) = get(&app,&sess(&s,"outsider"),&format!("/requests/search?q={partial}")).await?; parity_assert_eq!("L:e469a796b70b6b60-1", st, 200); parity_assert_eq!("L:b089958944d1a58c-1", d["requests"].as_array().unwrap().len(), 0);
        let (st,_) = get(&app,&sub,"/requests/search?q=ab").await?; parity_assert_eq!("L:40a48f464431fa10-1", st, 400);
        let (st,d) = get(&app,&sub,&format!("/requests/search?q={}", rr["request"]["requestNumber"].as_str().unwrap())).await?; parity_assert_eq!("L:83b869515396e657-1", st, 200);
        let found = d["requests"].as_array().unwrap().iter().find(|r| r["id"]==id.as_str()); parity_assert!("L:04ee2aa748eea0b8-1", found.is_some()); parity_assert_eq!("L:a38b7e240fe94fb3-1", found.unwrap()["viewerIsCurrentStepReviewer"], false);
        let (st, d) = get(&app,&sess(&s,"agencyApprover"),&format!("/requests/search?q={}", rr["request"]["requestNumber"].as_str().unwrap())).await?; let found=d["requests"].as_array().unwrap().iter().find(|r| r["id"]==id.as_str()); parity_assert_eq!("L:2ca65254d1dca1c2-1", st, 200); parity_assert!("L:b41c3d224b6a4f92-1", found.is_some()); parity_assert_eq!("L:2827f94d85d6b897-1", found.unwrap()["viewerCanOverride"], true); parity_assert_eq!("L:123cf962a6eb58ec-1", found.unwrap()["viewerIsCurrentStepReviewer"], false);
        let (st, d) = get(&app,&sess(&s,"vendorApprover"),&format!("/requests/search?q={}", rr["request"]["requestNumber"].as_str().unwrap())).await?; let found=d["requests"].as_array().unwrap().iter().find(|r| r["id"]==id.as_str()); parity_assert_eq!("L:aa143df2be44c642-1", st, 200); parity_assert!("L:beefa178b24a27f3-1", found.is_some()); parity_assert_eq!("L:2297841b984b9271-1", found.unwrap()["viewerIsCurrentStepReviewer"], true);
        let (_, d) = get(&app,&sess(&s,"owner"),&format!("/requests/search?q={}", rr["request"]["requestNumber"].as_str().unwrap())).await?; parity_assert_eq!("L:92280aa18b21108c-1", d["requests"].as_array().unwrap().iter().find(|r| r["id"]==id.as_str()).is_none(), true);
        // override approve by agency approver (off-step) + notes rules
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{id}/step-decision"),json!({"decision":"approve"})).await?; parity_assert_eq!("L:8264962120c411a1-1", st, 403); // off-step without override
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{id}/step-decision"),json!({"decision":"reject"})).await?; parity_assert_eq!("L:bc635782303728e7-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{id}/step-decision"),json!({"decision":"approve","override":true})).await?; parity_assert_eq!("L:1f8b690436a21284-1", st, 200);
        let (_, d) = get(&app,&sub,&format!("/requests/{id}")).await?; let step=d["approvalSteps"].as_array().unwrap().iter().find(|x| x["stepOrdinal"]==2).cloned().unwrap_or(json!({}));
        parity_assert_eq!("L:5f1d0adfd5455a4a-1", step["stepStatus"], "approved"); parity_assert_eq!("L:0405d650c9b00325-1", step["decidedViaOverride"], true); parity_assert_eq!("L:3296028b9b652e05-1", step["decidedBy"], s.agency_approver.id.to_string()); parity_assert_eq!("L:5e1fa531d2e6277f-1", d["request"]["currentStepOrdinal"], 3);
        // approver-edit + topology smoke
        let (_, r2) = submit_four_step(&app,&s,&sub,"Topology flow justification").await?; let id2=r2["request"]["id"].as_str().unwrap().to_string();
        let (st,_) = app.auth_send_json(reqwest::Method::PUT,&format!("/requests/{id2}/approver-edit"),&sess(&s,"vendorApprover"),resubmit_body(&s,"Edited by approver for clarity.")).await.map(|(st,_)|(st.as_u16(),()))?; parity_assert_eq!("L:1d781fd4dde02214-1", st, 200);
        let (_, d)=get(&app,&sub,&format!("/requests/{id2}")).await?; parity_assert_eq!("L:1fbf45fac21be230-1", d["request"]["justification"], "Edited by approver for clarity."); parity_assert_eq!("L:051ed3fcc84d5ed4-1", d["request"]["currentStepOrdinal"], 2); parity_assert_eq!("L:b006c39b74cbd466-1", d["request"]["status"], "submitted");
        // additional pinned detail/search contracts
        let (st,d)=get(&app,&sub,"/requests/search?q=").await?; parity_assert_eq!("L:dd46d7e4447edcad-1", st, 200); parity_assert_eq!("L:840987044e326391-1", d["requests"].as_array().unwrap().len(), 0);
        let (st,_) = get(&app,&sub,&format!("/requests/search?q={}", "x".repeat(129))).await?; parity_assert_eq!("L:3285eb5058720c1b-1", st, 400);
        let (st,_) = app.auth_send_json(reqwest::Method::DELETE, &format!("/admin/systems/{}", s.system_id), &admin_session(&app,&admin).await?, json!({})).await.map(|(st,_)|(st.as_u16(),()))?; parity_assert_eq!("L:678c701a37e88df9-1", st, 400);
        let (_, d)=get(&app,&sub,&format!("/requests/{id2}")).await?;
        parity_assert_eq!("L:dcca22ae20e28c80-1", d["approvalSteps"].as_array().unwrap().len(), 5);
        parity_assert_eq!("L:19e24f7ad5b0fe4c-1", d["approvalSteps"][0]["stepOrdinal"], 1);
        parity_assert_eq!("L:8abb023a2316788e-1", d["approvalSteps"][1]["stepOrdinal"], 2);
        parity_assert_eq!("L:17947cf4bbd0f4fa-1", d["approvalSteps"][2]["stepOrdinal"], 3);
        parity_assert_eq!("L:200db018e7034046-1", d["approvalSteps"][3]["stepOrdinal"], 4);
        parity_assert_eq!("L:70b437df2985da97-1", d["approvalSteps"][4]["stepOrdinal"], 5);
        parity_assert_eq!("L:8ccbcd1cd3847a49-1", d["approvalSteps"][1]["stepKind"], "hierarchical");
        parity_assert_eq!("L:4cc0e2692babc580-1", d["request"]["systemId"], s.system_id.to_string());
        parity_assert_eq!("L:410c8e04c6ac3608-1", d["request"]["submittedBy"], s.submitter.id.to_string());
        parity_assert_eq!("L:695714f466c792eb-1", d["credentialItems"].as_array().unwrap().len(), 1);
        parity_assert_eq!("L:9d2c8532ce38bb8d-1", d["credentialItems"][0]["assetId"], s.asset_id.to_string());
        parity_assert_eq!("L:6e96649e8db7b3cd-1", d["request"]["returnCount"], 0);
        parity_assert_eq!("L:41c9ca44e5774ffd-1", d["request"]["status"], "submitted");
        parity_assert_eq!("L:677839f0e2a9cae4-1", d["request"]["currentStepOrdinal"], 2);
        parity_assert_eq!("L:866e52cd0d4ebe3e-1", d["submitter"]["email"], s.submitter.email.as_str());
        parity_assert!("L:e03c763c4be40af4-1", d["request"]["requestNumber"].is_string());
        parity_assert_eq!("L:92a3f58311bbb561-1", d["request"]["viewerIsCurrentStepReviewer"], false);
        parity_assert_eq!("L:88416320c9aabb8a-1", d["request"]["viewerCanOverride"], false);
        let (_, sd)=get(&app,&sub,&format!("/requests/search?q={}", r2["request"]["requestNumber"].as_str().unwrap())).await?;
        let f=sd["requests"].as_array().unwrap().iter().find(|r| r["id"]==id2.as_str()).unwrap();
        parity_assert_eq!("L:f9fb295cc6501305-1", f["requestNumber"], r2["request"]["requestNumber"]);
        parity_assert_eq!("L:c9424b702781fb8b-1", f["status"], "submitted");
        parity_assert_eq!("L:2d6e1fda84e2da98-1", f["currentStepOrdinal"], 2);
        parity_assert_eq!("L:883a9d86e41f74c2-1", f["systemId"], s.system_id.to_string());
        parity_assert_eq!("L:a2e92f0c18412f10-1", f["submittedBy"], s.submitter.id.to_string());
        parity_assert_eq!("L:c9be8afe767f7435-1", f["viewerIsCurrentStepReviewer"], false);
        parity_assert_eq!("L:2259df7e3b5bf284-1", f["viewerCanOverride"], false);
        let (st,_) = post(&app,&sess(&s,"vendorApprover"),&format!("/requests/{id2}/step-decision"),json!({"decision":"return"})).await?; parity_assert_eq!("L:08f12c275811bf6c-1", st, 400);
        let (st,_) = app.auth_send_json(reqwest::Method::PUT,&format!("/requests/{id2}/approver-edit"),&sess(&s,"outsider"),resubmit_body(&s,"Nope with enough characters to pass.")).await.map(|(st,_)|(st.as_u16(),()))?; parity_assert_eq!("L:6308806ace84f972-1", st, 403);
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{id2}/owner-decision"),json!({"decision":"reject"})).await?; parity_assert_eq!("L:a833e947085ddc0a-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{id2}/issue-credential"),json!({})).await?; parity_assert_eq!("L:411de97821c5d2ae-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"agencyApprover"),&format!("/requests/{id2}/close"),json!({})).await?; parity_assert_eq!("L:06df22c50082896c-1", st, 400);
        let (st,_) = post(&app,&sess(&s,"owner"),&format!("/requests/{id2}/admin-reset"),json!({})).await?; parity_assert_eq!("L:3bd06ac26f4069f4-1", st, 403);
        let (_, mr)=get(&app,&sub,"/requests/my-requests").await?; parity_assert!("L:41df0e745b73d48b-1", mr["requests"].as_array().unwrap().iter().any(|r| r["id"]==id2.as_str()));
        // audit unauthenticated
        let (st,_) = app.get_json(&format!("/audit/request/{id}")).await?; parity_assert_eq!("L:2f44d96bd58c043b-1", st.as_u16(), 403);
        Ok(())
    }).await
}
