//! Stage 4B transport codec assertions against ffs-server's AWS codec.
//! Fixture keys are read directly from the committed Node suite fixture (no copied secrets).
use ffs_server::aws::transport::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::json;

fn fixture(name: &str) -> String {
    let text = include_str!("../../../../test/fixtures/aws-transport-keys.ts");
    let prefix = format!("export const {name} = ");
    let line = text.lines().find(|line| line.starts_with(&prefix)).expect("fixture constant");
    serde_json::from_str::<String>(line.strip_prefix(&prefix).unwrap().trim_end_matches(';'))
        .expect("fixture string literal")
}

#[test]
fn transport_codec() {
    let tenant_priv = fixture("TENANT_PRIVATE_KEY_PEM");
    let tenant_pub = fixture("TENANT_PUBLIC_KEY_PEM");
    let app_priv = fixture("APP_PRIVATE_KEY_PEM");
    let app_pub = fixture("APP_PUBLIC_KEY_PEM");
    let pub_b64 = STANDARD.encode(&tenant_pub);
    let app_pub_b64 = STANDARD.encode(&app_pub);
    let app_priv_b64 = STANDARD.encode(&app_priv);
    let der = pem_to_der(&tenant_pub, "PUBLIC KEY").unwrap();
    let tenant_private = private_key(&tenant_priv).unwrap();
    let tenant_public = public_key(&tenant_pub).unwrap();
    let app_private = private_key(&app_priv).unwrap();
    let app_public = public_key(&app_pub).unwrap();
    let payload = json!({"schemaVersion":"1.0", "requestId":"req-123", "publicKey":"cGF5bG9hZHM=", "credentialItems":[{"userid":"svc", "hostname":"host-1", "credentialType":"password"}]});
    let message = serde_json::to_vec(&payload).unwrap();
    let env = encrypt(&tenant_public, &message).unwrap();
    let sig = sign(&app_private, &env);
    let mut tampered = env.clone();
    tampered.ciphertext.push('A');
    let inbound = encrypt(&app_public, &message).unwrap();
    let inbound_sig = sign(&tenant_private, &inbound);
    let outbound_text = wrap(&payload, &app_priv, &tenant_pub, "request").unwrap();
    let outbound: WrappedFile = serde_json::from_str(&outbound_text).unwrap();
    let inbound_text = wrap(&payload, &tenant_priv, &app_pub, "response").unwrap();
    let parsed_inbound: WrappedFile = serde_json::from_str(&inbound_text).unwrap();
    let mut changed: WrappedFile = serde_json::from_str(&inbound_text).unwrap();
    changed.envelope.ciphertext = "AA".into();
    // parity-assert: L:5dea5907a16ba441-1
    assert!(der == pem_to_der(&pub_b64, "PUBLIC KEY").unwrap());
    // parity-assert: L:0c69ca96411f90dd-1
    assert!(der == pem_to_der(&STANDARD.encode(&der), "PUBLIC KEY").unwrap());
    // parity-assert: L:82e585199a72c2f6-1
    assert!(der.len() == 294);
    // parity-assert: L:6c932ebee50ee498-1
    assert!(valid_public_key(&tenant_pub));
    // parity-assert: L:37e22c416e2b9969-1
    assert!(valid_public_key(&app_pub_b64));
    // parity-assert: L:7fb8e951ce6b1e6a-1
    assert!(!valid_public_key("not a key"));
    // parity-assert: L:e81442844b9abf96-1
    assert!(!valid_public_key(&tenant_priv));
    // parity-assert: L:26cddbf1975f04c2-1
    assert!(valid_private_key(&app_priv));
    // parity-assert: L:e190ee80695e746b-1
    assert!(valid_private_key(&app_priv_b64));
    // parity-assert: L:a0b4d18327884a36-1
    assert!(!valid_private_key("not a key"));
    // parity-assert: L:1c60e51754768f18-1
    assert!(env.algorithm == "RSA-OAEP-2048-SHA256+AES-256-GCM");
    // parity-assert: L:20935ce5929c28b3-1
    assert!(decrypt(&tenant_private, &env).unwrap() == message);
    // parity-assert: L:0906e1fadbc63ec3-1
    assert!(decrypt(&app_private, &env).is_err());
    // parity-assert: L:8ee99ef177dd782e-1
    assert!(verify(&app_public, &env, &sig));
    // parity-assert: L:0f02260cc75ece17-1
    assert!(!verify(&tenant_public, &env, &sig));
    // parity-assert: L:ad10b97f2207081e-1
    assert!(!verify(&app_public, &tampered, &sig));
    // parity-assert: L:44ac655690622cc0-1
    assert!(verify(&app_public, &env, &sig));
    // parity-assert: L:a00c7f1724d198f9-1
    assert!(decrypt(&tenant_private, &env).unwrap() == message);
    // parity-assert: L:96e109296f681b59-1
    assert!(verify(&tenant_public, &inbound, &inbound_sig));
    // parity-assert: L:4c66fdc9d2aac8cd-1
    assert!(decrypt(&app_private, &inbound).unwrap() == message);
    // parity-assert: L:9d929743e1f1c6d2-1
    assert!(is_wrapped(&outbound_text));
    // parity-assert: L:f18a6d1fe203ffb0-1
    assert!(outbound.schema_version == "2.0");
    // parity-assert: L:f4f5b09f2832b0c0-1
    assert!(outbound.kind == "request");
    // parity-assert: L:ea562364ca2e4d98-1
    assert!(outbound.signature.algorithm == "RSASSA-PKCS1-v1_5-SHA256");
    // parity-assert: L:9a585e45a32b827b-1
    assert!(!outbound.envelope.ciphertext.is_empty());
    // parity-assert: L:5bfbd1cf979d9f47-1
    assert!(!outbound.signed_at.is_empty());
    // parity-assert: L:fc7e65f72abd040f-1
    assert!(unwrap(&outbound_text, &tenant_priv, &app_pub).unwrap() == payload);
    // parity-assert: L:3d817b6ba8b8e89a-1
    assert!(is_wrapped(&inbound_text));
    // parity-assert: L:bd2aca97c3ef0e6e-1
    assert!(parsed_inbound.kind == "response");
    // parity-assert: L:5c5fc0b0c0ee6526-1
    assert!(unwrap(&inbound_text, &app_priv, &tenant_pub).unwrap() == payload);
    // parity-assert: L:2a9d51493f06d8db-1
    assert!(unwrap(&outbound_text, &app_priv, &tenant_pub).unwrap_err().contains("verification FAILED"));
    // parity-assert: L:26a74b7041cdd367-1
    assert!(!is_wrapped(&payload.to_string()));
    // parity-assert: L:017029b879dd6687-1
    assert!(unwrap(r#"{"schemaVersion":"1.0","requestId":"legacy"}"#, &app_priv, &tenant_pub).unwrap() == json!({"schemaVersion":"1.0","requestId":"legacy"}));
    // parity-assert: L:834869538a4dd959-1
    assert!(unwrap(&serde_json::to_string(&changed).unwrap(), &app_priv, &tenant_pub).unwrap_err().contains("verification FAILED"));
    // parity-assert: L:8cdd4ef1784fecbf-1
    assert!(unwrap(&inbound_text, &app_priv, &app_pub).unwrap_err().contains("verification FAILED"));
}

/// Legacy `resolveTransportKeys` enablement cases, backed by real app_settings.
#[tokio::test]
async fn transport_key_enablement() -> anyhow::Result<()> {
    use ffs_test_support::{parity_assert_eq, TestApp};
    TestApp::run("aws_transport_enablement", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        sqlx::query("UPDATE app_settings SET value='' WHERE key IN ('aws_encrypt_private_key_pem_b64','aws_encrypt_public_key_pem_b64') AND organization_id IS NULL")
            .execute(app.db()).await?;
        ffs_server::app_settings::clear_cache();
        parity_assert_eq!("L:c74d00a9ca3f7fd8-1", resolve_transport_keys(&db, None).await.map_err(anyhow::Error::msg)?.is_none(), true);
        parity_assert_eq!("L:6a78c4a64d677d4c-1", resolve_transport_keys(&db, Some("")).await.map_err(anyhow::Error::msg)?.is_none(), true);
        parity_assert_eq!("L:07f55514a91af831-1", resolve_transport_keys(&db, Some("not a key")).await.unwrap_err().contains("not a valid RSA public key"), true);
        let tenant_pub = fixture("TENANT_PUBLIC_KEY_PEM");
        let tenant_b64 = STANDARD.encode(&tenant_pub);
        parity_assert_eq!("L:9296783aebc0bfb6-1", resolve_transport_keys(&db, Some(&tenant_b64)).await.unwrap_err().contains("app's own key settings"), true);
        let app_priv = fixture("APP_PRIVATE_KEY_PEM");
        let app_pub = fixture("APP_PUBLIC_KEY_PEM");
        sqlx::query("UPDATE app_settings SET value=$1 WHERE key='aws_encrypt_private_key_pem_b64' AND organization_id IS NULL")
            .bind(STANDARD.encode(&app_priv)).execute(app.db()).await?;
        sqlx::query("UPDATE app_settings SET value=$1 WHERE key='aws_encrypt_public_key_pem_b64' AND organization_id IS NULL")
            .bind(STANDARD.encode(&app_pub)).execute(app.db()).await?;
        ffs_server::app_settings::clear_cache();
        let keys = resolve_transport_keys(&db, Some(&tenant_b64)).await.map_err(anyhow::Error::msg)?.expect("configured transport keys");
        parity_assert_eq!("L:3706fbbf9d99524e-1", !keys.app_priv_pem.is_empty(), true);
        parity_assert_eq!("L:4089914d45f99fae-1", keys.app_priv_pem.as_str(), app_priv.as_str());
        parity_assert_eq!("L:4701786be9834625-1", keys.app_pub_pem.as_str(), app_pub.as_str());
        parity_assert_eq!("L:ff9e41630d4a52f6-1", keys.tenant_pub_pem.as_str(), tenant_pub.as_str());
        let payload = json!({"schemaVersion":"1.0", "requestId":"req-123"});
        let wrapped = wrap(&payload, &keys.app_priv_pem, &keys.tenant_pub_pem, "request").map_err(anyhow::Error::msg)?;
        parity_assert_eq!("L:07175d1797d85487-1", unwrap(&wrapped, &fixture("TENANT_PRIVATE_KEY_PEM"), &keys.app_pub_pem).map_err(anyhow::Error::msg)?, payload);
        Ok(())
    }).await
}
