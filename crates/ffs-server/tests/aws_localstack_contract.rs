//! Opt-in S3 integration contract for Stage 4B. Not included in frozen parity:
//! it requires a separately bootstrapped LocalStack, and does NOT prove the
//! EventBridge -> Lambda exchange or the Rust request/sweep routes (not yet wired).
//! Run: AWS_ENDPOINT_URL=http://... cargo test -p ffs-server --test aws_localstack_contract -- --ignored
use anyhow::{Context, Result};
use aws_sdk_s3::{config::{Credentials, Region}, primitives::ByteStream, Client};
use base64::{engine::general_purpose::STANDARD, Engine};
use ffs_server::aws::{channel, transport};
use ffs_test_support::TestApp;
use serde_json::json;

fn fixture(name: &str) -> String {
    let text = include_str!("../../../test/fixtures/aws-transport-keys.ts");
    let prefix = format!("export const {name} = ");
    let line = text.lines().find(|s| s.starts_with(&prefix)).expect("key fixture");
    serde_json::from_str(line.strip_prefix(&prefix).unwrap().trim_end_matches(';')).unwrap()
}

#[tokio::test]
#[ignore = "needs bootstrapped LocalStack S3; never count as frozen assertion parity without running"]
async fn signed_tenant_s3_io_contract() -> Result<()> {
    let endpoint = std::env::var("AWS_ENDPOINT_URL").context("set AWS_ENDPOINT_URL to bootstrapped LocalStack")?;
    let bucket = std::env::var("AWS_TEST_BUCKET").unwrap_or_else(|_| "ffs-e2e-bucket".into());
    let config = aws_sdk_s3::config::Builder::new()
        .region(Region::new("ap-southeast-1"))
        .credentials_provider(Credentials::new("test", "test", None, None, "localstack-contract"))
        .endpoint_url(endpoint).force_path_style(true).behavior_version_latest().build();
    let s3 = Client::from_conf(config);
    TestApp::run("aws_s3_contract", |app| async move {
        let (status, body) = app.get_json("/setup?file=001_schema.sql").await?;
        anyhow::ensure!(status.is_success(), "schema setup: {status} {body}");
        let db = sea_orm::Database::connect(app.db_url()).await?;
        let app_priv = fixture("APP_PRIVATE_KEY_PEM");
        let app_pub = fixture("APP_PUBLIC_KEY_PEM");
        let tenant_priv = fixture("TENANT_PRIVATE_KEY_PEM");
        let tenant_pub = fixture("TENANT_PUBLIC_KEY_PEM");
        for (name, pem) in [
            ("aws_encrypt_private_key_pem_b64", &app_priv),
            ("aws_encrypt_public_key_pem_b64", &app_pub),
        ] {
            sqlx::query("UPDATE app_settings SET value=$1 WHERE key=$2 AND organization_id IS NULL")
                .bind(STANDARD.encode(pem)).bind(name).execute(app.db()).await?;
        }
        ffs_server::app_settings::clear_cache();
        let tenant_b64 = STANDARD.encode(&tenant_pub);
        let id = uuid::Uuid::now_v7().to_string();
        let outbound = json!({"schemaVersion":"1.0", "requestId":id});
        let key = channel::put_outbound(&db, &s3, &bucket, "exchange", "credential_request", &id,
            Some(&tenant_b64), &outbound).await.map_err(anyhow::Error::msg)?;
        let published = s3.get_object().bucket(&bucket).key(&key).send().await?;
        let data = published.body.collect().await?.into_bytes();
        let signed = std::str::from_utf8(&data)?;
        anyhow::ensure!(transport::is_wrapped(signed), "outbound was not signed");
        let decoded = transport::unwrap(signed, &tenant_priv, &app_pub).map_err(anyhow::Error::msg)?;
        anyhow::ensure!(decoded == outbound, "outbound did not roundtrip");

        // Stand in for tenant publication, NOT for EventBridge/Lambda execution.
        let inbound = json!({"schemaVersion":"1.0", "requestId":id, "status":"success"});
        let inbound_key = channel::inbound_object_key("exchange", "credential_response", &id)
            .map_err(anyhow::Error::msg)?;
        let signed = transport::wrap(&inbound, &tenant_priv, &app_pub, "response")
            .map_err(anyhow::Error::msg)?;
        s3.put_object().bucket(&bucket).key(&inbound_key)
            .body(ByteStream::from(signed.into_bytes())).content_type("application/json").send().await?;
        let result = channel::get_inbound(&db, &s3, &bucket, &inbound_key, Some(&tenant_b64))
            .await.map_err(anyhow::Error::msg)?;
        anyhow::ensure!(result == inbound, "inbound failed verification/decryption");
        Ok(())
    }).await
}
