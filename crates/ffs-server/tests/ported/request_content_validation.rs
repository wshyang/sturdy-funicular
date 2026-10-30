//! Port of test/backend/deno/request_content_validation.test.tsx (30 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::{json, Value};

const START: &str = "2026-09-01T09:00:00.000Z";
const END: &str = "2026-09-01T17:00:00.000Z";
fn err(r: Result<ffs_server::request_helpers::ValidatedContent, String>) -> Option<String> { r.err() }

#[tokio::test]
async fn request_content_validation_guard() -> Result<()> {
    TestApp::run("request_content_validation", |app| async move {
        fixtures::prepare(&app).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        let admin = fixtures::create_admin(&app, "ValidateAdmin!2026").await?;
        let owner = fixtures::create_active_user(&app, "Content Owner", &fixtures::unique_email("contentowner"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let other = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let asset = fixtures::create_asset(&app, wired.system_id, "host-a").await?;
        let second = fixtures::create_asset(&app, wired.system_id, "host-b").await?;
        let foreign = fixtures::create_asset(&app, other.system_id, "host-foreign").await?;
        let valid = || json!({"justification":"Emergency access to restore the payroll batch job.","srNumber":"SR-12345","activityStartAt":START,"activityEndAt":END,"credentialItems":[{"assetId":asset.to_string(),"hostnameDescription":"primary db"}]});
        use ffs_server::request_helpers::validate_content;
        let out = validate_content(&db, &valid(), wired.system_id).await;
        parity_assert_eq!("L:1039486239b87214-1", err(out.clone()), None);
        let ok = out.unwrap();
        parity_assert_eq!("L:1b4f995ec012c1fa-1", ok.start_iso, START);
        parity_assert_eq!("L:3fbe729744f6e45c-1", ok.end_iso, END);
        parity_assert_eq!("L:e565decf6cb01956-1", ok.resolved_assets.len(), 1);
        parity_assert!("L:a3e77f6abfe70897-1", ok.resolved_assets.contains_key(&asset.to_string()));
        let mut b = valid(); b["activityStartAt"] = json!("2026-09-01T09:00:00Z"); b["activityEndAt"] = json!("2026-09-01T17:00:00+00:00");
        let out = validate_content(&db, &b, wired.system_id).await;
        parity_assert_eq!("L:dd3571e24b8804c8-1", err(out.clone()), None);
        let ok = out.unwrap();
        parity_assert_eq!("L:921a4b01931888c2-1", ok.start_iso, START);
        parity_assert_eq!("L:1424efcbbbefc111-1", ok.end_iso, END);
        let mut b = valid(); b["credentialItems"] = json!([{"assetId":asset.to_string()},{"assetId":second.to_string()}]);
        let out = validate_content(&db, &b, wired.system_id).await;
        parity_assert_eq!("L:dc10228302cc1c7d-1", err(out.clone()), None);
        parity_assert_eq!("L:044d20f4bd2de087-1", out.unwrap().resolved_assets.len(), 2);
        let mut b = valid(); b["credentialItems"] = json!([{"assetId":asset.to_string()}]);
        parity_assert_eq!("L:a64af5310235466c-1", err(validate_content(&db, &b, wired.system_id).await), None);
        for justification in [Value::Null, json!(""), json!("   "), json!("x".repeat(2001))] {
            let mut b = valid(); b["justification"] = justification;
            let e = err(validate_content(&db, &b, wired.system_id).await);
            parity_assert!("L:d0a6dd1dcea101f5-1", e.is_some());
            parity_assert!("L:b56ee1be81646c92-1", e.unwrap_or_default().contains("Justification"));
        }
        let mut b = valid(); b["justification"] = json!("x".repeat(2000));
        parity_assert_eq!("L:f668eec05947fb52-1", err(validate_content(&db, &b, wired.system_id).await), None);
        for sr in [Value::Null, json!(""), json!("x".repeat(101))] {
            let mut b = valid(); b["srNumber"] = sr;
            let e = err(validate_content(&db, &b, wired.system_id).await);
            parity_assert!("L:7545669b41f85a8e-1", e.is_some());
            parity_assert!("L:8f2f33257409fd59-1", e.unwrap_or_default().contains("SR number"));
        }
        let mut b = valid(); b.as_object_mut().unwrap().remove("activityStartAt");
        parity_assert_eq!("L:764453be3b9816b9-1", err(validate_content(&db, &b, wired.system_id).await), Some("Activity start and end times are required.".into()));
        let mut b = valid(); b.as_object_mut().unwrap().remove("activityEndAt");
        parity_assert_eq!("L:97266a54e04c3910-1", err(validate_content(&db, &b, wired.system_id).await), Some("Activity start and end times are required.".into()));
        let mut b = valid(); b["activityStartAt"] = json!("not-a-date");
        parity_assert_eq!("L:f63ef6f302916bc9-1", err(validate_content(&db, &b, wired.system_id).await), Some("Activity start time is invalid.".into()));
        let mut b = valid(); b["activityEndAt"] = json!("not-a-date");
        parity_assert_eq!("L:a05b8b8dd4e56a18-1", err(validate_content(&db, &b, wired.system_id).await), Some("Activity end time is invalid.".into()));
        let mut b = valid(); b["activityStartAt"] = json!(END); b["activityEndAt"] = json!(START);
        parity_assert_eq!("L:306cd2396bd0bd75-1", err(validate_content(&db, &b, wired.system_id).await), Some("Activity end time must be after start time.".into()));
        let mut b = valid(); b["activityStartAt"] = json!(START); b["activityEndAt"] = json!(START);
        parity_assert_eq!("L:8bfaf0187f431436-1", err(validate_content(&db, &b, wired.system_id).await), Some("Activity end time must be after start time.".into()));
        for items in [Value::Null, json!([]), json!("nope"), json!({})] {
            let mut b = valid(); b["credentialItems"] = items;
            parity_assert_eq!("L:35100c16ecb5e403-1", err(validate_content(&db, &b, wired.system_id).await), Some("At least one credential item (a selected asset) is required.".into()));
        }
        for item in [json!({}), json!({"assetId":""}), json!({"assetId":42}), json!({"assetId":null})] {
            let mut b = valid(); b["credentialItems"] = json!([item]);
            parity_assert_eq!("L:05879674a5ccf91a-1", err(validate_content(&db, &b, wired.system_id).await), Some("Each credential item must reference a selected asset.".into()));
        }
        let mut b = valid(); b["credentialItems"] = json!([{"assetId":asset.to_string()},{"assetId":asset.to_string()}]);
        parity_assert_eq!("L:70cdb7371b6d49c3-1", err(validate_content(&db, &b, wired.system_id).await), Some("The same asset was selected more than once.".into()));
        let mut b = valid(); b["credentialItems"] = json!([{"assetId":asset.to_string(),"hostnameDescription":"x".repeat(201)}]);
        parity_assert!("L:b64ca510e0eac49d-1", err(validate_content(&db, &b, wired.system_id).await).unwrap_or_default().contains("Hostname description"));
        let mut b = valid(); b["credentialItems"] = json!([{"assetId":"00000000-0000-7000-8000-0000000000ff"}]);
        parity_assert_eq!("L:bd84ce2e643a9dbf-1", err(validate_content(&db, &b, wired.system_id).await), Some("Each credential item must reference a valid, active asset for this system.".into()));
        let mut b = valid(); b["credentialItems"] = json!([{"assetId":foreign.to_string()}]);
        parity_assert_eq!("L:93e25de1f1a61f03-1", err(validate_content(&db, &b, wired.system_id).await), Some("Each credential item must reference a valid, active asset for this system.".into()));
        let retired = fixtures::create_asset(&app, wired.system_id, "host-retired").await?;
        sqlx::query("UPDATE assets SET expires_after=now() WHERE id=$1").bind(retired).execute(app.db()).await?;
        let mut b = valid(); b["credentialItems"] = json!([{"assetId":retired.to_string()}]);
        parity_assert_eq!("L:b8b0c495d68258b4-1", err(validate_content(&db, &b, wired.system_id).await), Some("Each credential item must reference a valid, active asset for this system.".into()));
        let mut b = valid(); b["justification"] = json!(""); b["credentialItems"] = json!([{"assetId":"nope"}]);
        parity_assert!("L:f19a5f93466f5cf1-1", err(validate_content(&db, &b, wired.system_id).await).unwrap_or_default().contains("Justification"));
        Ok(())
    }).await
}
