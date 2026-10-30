//! Port of test/backend/deno/admin_roles_crud.test.tsx (27 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::{Method, StatusCode};
use serde_json::json;

#[tokio::test]
async fn admin_roles_crud() -> Result<()> {
    TestApp::run("admin_roles_crud", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "AdminRoles!2026").await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let sea = sea_orm::Database::connect(app.db_url()).await?;

        let (status, data) = app.auth_post_json("/admin/roles", &session, json!({
            "key": "helpdesk_admin", "name": "Helpdesk Administrator",
            "description": "View users and audit logs", "capabilities": ["UserRead", "AuditLogRead"]
        })).await?;
        parity_assert_eq!("L:9055d60ce9000a5c-1", status, StatusCode::CREATED);
        parity_assert_eq!("L:f37d3351c0d345ff-1", data["role"]["key"], json!("helpdesk_admin"));
        parity_assert_eq!("L:d1fe3cd7b3cbf3b5-1", data["role"]["isSystemRole"], json!(false));
        parity_assert_eq!("L:0c693e4a5d8d9679-1", data["role"]["capabilities"], json!(["UserRead", "AuditLogRead"]));

        let (status, _) = app.auth_post_json("/admin/roles", &session, json!({
            "key": "full_admin", "name": "Nope", "description": "", "capabilities": ["UserRead"]
        })).await?;
        parity_assert_eq!("L:8d02feed2fc11698-1", status, StatusCode::BAD_REQUEST);

        let (status, _) = app.auth_post_json("/admin/roles", &session, json!({
            "key": "bad_role", "name": "Bad Role", "description": "", "capabilities": ["NotARealCapability"]
        })).await?;
        parity_assert_eq!("L:c8e5d886595f560e-1", status, StatusCode::BAD_REQUEST);

        let (status, data) = app.auth_get_json("/admin/roles", &session).await?;
        parity_assert_eq!("L:bf80e8ab2aa15de7-1", status, StatusCode::OK);
        let role = fixtures::role_by_key(&data, "helpdesk_admin");
        parity_assert!("L:10a49c9f8891180a-1", role.is_some());
        parity_assert_eq!("L:053d45072c642620-1", role.unwrap()["capabilities"], json!(["UserRead", "AuditLogRead"]));
        let full = fixtures::role_by_key(&data, "full_admin");
        parity_assert!("L:4833c0342b7e33fc-1", full.is_some());
        parity_assert_eq!("L:18d5891ca11ff5ed-1", full.unwrap()["capabilities"].as_array().unwrap().iter().any(|c| c == "AdminRolesManage"), true);

        let (status, data) = app.auth_send_json(Method::PUT, "/admin/roles/helpdesk_admin", &session, json!({
            "description": "Now also sees sent notifications",
            "capabilities": ["UserRead", "AuditLogRead", "AuditSentNotificationsRead"]
        })).await?;
        parity_assert_eq!("L:911f1c5e6996a7f3-1", status, StatusCode::OK);
        parity_assert_eq!("L:6769a20e856d2c18-1", data["role"]["capabilities"].as_array().unwrap().iter().any(|c| c == "AuditSentNotificationsRead"), true);

        let user = fixtures::create_active_user(&app, &fixtures::unique_name("Rolee"), &fixtures::unique_email("rolee"), "RoleePass!2026", "agency", true).await?;
        let path = format!("/admin/users/{}/roles", user.id);
        let (status, _) = app.auth_send_json(Method::PUT, &path, &session, json!({"roleKeys": ["helpdesk_admin", "data_operator"]})).await?;
        parity_assert_eq!("L:d5d9ad770a4e9e41-1", status, StatusCode::OK);
        let (_, data) = app.auth_get_json(&path, &session).await?;
        let mut keys: Vec<String> = data["roleKeys"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        keys.sort();
        parity_assert_eq!("L:859dfe791f161b10-1", keys, vec!["data_operator".to_string(), "helpdesk_admin".to_string()]);
        let caps = ffs_server::db::admin_roles::get_effective_admin_capabilities(&sea, user.id).await?;
        parity_assert_eq!("L:7254c589db05a1c7-1", caps.contains("UserRead"), true);
        parity_assert_eq!("L:55d8dc4db050a7e2-1", caps.contains("AuditSentNotificationsRead"), true);
        parity_assert_eq!("L:6407089c73d75dd8-1", caps.contains("DataExport"), true);
        parity_assert_eq!("L:d70b194038e4feac-1", caps.contains("AdminRolesManage"), false);
        let (status, _) = app.auth_send_json(Method::PUT, &path, &session, json!({"roleKeys": ["helpdesk_admin"]})).await?;
        parity_assert_eq!("L:0b00acc230a132f5-1", status, StatusCode::OK);
        let after = ffs_server::db::admin_roles::get_effective_admin_capabilities(&sea, user.id).await?;
        parity_assert_eq!("L:8a2bc47d9abb47bd-1", after.contains("DataExport"), false);

        let protected = fixtures::create_active_user(&app, "Protected Rolee", &fixtures::unique_email("prole"), "RoleePass!2026", "agency", true).await?;
        sqlx::query("UPDATE users SET is_protected=true WHERE id=$1").bind(protected.id).execute(app.db()).await?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/roles", protected.id), &session, json!({"roleKeys": ["helpdesk_admin"]})).await?;
        parity_assert_eq!("L:6cf5f01f2a27204c-1", status, StatusCode::BAD_REQUEST);

        let (status, _) = app.auth_send_json(Method::DELETE, "/admin/roles/user_admin", &session, json!({})).await?;
        parity_assert_eq!("L:34b02d8c3457c37d-1", status, StatusCode::BAD_REQUEST);

        let still = fixtures::create_active_user(&app, &fixtures::unique_name("StillGranted"), &fixtures::unique_email("sg"), "RoleePass!2026", "agency", true).await?;
        let (grant_status, _) = app.auth_send_json(Method::PUT, &format!("/admin/users/{}/roles", still.id), &session, json!({"roleKeys": ["helpdesk_admin"]})).await?;
        if grant_status != StatusCode::OK { anyhow::bail!("still-granted setup failed: {grant_status}"); }
        let (status, _) = app.auth_send_json(Method::DELETE, "/admin/roles/helpdesk_admin", &session, json!({})).await?;
        parity_assert_eq!("L:f6da1ce185c98b54-1", status, StatusCode::BAD_REQUEST);

        sqlx::query("UPDATE user_admin_role_grants SET revoked_at=now(), revoked_by=$1, revocation_reason='test cleanup' WHERE role_key='helpdesk_admin' AND revoked_at IS NULL")
            .bind(admin.id).execute(app.db()).await?;
        let (status, _) = app.auth_send_json(Method::DELETE, "/admin/roles/helpdesk_admin", &session, json!({})).await?;
        parity_assert_eq!("L:ccacaf871038dcb5-1", status, StatusCode::OK);
        let (_, list) = app.auth_get_json("/admin/roles", &session).await?;
        parity_assert_eq!("L:6fccef5b13bf1bfc-1", fixtures::role_by_key(&list, "helpdesk_admin").is_none(), true);

        let vendor = fixtures::create_active_user(&app, "Vendor", &fixtures::unique_email("v"), "VendorPass!2026", "vendor", true).await?;
        let vsession = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;
        let (status, _) = app.auth_post_json("/admin/roles", &vsession, json!({"key":"x","name":"X","description":"","capabilities":[]})).await?;
        parity_assert_eq!("L:052c01552185ad62-1", status, StatusCode::FORBIDDEN);
        Ok(())
    }).await
}
