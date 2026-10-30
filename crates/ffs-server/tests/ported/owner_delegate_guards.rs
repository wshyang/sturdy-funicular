//! PORT-3B — owner delegate / statistics validation guards (legacy owner_delegate_guards.test.tsx, 21 assertions).
use super::fixtures::*;
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn owner_delegate_and_statistics_guards() -> Result<()> {
    TestApp::run("owner-delegate-guards", |app| async move {
        prepare(&app).await?;
        let admin = create_admin(&app, "Admin!2026aa").await?;
        let owner = mk_user(&app, "agency").await?;
        let w = create_wired_system(&app, admin.id, &owner).await?;
        let os = session_of(&login_user(&app, &owner).await?)?;
        let candidate = mk_user(&app, "agency").await?; add_org_membership(&app, w.agency_org_id, candidate.id, admin.id).await?;
        // delegate validation
        let (st, b) = app.auth_post_json(&format!("/owner/systems/{}/delegates", Uuid::now_v7()), &os, json!({"delegateUserId": candidate.id})).await?;
        parity_assert_eq!("L:304385424e9d3021-1", st.as_u16(), 404); parity_assert_eq!("L:9ebb8d0d7fe319f4-1", b["error"], "System not found.");
        let inactive = mk_user(&app, "agency").await?; sqlx::query("UPDATE users SET status='pending_approval' WHERE id=$1").bind(inactive.id).execute(app.db()).await?;
        let (st, b) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": inactive.id})).await?;
        parity_assert_eq!("L:63e45d8b316b4f8b-1", st.as_u16(), 400); parity_assert_eq!("L:44eb7b78ef7b12cd-1", b["error"], "Delegate must be an active user.");
        let backup = mk_user(&app, "agency").await?; sqlx::query("INSERT INTO system_owners (system_id,user_id,kind,created_by) VALUES ($1,$2,'backup',$3)").bind(w.system_id).bind(backup.id).bind(admin.id).execute(app.db()).await?;
        let (st, b) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": backup.id})).await?;
        parity_assert_eq!("L:d44b5729235d9901-1", st.as_u16(), 400); parity_assert_eq!("L:e7c8cb34899894c3-1", b["error"], "This user is already an owner of the system.");
        let (st, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": candidate.id})).await?; parity_assert_eq!("L:d77e1c8441407d4c-1", st.as_u16(), 201);
        let (st, b) = app.auth_post_json(&format!("/owner/systems/{}/delegates", w.system_id), &os, json!({"delegateUserId": candidate.id})).await?;
        parity_assert_eq!("L:c6684e47c9ff3fd8-1", st.as_u16(), 400); parity_assert_eq!("L:3a8d588ddb304de9-1", b["error"], "This user is already a delegate for this system.");
        let (st, b) = app.auth_send_json(reqwest::Method::DELETE, &format!("/owner/systems/{}/delegates/{}", w.system_id, Uuid::now_v7()), &os, json!({})).await?;
        parity_assert_eq!("L:04dc603dde15e1af-1", st.as_u16(), 404); parity_assert_eq!("L:d45189457b1650f0-1", b["error"], "Delegate not found for this system.");
        // statistics validation
        let (st, b) = app.auth_get_json("/owner/statistics", &os).await?; parity_assert_eq!("L:2cf935e46d936b7c-1", st.as_u16(), 400); parity_assert_eq!("L:e82b54d2a6dedcac-1", b["error"], "from and to are required.");
        let (st, b) = app.auth_get_json("/owner/statistics?from=bad&to=bad", &os).await?; parity_assert_eq!("L:47f92929763ba046-1", st.as_u16(), 400); parity_assert_eq!("L:250f916ed7450a62-1", b["error"], "Invalid date range.");
        let now = chrono::Utc::now();
        let (st, b) = app.auth_get_json(&format!("/owner/statistics?from={}&to={}", now.format("%Y-%m-%dT%H:%M:%SZ"), (now - chrono::Duration::days(1)).format("%Y-%m-%dT%H:%M:%SZ")), &os).await?; parity_assert_eq!("L:558be1fd216c52de-1", st.as_u16(), 400); parity_assert_eq!("L:f4082d907ea70643-1", b["error"], "Invalid date range.");
        let nobody = mk_user(&app, "agency").await?; let ns = session_of(&login_user(&app, &nobody).await?)?;
        let (st, b) = app.auth_get_json(&format!("/owner/statistics?from={}&to={}", (now - chrono::Duration::days(1)).format("%Y-%m-%dT%H:%M:%SZ"), now.format("%Y-%m-%dT%H:%M:%SZ")), &ns).await?;
        parity_assert_eq!("L:eff08257fd89ebbe-1", st.as_u16(), 200); parity_assert_eq!("L:46a47930b360c00b-1", b["mode"], "by_system"); parity_assert_eq!("L:606216603953dfbb-1", b["systemId"], serde_json::Value::Null); parity_assert_eq!("L:d7886b1cdf887f11-1", b["data"].as_array().unwrap().len(), 0);
        Ok(())
    }).await
}
