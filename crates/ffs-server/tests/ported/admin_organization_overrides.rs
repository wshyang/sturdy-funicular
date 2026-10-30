//! Port of test/backend/deno/admin_organization_overrides.test.tsx (54 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn admin_organization_overrides_settings_templates() -> Result<()> {
    TestApp::run("admin_organization_overrides", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "OrgOverrideAdmin!2026").await?;
        let login = fixtures::login_user(&app, &admin).await?;
        parity_assert!("L:1c0a4d68c758efc0-1", login.get("session").is_some());
        let session = fixtures::session_of(&login)?;
        let org = fixtures::create_organization(&app, &fixtures::unique_name("Override Org"), &fixtures::unique_short_code(), admin.id).await?;
        let (status, data) = app.auth_get_json(&format!("/admin/organizations/{org}/settings"), &session).await?;
        parity_assert_eq!("L:12ae89ec5094c4c8-1", status, reqwest::StatusCode::OK);
        let settings = data["settings"].as_array().unwrap();
        parity_assert!("L:804117d6e12ab16d-1", !settings.is_empty());
        let keys: Vec<&str> = settings.iter().map(|s| s["key"].as_str().unwrap()).collect();
        parity_assert!("L:d33d9de8c3a63e7f-1", keys.contains(&"smtp_host"));
        for platform in ["session_ttl_ms","max_login_attempts"] { parity_assert_eq!("L:037dc1dc6d467050-1", keys.contains(&platform), false); }
        parity_assert_eq!("L:ab6c467103e7489e-1", settings.iter().all(|s| s["source"]=="global"), true);
        parity_assert_eq!("L:d8861c69fea7e232-1", settings.iter().all(|s| s["orgUpdatedAt"].is_null()), true);
        let (status, _) = app.auth_get_json(&format!("/admin/organizations/{}/settings", Uuid::now_v7()), &session).await?;
        parity_assert_eq!("L:98ac8305d24c5bee-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.get_json(&format!("/admin/organizations/{org}/settings")).await?;
        parity_assert_eq!("L:1a5916b0f5491cb9-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, _) = app.send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/smtp_host"), json!({"value":"smtp.example.gov"})).await?;
        parity_assert_eq!("L:874c8a2324560901-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/smtp_host"), &session, json!({"value":"smtp.agency.example"})).await?;
        parity_assert_eq!("L:1696d71a036177d4-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:80c9afa96c1da3ce-1", body["value"], json!("smtp.agency.example"));
        parity_assert_eq!("L:dfbf01c2b3b21445-1", body["source"], json!("organization"));
        let (_, data) = app.auth_get_json(&format!("/admin/organizations/{org}/settings"), &session).await?;
        let row = data["settings"].as_array().unwrap().iter().find(|s| s["key"]=="smtp_host").unwrap();
        parity_assert_eq!("L:7277c52882478235-1", row["value"], json!("smtp.agency.example"));
        parity_assert_eq!("L:1ed99337b596bf38-1", row["source"], json!("organization"));
        parity_assert!("L:03e4ce9f65e63118-1", !row["orgUpdatedAt"].is_null());
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/smtp_host"), &session, json!({"value":"smtp2.agency.example"})).await?;
        parity_assert_eq!("L:d2bb0ddc61e4595f-1", status, reqwest::StatusCode::OK);
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM app_settings WHERE organization_id=$1 AND key='smtp_host' AND expires_after IS NULL").bind(org).fetch_one(app.db()).await?;
        parity_assert_eq!("L:822408b5ae9b50e9-1", n, 1);
        let (_, data) = app.auth_get_json(&format!("/admin/organizations/{org}/settings"), &session).await?;
        let row = data["settings"].as_array().unwrap().iter().find(|s| s["key"]=="smtp_host").unwrap();
        parity_assert_eq!("L:56c10915416242b6-1", row["value"], json!("smtp2.agency.example"));
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/smtp_password"), &session, json!({"value":"hunter2-super-secret"})).await?;
        parity_assert_eq!("L:f2de111f54804f2f-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:531870101ae687a9-1", body["value"], json!("••••••••"));
        let (_, data) = app.auth_get_json(&format!("/admin/organizations/{org}/settings"), &session).await?;
        let row = data["settings"].as_array().unwrap().iter().find(|s| s["key"]=="smtp_password").unwrap();
        parity_assert_eq!("L:e0efaa93c5fd034b-1", row["isSecret"], json!(true));
        parity_assert_eq!("L:f3a21ed52d8d4018-1", row["value"], json!("••••••••"));
        parity_assert!("L:8c48a9a44f1c3f02-1", !data.to_string().contains("hunter2"));
        let stored: String = sqlx::query_scalar("SELECT value FROM app_settings WHERE organization_id=$1 AND key='smtp_password' AND expires_after IS NULL").bind(org).fetch_one(app.db()).await?;
        parity_assert_eq!("L:72c2a40d453b7a0e-1", stored, "hunter2-super-secret");
        let audits = sqlx::query_scalar::<_, String>("SELECT details::text FROM audit_log WHERE action='organization_setting.updated' AND target_id=$1 ORDER BY created_at DESC").bind(org.to_string()).fetch_all(app.db()).await?;
        parity_assert!("L:82873f1b1db13e32-1", !audits.is_empty());
        parity_assert!("L:b7fad334626c5467-1", !audits[0].contains("hunter2"));
        parity_assert!("L:9657303be7f05a25-1", audits[0].contains("[hidden]"));
        let (status, body) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/session_ttl_ms"), &session, json!({"value":"60000"})).await?;
        parity_assert_eq!("L:a3566877b542a626-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert!("L:f1b0b9af0198089b-1", body["error"].as_str().unwrap_or("").contains("not org-overridable"));
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM app_settings WHERE organization_id=$1 AND key='session_timeout_minutes'").bind(org).fetch_one(app.db()).await?;
        parity_assert_eq!("L:bc142991ea72aed5-1", n, 0);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/totally_made_up_key"), &session, json!({"value":"x"})).await?;
        parity_assert_eq!("L:7c1161291bbcc6b1-1", status, reqwest::StatusCode::NOT_FOUND);
        for field in ["key","valueType","category","organizationId"] {
            let (status, body) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/smtp_host"), &session, json!({"value":"smtp.x.example", field:"tampered"})).await?;
            parity_assert_eq!("L:15c709af8128c436-1", status, reqwest::StatusCode::BAD_REQUEST);
            parity_assert!("L:ff73e1880feceb5b-1", body["error"].as_str().unwrap_or("").contains("immutable"));
        }
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/aws_encrypt_public_key_pem_b64"), &session, json!({"value":"bm90LWEta2V5"})).await?;
        parity_assert_eq!("L:84dde7a5db3f62a2-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{}/settings/smtp_host", Uuid::now_v7()), &session, json!({"value":"x"})).await?;
        parity_assert_eq!("L:27bac395199da372-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org}/settings/smtp_host"), &session, json!({})).await?;
        parity_assert_eq!("L:470227d0b2d854da-1", status, reqwest::StatusCode::OK);
        let (_, data) = app.auth_get_json(&format!("/admin/organizations/{org}/settings"), &session).await?;
        let row = data["settings"].as_array().unwrap().iter().find(|s| s["key"]=="smtp_host").unwrap();
        parity_assert_eq!("L:20bda8d68521322e-1", row["source"], json!("global"));
        parity_assert_eq!("L:03e3583d1ffba7fc-1", row["orgUpdatedAt"].is_null(), true);
        let dead: i64 = sqlx::query_scalar("SELECT count(*) FROM app_settings WHERE organization_id=$1 AND key='smtp_host' AND expires_after IS NOT NULL").bind(org).fetch_one(app.db()).await?;
        parity_assert_eq!("L:5df15ecaf9a4591d-1", dead, 1);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/settings/smtp_host"), &session, json!({"value":"smtp3.agency.example"})).await?;
        parity_assert_eq!("L:4cb3ed72c5c27ab4-1", status, reqwest::StatusCode::OK);
        let (_, data) = app.auth_get_json(&format!("/admin/organizations/{org}/settings"), &session).await?;
        let row = data["settings"].as_array().unwrap().iter().find(|s| s["key"]=="smtp_host").unwrap();
        parity_assert_eq!("L:a28b007b932f0587-1", row["source"], json!("organization"));
        parity_assert_eq!("L:4f4f28f8f34726e1-1", row["value"], json!("smtp3.agency.example"));
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org}/settings/ses_region"), &session, json!({})).await?;
        parity_assert_eq!("L:15326fa31d2d9710-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org}/settings/totally_made_up_key"), &session, json!({})).await?;
        parity_assert_eq!("L:4e5566d8f2907da5-1", status, reqwest::StatusCode::NOT_FOUND);
        let (status, data) = app.auth_get_json(&format!("/admin/organizations/{org}/templates"), &session).await?;
        parity_assert_eq!("L:93345ed9bb9a0f10-1", status, reqwest::StatusCode::OK);
        let templates = data["templates"].as_array().unwrap();
        parity_assert!("L:349dd8e65d649de9-1", !templates.is_empty());
        parity_assert_eq!("L:58d98350929a4f59-1", templates.iter().all(|t| t["source"]=="global"), true);
        let trigger = templates[0]["triggerKey"].as_str().unwrap().to_string();
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/templates/{trigger}"), &session, json!({"subject":"Org-specific subject","bodyHtml":"<p>Org body</p>","bodyText":"Org body","channels":["email"],"isActive":true})).await?;
        parity_assert_eq!("L:4b0d8635e0de6467-1", status, reqwest::StatusCode::OK);
        let (_, data) = app.auth_get_json(&format!("/admin/organizations/{org}/templates"), &session).await?;
        let row = data["templates"].as_array().unwrap().iter().find(|t| t["triggerKey"]==json!(trigger)).unwrap();
        parity_assert_eq!("L:f2ba07b5a627deb1-1", row["source"], json!("organization"));
        parity_assert_eq!("L:b50ad459f4e5f8eb-1", row["subject"], json!("Org-specific subject"));
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org}/templates/{trigger}"), &session, json!({})).await?;
        parity_assert_eq!("L:c889b073c940dc3b-1", status, reqwest::StatusCode::OK);
        let (_, data) = app.auth_get_json(&format!("/admin/organizations/{org}/templates"), &session).await?;
        let row = data["templates"].as_array().unwrap().iter().find(|t| t["triggerKey"]==json!(trigger)).unwrap();
        parity_assert_eq!("L:0cf0a08d524d63cf-1", row["source"], json!("global"));
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/organizations/{org}/templates/not.a.real.trigger"), &session, json!({"subject":"x","bodyHtml":"<p>x</p>","channels":["email"],"isActive":true})).await?;
        parity_assert_eq!("L:8a1c3344537eded6-1", status, reqwest::StatusCode::NOT_FOUND);
        Ok(())
    }).await
}
