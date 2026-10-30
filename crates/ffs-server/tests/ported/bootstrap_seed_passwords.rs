//! Port of test/backend/deno/bootstrap_seed_passwords.test.tsx (4 assertions).

use anyhow::Result;
use ffs_test_support::TestApp;

#[tokio::test]
async fn breakglass_admin_password_falls_back_when_unset() -> Result<()> {
    TestApp::run("breakglass_admin_password_falls_back_when_unset", |app| async move {
        let (_, data) = app.get_json("/setup").await?;
        // parity-assert: L:894a38075e5e0d38-1
        assert_eq!(data["password"], "BreakGlass@2026Admin");
        Ok(())
    })
    .await
}

#[tokio::test]
async fn breakglass_admin_password_honours_env_override() -> Result<()> {
    TestApp::run_with_env(
        "breakglass_admin_password_honours_env_override",
        &[("BREAKGLASS_ADMIN_PASSWORD", "CustomAdminPass!2026")],
        |app| async move {
            let (_, data) = app.get_json("/setup").await?;
            // parity-assert: L:6375f03d9e153f98-1
            assert_eq!(data["password"], "CustomAdminPass!2026");
            Ok(())
        },
    )
    .await
}

#[test]
fn demo_seed_password_falls_back_and_honours_env_override() {
    std::env::remove_var("DEMO_SEED_PASSWORD");
    // parity-assert: L:1aa5fda3558ed072-1
    assert_eq!(ffs_server::bootstrap::get_demo_seed_password(), "Password@2026");

    std::env::set_var("DEMO_SEED_PASSWORD", "CustomDemoPass!2026");
    // parity-assert: L:0165d12b59e75e61-1
    assert_eq!(ffs_server::bootstrap::get_demo_seed_password(), "CustomDemoPass!2026");
    std::env::remove_var("DEMO_SEED_PASSWORD");
}
