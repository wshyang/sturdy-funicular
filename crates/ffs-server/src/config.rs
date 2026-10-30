// Application configuration from environment variables.
// Mirrors the env var usage across server/app-middleware.tsx, server/pg.tsx, server/auth.tsx.

use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub database_url: String,
    pub port: u16,
    pub frontend_url: Option<String>,
    pub app_env: AppEnv,
    /// Session secret for signing cookies (min 32 bytes hex-encoded).
    pub session_secret: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AppEnv {
    Dev,
    Prod,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        // Load .env if present (dev only — prod injects env directly).
        let _ = dotenvy::dotenv();

        let database_url = std::env::var("DATABASE_URL")
            .context("DATABASE_URL is not set. Copy .env.example to .env and fill in a Postgres connection string.")?;

        let port = std::env::var("PORT")
            .ok()
            .and_then(|v| v.parse::<u16>().ok())
            .unwrap_or(8787);

        let frontend_url = std::env::var("FRONTEND_URL").ok();

        let app_env = match std::env::var("APP_ENV").as_deref() {
            Ok("prod" | "production") => AppEnv::Prod,
            _ => AppEnv::Dev,
        };

        let session_secret = std::env::var("SESSION_SECRET").unwrap_or_else(|_| {
            // Dev fallback — a fixed key. NEVER use in prod.
            "dev-session-secret-do-not-use-in-production-12345678".to_string()
        });

        Ok(Config {
            database_url,
            port,
            frontend_url,
            app_env,
            session_secret,
        })
    }

    pub fn is_https(&self) -> bool {
        self.app_env == AppEnv::Prod
    }
}

impl axum::extract::FromRef<(Config, sea_orm::DatabaseConnection)> for Config {
    fn from_ref(state: &(Config, sea_orm::DatabaseConnection)) -> Self {
        state.0.clone()
    }
}
