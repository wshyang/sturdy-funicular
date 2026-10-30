//! Port of test/backend/deno/admin_systems_update_delete.test.tsx (59 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn admin_systems_update_validation_and_delete_lifecycle() -> Result<()> {
    TestApp::run("admin_systems_update_delete", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "SystemsCrud!2026").await?;
        let login = fixtures::login_user(&app, &admin).await?;
        parity_assert!("L:0de2896afe51f182-1", login.get("session").is_some());
        let auth = fixtures::session_of(&login)?;
        let owner = fixtures::create_active_user(&app, "Agency owner", &fixtures::unique_email("agencyowner"), "SystemsCrud!2026", "agency", true).await?;
        let backup = fixtures::create_active_user(&app, "Agency backup", &fixtures::unique_email("agencybackup"), "SystemsCrud!2026", "agency", true).await?;
        let other = fixtures::create_active_user(&app, "Agency other", &fixtures::unique_email("agencyother"), "SystemsCrud!2026", "agency", true).await?;
        let vendor_user = fixtures::create_active_user(&app, "Vendor Person", &fixtures::unique_email("vendorperson"), "SystemsCrud!2026", "vendor", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let system = wired.system_id;
        let path = format!("/admin/systems/{system}");
        let ghost = "00000000-0000-7000-8000-0000000000ff";

        let (s1,_) = app.json_with_headers(Method::PUT, &path, &[], Some(json!({"name":"Nope"}))).await?;
        parity_assert!("L:8e7ac28039137958-1", s1 == reqwest::StatusCode::UNAUTHORIZED || s1 == reqwest::StatusCode::FORBIDDEN);
        let (s2,_) = app.json_with_headers(Method::DELETE, &path, &[], None).await?;
        parity_assert!("L:f18656be9fe5fb1e-1", s2 == reqwest::StatusCode::UNAUTHORIZED || s2 == reqwest::StatusCode::FORBIDDEN);
        let (status,_) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{ghost}"), &auth, json!({"name":"Ghost"})).await?;
        parity_assert_eq!("L:1da2a9726b84d3cf-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status,_) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{ghost}"), &auth, json!({})).await?;
        parity_assert_eq!("L:28dbae2a916e7ddc-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({})).await?;
        parity_assert_eq!("L:4becf43bcbba8930-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:58671bf97f415c9b-1", body["error"], json!("No fields to update."));

        let new_name = fixtures::unique_name("Renamed System");
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"name":new_name})).await?;
        parity_assert_eq!("L:56ab1dcdef87214b-1", status, reqwest::StatusCode::OK);
        let stored: String = sqlx::query_scalar("SELECT name FROM systems WHERE id=$1").bind(system).fetch_one(app.db()).await?;
        parity_assert_eq!("L:ef829a56794486c2-1", stored, new_name);
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"name":"   Padded Name   "})).await?;
        parity_assert_eq!("L:f96622989b53feaf-1", status, reqwest::StatusCode::OK);
        let stored: String = sqlx::query_scalar("SELECT name FROM systems WHERE id=$1").bind(system).fetch_one(app.db()).await?;
        parity_assert_eq!("L:59c2024be4ca3363-1", stored, "Padded Name");
        let mut blank_statuses = Vec::new();
        for name in ["", "   "] {
            let (st,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"name":name})).await?;
            blank_statuses.push(st);
        }
        parity_assert_eq!("L:20578ba21ec3b60f-1", blank_statuses, vec![reqwest::StatusCode::BAD_REQUEST, reqwest::StatusCode::BAD_REQUEST]);
        let rival = fixtures::create_wired_system(&app, admin.id, &other).await?;
        let rival_name: String = sqlx::query_scalar("SELECT name FROM systems WHERE id=$1").bind(rival.system_id).fetch_one(app.db()).await?;
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"name":rival_name})).await?;
        parity_assert_eq!("L:7422e585d6b8f4ad-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:9df906eb3b5c93d7-1", body["error"], json!("A system with this name already exists."));
        let current: String = sqlx::query_scalar("SELECT name FROM systems WHERE id=$1").bind(system).fetch_one(app.db()).await?;
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"name":current})).await?;
        parity_assert_eq!("L:d4262c4bd0a9bdd3-1", status, reqwest::StatusCode::OK);
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"description":"x".repeat(501)})).await?;
        parity_assert_eq!("L:804a5f0355abc076-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"awsRoleArnNote":"x".repeat(501)})).await?;
        parity_assert_eq!("L:bf3822bcca51304a-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"description":"temporary"})).await?;
        parity_assert_eq!("L:d94f1792bdb337f9-1", status, reqwest::StatusCode::OK);
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"description":""})).await?;
        parity_assert_eq!("L:e71d98eba59d7875-1", status, reqwest::StatusCode::OK);
        let desc: Option<String> = sqlx::query_scalar("SELECT description FROM systems WHERE id=$1").bind(system).fetch_one(app.db()).await?;
        parity_assert_eq!("L:0332834f2ead82e6-1", desc, None);

        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"backupOwnerId":backup.id})).await?;
        parity_assert_eq!("L:9562776d0c5e6577-1", status, reqwest::StatusCode::OK);
        let n: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM system_owners WHERE system_id=$1 AND kind='backup' AND expires_after IS NULL").bind(system).fetch_one(app.db()).await?;
        parity_assert_eq!("L:4c935ac07e5a3dbc-1", n, 1);
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"backupOwnerId":null})).await?;
        parity_assert_eq!("L:9c048f857921dc58-1", status, reqwest::StatusCode::OK);
        let n: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM system_owners WHERE system_id=$1 AND kind='backup' AND expires_after IS NULL").bind(system).fetch_one(app.db()).await?;
        parity_assert_eq!("L:cbfaae7dbf317544-1", n, 0);

        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"primaryOwnerId":owner.id,"backupOwnerId":owner.id})).await?;
        parity_assert_eq!("L:2bb636d9ec93cfba-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:a17605e767dbefb2-1", body["error"], json!("Backup owner cannot be the same person as the primary owner."));
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"backupOwnerId":owner.id})).await?;
        parity_assert_eq!("L:165a02044eaf02d7-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:23af866b3ad48cba-1", body["error"], json!("Backup owner cannot be the same person as the primary owner."));
        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"backupOwnerId":backup.id})).await?;
        parity_assert_eq!("L:3f53384363abd7d3-1", status, reqwest::StatusCode::OK);
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"primaryOwnerId":backup.id})).await?;
        parity_assert_eq!("L:f794a5aeff175169-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:f9215b2f36ac8cee-1", body["error"], json!("Backup owner cannot be the same person as the primary owner."));
        app.auth_send_json(Method::PUT, &path, &auth, json!({"backupOwnerId":null})).await?;

        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"primaryOwnerId":vendor_user.id})).await?;
        parity_assert_eq!("L:25e4bff8907a6abb-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:ebb3b2edbbd98dd6-1", body["error"], json!("Primary owner must have agency affiliation."));
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"backupOwnerId":vendor_user.id})).await?;
        parity_assert_eq!("L:95cc43489f1521b1-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:748a15094c9e717a-1", body["error"], json!("Backup owner must have agency affiliation."));
        let missing_id = "00000000-0000-7000-8000-0000000000fe";
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"primaryOwnerId":missing_id})).await?;
        parity_assert_eq!("L:cf78ea007e866576-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:480f75750860015a-1", body["error"], json!("Primary owner must be an active user."));
        let dormant = fixtures::create_active_user(&app,"Agency dormant",&fixtures::unique_email("agencydormant"),"SystemsCrud!2026","agency",true).await?;
        sqlx::query("UPDATE users SET status='tombstoned' WHERE id=$1").bind(dormant.id).execute(app.db()).await?;
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"primaryOwnerId":dormant.id})).await?;
        parity_assert_eq!("L:8d5a47a3ba8d0578-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:9186bdda090afd00-1", body["error"], json!("Primary owner must be an active user."));
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"backupOwnerId":dormant.id})).await?;
        parity_assert_eq!("L:b7ee42c8a3bb0fd9-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:c8a7021c83dc7365-1", body["error"], json!("Backup owner must be an active user."));

        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"primaryOwnerId":other.id})).await?;
        parity_assert_eq!("L:e8d081ed1c85fbcd-1", status, reqwest::StatusCode::OK);
        let live: Vec<Uuid> = sqlx::query_scalar("SELECT user_id FROM system_owners WHERE system_id=$1 AND kind='primary' AND expires_after IS NULL").bind(system).fetch_all(app.db()).await?;
        parity_assert_eq!("L:7d5f07a059f1acc7-1", live.len(), 1);
        parity_assert_eq!("L:e3824f462f2b40f4-1", live[0], other.id);
        let expired: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM system_owners WHERE system_id=$1 AND kind='primary' AND expires_after IS NOT NULL").bind(system).fetch_one(app.db()).await?;
        parity_assert!("L:04f8dd3c63cbab92-1", expired >= 1);

        let (status,_) = app.auth_send_json(Method::PUT, &path, &auth, json!({"agencyClusterId":"00000000-0000-7000-8000-0000000000fd"})).await?;
        parity_assert_eq!("L:6494abe643e31e02-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status,body) = app.auth_send_json(Method::PUT, &path, &auth, json!({"workflowDefinition":[{"step":1,"teamId":"00000000-0000-7000-8000-0000000000fc"}]})).await?;
        parity_assert_eq!("L:2d707c11eff11d80-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert!("L:e7864b37ba277cc7-1", body["error"].as_str().unwrap_or("").starts_with("Invalid workflow"));

        let doomed_owner = fixtures::create_active_user(&app,"Agency doomed",&fixtures::unique_email("agencydoomed"),"SystemsCrud!2026","agency",true).await?;
        let doomed = fixtures::create_wired_system(&app, admin.id, &doomed_owner).await?;
        let before: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM team_system_mappings WHERE system_id=$1 AND expires_after IS NULL").bind(doomed.system_id).fetch_one(app.db()).await?;
        parity_assert!("L:1419b875a8f54ea1-1", before > 0);
        let (status,_) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}",doomed.system_id), &auth, json!({})).await?;
        parity_assert_eq!("L:ffd5d3d28d90ecfc-1", status, reqwest::StatusCode::OK);
        let row_count: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM systems WHERE id=$1").bind(doomed.system_id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:7f055a920fe33116-1", row_count, 1);
        let expired_flag: bool = sqlx::query_scalar("SELECT expires_after IS NOT NULL FROM systems WHERE id=$1").bind(doomed.system_id).fetch_one(app.db()).await?;
        parity_assert!("L:0a573dc03a323459-1", expired_flag);
        let mappings_left: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM team_system_mappings WHERE system_id=$1 AND expires_after IS NULL").bind(doomed.system_id).fetch_one(app.db()).await?;
        let owners_left: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM system_owners WHERE system_id=$1 AND expires_after IS NULL").bind(doomed.system_id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:dab230ee738d76f4-1", (mappings_left, owners_left), (0, 0));

        let gone = fixtures::create_active_user(&app,"Agency gone",&fixtures::unique_email("agencygone"),"SystemsCrud!2026","agency",true).await?;
        let target = fixtures::create_wired_system(&app, admin.id, &gone).await?;
        let (status,_) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}",target.system_id), &auth, json!({})).await?;
        parity_assert_eq!("L:ac8d7d40677a0155-1", status, reqwest::StatusCode::OK);
        let (status,_) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}",target.system_id), &auth, json!({"name":"after delete"})).await?;
        parity_assert_eq!("L:1f9bbb527574257b-1", status, reqwest::StatusCode::NOT_FOUND);
        let (second,_) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}",target.system_id), &auth, json!({})).await?;
        parity_assert_eq!("L:f290696f662b0081-1", second, reqwest::StatusCode::NOT_FOUND);

        let busy_owner = fixtures::create_active_user(&app,"Agency busy",&fixtures::unique_email("agencybusy"),"SystemsCrud!2026","agency",true).await?;
        let busy = fixtures::create_wired_system(&app, admin.id, &busy_owner).await?;
        sqlx::query(r#"INSERT INTO breakglass_requests (id,request_number,system_id,submitted_by,vendor_cluster_id,justification,sr_number,activity_start_at,activity_end_at,status,return_count,created_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,'open work','SR-OPEN',now(),now()+interval '1 hour','submitted',0,now(),now())"#)
            .bind(Uuid::now_v7()).bind(format!("REQ-OPEN-{}",&Uuid::now_v7().simple().to_string()[..8])).bind(busy.system_id).bind(busy_owner.id).bind(busy.vendor_cluster_id)
            .execute(app.db()).await?;
        let (status,body) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}",busy.system_id), &auth, json!({})).await?;
        parity_assert_eq!("L:9a7e752b7c8247b9-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert!("L:4469cd5dedce37a3-1", body["error"].as_str().unwrap_or("").contains("open break-glass requests"));
        let still_live: bool = sqlx::query_scalar("SELECT expires_after IS NULL FROM systems WHERE id=$1").bind(busy.system_id).fetch_one(app.db()).await?;
        parity_assert!("L:3ae3be661b4d2123-1", still_live);
        Ok(())
    }).await
}
