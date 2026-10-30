//! PORT-3B — first-to-act-wins concurrency (legacy concurrency.test.tsx, 14 assertions).
use super::fixtures::*;
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

fn tally(statuses: [u16; 2]) -> (usize, usize) {
    (statuses.iter().filter(|s| (200u16..300u16).contains(*s)).count(), statuses.iter().filter(|s| **s >= 400).count())
}

#[tokio::test]
async fn first_to_act_wins() -> Result<()> {
    TestApp::run("concurrency", |app| async move {
        prepare(&app).await?;
        let admin = create_admin(&app, "Admin!2026aa").await?;
        let owner = mk_user(&app, "agency").await?;
        let w = create_wired_system(&app, admin.id, &owner).await?;
        let submitter = mk_user(&app, "vendor").await?; add_serving_member(&app, w.vendor_l1, &submitter, admin.id).await?;
        let v1 = mk_user(&app, "vendor").await?; add_serving_member(&app, w.vendor_l2, &v1, admin.id).await?;
        let v2 = mk_user(&app, "vendor").await?; add_serving_member(&app, w.vendor_l2, &v2, admin.id).await?;
        let a1 = mk_user(&app, "agency").await?; add_member(&app, w.agency_l1, &a1, admin.id, "member").await?;
        let a2 = mk_user(&app, "agency").await?; add_member(&app, w.agency_l1, &a2, admin.id, "member").await?;
        let ss = session_of(&login_user(&app, &submitter).await?)?;
        let s1 = session_of(&login_user(&app, &v1).await?)?; let s2 = session_of(&login_user(&app, &v2).await?)?;
        let sa1 = session_of(&login_user(&app, &a1).await?)?; let sa2 = session_of(&login_user(&app, &a2).await?)?;
        let backup_owner = mk_user(&app, "agency").await?;
        sqlx::query("INSERT INTO system_owners (system_id,user_id,kind,created_by) VALUES ($1,$2,'backup',$3)").bind(w.system_id).bind(backup_owner.id).bind(admin.id).execute(app.db()).await?;
        let so1 = session_of(&login_user(&app, &owner).await?)?; let so2 = session_of(&login_user(&app, &backup_owner).await?)?;
        let asset = create_asset(&app, w.system_id, "cx-host").await?;
        let (_, r) = submit_request(&app, &ss, w.system_id, asset, "SR-CX").await?;
        let id = r["request"]["id"].as_str().unwrap().to_string(); let uid = Uuid::parse_str(&id)?;
        // step race
        let step_path = format!("/requests/{id}/step-decision");
        let (r1, r2) = tokio::join!(
            app.auth_post_json(&step_path, &s1, json!({"decision":"approve","notes":"v1"})),
            app.auth_post_json(&step_path, &s2, json!({"decision":"approve","notes":"v2"}))
        );
        let t = tally([r1?.0.as_u16(), r2?.0.as_u16()]);
        parity_assert_eq!("L:fca7fb267065e07b-1", t.0, 1); parity_assert_eq!("L:358aa402c1f1f785-1", t.1, 1);
        let row = sqlx::query("SELECT current_step_ordinal, status::text AS status FROM breakglass_requests WHERE id=$1").bind(uid).fetch_one(app.db()).await?;
        parity_assert_eq!("L:91e0dab113fa9034-1", row.try_get::<i16,_>("current_step_ordinal")?, 3); parity_assert_eq!("L:338adfce3352afb7-1", row.try_get::<String,_>("status")?, "under_review");
        let n: i32 = sqlx::query_scalar("SELECT count(*)::int FROM audit_log WHERE action IN ('request.step_approved','request.step_override_approved') AND details->>'requestId'=$1 AND details->>'stepOrdinal'='2'").bind(id.clone()).fetch_one(app.db()).await?;
        parity_assert_eq!("L:bc7eeb7a3df5ae4a-1", n, 1);
        // advance to owner, then owner race
        app.auth_post_json(&format!("/requests/{id}/step-decision"), &sa1, json!({"decision":"approve"})).await?;
        let owner_path = format!("/requests/{id}/owner-decision");
        let (r1, r2) = tokio::join!(
            app.auth_post_json(&owner_path, &so1, json!({"decision":"approve"})),
            app.auth_post_json(&owner_path, &so2, json!({"decision":"approve"}))
        );
        let t = tally([r1?.0.as_u16(), r2?.0.as_u16()]); parity_assert_eq!("L:2998e4e84be187fa-1", t.0, 1); parity_assert_eq!("L:601ed7ceefe6ee8c-1", t.1, 1);
        let st: String = sqlx::query_scalar("SELECT status::text FROM breakglass_requests WHERE id=$1").bind(uid).fetch_one(app.db()).await?; parity_assert_eq!("L:e1c8da0d06b427c8-1", st, "approved");
        // issue race
        let issue_path = format!("/requests/{id}/issue-credential");
        let (r1, r2) = tokio::join!(
            app.auth_post_json(&issue_path, &sa1, json!({})),
            app.auth_post_json(&issue_path, &sa2, json!({}))
        );
        let t = tally([r1?.0.as_u16(), r2?.0.as_u16()]); parity_assert_eq!("L:2be1b7d9a9f90556-1", t.0, 1); parity_assert_eq!("L:29bed4cf38417abb-1", t.1, 1);
        let st: String = sqlx::query_scalar("SELECT status::text FROM breakglass_requests WHERE id=$1").bind(uid).fetch_one(app.db()).await?; parity_assert_eq!("L:90996a87a04c1d7c-1", st, "credential_issued");
        // close race
        let close_path = format!("/requests/{id}/close");
        let (r1, r2) = tokio::join!(
            app.auth_post_json(&close_path, &sa1, json!({"closingNotes":"done"})),
            app.auth_post_json(&close_path, &sa2, json!({"closingNotes":"done"}))
        );
        let t = tally([r1?.0.as_u16(), r2?.0.as_u16()]); parity_assert_eq!("L:8321a45791c41c9b-1", t.0, 1); parity_assert_eq!("L:422df2474550f89f-1", t.1, 1);
        let st: String = sqlx::query_scalar("SELECT status::text FROM breakglass_requests WHERE id=$1").bind(uid).fetch_one(app.db()).await?; parity_assert_eq!("L:31e90c3e7728efe0-1", st, "closed");
        Ok(())
    }).await
}
