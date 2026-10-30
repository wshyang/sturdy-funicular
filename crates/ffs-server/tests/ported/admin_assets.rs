//! Port of test/backend/deno/admin_assets.test.tsx (68 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_server::aws::asset_inventory::{reconcile_asset_inventory, InventoryResponse, InventoryResponseAssetEntry};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

fn entry(h: &str, c: &str, t: &str) -> InventoryResponseAssetEntry {
    InventoryResponseAssetEntry { hostname: h.into(), credential_name: c.into(), credential_type: t.into() }
}
fn resp(system: Uuid, status: &str, assets: Option<Vec<InventoryResponseAssetEntry>>, err: Option<&str>) -> InventoryResponse {
    InventoryResponse { schema_version: "1.0".into(), system_id: system.to_string(), status: status.into(), assets, error_message: err.map(str::to_string), processed_at: String::new() }
}
async fn asset_row(app: &TestApp, system: Uuid, hostname: &str) -> Result<Option<sqlx::postgres::PgRow>> {
    Ok(sqlx::query("SELECT id, system_managed, expires_after, credential_type::TEXT AS credential_type, hostname, credential_name FROM assets WHERE system_id=$1 AND hostname=$2 ORDER BY created_at DESC LIMIT 1")
        .bind(system).bind(hostname).fetch_optional(app.db()).await?)
}

#[tokio::test]
async fn admin_assets_crud_sync_and_reconcile() -> Result<()> {
    TestApp::run("admin_assets", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "AssetAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let sea = sea_orm::Database::connect(app.db_url()).await?;
        let vendor = fixtures::create_active_user(&app, "AssetVendor", &fixtures::unique_email("assetvendor"), "VendorPass!2026", "vendor", true).await?;
        let vendor_session = fixtures::session_of(&fixtures::login_user(&app, &vendor).await?)?;

        let owner = fixtures::create_active_user(&app,"AssetOwner1",&fixtures::unique_email("assetowner1"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        fixtures::create_asset(&app,w.system_id,"host-a").await?;
        let (status,data) = app.auth_get_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session).await?;
        parity_assert_eq!("L:d26043d7c6dc8b28-1", status, reqwest::StatusCode::OK);
        parity_assert!("L:72fe4c6db9fb38dd-1", data["assets"].as_array().unwrap().iter().any(|a| a["hostname"]=="host-a"));
        let (status,_) = app.auth_get_json(&format!("/admin/systems/{}/assets",w.system_id),&vendor_session).await?;
        parity_assert_eq!("L:f63cae7e5418f665-1", status, reqwest::StatusCode::FORBIDDEN);
        let (status,_) = app.auth_get_json("/admin/systems/00000000-0000-0000-0000-000000000999/assets",&admin_session).await?;
        parity_assert_eq!("L:f9737053c06793f1-1", status, reqwest::StatusCode::NOT_FOUND);

        let owner = fixtures::create_active_user(&app,"AssetOwner3",&fixtures::unique_email("assetowner3"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (status,data) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,
            json!({"hostname":"host-b","credentialName":"cred-b","credentialType":"token","systemManaged":true,"description":"Staging DB read-only cred","managementMode":"manual"})).await?;
        parity_assert_eq!("L:2e177b1482400f65-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:f470029857c92c55-1", data["asset"]["systemManaged"], json!(false));
        parity_assert_eq!("L:c2160b55bcf277d3-1", data["asset"]["credentialType"], json!("token"));
        parity_assert_eq!("L:552793481c7ebba1-1", data["asset"]["description"], json!("Staging DB read-only cred"));
        let (status,data) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,
            json!({"hostname":"host-nodesc","credentialName":"cred-nodesc","managementMode":"manual"})).await?;
        parity_assert_eq!("L:2468df131e441735-1", status, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:7a62aeda92f96ee6-1", data["asset"]["description"], json!(null));
        let (status,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&vendor_session,json!({"hostname":"host-x","credentialName":"cred-x"})).await?;
        parity_assert_eq!("L:273ee1f10f2dee84-1", status, reqwest::StatusCode::FORBIDDEN);
        let n: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM assets WHERE system_id=$1").bind(w.system_id).fetch_one(app.db()).await?;
        // two manual assets above already exist; the non-admin add must not add a third
        parity_assert_eq!("L:eaca30477ed8c44b-1", n, 2);
        let (status,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"credentialName":"cred-c"})).await?;
        parity_assert_eq!("L:705158cc6daeb911-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"host-d","credentialName":"cred-d","credentialType":"bogus"})).await?;
        parity_assert_eq!("L:323e4cc429a3d4dd-1", status, reqwest::StatusCode::BAD_REQUEST);

        let owner = fixtures::create_active_user(&app,"AssetOwner7",&fixtures::unique_email("assetowner7"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (first,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"host-e","credentialName":"cred-e","managementMode":"manual"})).await?;
        let (second,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"host-e","credentialName":"cred-e","managementMode":"manual"})).await?;
        parity_assert_eq!("L:caf854bbda98786d-1", first, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:f80213143dca61b7-1", second, reqwest::StatusCode::BAD_REQUEST);

        let owner = fixtures::create_active_user(&app,"AssetMultiSvc",&fixtures::unique_email("assetmultisvc"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (a,a_json) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"app-1","credentialName":"root","service":"ssh","managementMode":"manual"})).await?;
        let (b,b_json) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"app-1","credentialName":"root","service":"Admin Web UI","managementMode":"manual"})).await?;
        parity_assert_eq!("L:917dbe26bf7d85d6-1", a, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:e482173913ac607e-1", b, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:97a7120de3df3f77-1", a_json["asset"]["service"], json!("ssh"));
        parity_assert_eq!("L:c99118400b43ab0a-1", b_json["asset"]["service"], json!("Admin Web UI"));
        parity_assert!("L:28b1666ccf2e74b4-1", a_json["asset"]["id"] != b_json["asset"]["id"]);
        let (dup,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"app-1","credentialName":"root","service":"ssh","managementMode":"manual"})).await?;
        parity_assert_eq!("L:7a07a77e82bae98b-1", dup, reqwest::StatusCode::BAD_REQUEST);

        let owner = fixtures::create_active_user(&app,"AssetNullSvc",&fixtures::unique_email("assetnullsvc"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (def,def_json) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"db-1","credentialName":"appuser","service":"","managementMode":"manual"})).await?;
        parity_assert_eq!("L:d4bbe3b9aaf4f5b3-1", def, reqwest::StatusCode::CREATED);
        parity_assert_eq!("L:10f807aa3e24dabc-1", def_json["asset"]["service"], json!(null));
        let (named,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"db-1","credentialName":"appuser","service":"Postgres","managementMode":"manual"})).await?;
        parity_assert_eq!("L:97d7fb6f40fee949-1", named, reqwest::StatusCode::CREATED);
        let (def_dup,_) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"db-1","credentialName":"appuser","managementMode":"manual"})).await?;
        parity_assert_eq!("L:34a0a8a7ce042477-1", def_dup, reqwest::StatusCode::BAD_REQUEST);

        let owner = fixtures::create_active_user(&app,"AssetOwner8",&fixtures::unique_email("assetowner8"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (_,created) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"host-f","credentialName":"cred-f","managementMode":"manual"})).await?;
        let aid = created["asset"]["id"].as_str().unwrap().to_string();
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/admin/systems/{}/assets/{}",w.system_id,aid),&admin_session,json!({"hostname":"changed"})).await?;
        parity_assert_eq!("L:251eeccfa8a073a5-1", status, reqwest::StatusCode::BAD_REQUEST);
        let still = asset_row(&app,w.system_id,"host-f").await?;
        parity_assert_eq!("L:bce5790f40a505ea-1", still.unwrap().try_get::<String,_>("hostname")?, "host-f");
        let (status,data) = app.auth_send_json(Method::PUT,&format!("/admin/systems/{}/assets/{}",w.system_id,aid),&admin_session,json!({"expiresAfter":null})).await?;
        parity_assert_eq!("L:0c1c64daac82c5cd-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:ebac37b32a2fd386-1", data["asset"]["expiresAfter"], json!(null));
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/admin/systems/{}/assets/{}",w.system_id,aid),&vendor_session,json!({"expiresAfter":null})).await?;
        parity_assert_eq!("L:b5fbd1f27f4d0874-1", status, reqwest::StatusCode::FORBIDDEN);

        let owner = fixtures::create_active_user(&app,"AssetOwner10",&fixtures::unique_email("assetowner10"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let managed = Uuid::now_v7();
        sqlx::query("INSERT INTO assets (id,system_id,system_managed,credential_type,hostname,credential_name) VALUES ($1,$2,true,'password','host-managed','cred-managed')").bind(managed).bind(w.system_id).execute(app.db()).await?;
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/admin/systems/{}/assets/{}",w.system_id,managed),&admin_session,json!({"hostname":"should-not-change"})).await?;
        parity_assert_eq!("L:2ecbbcf051928d4e-1", status, reqwest::StatusCode::BAD_REQUEST);
        let still = asset_row(&app,w.system_id,"host-managed").await?;
        parity_assert_eq!("L:f0a3a0b821b30ec6-1", still.unwrap().try_get::<String,_>("hostname")?, "host-managed");

        let owner_a = fixtures::create_active_user(&app,"AssetOwnerA",&fixtures::unique_email("assetownera"),"OwnerPass!2026","agency",true).await?;
        let wa = fixtures::create_wired_system(&app,admin.id,&owner_a).await?;
        let owner_b = fixtures::create_active_user(&app,"AssetOwnerB",&fixtures::unique_email("assetownerb"),"OwnerPass!2026","agency",true).await?;
        let wb = fixtures::create_wired_system(&app,admin.id,&owner_b).await?;
        let (_,created) = app.auth_post_json(&format!("/admin/systems/{}/assets",wb.system_id),&admin_session,json!({"hostname":"host-h","credentialName":"cred-h","managementMode":"manual"})).await?;
        let aid = created["asset"]["id"].as_str().unwrap();
        let (status,_) = app.auth_send_json(Method::PUT,&format!("/admin/systems/{}/assets/{}",wa.system_id,aid),&admin_session,json!({"expiresAfter":null})).await?;
        parity_assert_eq!("L:510437469aad28dc-1", status, reqwest::StatusCode::NOT_FOUND);

        let owner = fixtures::create_active_user(&app,"AssetOwner11",&fixtures::unique_email("assetowner11"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (_,created) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"host-i","credentialName":"cred-i","managementMode":"manual"})).await?;
        let aid = created["asset"]["id"].as_str().unwrap().to_string();
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/admin/systems/{}/assets/{}",w.system_id,aid),&admin_session,json!({})).await?;
        parity_assert_eq!("L:3b0595e7aafc145c-1", status, reqwest::StatusCode::OK);
        let still = asset_row(&app,w.system_id,"host-i").await?;
        parity_assert!("L:68a054e6bc5dcd25-1", still.is_some());
        let still = still.unwrap();
        parity_assert!("L:b4e7d17cfbbfa944-1", still.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_some());
        parity_assert_eq!("L:65a673cd21db7a49-1", still.try_get::<String,_>("hostname")?, "host-i");
        // re-create a fresh manual asset to prove non-admin delete left it live
        let (_,created2) = app.auth_post_json(&format!("/admin/systems/{}/assets",w.system_id),&admin_session,json!({"hostname":"host-j","credentialName":"cred-j","managementMode":"manual"})).await?;
        let aid2 = created2["asset"]["id"].as_str().unwrap().to_string();
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/admin/systems/{}/assets/{}",w.system_id,aid2),&vendor_session,json!({})).await?;
        parity_assert_eq!("L:100adb915600b181-1", status, reqwest::StatusCode::FORBIDDEN);
        let still = asset_row(&app,w.system_id,"host-j").await?;
        parity_assert!("L:5807493c67140195-1", still.unwrap().try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_none());

        let owner = fixtures::create_active_user(&app,"AssetOwner13",&fixtures::unique_email("assetowner13"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let managed2 = Uuid::now_v7();
        sqlx::query("INSERT INTO assets (id,system_id,system_managed,credential_type,hostname,credential_name) VALUES ($1,$2,true,'password','host-managed2','cred-managed2')").bind(managed2).bind(w.system_id).execute(app.db()).await?;
        let (status,_) = app.auth_send_json(Method::DELETE,&format!("/admin/systems/{}/assets/{}",w.system_id,managed2),&admin_session,json!({})).await?;
        parity_assert_eq!("L:653ca4301e192bbe-1", status, reqwest::StatusCode::OK);
        let still = asset_row(&app,w.system_id,"host-managed2").await?;
        parity_assert!("L:d813a59f6f87e39a-1", still.is_some());
        parity_assert!("L:773867fc1ec66e1e-1", still.unwrap().try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_some());

        let owner = fixtures::create_active_user(&app,"AssetOwner14",&fixtures::unique_email("assetowner14"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (status,_) = app.auth_post_json(&format!("/admin/systems/{}/assets/sync",w.system_id),&vendor_session,json!({})).await?;
        parity_assert_eq!("L:8d4be0ccaad26ca5-1", status, reqwest::StatusCode::FORBIDDEN);
        sqlx::query("UPDATE systems SET aws_role_arn_note='arn:aws:iam::123456789012:role/example' WHERE id=$1").bind(w.system_id).execute(app.db()).await?;
        let (status,_) = app.auth_post_json(&format!("/admin/systems/{}/assets/sync",w.system_id),&admin_session,json!({})).await?;
        parity_assert_eq!("L:30207fd346c40b72-1", status, reqwest::StatusCode::BAD_REQUEST);
        let owner = fixtures::create_active_user(&app,"AssetOwner16",&fixtures::unique_email("assetowner16"),"OwnerPass!2026","agency",true).await?;
        let w2 = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let (status,_) = app.auth_post_json(&format!("/admin/systems/{}/assets/sync",w2.system_id),&admin_session,json!({})).await?;
        parity_assert_eq!("L:72971b1fd40892c3-1", status, reqwest::StatusCode::BAD_REQUEST);
        let (status,_) = app.auth_post_json("/admin/systems/00000000-0000-0000-0000-000000000999/assets/sync",&admin_session,json!({})).await?;
        parity_assert_eq!("L:6907c700cfadfc95-1", status, reqwest::StatusCode::NOT_FOUND);

        // reconcile: create
        let owner = fixtures::create_active_user(&app,"ReconOwner1",&fixtures::unique_email("reconowner1"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"success",Some(vec![entry("recon-host-1","recon-cred-1","password")]),None)).await?;
        let found = asset_row(&app,w.system_id,"recon-host-1").await?;
        parity_assert!("L:430069f209a77ba8-1", found.is_some());
        let found = found.unwrap();
        parity_assert_eq!("L:67cf2abbfa1ad3af-1", found.try_get::<bool,_>("system_managed")?, true);
        parity_assert!("L:e6f01034827365dc-1", found.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_none());

        // reconcile: expire when absent
        let owner = fixtures::create_active_user(&app,"ReconOwner2",&fixtures::unique_email("reconowner2"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"success",Some(vec![entry("recon-host-2","recon-cred-2","password")]),None)).await?;
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"success",Some(vec![]),None)).await?;
        let found = asset_row(&app,w.system_id,"recon-host-2").await?;
        parity_assert!("L:2f01d3c36e4f42e8-1", found.is_some());
        parity_assert!("L:4fdaca35a27d0d58-1", found.unwrap().try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_some());

        // reconcile: revive
        let owner = fixtures::create_active_user(&app,"ReconOwner3",&fixtures::unique_email("reconowner3"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let present = resp(w.system_id,"success",Some(vec![entry("recon-host-3","recon-cred-3","password")]),None);
        reconcile_asset_inventory(&sea,w.system_id,&present).await?;
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"success",Some(vec![]),None)).await?;
        let after_loss = asset_row(&app,w.system_id,"recon-host-3").await?;
        parity_assert!("L:7a3d001df47facf8-1", after_loss.unwrap().try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_some());
        reconcile_asset_inventory(&sea,w.system_id,&present).await?;
        let found = asset_row(&app,w.system_id,"recon-host-3").await?;
        parity_assert!("L:8c350b0040ef63d3-1", found.is_some());
        parity_assert!("L:99b135b51954db5f-1", found.unwrap().try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_none());

        // reconcile: manual untouched
        let owner = fixtures::create_active_user(&app,"ReconOwner4",&fixtures::unique_email("reconowner4"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let manual = Uuid::now_v7();
        sqlx::query("INSERT INTO assets (id,system_id,system_managed,credential_type,hostname,credential_name) VALUES ($1,$2,false,'password','manual-host','manual-cred')").bind(manual).bind(w.system_id).execute(app.db()).await?;
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"success",Some(vec![]),None)).await?;
        let still = asset_row(&app,w.system_id,"manual-host").await?;
        parity_assert!("L:c514874ed10b675d-1", still.is_some());
        parity_assert!("L:b75c3ef5e70d3c32-1", still.unwrap().try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_none());

        // reconcile: identity immutable across loss/return
        let owner = fixtures::create_active_user(&app,"ReconOwner6",&fixtures::unique_email("reconowner6"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let present = resp(w.system_id,"success",Some(vec![entry("recon-host-immutable","recon-cred-immutable","password")]),None);
        reconcile_asset_inventory(&sea,w.system_id,&present).await?;
        let before_loss = asset_row(&app,w.system_id,"recon-host-immutable").await?.unwrap();
        let before_id: Uuid = before_loss.try_get("id")?;
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"success",Some(vec![]),None)).await?;
        let after_loss = asset_row(&app,w.system_id,"recon-host-immutable").await?.unwrap();
        parity_assert!("L:85843bf8f331eb9c-1", after_loss.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_some());
        parity_assert_eq!("L:feb48eb9486241ef-1", after_loss.try_get::<String,_>("hostname")?, "recon-host-immutable");
        parity_assert_eq!("L:cbd52843b7a29ac4-1", after_loss.try_get::<String,_>("credential_name")?, "recon-cred-immutable");
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"success",Some(vec![entry("recon-host-immutable","recon-cred-immutable","token")]),None)).await?;
        let after_return = asset_row(&app,w.system_id,"recon-host-immutable").await?.unwrap();
        parity_assert!("L:776d5b7fa25f036f-1", after_return.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_none());
        parity_assert_eq!("L:16f888ce522760ee-1", after_return.try_get::<String,_>("credential_type")?, "token");
        parity_assert_eq!("L:5afe5a077b7d8209-1", after_return.try_get::<String,_>("hostname")?, "recon-host-immutable");
        parity_assert_eq!("L:2af5a628a731daf2-1", after_return.try_get::<String,_>("credential_name")?, "recon-cred-immutable");
        parity_assert_eq!("L:ca491a2d05a7d149-1", after_return.try_get::<Uuid,_>("id")?, before_id);

        // reconcile: error leaves assets + audits + emails owner
        let owner = fixtures::create_active_user(&app,"ReconOwner5",&fixtures::unique_email("reconowner5"),"OwnerPass!2026","agency",true).await?;
        let w = fixtures::create_wired_system(&app,admin.id,&owner).await?;
        let managed = Uuid::now_v7();
        sqlx::query("INSERT INTO assets (id,system_id,system_managed,credential_type,hostname,credential_name) VALUES ($1,$2,true,'password','recon-host-err','recon-cred-err')").bind(managed).bind(w.system_id).execute(app.db()).await?;
        reconcile_asset_inventory(&sea,w.system_id,&resp(w.system_id,"error",None,Some("tenant unreachable"))).await?;
        let still = asset_row(&app,w.system_id,"recon-host-err").await?;
        parity_assert!("L:29ae5cb6495697e0-1", still.unwrap().try_get::<Option<chrono::DateTime<chrono::FixedOffset>>,_>("expires_after")?.is_none());
        let email = fixtures::latest_notification_emails(&app,"asset_inventory.sync_failed").await?;
        parity_assert!("L:e7dbd2bcb4f5c18f-1", email.is_some());
        parity_assert_eq!("L:9385acd6c2ad5919-1", email.unwrap(), vec![owner.email.clone()]);
        Ok(())
    }).await
}
