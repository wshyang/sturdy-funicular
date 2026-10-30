//! Port of test/backend/deno/admin_data.test.tsx (37 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::json;
use uuid::Uuid;

#[tokio::test]
async fn admin_data_export_import_reset_seed() -> Result<()> {
    TestApp::run_with_env("admin_data", &[("BREAKGLASS_DEV","DEV")], |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "DataAdmin!2026").await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let vendor = fixtures::create_active_user(&app, "DataVendor", &fixtures::unique_email("datavendor"), "DataVendorPass!2026", "vendor", true).await?;
        let vs = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;
        let (status, _) = app.auth_get_json("/admin/data/export", &vs).await?;
        parity_assert_eq!("L:54fda14418c68eb1-1", status, reqwest::StatusCode::FORBIDDEN);
        let org = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
        let cluster = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let (status, data) = app.auth_get_json("/admin/data/export", &session).await?;
        parity_assert_eq!("L:35956476c589c947-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:d5dc25eb5038312d-1", data["schema"], json!("breakglass-export-v3"));
        parity_assert!("L:5a35261157f0ad79-1", data.get("tables").is_some());
        let tables = data["tables"].as_array().unwrap();
        let users_table = tables.iter().find(|t| t["table"]=="users");
        parity_assert!("L:caaa38c8ec3c55fd-1", users_table.is_some());
        parity_assert_eq!("L:2ef1ba3ac7f89256-1", users_table.unwrap()["rows"].as_array().unwrap().len() > 0, true);
        let total: usize = tables.iter().map(|t| t["rows"].as_array().unwrap().len()).sum();
        parity_assert_eq!("L:564a77f0fefb383d-1", data["entryCount"].as_u64().unwrap() as usize, total);
        let (status, _) = app.auth_post_json("/admin/data/import", &session, json!({"bundle":{"notTables":[]}})).await?;
        parity_assert_eq!("L:ef9c2acaccc8f569-1", status, reqwest::StatusCode::BAD_REQUEST);
        let cluster2 = fixtures::create_cluster_in_org(&app, "agency", admin.id, org).await?;
        let iv = fixtures::create_active_user(&app, "ImportVendor", &fixtures::unique_email("importvendor"), "ImportVendorPass!2026", "vendor", true).await?;
        let ivs = fixtures::session_of(&fixtures::login_user(&app, &iv).await?)?;
        let (status, _) = app.auth_post_json("/admin/data/import", &ivs, json!({"bundle":{"tables":[{"table":"clusters","rows":[]}]},"wipeFirst":true})).await?;
        parity_assert_eq!("L:092579311f332bf8-1", status, reqwest::StatusCode::FORBIDDEN);
        let n: i64 = sqlx::query_scalar("SELECT count(*) FROM clusters WHERE id=$1").bind(cluster2).fetch_one(app.db()).await?;
        parity_assert!("L:0b3f09c866ff0e5b-1", n == 1);
        let (_, bundle) = app.auth_get_json("/admin/data/export", &session).await?;
        let (status, import_data) = app.auth_post_json("/admin/data/import", &session, json!({"bundle":{"tables":bundle["tables"]},"wipeFirst":true})).await?;
        parity_assert_eq!("L:666f0843148ccf5b-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:194356a48ac5651c-1", import_data.get("entriesWritten").is_some());
        let name: Option<String> = sqlx::query_scalar("SELECT name FROM clusters WHERE id=$1").bind(cluster).fetch_optional(app.db()).await?;
        parity_assert!("L:943f9295890f4506-1", name.is_some());
        let cname: String = sqlx::query_scalar("SELECT name FROM clusters WHERE id=$1").bind(cluster).fetch_one(app.db()).await?;
        parity_assert_eq!("L:b72dc344c9cc2a67-1", cname, name.unwrap());
        // Self-referential FK ordering.
        let approver = fixtures::create_active_user(&app, "Approver", &fixtures::unique_email("approver"), "ApproverPass!2026", "agency", true).await?;
        let approvee = fixtures::create_active_user(&app, "Approvee", &fixtures::unique_email("approvee"), "ApproveePass!2026", "vendor", true).await?;
        sqlx::query("UPDATE users SET approved_by=$1 WHERE id=$2").bind(approver.id).bind(approvee.id).execute(app.db()).await?;
        let (_, mut bundle) = app.auth_get_json("/admin/data/export", &session).await?;
        if let Some(tables) = bundle["tables"].as_array_mut() {
            if let Some(ut) = tables.iter_mut().find(|t| t["table"]=="users") {
                if let Some(rows) = ut["rows"].as_array_mut() {
                    let approvee_row = rows.iter().find(|r| r["id"]==json!(approvee.id.to_string())).cloned().unwrap();
                    let approver_row = rows.iter().find(|r| r["id"]==json!(approver.id.to_string())).cloned().unwrap();
                    rows.retain(|r| r["id"]!=json!(approvee.id.to_string()) && r["id"]!=json!(approver.id.to_string()));
                    rows.insert(0, approvee_row); rows.push(approver_row);
                }
            }
        }
        let (status, import_data) = app.auth_post_json("/admin/data/import", &session, json!({"bundle":{"tables":bundle["tables"]},"wipeFirst":true})).await?;
        parity_assert_eq!("L:dd7e8869b0b67432-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:adc002f96196d815-1", import_data.get("entriesWritten").is_some());
        let ab: Option<Uuid> = sqlx::query_scalar("SELECT approved_by FROM users WHERE id=$1").bind(approvee.id).fetch_optional(app.db()).await?;
        parity_assert!("L:8c15762f3b0998dc-1", ab.is_some());
        parity_assert_eq!("L:5dcb8c2fbefde786-1", ab, Some(approver.id));
        // Full rename/restore round-trip.
        let fu = fixtures::create_active_user(&app, "Zzyzx Quokka-9931", &fixtures::unique_email("quokka"), "QuokkaPass!2026", "vendor", true).await?;
        let fc = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        sqlx::query("UPDATE clusters SET name='Flibbertigibbet-Cluster-4471' WHERE id=$1").bind(fc).execute(app.db()).await?;
        let ft = fixtures::create_team_in_cluster(&app, fc, 1, admin.id).await?;
        sqlx::query("UPDATE teams SET name='Wobbling Narwhal Squad-2286' WHERE id=$1").bind(ft).execute(app.db()).await?;
        let owner = fixtures::create_active_user(&app, "Data Owner", &fixtures::unique_email("dataowner"), "OwnerPass!2026", "agency", true).await?;
        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        sqlx::query("UPDATE systems SET name='Discombobulator-7734' WHERE id=$1").bind(wired.system_id).execute(app.db()).await?;
        let (status, bundle) = app.auth_get_json("/admin/data/export", &session).await?;
        parity_assert_eq!("L:e5ef75882396eb4c-1", status, reqwest::StatusCode::OK);
        sqlx::query("UPDATE users SET full_name='RENAMED-Bumfuzzled-Yak-1123' WHERE id=$1").bind(fu.id).execute(app.db()).await?;
        sqlx::query("UPDATE clusters SET name='RENAMED-Kerfuffle-Cluster-5528' WHERE id=$1").bind(fc).execute(app.db()).await?;
        sqlx::query("UPDATE teams SET name='RENAMED-Absquatulate-Team-8842' WHERE id=$1").bind(ft).execute(app.db()).await?;
        sqlx::query("UPDATE systems SET name='RENAMED-Gobbledygook-6617' WHERE id=$1").bind(wired.system_id).execute(app.db()).await?;
        let n: String = sqlx::query_scalar("SELECT full_name FROM users WHERE id=$1").bind(fu.id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:40af0b330e454d54-1", n, "RENAMED-Bumfuzzled-Yak-1123");
        let n: String = sqlx::query_scalar("SELECT name FROM clusters WHERE id=$1").bind(fc).fetch_one(app.db()).await?;
        parity_assert_eq!("L:de3d4351115b43f3-1", n, "RENAMED-Kerfuffle-Cluster-5528");
        let n: String = sqlx::query_scalar("SELECT name FROM teams WHERE id=$1").bind(ft).fetch_one(app.db()).await?;
        parity_assert_eq!("L:118472e48bc26aaf-1", n, "RENAMED-Absquatulate-Team-8842");
        let n: String = sqlx::query_scalar("SELECT name FROM systems WHERE id=$1").bind(wired.system_id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:98dec28b1ea6de60-1", n, "RENAMED-Gobbledygook-6617");
        let (status, import_result) = app.auth_post_json("/admin/data/import", &session, json!({"bundle":{"tables":bundle["tables"]},"wipeFirst":true})).await?;
        parity_assert_eq!("L:d5a88af35cd511bd-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:9a95a6aa283f149a-1", import_result.get("entriesWritten").is_some());
        let n: String = sqlx::query_scalar("SELECT full_name FROM users WHERE id=$1").bind(fu.id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:ac7e476108a413cc-1", n, "Zzyzx Quokka-9931");
        let n: String = sqlx::query_scalar("SELECT name FROM clusters WHERE id=$1").bind(fc).fetch_one(app.db()).await?;
        parity_assert_eq!("L:5c009ee604700d7d-1", n, "Flibbertigibbet-Cluster-4471");
        let n: String = sqlx::query_scalar("SELECT name FROM teams WHERE id=$1").bind(ft).fetch_one(app.db()).await?;
        parity_assert_eq!("L:f677fe827f76bf75-1", n, "Wobbling Narwhal Squad-2286");
        let n: String = sqlx::query_scalar("SELECT name FROM systems WHERE id=$1").bind(wired.system_id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:1224006c4f5429e0-1", n, "Discombobulator-7734");
        let (status, _) = app.auth_get_json("/auth/me", &session).await?;
        parity_assert_eq!("L:03c0a718176c2922-1", status, reqwest::StatusCode::OK);
        let sv = fixtures::create_active_user(&app, "SeedVendor", &fixtures::unique_email("seedvendor"), "SeedVendorPass!2026", "vendor", true).await?;
        let svs = fixtures::session_of(&fixtures::login_user(&app, &sv).await?)?;
        let (status, _) = app.auth_post_json("/admin/data/reset-seed", &svs, json!({})).await?;
        parity_assert_eq!("L:14aae917d0cb6dfa-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status, data) = app.auth_post_json("/admin/data/reset-seed", &session, json!({})).await?;
        parity_assert_eq!("L:321e301ed316b59e-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:e60dbb1e02d3b095-1", data.get("summary").is_some());
        parity_assert_eq!("L:d263c1081f30f0ef-1", data["summary"]["systems"], json!(2));
        let (status, _) = app.auth_get_json("/auth/me", &session).await?;
        parity_assert_eq!("L:57262116cc4d356c-1", status, reqwest::StatusCode::OK);
        Ok(())
    }).await?;
    // PROD gate in a fresh app.
    TestApp::run_with_env("admin_data_prod", &[("BREAKGLASS_DEV","PROD")], |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "ProdAdmin!2026").await?;
        let session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let (status, body) = app.auth_post_json("/admin/data/reset-seed", &session, json!({})).await?;
        parity_assert_eq!("L:e568055d8ef70348-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:d105d920c34ea7ae-1", body["error"].as_str().unwrap_or("").contains("BREAKGLASS_DEV"), true);
        Ok(())
    }).await
}
