//! Port of test/backend/deno/admin_users.test.tsx (84 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

async fn pending_user(app: &TestApp, label: &str) -> Result<fixtures::FixtureUser> {
    let email = fixtures::unique_email(label);
    let password = "PendingPass!2026";
    let salt = ffs_server::auth::password::generate_salt();
    let hash = ffs_server::auth::password::hash_password(password, &salt)?;
    let id = Uuid::now_v7();
    sqlx::query("INSERT INTO users (id, full_name, email, password_hash, password_salt, affiliation, status, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,'vendor','pending_approval',now(),now())")
        .bind(id).bind(label).bind(&email).bind(hash).bind(salt).execute(app.db()).await?;
    Ok(fixtures::FixtureUser { id, email, password: password.into() })
}
async fn user_status(app: &TestApp, id: Uuid) -> Result<String> {
    Ok(sqlx::query_scalar("SELECT status::text FROM users WHERE id=$1").bind(id).fetch_one(app.db()).await?)
}
async fn user_aff(app: &TestApp, id: Uuid) -> Result<String> {
    Ok(sqlx::query_scalar("SELECT affiliation::text FROM users WHERE id=$1").bind(id).fetch_one(app.db()).await?)
}

#[tokio::test]
async fn admin_users_lifecycle_and_scoped_affiliation() -> Result<()> {
    TestApp::run_with_env("admin_users", &[("TOTP_LOGIN_ENFORCEMENT_ENABLED","false")], |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "UserAdmin!2026").await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let vendor = fixtures::create_active_user(&app, "UsersVendor", &fixtures::unique_email("usvendor"), "VendorPass!2026", "vendor", true).await?;
        let vs = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;
        let target = pending_user(&app, "Pending Target").await?;
        let (status, _) = app.auth_get_json("/admin/users/pending", &vs).await?;
        parity_assert_eq!("L:c0f465aab785c9ab-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_get_json("/admin/users", &vs).await?;
        parity_assert_eq!("L:fd85fad3594901a5-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.get_json("/admin/users/pending").await?;
        parity_assert_eq!("L:cdbb8eb0dfaf0b78-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.get_json("/admin/users").await?;
        parity_assert_eq!("L:448985b292f6af0f-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/approve", target.id), &vs, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:534e196f465ed320-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/reject", target.id), &vs, json!({})).await?;
        parity_assert_eq!("L:bd4baebb75a6e532-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", target.id), &vs, json!({})).await?;
        parity_assert_eq!("L:a4f82587827f7259-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/untombstone", target.id), &vs, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:0c455fe121f3b2f8-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", target.id), &vs, json!({"affiliation":"agency"})).await?;
        parity_assert_eq!("L:6623d7135f15fa49-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:b84527d1549e9223-1", user_status(&app, target.id).await?, "pending_approval");
        let (status, data) = app.auth_get_json("/admin/users/pending", &session).await?;
        parity_assert_eq!("L:ae2ca927ab505f08-1", status, reqwest::StatusCode::OK);
        let found = data["users"].as_array().unwrap().iter().find(|u| u["id"] == json!(target.id.to_string()));
        parity_assert!("L:6210495b8cda2369-1", found.is_some());
        parity_assert_eq!("L:a9e108c7101b114a-1", found.unwrap().get("passwordHash").is_none(), true);
        parity_assert_eq!("L:03fcba62ff588239-1", found.unwrap().get("passwordSalt").is_none(), true);
        parity_assert_eq!("L:e69309a9c8dd2817-1", found.unwrap()["status"], json!("pending_approval"));
        let (status, data) = app.auth_get_json("/admin/users", &session).await?;
        parity_assert_eq!("L:d469c6009c439d28-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:d5d57d27ebbb9354-1", data["users"].is_array(), true);
        parity_assert_eq!("L:56c5a70fb5397dd9-1", data["users"].as_array().unwrap().len() > 0, true);
        // Protected admin immutability + self-tombstone.
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", admin.id), &session, json!({})).await?;
        parity_assert_eq!("L:77d3fb26c23bff51-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", admin.id), &session, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:434f386a2db8c110-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:68fec6eeb082f929-1", user_status(&app, admin.id).await?, "active");
        parity_assert_eq!("L:d5c2c3f3e79868b5-1", user_aff(&app, admin.id).await?, "agency");
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/approve", target.id), &session, json!({})).await?;
        parity_assert_eq!("L:0555ad77c01d56d4-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/approve", target.id), &session, json!({"affiliation":"invalid"})).await?;
        parity_assert_eq!("L:479a822065099eb4-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/approve", Uuid::now_v7()), &session, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:a97f3a701d1a13c7-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/approve", target.id), &session, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:12cdc5d31f9ed1b2-1", status, reqwest::StatusCode::OK);
        let login = fixtures::login_as(&app, &target.email, "PendingPass!2026").await?;
        parity_assert!("L:976085ce0f823ebf-1", login.get("session").is_some() || login.get("twofaRequired").is_some());
        let emails = fixtures::latest_notification_emails(&app, "user.approved").await?;
        parity_assert!("L:6139bbacbafe760c-1", emails.is_some());
        parity_assert_eq!("L:e3aaede75b019303-1", emails.unwrap(), vec![target.email.clone()]);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/approve", target.id), &session, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:6e6d5d27719eee72-1", status, reqwest::StatusCode::BAD_REQUEST);
        // Reject.
        let rej = pending_user(&app, "Reject Me").await?;
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/reject", rej.id), &session, json!({"reason":"no"})).await?;
        parity_assert_eq!("L:bb5dc0f09f55a7ea-1", status, reqwest::StatusCode::OK);
        let login = app.post_json("/auth/login", json!({"email":rej.email,"password":"PendingPass!2026"})).await?;
        parity_assert_eq!("L:844c6ef9f1884599-1", login.0, reqwest::StatusCode::UNAUTHORIZED);
        let emails = fixtures::latest_notification_emails(&app, "user.rejected").await?;
        parity_assert!("L:570a63bb5c54519e-1", emails.is_some());
        parity_assert_eq!("L:e4c9ae933cfa4800-1", emails.unwrap(), vec![rej.email.clone()]);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/reject", rej.id), &session, json!({})).await?;
        parity_assert_eq!("L:4dc68bf8bd4db6fe-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", rej.id), &session, json!({})).await?;
        parity_assert_eq!("L:6c3b2dcbe86e9cfa-1", status, reqwest::StatusCode::BAD_REQUEST);
        // Tombstone another admin.
        let admin2 = fixtures::create_admin(&app, "SecondAdmin!2026").await?;
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", admin2.id), &session, json!({})).await?;
        parity_assert_eq!("L:bb1507d3cacf19f7-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:501e4b41fa43d63b-1", user_status(&app, admin2.id).await?, "tombstoned");
        let emails = fixtures::latest_notification_emails(&app, "user.tombstoned").await?;
        parity_assert!("L:fe8e5a67ef8a1b39-1", emails.is_some());
        parity_assert_eq!("L:9944207850341c04-1", emails.unwrap(), vec![admin2.email.clone()]);
        // Tombstone vendor with membership cascade + session invalidation.
        let org = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
        let team = fixtures::create_team_in_cluster(&app, fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?, 1, admin.id).await?;
        let v2 = fixtures::create_active_user(&app, "Cascade Vendor", &fixtures::unique_email("cascade"), "VendorPass!2026", "vendor", true).await?;
        fixtures::add_org_membership(&app, org, v2.id, admin.id).await?;
        fixtures::add_member(&app, team, &v2, admin.id, "member").await?;
        let v2s = fixtures::session_of(&fixtures::login_user(&app, &v2).await?)?;
        parity_assert!("L:11f02fdd8b3d7f49-1", !v2s.is_empty());
        let (status, _) = app.auth_get_json("/requests/my-requests", &v2s).await?;
        parity_assert_eq!("L:565d9b72e441f800-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", v2.id), &session, json!({})).await?;
        parity_assert_eq!("L:0798ab3600fae5e5-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:112c8f1f0c8b5547-1", user_status(&app, v2.id).await?, "tombstoned");
        let team_members: i64 = sqlx::query_scalar("SELECT count(*) FROM team_memberships WHERE user_id=$1 AND team_id=$2 AND expires_after IS NULL").bind(v2.id).bind(team).fetch_one(app.db()).await?;
        parity_assert_eq!("L:6389b33a64e7704a-1", team_members, 0);
        let (status, _) = app.auth_get_json("/requests/my-requests", &v2s).await?;
        parity_assert_eq!("L:08884bb73e6b22bc-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", v2.id), &session, json!({})).await?;
        parity_assert_eq!("L:51b745394ca29c70-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", admin.id), &session, json!({})).await?;
        parity_assert_eq!("L:f603dac35ebea44a-1", status, reqwest::StatusCode::BAD_REQUEST);
        // Sole primary owner guard.
        let owner = fixtures::create_active_user(&app, "Sole Owner", &fixtures::unique_email("soleowner"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let _ = wired;
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", owner.id), &session, json!({})).await?;
        parity_assert_eq!("L:f25672fe540aa4d5-1", status, reqwest::StatusCode::BAD_REQUEST);
        // Untombstone.
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/untombstone", v2.id), &session, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:3369cab09c06e34b-1", status, reqwest::StatusCode::OK);
        let login = fixtures::login_as(&app, &v2.email, "VendorPass!2026").await?;
        parity_assert!("L:ddcabf74655a5bf9-1", login.get("session").is_some() || login.get("twofaRequired").is_some());
        let emails = fixtures::latest_notification_emails(&app, "user.untombstoned").await?;
        parity_assert!("L:d59bea6892c18f36-1", emails.is_some());
        parity_assert_eq!("L:2996e46e7e611849-1", emails.unwrap(), vec![v2.email.clone()]);
        // Auto-cancel in-flight request.
        let sub = fixtures::create_active_user(&app, "Doomed Submitter", &fixtures::unique_email("doomed"), "SubPass!2026", "vendor", true).await?;
        let subs = fixtures::session_of(&fixtures::login_user(&app, &sub).await?)?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &sub, admin.id).await?;
        let asset = fixtures::create_asset(&app, wired.system_id, &fixtures::unique_name("host")).await?;
        let (status, req) = fixtures::submit_request(&app, &subs, wired.system_id, asset, &fixtures::unique_name("SR")).await?;
        parity_assert_eq!("L:eef9f2358c2547cc-1", status, reqwest::StatusCode::CREATED);
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/tombstone", sub.id), &session, json!({})).await?;
        parity_assert_eq!("L:e66c0bb3781261b6-1", status, reqwest::StatusCode::OK);
        let emails = fixtures::latest_notification_emails(&app, "user.tombstoned_auto_cancelled_request").await?;
        parity_assert!("L:f91c667039c8577a-1", emails.is_some());
        parity_assert_eq!("L:63b46f6509c82335-1", emails.unwrap(), vec![sub.email.clone()]);
        let related: Option<String> = sqlx::query_scalar("SELECT related_target_id FROM sent_notifications WHERE trigger_key='user.tombstoned_auto_cancelled_request' ORDER BY created_at DESC LIMIT 1").fetch_one(app.db()).await?;
        parity_assert_eq!("L:c79c114711099667-1", related, req["request"]["id"].as_str().map(String::from));
        let (status, _) = app.auth_post_json(&format!("/admin/users/{}/untombstone", v2.id), &session, json!({"affiliation":"invalid"})).await?;
        parity_assert_eq!("L:2ee56a3270424422-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", v2.id), &session, json!({"affiliation":"agency"})).await?;
        parity_assert_eq!("L:86b90a3eaf15ce4e-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:7596a1de08c46a5c-1", user_aff(&app, v2.id).await?, "agency");
        // Submitter membership live re-check.
        let v3 = fixtures::create_active_user(&app, "Membership Submitter", &fixtures::unique_email("memsub"), "SubPass!2026", "vendor", true).await?;
        let v3s = fixtures::session_of(&fixtures::login_user(&app, &v3).await?)?;
        fixtures::add_serving_member(&app, wired.vendor_l1, &v3, admin.id).await?;
        parity_assert!("L:74c295d8ab04b082-1", !v3s.is_empty());
        let asset2 = fixtures::create_asset(&app, wired.system_id, &fixtures::unique_name("host2")).await?;
        let (status, _) = fixtures::submit_request(&app, &v3s, wired.system_id, asset2, &fixtures::unique_name("SR2")).await?;
        parity_assert_eq!("L:639eac6e63722f93-1", status, reqwest::StatusCode::CREATED);
        sqlx::query("UPDATE users SET affiliation='agency' WHERE id=$1").bind(v3.id).execute(app.db()).await?;
        let (status, _) = fixtures::submit_request(&app, &v3s, wired.system_id, asset2, &fixtures::unique_name("SR3")).await?;
        parity_assert_eq!("L:575fa4f0207db8dc-1", status, reqwest::StatusCode::FORBIDDEN);
        // Scoped affiliation guards (addendum-204 F2).
        let scoped = fixtures::create_active_user(&app, "Scoped Aff Admin", &fixtures::unique_email("scopedaff"), "ScopedPass!2026", "agency", true).await?;
        fixtures::grant_scoped(&app, scoped.id, "user_admin", org, admin.id).await?;
        let ss = fixtures::session_of(&fixtures::login_user(&app, &scoped).await?)?;
        parity_assert!("L:0f6e0104b3670598-1", !ss.is_empty());
        let t2 = fixtures::create_active_user(&app, "Aff Target", &fixtures::unique_email("afftarget"), "TargetPass!2026", "agency", true).await?;
        fixtures::add_org_membership(&app, org, t2.id, admin.id).await?;
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", t2.id), &ss, json!({"affiliation":"agency","grantFullAdmin":true})).await?;
        parity_assert_eq!("L:7e53ca926e4cd4d4-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:f91b54b35f6d7f7d-1", body["error"].as_str().unwrap_or("").contains("global UserAffiliationChange grant"), true);
        let db = sea_orm::Database::connect(app.db_url()).await?;
        parity_assert_eq!("L:6e0cb8269fae9724-1", ffs_server::db::admin_roles::list_admin_role_grants(&db, t2.id, false).await?.len(), 0);
        parity_assert_eq!("L:e6b8da71d2277719-1", user_aff(&app, t2.id).await?, "agency");
        ffs_server::db::admin_roles::grant_admin_role(&db, t2.id, "config_audit_admin", admin.id, None, None).await?;
        parity_assert_eq!("L:39b1fe50e0b9973b-1", ffs_server::db::admin_roles::list_admin_role_grants(&db, t2.id, false).await?.len(), 1);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", t2.id), &ss, json!({"affiliation":"agency","roleKeys":[]})).await?;
        parity_assert_eq!("L:93ada9e884c1c48b-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:b3c10b4b83dec4fb-1", ffs_server::db::admin_roles::list_admin_role_grants(&db, t2.id, false).await?.len(), 1);
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", t2.id), &ss, json!({"affiliation":"vendor"})).await?;
        parity_assert_eq!("L:f33fa88ec3596afe-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:b3618fa08c6ee1f6-1", body["error"].as_str().unwrap_or("").contains("global administrator must remove"), true);
        parity_assert_eq!("L:cba17add0c399805-1", user_aff(&app, t2.id).await?, "agency");
        parity_assert_eq!("L:fed81383b68b8777-1", ffs_server::db::admin_roles::list_admin_role_grants(&db, t2.id, false).await?.len(), 1);
        let t3 = fixtures::create_active_user(&app, "Plain Flip", &fixtures::unique_email("plainflip"), "TargetPass!2026", "vendor", true).await?;
        fixtures::add_org_membership(&app, org, t3.id, admin.id).await?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", t3.id), &ss, json!({"affiliation":"agency"})).await?;
        parity_assert_eq!("L:049e1bdb7c5ed5ee-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:99d9a170eab3701f-1", user_aff(&app, t3.id).await?, "agency");
        parity_assert_eq!("L:8ff0c8ca4837aa61-1", ffs_server::db::admin_roles::list_admin_role_grants(&db, t3.id, false).await?.len(), 0);
        // Global mint/strip settlement.
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", t2.id), &session, json!({"affiliation":"agency","grantFullAdmin":true})).await?;
        parity_assert_eq!("L:97965b3cab2fb3ce-1", status, reqwest::StatusCode::OK);
        let grants = ffs_server::db::admin_roles::list_admin_role_grants(&db, t2.id, false).await?;
        parity_assert_eq!("L:54523cf5349b3684-1", grants.iter().any(|g| g.role_key=="full_admin" && g.organization_id.is_none()), true);
        parity_assert_eq!("L:bd4b57453f145723-1", user_aff(&app, t2.id).await?, "agency");
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/affiliation", t2.id), &session, json!({"affiliation":"vendor","roleKeys":[]})).await?;
        parity_assert_eq!("L:f89a82a89bd11186-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:3bdd3bfd81866dcb-1", ffs_server::db::admin_roles::list_admin_role_grants(&db, t2.id, false).await?.len(), 0);
        Ok(())
    }).await
}
