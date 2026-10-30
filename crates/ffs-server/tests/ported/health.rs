//! Port of test/backend/deno/health.test.tsx (22 assertions).

use anyhow::Result;
use ffs_test_support::TestApp;
use reqwest::StatusCode;
use serde_json::Value;

fn includes(files: &Value, name: &str) -> bool {
    files
        .as_array()
        .map(|arr| arr.iter().any(|v| v.as_str() == Some(name)))
        .unwrap_or(false)
}

#[tokio::test]
async fn health_reports_ok() -> Result<()> {
    TestApp::run("health_reports_ok", |app| async move {
        let (status, data) = app.get_json("/health").await?;
        // parity-assert: L:9e31d1670693244e-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:2476a2adf11fd5cf-1
        assert_eq!(data["status"], "ok");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn setup_self_heals_schemaless_database() -> Result<()> {
    TestApp::run("setup_self_heals_schemaless_database", |app| async move {
        app.drop_public_schema().await?;
        let (status, data) = app.get_json("/setup").await?;
        // parity-assert: L:5c20d22ae1449139-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:3e6f9d03e4ac94a2-1
        assert_eq!(data["schemaJustBootstrapped"], true);
        // parity-assert: L:96785c41ae323141-1
        assert!(!data["message"].is_null());
        let count = app.scalar_i64("SELECT COUNT(*)::bigint FROM users").await?;
        // parity-assert: L:f715fde9bbad7d90-1
        assert!(count > 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn setup_creates_default_admin_when_no_users() -> Result<()> {
    TestApp::run("setup_creates_default_admin_when_no_users", |app| async move {
        // Prepare schema without creating the default admin.
        let (prepare_status, _) = app.get_json("/setup?file=001_schema.sql").await?;
        if prepare_status != StatusCode::OK {
            anyhow::bail!("schema preparation failed: {prepare_status}");
        }
        let (status, data) = app.get_json("/setup").await?;
        // parity-assert: L:f964025153fcc569-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:6bcd01b88c920837-1
        assert!(!data["message"].is_null());
        // parity-assert: L:e5a229a9dad17df6-1
        assert_eq!(data["schemaJustBootstrapped"], false);
        // parity-assert: L:89fc2829ea0c6570-1
        assert!(includes(&data["availableSqlFiles"], "001_schema.sql"));
        // parity-assert: L:e431b36729ac7160-1
        assert!(includes(&data["availableSqlFiles"], "002_seed_demo.sql"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn setup_reports_user_count_when_users_exist() -> Result<()> {
    TestApp::run("setup_reports_user_count_when_users_exist", |app| async move {
        let _ = app.get_json("/setup").await?;
        let (status, data) = app.get_json("/setup").await?;
        // parity-assert: L:f908f5dff2ddd449-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:92fb76b1c45a64d7-1
        assert!(data["userCount"].is_number());
        // parity-assert: L:785f2a9acf315b18-1
        assert!(data["userCount"].as_i64().unwrap_or(0) > 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn setup_rejects_file_once_users_exist() -> Result<()> {
    TestApp::run("setup_rejects_file_once_users_exist", |app| async move {
        let _ = app.get_json("/setup").await?;
        let (status, data) = app.get_json("/setup?file=002_seed_demo.sql").await?;
        // parity-assert: L:9c921c2eff87281e-1
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // parity-assert: L:ff8e100bbd55e1db-1
        assert!(!data["error"].is_null());
        Ok(())
    })
    .await
}

#[tokio::test]
async fn setup_applies_chosen_file_with_zero_users() -> Result<()> {
    TestApp::run("setup_applies_chosen_file_with_zero_users", |app| async move {
        let (status, data) = app.get_json("/setup?file=002_seed_demo.sql").await?;
        // parity-assert: L:109c58e9dd8ae6db-1
        assert_eq!(status, StatusCode::OK);
        // parity-assert: L:28ee525e77644942-1
        assert_eq!(data["appliedFile"], "002_seed_demo.sql");
        let admin_count = app
            .scalar_i64("SELECT COUNT(*)::bigint FROM users WHERE email = 'admin@breakglass.local'")
            .await?;
        // parity-assert: L:f0c050c7a5ee14bf-1
        assert_eq!(admin_count, 0);
        let demo_count = app
            .scalar_i64("SELECT COUNT(*)::bigint FROM users WHERE NOT is_system")
            .await?;
        // parity-assert: L:04118c5313e6e444-1
        assert!(demo_count > 0);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn setup_rejects_unknown_filename() -> Result<()> {
    TestApp::run("setup_rejects_unknown_filename", |app| async move {
        let (status, data) = app.get_json("/setup?file=003_evil.sql").await?;
        // parity-assert: L:dfa2d779104c76a1-1
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // parity-assert: L:2d6b316ed3d0c2eb-1
        assert!(!data["error"].is_null());
        Ok(())
    })
    .await
}
