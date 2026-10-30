//! Port of test/backend/deno/app_settings_providers.test.tsx (43 parity assertions).
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use std::sync::Mutex;
static ENV_LOCK: Mutex<()> = Mutex::new(());

async fn set(db_url: &str, key: &str, value: &str) -> Result<()> {
    let pool = sqlx::PgPool::connect(db_url).await?;
    sqlx::query("UPDATE app_settings SET value=$1 WHERE key=$2 AND organization_id IS NULL").bind(value).bind(key).execute(&pool).await?;
    ffs_server::app_settings::clear_cache();
    Ok(())
}

#[tokio::test]
async fn app_settings_providers_smtp_ses_env_cache() -> Result<()> {
    let _guard = ENV_LOCK.lock().unwrap();
    TestApp::run("app_settings_providers", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        let url = app.db_url().to_string();
        use ffs_server::app_settings::*;
        clear_cache();
        for k in ["smtp_host","smtp_port","smtp_username","smtp_password","smtp_from","smtp_secure","ses_region","ses_from_address","ses_configuration_set"] { set(&url,k,"").await?; }
        for k in ["smtp_host","smtp_port","smtp_username","smtp_password","smtp_from","smtp_secure","ses_region","ses_from_address","ses_configuration_set"] { set(&url,k,"").await?; }
        parity_assert_eq!("L:56ab1fe066f690c9-1", is_smtp_configured(&db).await?, false);
        parity_assert_eq!("L:bfea251903f29f93-1", get_smtp_host(&db).await?, None);
        parity_assert_eq!("L:acb47f3c50df477d-1", get_smtp_port(&db).await?, None);
        parity_assert_eq!("L:5714eb170624f4c1-1", get_smtp_username(&db).await?, None);
        parity_assert_eq!("L:ebe80ce227be916f-1", get_smtp_password(&db).await?, None);
        parity_assert_eq!("L:c3f390fd5cd98222-1", get_smtp_from(&db).await?, None);
        for (k,v) in [("smtp_host","smtp.example.gov"),("smtp_port","587"),("smtp_username","u"),("smtp_password","p"),("smtp_from","f@example.gov")] { set(&url,k,v).await?; }
        parity_assert_eq!("L:9f64e0065bb45a13-1", is_smtp_configured(&db).await?, true);
        parity_assert_eq!("L:a60ca8c50355554c-1", get_smtp_host(&db).await?, Some("smtp.example.gov".into()));
        parity_assert_eq!("L:93229e4bbeca6520-1", get_smtp_port(&db).await?, Some(587));
        for key in ["smtp_host","smtp_port","smtp_username","smtp_password","smtp_from"] {
            parity_assert_eq!("L:597f06c6433d823c-1", is_smtp_configured(&db).await?, true);
            let saved: String = sqlx::query_scalar(&format!("SELECT value FROM app_settings WHERE key='{key}' AND organization_id IS NULL")).fetch_one(app.db()).await?;
            set(&url,key,"").await?;
            parity_assert_eq!("L:58ebeb88b29ba1c7-1", is_smtp_configured(&db).await?, false);
            set(&url,key,&saved).await?;
        }
        parity_assert_eq!("L:947a899b2129da6e-1", get_smtp_secure(&db).await?, None);
        parity_assert_eq!("L:2884e155efb6459a-1", is_smtp_configured(&db).await?, true);
        set(&url,"smtp_secure","true").await?;
        parity_assert_eq!("L:8f30d10c6b9ec501-1", get_smtp_secure(&db).await?, Some(true));
        for raw in ["","yes","1","TRUE"] { set(&url,"smtp_secure",raw).await?; parity_assert_eq!("L:d4f54cabdd26bcdc-1", get_smtp_secure(&db).await?, None); }
        set(&url,"smtp_secure","false").await?;
        // SES
        for k in ["ses_region","ses_from_address","ses_configuration_set"] { set(&url,k,"").await?; }
        parity_assert_eq!("L:83e9cd5d8591241f-1", is_ses_configured(&db).await?, false);
        set(&url,"ses_region","ap-southeast-1").await?;
        parity_assert_eq!("L:b7a4c4b265b75cbd-1", is_ses_configured(&db).await?, false);
        set(&url,"ses_from_address","noreply@example.gov").await?;
        parity_assert_eq!("L:cb74a491a1e73dc8-1", is_ses_configured(&db).await?, true);
        parity_assert_eq!("L:b3e0bbf5fc8bc95f-1", get_ses_region(&db).await?, Some("ap-southeast-1".into()));
        parity_assert_eq!("L:6fd603d9f58953b8-1", get_ses_from_address(&db).await?, Some("noreply@example.gov".into()));
        parity_assert_eq!("L:177d6addca92521d-1", get_ses_configuration_set(&db).await?, None);
        parity_assert_eq!("L:cb74a491a1e73dc8-2", is_ses_configured(&db).await?, true);
        set(&url,"ses_configuration_set","primary").await?;
        parity_assert_eq!("L:13c916917f685a19-1", get_ses_configuration_set(&db).await?, Some("primary".into()));
        set(&url,"ses_region","").await?;
        parity_assert_eq!("L:b94f2965fa6c16c4-1", is_ses_configured(&db).await?, false);
        set(&url,"ses_region","ap-southeast-1").await?; set(&url,"ses_from_address","").await?;
        parity_assert_eq!("L:b94f2965fa6c16c4-2", is_ses_configured(&db).await?, false);
        set(&url,"ses_from_address","noreply@example.gov").await?;
        parity_assert_eq!("L:ea23c5e1cf0d6e4e-1", is_ses_configured(&db).await?, true);
        set(&url,"ses_configuration_set"," ").await?;
        parity_assert_eq!("L:2a5a8682ceefdcc8-1", get_ses_configuration_set(&db).await?, Some(" ".into()));
        // Env overrides
        set(&url,"email_delivery_enabled","false").await?;
        std::env::remove_var("EMAIL_DELIVERY_ENABLED");
        parity_assert_eq!("L:2e6c163be6474cb4-1", get_email_delivery_enabled(&db).await?, false);
        set(&url,"email_delivery_enabled","true").await?;
        parity_assert_eq!("L:752010a7080d953e-1", get_email_delivery_enabled(&db).await?, true);
        set(&url,"email_delivery_enabled","false").await?;
        std::env::set_var("EMAIL_DELIVERY_ENABLED","true");
        parity_assert_eq!("L:db409de874da4772-1", get_email_delivery_enabled(&db).await?, true);
        set(&url,"email_delivery_enabled","true").await?;
        std::env::set_var("EMAIL_DELIVERY_ENABLED","false");
        parity_assert_eq!("L:7eab34edcee50c4c-1", get_email_delivery_enabled(&db).await?, false);
        set(&url,"email_delivery_enabled","true").await?;
        std::env::set_var("EMAIL_DELIVERY_ENABLED","");
        parity_assert_eq!("L:34a0942788fb959c-1", get_email_delivery_enabled(&db).await?, true);
        for raw in ["1","yes","TRUE"] { std::env::set_var("EMAIL_DELIVERY_ENABLED",raw); set(&url,"email_delivery_enabled","false").await?; parity_assert_eq!("L:63ff136f795e09c0-1", get_email_delivery_enabled(&db).await?, false); }
        std::env::remove_var("EMAIL_DELIVERY_ENABLED");
        std::env::remove_var("EMAIL_DELIVERY_PROVIDER");
        set(&url,"email_delivery_provider","smtp").await?;
        parity_assert_eq!("L:841cd6a11bbabdb4-1", get_email_delivery_provider(&db).await?, "smtp");
        set(&url,"email_delivery_provider","ses").await?;
        parity_assert_eq!("L:0f2e8d266404856c-1", get_email_delivery_provider(&db).await?, "ses");
        set(&url,"email_delivery_provider","not-a-real-provider").await?;
        parity_assert_eq!("L:ce0fd2f90986f07d-1", get_email_delivery_provider(&db).await?, "not-a-real-provider");
        set(&url,"email_delivery_provider","smtp").await?;
        std::env::set_var("EMAIL_DELIVERY_PROVIDER","");
        parity_assert_eq!("L:a6663ca11d393167-1", get_email_delivery_provider(&db).await?, "smtp");
        std::env::remove_var("EMAIL_DELIVERY_PROVIDER");
        // Cache
        set(&url,"smtp_host","first.example.gov").await?;
        parity_assert_eq!("L:c1803a952ec870f6-1", get_smtp_host(&db).await?, Some("first.example.gov".into()));
        sqlx::query("UPDATE app_settings SET value='second.example.gov' WHERE key='smtp_host' AND organization_id IS NULL").execute(app.db()).await?;
        parity_assert_eq!("L:91bff292642fbeaf-1", get_smtp_host(&db).await?, Some("first.example.gov".into()));
        clear_cache();
        parity_assert_eq!("L:d3bac5ade70c6723-1", get_smtp_host(&db).await?, Some("second.example.gov".into()));
        set(&url,"smtp_host","").await?;
        parity_assert_eq!("L:926537203c4d9933-1", get_smtp_host(&db).await?, None);
        parity_assert_eq!("L:3791a17615aa4c89-1", get_smtp_host(&db).await?, None);
        parity_assert!("L:457e52a436b3c1f6-1", !is_smtp_configured(&db).await?);
        Ok(())
    }).await
}
