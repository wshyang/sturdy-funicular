//! Port of test/backend/deno/app_settings_helper.test.tsx (9 parity assertions).
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};

#[tokio::test]
async fn app_settings_helper_resolution_and_cache() -> Result<()> {
    TestApp::run("app_settings_helper", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        ffs_server::app_settings::clear_cache();
        let ttl = ffs_server::app_settings::get_setting(&db, "session_ttl_ms").await?;
        parity_assert_eq!("L:426d868fc0bd981d-1", ttl.is_number(), true);
        parity_assert_eq!("L:32c9057e80d12aeb-1", ttl.as_i64().unwrap(), 86_400_000);
        sqlx::query("UPDATE app_settings SET value='9' WHERE key='max_login_attempts' AND organization_id IS NULL").execute(app.db()).await?;
        ffs_server::app_settings::clear_cache();
        parity_assert_eq!("L:4fc00b33271307ff-1", ffs_server::app_settings::get_setting_int(&db, "max_login_attempts").await?, 9);
        sqlx::query("DELETE FROM app_settings WHERE key='max_login_attempts' AND organization_id IS NULL").execute(app.db()).await?;
        ffs_server::app_settings::clear_cache();
        parity_assert_eq!("L:fc652c72f48584c2-1", ffs_server::app_settings::get_setting_int(&db, "max_login_attempts").await?, 5);
        parity_assert_eq!("L:2fa09831efb4345d-1", ffs_server::app_settings::get_setting_int(&db, "password_min_length").await?, 12);
        let enabled = ffs_server::app_settings::get_email_delivery_enabled(&db).await?;
        parity_assert_eq!("L:1c9f241fa83326e6-1", enabled, false);
        let unknown = ffs_server::app_settings::get_setting(&db, "totally_unknown_key").await;
        parity_assert_eq!("L:2d963e7b4c870f5e-1", unknown.is_err(), true);
        parity_assert_eq!("L:7b8360d2e3065f91-1", ffs_server::app_settings::get_entra_private_key_pem(&db).await?, None);
        let pem = "-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----";
        sqlx::query("UPDATE app_settings SET value=$1 WHERE key='entra_client_key_pem_base64' AND organization_id IS NULL").bind(pem).execute(app.db()).await?;
        ffs_server::app_settings::clear_cache();
        parity_assert_eq!("L:b72990e82996f419-1", ffs_server::app_settings::get_entra_private_key_pem(&db).await?, Some(pem.to_string()));
        Ok(())
    }).await
}
