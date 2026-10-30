// Database connection pool with SeaORM.
// Injects -c timezone=UTC startup GUC (mirrors pg.tsx:18-26).
// All handlers receive the pool via axum State; transaction handles
// are threaded explicitly via TxHandle in request extensions.

use anyhow::{Context, Result};
use sea_orm::{ConnectOptions, Database, DatabaseConnection};
use std::time::Duration;

/// Build a SeaORM connection pool from DATABASE_URL, injecting timezone=UTC.
pub async fn connect(database_url: &str) -> Result<DatabaseConnection> {
    let url = inject_timezone_utc(database_url)?;

    let mut opts = ConnectOptions::new(url);
    opts.max_connections(10)
        .min_connections(2)
        .connect_timeout(Duration::from_secs(10))
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(300))
        .max_lifetime(Duration::from_secs(1800))
        .sqlx_logging(false); // use tracing layer instead

    let conn = Database::connect(opts)
        .await
        .context("Failed to connect to database")?;

    // Verify the UTC GUC took effect.
    verify_utc_timezone(&conn).await?;

    Ok(conn)
}

/// Inject `-c timezone=UTC` into the Postgres connection string as a startup option.
/// Mirrors pg.tsx buildPoolUrl: appends to existing `options` param if present.
fn inject_timezone_utc(base_url: &str) -> Result<String> {
    let mut url = url::Url::parse(base_url).context("Invalid DATABASE_URL")?;

    let tz_opt = "-c timezone=UTC";
    let existing = url
        .query_pairs()
        .find(|(k, _)| k == "options")
        .map(|(_, v)| v.to_string())
        .unwrap_or_default();

    if !existing.contains("timezone=UTC") {
        let new_options = if existing.is_empty() {
            tz_opt.to_string()
        } else {
            format!("{existing} {tz_opt}")
        };
        // Rebuild query pairs without modifying existing params.
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(k, _)| k != "options")
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        {
            let mut query = url.query_pairs_mut();
            query.clear();
            for (k, v) in pairs {
                query.append_pair(&k, &v);
            }
            query.append_pair("options", &new_options);
        }
    }

    Ok(url.to_string())
}

/// Hard-fail startup if the connection is NOT running UTC.
/// Silent corruption trap: a UTC+8 host stores timestamps 8h behind without this.
async fn verify_utc_timezone(conn: &DatabaseConnection) -> Result<()> {
    use sea_orm::Statement;
    use sea_orm::ConnectionTrait;

    let result = conn
        .query_one(Statement::from_string(
            sea_orm::DatabaseBackend::Postgres,
            "SHOW timezone",
        ))
        .await?;

    if let Some(row) = result {
        let tz: String = row.try_get("", "TimeZone")?;
        if !tz.to_uppercase().contains("UTC") {
            anyhow::bail!(
                "Database timezone is '{}', expected UTC. \
                 Check the DATABASE_URL options parameter.",
                tz
            );
        }
    }
    Ok(())
}
