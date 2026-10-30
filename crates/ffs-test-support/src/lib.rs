//! Black-box harness for ported legacy backend suites.
//!
//! Each test leases a dedicated Postgres database, spawns the real `ffs-server`
//! binary on an ephemeral port, and cleans up the process/database afterwards.

use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use reqwest::{Client, Method, Response, StatusCode};
use serde_json::Value;
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

pub mod artifacts;
pub mod name_seeds;
pub mod time;

#[derive(Clone)]
pub struct TestApp {
    inner: Arc<Inner>,
}

struct Inner {
    pub base_url: String,
    pub client: Client,
    pub db: PgPool,
    admin: PgPool,
    db_name: String,
    db_url: String,
    child: Mutex<Child>,
    closed: AtomicBool,
    pub artifact_dir: PathBuf,
}

impl TestApp {
    pub fn base_url(&self) -> &str {
        &self.inner.base_url
    }

    pub fn db(&self) -> &PgPool {
        &self.inner.db
    }

    pub fn db_url(&self) -> &str {
        &self.inner.db_url
    }

    pub fn artifact_dir(&self) -> &PathBuf {
        &self.inner.artifact_dir
    }

    pub async fn start(test_name: &str) -> Result<Self> {
        Self::start_with_env(test_name, &[]).await
    }

    /// Convenience for ported suites that manage their own fixtures/teardown.
    pub async fn spawn() -> Result<Self> {
        Self::start("ported").await
    }

    pub async fn start_with_env(test_name: &str, extra_env: &[(&str, &str)]) -> Result<Self> {
        let admin_url = std::env::var("TEST_DATABASE_URL")
            .or_else(|_| std::env::var("DATABASE_URL"))
            .context("TEST_DATABASE_URL or DATABASE_URL must point at a Postgres admin database")?;
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .acquire_timeout(Duration::from_secs(10))
            .connect(&admin_url)
            .await
            .context("connect admin database")?;

        let db_name = format!("ffs_test_{}", Uuid::now_v7().simple());
        sqlx::query(&format!("CREATE DATABASE \"{db_name}\""))
            .execute(&admin)
            .await
            .context("create test database")?;

        let db_url = replace_database(&admin_url, &db_name)?;
        let db = PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(10))
            .connect(&db_url)
            .await
            .context("connect test database")?;

        let run_id = Uuid::now_v7().simple().to_string();
        let artifact_dir = workspace_root()
            .join("test_output/rust")
            .join(format!("{}-{}", sanitize(test_name), &run_id[..8]));
        tokio::fs::create_dir_all(&artifact_dir).await?;

        let port = free_port()?;
        let base_url = format!("http://127.0.0.1:{port}");
        let bin = server_binary()?;
        let stdout = std::fs::File::create(artifact_dir.join("server.stdout.log"))?;
        let stderr = std::fs::File::create(artifact_dir.join("server.stderr.log"))?;

        let mut cmd = Command::new(bin);
        cmd.current_dir(workspace_root())
            .env("DATABASE_URL", &db_url)
            .env("PORT", port.to_string())
            .env("APP_ENV", "development")
            .env("BREAKGLASS_DEV", "TEST")
            .env("TRUST_PROXY", "false")
            .env("SESSION_SECRET", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
            .env("RUST_LOG", "ffs_server=warn")
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .kill_on_drop(true);
        for key in std::env::vars().map(|(k, _)| k) {
            if key.starts_with("AWS_") || key.starts_with("SMTP_") || key.starts_with("ENTRA_") {
                cmd.env_remove(key);
            }
        }
        cmd.env_remove("BREAKGLASS_ADMIN_PASSWORD");
        cmd.env_remove("DEMO_SEED_PASSWORD");
        // Default to fail-closed 2FA login enforcement; toggle suites override
        // this per spawned server instead of mutating the test process env.
        cmd.env_remove("TOTP_LOGIN_ENFORCEMENT_ENABLED");
        for (key, value) in extra_env {
            cmd.env(key, value);
        }
        let child = cmd.spawn().context("spawn ffs-server")?;

        let client = Client::builder()
            .timeout(Duration::from_secs(60))
            .build()?;

        let app = Self {
            inner: Arc::new(Inner {
                base_url: base_url.clone(),
                client,
                db,
                admin,
                db_name,
                db_url,
                child: Mutex::new(child),
                closed: AtomicBool::new(false),
                artifact_dir,
            }),
        };

        app.wait_healthy().await?;
        Ok(app)
    }

    pub async fn run<F, Fut>(test_name: &str, f: F) -> Result<()>
    where
        F: FnOnce(TestApp) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<()>> + Send,
    {
        Self::run_with_env(test_name, &[], f).await
    }

    pub async fn run_with_env<F, Fut>(test_name: &str, extra_env: &[(&str, &str)], f: F) -> Result<()>
    where
        F: FnOnce(TestApp) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = Result<()>> + Send,
    {
        let app = Self::start_with_env(test_name, extra_env).await?;
        let task_app = app.clone();
        let handle = tokio::spawn(async move { f(task_app).await });
        let result = handle.await;
        let cleanup = app.close().await;
        match result {
            Ok(inner) => {
                cleanup?;
                inner
            }
            Err(join_err) => {
                let _ = cleanup;
                if join_err.is_panic() {
                    std::panic::resume_unwind(join_err.into_panic());
                }
                Err(anyhow!("test task failed: {join_err}"))
            }
        }
    }

    async fn wait_healthy(&self) -> Result<()> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        let mut last = String::new();
        while tokio::time::Instant::now() < deadline {
            {
                let mut child = self.inner.child.lock().await;
                if let Some(status) = child.try_wait()? {
                    return Err(anyhow!("ffs-server exited before health check: {status}"));
                }
            }
            match self.inner.client.get(format!("{}/health", self.inner.base_url)).send().await {
                Ok(resp) if resp.status().is_success() => return Ok(()),
                Ok(resp) => last = format!("status {}", resp.status()),
                Err(e) => last = e.to_string(),
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        Err(anyhow!("ffs-server did not become healthy: {last}"))
    }

    pub async fn close(&self) -> Result<()> {
        if self.inner.closed.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        {
            let mut child = self.inner.child.lock().await;
            let _ = child.kill().await;
            let _ = child.wait().await;
        }
        self.inner.db.close().await;
        let drop_sql = format!("DROP DATABASE IF EXISTS \"{}\" WITH (FORCE)", self.inner.db_name);
        sqlx::query(&drop_sql).execute(&self.inner.admin).await?;
        self.inner.admin.close().await;
        Ok(())
    }

    pub async fn request(&self, method: Method, path: &str) -> Result<Response> {
        let url = format!("{}{}", self.inner.base_url, path);
        let req = self.inner.client.request(method, url);
        Ok(req.send().await?)
    }

    pub async fn get(&self, path: &str) -> Result<Response> {
        self.request(Method::GET, path).await
    }

    pub async fn get_json(&self, path: &str) -> Result<(StatusCode, Value)> {
        let resp = self.get(path).await?;
        let status = resp.status();
        let body = resp.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, body))
    }

    pub async fn send_json(&self, method: Method, path: &str, body: Value) -> Result<(StatusCode, Value)> {
        let url = format!("{}{}", self.inner.base_url, path);
        let resp = self
            .inner
            .client
            .request(method, url)
            .header("X-Idempotency-Token", Uuid::now_v7().to_string())
            .json(&body)
            .send()
            .await?;
        let status = resp.status();
        let body = resp.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, body))
    }

    pub async fn post_json(&self, path: &str, body: Value) -> Result<(StatusCode, Value)> {
        self.send_json(Method::POST, path, body).await
    }

    pub async fn request_with_headers(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<Response> {
        let url = format!("{}{}", self.inner.base_url, path);
        let mut req = self.inner.client.request(method, url);
        for (key, value) in headers {
            req = req.header(*key, *value);
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        Ok(req.send().await?)
    }

    pub async fn json_with_headers(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<(StatusCode, Value)> {
        let resp = self.request_with_headers(method, path, headers, body).await?;
        let status = resp.status();
        let body = resp.json::<Value>().await.unwrap_or(Value::Null);
        Ok((status, body))
    }

    pub async fn text_with_headers(
        &self,
        method: Method,
        path: &str,
        headers: &[(&str, &str)],
        body: Option<Value>,
    ) -> Result<(StatusCode, String)> {
        let resp = self.request_with_headers(method, path, headers, body).await?;
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        Ok((status, text))
    }

    pub async fn auth_get_json(&self, path: &str, session: &str) -> Result<(StatusCode, Value)> {
        self.json_with_headers(Method::GET, path, &[("X-Session-Token", session)], None)
            .await
    }

    pub async fn auth_get_text(&self, path: &str, session: &str) -> Result<(StatusCode, String)> {
        self.text_with_headers(Method::GET, path, &[("X-Session-Token", session)], None)
            .await
    }

    pub async fn mint_idempotency_token(&self, session: &str) -> Result<String> {
        let (status, body) = self.auth_get_json("/me/capability-snapshot", session).await?;
        if !status.is_success() {
            anyhow::bail!("capability snapshot failed while minting idempotency token: {status} {body}");
        }
        body["idempotencyToken"]
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("capability snapshot did not return idempotencyToken"))
    }

    pub async fn auth_send_json(
        &self,
        method: Method,
        path: &str,
        session: &str,
        body: Value,
    ) -> Result<(StatusCode, Value)> {
        let token = self.mint_idempotency_token(session).await?;
        self.json_with_headers(
            method,
            path,
            &[("X-Session-Token", session), ("X-Idempotency-Token", &token)],
            Some(body),
        )
        .await
    }

    pub async fn auth_post_json(&self, path: &str, session: &str, body: Value) -> Result<(StatusCode, Value)> {
        self.auth_send_json(Method::POST, path, session, body).await
    }

    pub async fn drop_public_schema(&self) -> Result<()> {
        sqlx::query("DROP SCHEMA IF EXISTS public CASCADE")
            .execute(&self.inner.db)
            .await?;
        sqlx::query("CREATE SCHEMA public")
            .execute(&self.inner.db)
            .await?;
        Ok(())
    }

    pub async fn scalar_i64(&self, sql: &str) -> Result<i64> {
        let row: (i64,) = sqlx::query_as(sql).fetch_one(&self.inner.db).await?;
        Ok(row.0)
    }

    pub async fn wipe_real_users(&self) -> Result<()> {
        sqlx::query("DELETE FROM users WHERE NOT is_system")
            .execute(&self.inner.db)
            .await?;
        Ok(())
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        if !self.closed.load(Ordering::SeqCst) {
            if let Ok(mut child) = self.child.try_lock() {
                let _ = child.start_kill();
            }
        }
    }
}

fn replace_database(admin_url: &str, db_name: &str) -> Result<String> {
    let mut url = Url::parse(admin_url).context("parse database URL")?;
    url.set_path(db_name);
    Ok(url.to_string())
}

fn free_port() -> Result<u16> {
    let listener = std::net::TcpListener::bind("127.0.0.1:0")?;
    Ok(listener.local_addr()?.port())
}

fn server_binary() -> Result<PathBuf> {
    if let Ok(bin) = std::env::var("FFS_SERVER_BIN") {
        return Ok(PathBuf::from(bin));
    }
    if let Some(bin) = option_env!("CARGO_BIN_EXE_ffs-server") {
        return Ok(PathBuf::from(bin));
    }
    let exe = std::env::current_exe()?;
    let target_dir = exe
        .parent()
        .and_then(|p| p.parent())
        .ok_or_else(|| anyhow!("cannot locate target dir from {}", exe.display()))?;
    Ok(target_dir.join("ffs-server"))
}

pub fn workspace_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn sanitize(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

#[macro_export]
macro_rules! parity_assert {
    ($id:expr, $($arg:tt)*) => {{
        let _parity_id = $id;
        assert!($($arg)*);
    }};
}

#[macro_export]
macro_rules! parity_assert_eq {
    ($id:expr, $($arg:tt)*) => {{
        let _parity_id = $id;
        assert_eq!($($arg)*);
    }};
}

#[macro_export]
macro_rules! parity_assert_ne {
    ($id:expr, $($arg:tt)*) => {{
        let _parity_id = $id;
        assert_ne!($($arg)*);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replace_database_preserves_query() {
        let url = replace_database("postgres://postgres@127.0.0.1:5432/postgres", "ffs_test_x").unwrap();
        assert_eq!(url, "postgres://postgres@127.0.0.1:5432/ffs_test_x");
    }

    #[test]
    fn sanitize_keeps_safe_chars() {
        assert_eq!(sanitize("health/setup"), "health_setup");
    }
}
