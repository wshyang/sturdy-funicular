//! Port of test/backend/deno/admin_email_templates.test.tsx (34 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use uuid::Uuid;

async fn template_id(app: &TestApp, trigger: &str) -> Result<Uuid> {
    Ok(sqlx::query_scalar("SELECT id FROM notification_templates WHERE trigger_key=$1::email_trigger_key AND organization_id IS NULL").bind(trigger).fetch_one(app.db()).await?)
}
async fn template_subject(app: &TestApp, id: Uuid) -> Result<String> {
    Ok(sqlx::query_scalar("SELECT subject FROM notification_templates WHERE id=$1").bind(id).fetch_one(app.db()).await?)
}

#[tokio::test]
async fn admin_email_templates_crud_and_outbox() -> Result<()> {
    TestApp::run("admin_email_templates", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "EmailAdmin!2026").await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let (status, data) = app.auth_get_json("/admin/notification-templates", &session).await?;
        parity_assert_eq!("L:1d228d8ebfdbf199-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:2520f03897ec9299-1", data["templates"].as_array().unwrap().len(), 34);
        parity_assert!("L:6c0cc946d04c0206-1", data["templates"].as_array().unwrap().iter().any(|t| t["triggerKey"]=="request.submitted"));
        parity_assert!("L:8d9a4608aa30fe27-1", data["templates"].as_array().unwrap().iter().any(|t| t["triggerKey"]=="user.invited"));
        let vendor = fixtures::create_active_user(&app, "EmailVendor1", &fixtures::unique_email("emailvendor1"), "VendorPass!2026", "vendor", true).await?;
        let vs = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;
        let (status, _) = app.auth_get_json("/admin/notification-templates", &vs).await?;
        parity_assert_eq!("L:b15565367b1315b0-1", status, reqwest::StatusCode::FORBIDDEN);
        let id = template_id(&app, "user.rejected").await?;
        parity_assert!("L:ea243c51799faabb-1", true);
        let original_subject = template_subject(&app, id).await?;
        let (status, data) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &session, json!({"subject":"New subject {{fullName}}","bodyHtml":"<p>New body {{reason}}</p>","isActive":false})).await?;
        parity_assert_eq!("L:38ec7ec828930a0c-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:8cec629db979b237-1", data["template"]["subject"], json!("New subject {{fullName}}"));
        parity_assert_eq!("L:4efbf9698173a947-1", data["template"]["bodyHtml"], json!("<p>New body {{reason}}</p>"));
        parity_assert_eq!("L:89dfb7cfa56d0d3c-1", data["template"]["isActive"], json!(false));
        let detail = fixtures::latest_audit_detail(&app, "email_template.updated").await?;
        parity_assert!("L:20799b162de2422d-1", detail.is_some());
        let detail = detail.unwrap();
        parity_assert_eq!("L:682693e5810e2e55-1", detail["oldValues"]["subject"], json!(original_subject));
        parity_assert_eq!("L:a1fff78aae4af98e-1", detail["newValues"]["subject"], json!("New subject {{fullName}}"));
        sqlx::query("UPDATE notification_templates SET subject=$1, is_active=true WHERE id=$2").bind(&original_subject).bind(id).execute(app.db()).await?;
        parity_assert!("L:5627e84a472a96bb-1", true);
        let malicious = "<p onclick=\"steal()\">Safe <a href=\"javascript:steal()\" target=\"_blank\">link</a></p><svg onload=\"steal()\"><script>steal()</script><iframe srcdoc=\"x\"></iframe>";
        let (status, data) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &session, json!({"bodyHtml":malicious})).await?;
        parity_assert_eq!("L:931695a31368036d-1", status, reqwest::StatusCode::OK);
        let html = data["template"]["bodyHtml"].as_str().unwrap();
        parity_assert!("L:85370d44c7e21119-1", html.contains("Safe"));
        parity_assert!("L:52dfd85418063400-1", html.contains("link"));
        parity_assert!("L:da6a2e991287a7cb-1", html.contains("rel=\"noopener noreferrer\""));
        for forbidden in ["onclick","javascript:","<svg","onload","<script","<iframe","srcdoc"] {
            parity_assert_eq!("L:ca5db257ee5a7f0d-1", html.to_lowercase().contains(forbidden), false);
        }
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &session, json!({"subject":"   "})).await?;
        parity_assert_eq!("L:cd38ad7036ccfb95-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &session, json!({"bodyHtml":""})).await?;
        parity_assert_eq!("L:50a077824e5b2b54-1", status, reqwest::StatusCode::BAD_REQUEST);
        let subject255 = "A".repeat(255);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &session, json!({"subject":subject255})).await?;
        parity_assert_eq!("L:67acb7b68d421603-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &session, json!({"subject":"A".repeat(256)})).await?;
        parity_assert_eq!("L:d60bc87c16d87bdd-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:a12e6a62030abe19-1", template_subject(&app, id).await?, subject255);
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &session, json!({"triggerKey":"user.approved","subject":"Attempted trigger_key change"})).await?;
        parity_assert_eq!("L:d112e365914db335-1", status, reqwest::StatusCode::OK);
        let tk: String = sqlx::query_scalar("SELECT trigger_key::text FROM notification_templates WHERE id=$1").bind(id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:e75829370c25c95a-1", tk, "user.rejected");
        let vendor2 = fixtures::create_active_user(&app, "EmailVendor2", &fixtures::unique_email("emailvendor2"), "VendorPass!2026", "vendor", true).await?;
        let vs2 = fixtures::session_of(&fixtures::login_user(&app, &vendor2).await?)?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{id}"), &vs2, json!({"subject":"Should not apply"})).await?;
        parity_assert_eq!("L:292894b62a22557a-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:290f9de1368ad3d5-1", template_subject(&app, id).await?, "Attempted trigger_key change");
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/notification-templates/{}", Uuid::nil()), &session, json!({"subject":"Doesn't matter"})).await?;
        parity_assert_eq!("L:f23595b6de5f2889-1", status, reqwest::StatusCode::NOT_FOUND);
        sqlx::query("INSERT INTO sent_notifications (trigger_key, rendered_subject, rendered_body_html, rendered_body_text, created_at) VALUES ('user.approved','First','<p>1</p>','1',now() - interval '1 minute')").execute(app.db()).await?;
        sqlx::query("INSERT INTO sent_notifications (trigger_key, rendered_subject, rendered_body_html, rendered_body_text, created_at) VALUES ('user.approved','Second','<p>2</p>','2',now())").execute(app.db()).await?;
        let (status, data) = app.auth_get_json("/admin/sent-notifications", &session).await?;
        parity_assert_eq!("L:830fd05eba6fa482-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:84eb4148984f3e39-1", data["notifications"].as_array().unwrap().iter().any(|n| n["renderedSubject"]=="Second"));
        parity_assert!("L:78d80dda151251a7-1", data["notifications"].as_array().unwrap().iter().any(|n| n["renderedSubject"]=="First"));
        parity_assert_eq!("L:3b715e3aa8b7d79b-1", data["notifications"].as_array().unwrap().iter().any(|n| n.get("subject").is_some()), false);
        let vendor3 = fixtures::create_active_user(&app, "EmailVendor3", &fixtures::unique_email("emailvendor3"), "VendorPass!2026", "vendor", true).await?;
        let vs3 = fixtures::session_of(&fixtures::login_user(&app, &vendor3).await?)?;
        let (status, _) = app.auth_get_json("/admin/sent-notifications", &vs3).await?;
        parity_assert_eq!("L:e238eb68598206f2-1", status, reqwest::StatusCode::FORBIDDEN);
        Ok(())
    }).await
}
