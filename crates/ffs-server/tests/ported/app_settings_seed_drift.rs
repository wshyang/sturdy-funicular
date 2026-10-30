//! Port of test/backend/deno/app_settings_seed_drift.test.tsx (3 parity assertions).
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};
use sqlx::Row;

#[tokio::test]
async fn app_settings_seed_drift() -> Result<()> {
    TestApp::run("app_settings_seed_drift", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let rows = sqlx::query("SELECT key FROM app_settings WHERE organization_id IS NULL").fetch_all(app.db()).await?;
        let seeded: std::collections::HashSet<String> = rows.iter().map(|r| r.try_get::<String,_>("key").unwrap()).collect();
        let missing: Vec<&str> = ffs_server::app_settings::DEFAULTS.iter().map(|d| d.0).filter(|k| !seeded.contains(*k)).collect();
        parity_assert_eq!("L:54bcefd8e693bb9f-1", missing, Vec::<&str>::new());
        let rows = sqlx::query("SELECT value FROM app_settings WHERE key='email_delivery_provider' AND organization_id IS NULL").fetch_all(app.db()).await?;
        parity_assert_eq!("L:55a936b075b3f851-1", rows.len(), 1);
        parity_assert_eq!("L:487f073910337feb-1", rows[0].try_get::<String,_>("value")?, "disabled");
        Ok(())
    }).await
}
