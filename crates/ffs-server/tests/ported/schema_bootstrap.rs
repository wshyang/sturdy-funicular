//! Port of test/backend/deno/schema_bootstrap.test.tsx (12 assertions).
//! The legacy suite calls schema-bootstrap helpers directly; the Rust port
//! exercises the same behavior through GET /setup and real database probes.

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
async fn list_available_sql_files_includes_known_files() -> Result<()> {
    TestApp::run("list_available_sql_files_includes_known_files", |app| async move {
        let (_, data) = app.get_json("/setup").await?;
        let files = &data["availableSqlFiles"];
        // parity-assert: L:53d9cc0290af5a2f-1
        assert!(includes(files, "001_schema.sql"));
        // parity-assert: L:34166a7449258ff8-1
        assert!(includes(files, "002_seed_demo.sql"));
        // parity-assert: L:de0be4368a1c04d7-1
        assert!(includes(files, "003_seed_demo_live.sql"));
        Ok(())
    })
    .await
}

#[tokio::test]
async fn apply_sql_file_rejects_path_traversal() -> Result<()> {
    TestApp::run("apply_sql_file_rejects_path_traversal", |app| async move {
        let (status, _) = app.get_json("/setup?file=..%2F..%2Fetc%2Fpasswd").await?;
        // parity-assert: L:807a7f643f625c47-1
        assert_eq!(status, StatusCode::BAD_REQUEST);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn apply_sql_file_rejects_nonexistent_filename() -> Result<()> {
    TestApp::run("apply_sql_file_rejects_nonexistent_filename", |app| async move {
        let (status, _) = app.get_json("/setup?file=003_evil.sql").await?;
        // parity-assert: L:33fda047a3b7c571-1
        assert_eq!(status, StatusCode::BAD_REQUEST);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn schema_is_applied_and_ensure_is_noop() -> Result<()> {
    TestApp::run("schema_is_applied_and_ensure_is_noop", |app| async move {
        let _ = app.get_json("/setup?file=001_schema.sql").await?;
        let applied = app
            .scalar_i64("SELECT (to_regclass('public.users') IS NOT NULL)::int::bigint")
            .await?;
        // parity-assert: L:a650abf7d11c0ccd-1
        assert_eq!(applied, 1);
        let (_, data) = app.get_json("/setup?file=001_schema.sql").await?;
        // parity-assert: L:d789b207220b9315-1
        assert_eq!(data["schemaJustBootstrapped"], false);
        Ok(())
    })
    .await
}

#[tokio::test]
async fn schema_bootstrap_detects_and_self_heals_schemaless_database() -> Result<()> {
    TestApp::run("schema_bootstrap_detects_and_self_heals_schemaless_database", |app| async move {
        app.drop_public_schema().await?;
        let before = app
            .scalar_i64("SELECT (to_regclass('public.users') IS NOT NULL)::int::bigint")
            .await?;
        // parity-assert: L:b2c4d7e61225e147-1
        assert_eq!(before, 0);

        let (status, data) = app.get_json("/setup?file=001_schema.sql").await?;
        if status != StatusCode::OK {
            anyhow::bail!("schema self-heal failed: {status} {data}");
        }
        // parity-assert: L:85337d9480e6fb09-1
        assert_eq!(data["schemaJustBootstrapped"], true);

        let after = app
            .scalar_i64("SELECT (to_regclass('public.users') IS NOT NULL)::int::bigint")
            .await?;
        // parity-assert: L:cbe6054df4ed6d83-1
        assert_eq!(after, 1);

        let user_count = app.scalar_i64("SELECT COUNT(*)::bigint FROM users").await?;
        // parity-assert: L:29692d57811fd0d6-1
        assert_eq!(user_count, 2);

        let system_count = app
            .scalar_i64("SELECT COUNT(*)::bigint FROM users WHERE is_system")
            .await?;
        // parity-assert: L:a23182e92e3d2d3c-1
        assert_eq!(system_count, 2);
        Ok(())
    })
    .await
}
