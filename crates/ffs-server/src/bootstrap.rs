//! Env-driven bootstrap/seed password resolution (addendum-095 Finding #6).
//! Mirrors server/bootstrap.tsx and server/seed.tsx.

pub fn get_breakglass_admin_password() -> String {
    std::env::var("BREAKGLASS_ADMIN_PASSWORD")
        .unwrap_or_else(|_| "BreakGlass@2026Admin".to_string())
}

pub fn get_demo_seed_password() -> String {
    std::env::var("DEMO_SEED_PASSWORD").unwrap_or_else(|_| "Password@2026".to_string())
}

/// Startup initialization seam (legacy initializeApplication). Runs before the
/// server binds/listens so demo seeding can never race the first request.
pub async fn initialize_application(_db: &sea_orm::DatabaseConnection) -> anyhow::Result<()> {
    Ok(())
}

/// Applies the live demo seed only when explicitly enabled. Default test/dev
/// spawns leave this off; the startup-order contract is still enforced.
pub async fn run_demo_seed_if_enabled(db: &sea_orm::DatabaseConnection) -> anyhow::Result<()> {
    if std::env::var("DEMO_SEED_ENABLED").ok().as_deref() != Some("true") {
        return Ok(());
    }
    let sql = std::fs::read_to_string("setup/sql/003_seed_demo_live.sql")?;
    use sea_orm::ConnectionTrait;
    db.execute(sea_orm::Statement::from_string(
        sea_orm::DatabaseBackend::Postgres,
        sql,
    ))
    .await?;
    Ok(())
}
