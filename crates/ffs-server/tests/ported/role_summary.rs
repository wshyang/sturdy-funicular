//! Port of test/backend/deno/role_summary.test.tsx (18 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

async fn summary_as(app: &TestApp, user: &fixtures::FixtureUser) -> Result<Value> {
    let login = fixtures::login_user(app, user).await?;
    let session = fixtures::session_of(&login)?;
    let (status, body) = app.auth_get_json("/me/role-summary", &session).await?;
    parity_assert_eq!("L:826e7ffe836b745b-1", status, reqwest::StatusCode::OK);
    Ok(body)
}

async fn park_request(
    app: &TestApp, system_id: Uuid, submitter: Uuid, vendor_cluster: Uuid,
    status: &str, ordinal: i16, required_cluster: Uuid, required_level: i16, required_type: &str,
) -> Result<Uuid> {
    let id = Uuid::now_v7();
    let start = chrono::Utc::now() + chrono::Duration::hours(1);
    let end = chrono::Utc::now() + chrono::Duration::hours(2);
    sqlx::query(
        r#"INSERT INTO breakglass_requests
           (id, request_number, system_id, submitted_by, vendor_cluster_id, justification, sr_number,
            activity_start_at, activity_end_at, status, current_step_ordinal)
           VALUES ($1,$2,$3,$4,$5,'role-summary fixture',$6,$7,$8,$9::request_status,$10)"#,
    )
    .bind(id).bind(format!("BG-{}", &id.simple().to_string()[..12])).bind(system_id).bind(submitter)
    .bind(vendor_cluster).bind(format!("SR-{}", &id.simple().to_string()[..8]))
    .bind(start).bind(end).bind(status).bind(ordinal)
    .execute(app.db()).await?;
    if ordinal > 0 {
        sqlx::query(
            r#"INSERT INTO request_approval_steps
               (id, request_id, step_ordinal, required_cluster_id, required_team_type, required_level, step_kind, step_status)
               VALUES ($1,$2,$3,$4,$5::cluster_type,$6,'hierarchical','pending')"#,
        )
        .bind(Uuid::now_v7()).bind(id).bind(ordinal).bind(required_cluster).bind(required_type).bind(required_level)
        .execute(app.db()).await?;
    }
    Ok(id)
}

#[tokio::test]
async fn role_summary_applicable_roles_pending_counts_and_ordering() -> Result<()> {
    TestApp::run("role_summary_applicable_roles", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleSumAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "RoleSumOwner", &fixtures::unique_email("rolesumowner"), "RoleSumOwner!2026", "agency", true).await?;
        let owner_system = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let reviewer = fixtures::create_active_user(&app, "RoleSumReviewer", &fixtures::unique_email("rolesumreviewer"), "RoleSumReviewer!2026", "vendor", true).await?;
        let review_system = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        fixtures::add_serving_member(&app, review_system.vendor_l2, &reviewer, admin.id).await?;
        park_request(&app, review_system.system_id, admin.id, review_system.vendor_cluster_id, "submitted", 2, review_system.vendor_cluster_id, 2, "vendor").await?;
        let delegate = fixtures::create_active_user(&app, "RoleSumDelegate", &fixtures::unique_email("rolesumdelegate"), "RoleSumDelegate!2026", "vendor", true).await?;
        let owner_row = sqlx::query("SELECT user_id FROM system_owners WHERE system_id=$1 AND kind='primary'")
            .bind(owner_system.system_id).fetch_one(app.db()).await?;
        let owner_user_id: Uuid = owner_row.try_get("user_id")?;
        sqlx::query("INSERT INTO system_delegates (id, system_id, owner_id, delegate_user_id) VALUES ($1,$2,$3,$4)")
            .bind(Uuid::now_v7()).bind(owner_system.system_id).bind(owner_user_id).bind(delegate.id)
            .execute(app.db()).await?;
        park_request(&app, owner_system.system_id, admin.id, owner_system.vendor_cluster_id, "under_review", 0, owner_system.vendor_cluster_id, 1, "vendor").await?;

        let body = summary_as(&app, &admin).await?;
        let roles = body["roles"].as_array().unwrap();
        parity_assert!("L:6ed9909240b89d18-1", roles.iter().any(|r| r["key"] == "admin"));
        parity_assert_eq!("L:423e774129353a7f-1", roles.len(), 1, "a pure admin has only the admin role");

        let body = summary_as(&app, &owner).await?;
        let owner_role = fixtures::role_by_key(&body, "owner");
        parity_assert!("L:dd46a1568005f11a-1", owner_role.is_some());
        parity_assert_eq!("L:9e2dc248392661d8-1", owner_role.unwrap()["pending"], json!(1), "the parked terminal request counts as a pending owner action");

        let body = summary_as(&app, &reviewer).await?;
        let eng = fixtures::role_by_key(&body, "engineer");
        parity_assert!("L:d71d49bc08b25530-1", eng.is_some());
        parity_assert_eq!("L:356a96b4917b4525-1", eng.unwrap()["pending"], json!(1), "the step request counts as a pending engineer action");
        parity_assert_eq!("L:b51a7ca941a96b60-1", eng.unwrap()["label"], json!("Vendor Engineer"));

        let body = summary_as(&app, &delegate).await?;
        let del = fixtures::role_by_key(&body, "delegate");
        parity_assert!("L:a1d09327883417be-1", del.is_some());
        parity_assert_eq!("L:73f488c319b63538-1", del.unwrap()["pending"], json!(1));

        let admin2 = fixtures::create_admin(&app, "RoleSumAdmin2!2026").await?;
        let login2 = fixtures::login_user(&app, &admin2).await?;
        let session2 = fixtures::session_of(&login2)?;
        let (status, body) = app.auth_get_json("/me/role-summary", &session2).await?;
        parity_assert_eq!("L:3bedd7ed0ddc57fe-1", status, reqwest::StatusCode::OK);
        let roles = body["roles"].as_array().unwrap();
        parity_assert_eq!("L:4096e5bad99c52f4-1", roles.len(), 1);
        parity_assert_eq!("L:4e60450906ebbb63-1", roles[0]["key"], json!("admin"));

        let nobody = fixtures::create_active_user(&app, "RoleSumNobody", &fixtures::unique_email("rolesumnobody"), "RoleSumNobody!2026", "agency", true).await?;
        let body = summary_as(&app, &nobody).await?;
        parity_assert_eq!("L:8cd36c88e86cf213-1", body["roles"], json!([]));
        Ok(())
    }).await
}

#[tokio::test]
async fn role_summary_admin_reviewer_counts_only_own_current_step() -> Result<()> {
    TestApp::run("role_summary_admin_reviewer", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "RoleSumAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "RoleSumOwner2", &fixtures::unique_email("rolesumowner2"), "RoleSumOwner2!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let reviewer = fixtures::create_active_user(&app, "RoleSumReviewer2", &fixtures::unique_email("rolesumreviewer2"), "RoleSumReviewer2!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, wired.vendor_l2, &reviewer, admin.id).await?;
        let sea = sea_orm::Database::connect(app.db_url()).await?;
        ffs_server::db::admin_roles::grant_admin_role(&sea, reviewer.id, "full_admin", admin.id, Some("Test setup: admin+reviewer combination"), None).await?;
        park_request(&app, wired.system_id, admin.id, wired.vendor_cluster_id, "submitted", 2, wired.vendor_cluster_id, 2, "vendor").await?;
        park_request(&app, wired.system_id, admin.id, wired.vendor_cluster_id, "under_review", 3, wired.agency_cluster_id, 1, "agency").await?;

        let body = summary_as(&app, &reviewer).await?;
        parity_assert!("L:a1a1cee0f68da38a-1", fixtures::role_by_key(&body, "admin").is_some(), "the full_admin grant surfaces the admin role");
        let eng = fixtures::role_by_key(&body, "engineer");
        parity_assert!("L:7dd2dfe119a08600-1", eng.is_some(), "team membership surfaces the engineer role alongside the grant");
        parity_assert_eq!("L:ef000e4d9c612025-1", eng.unwrap()["label"], json!("Vendor Engineer"));
        parity_assert_eq!("L:e50ee1ee7e9b3b97-1", eng.unwrap()["pending"], json!(1), "only requests at THIS viewer's own current step count (pre-fix: 2 — addendum-096)");
        Ok(())
    }).await
}
