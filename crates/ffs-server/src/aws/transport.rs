//! AWS tenant file transport codec (schema 2.0). This is application code,
//! not a test-only encryption substitute. S3 channel integration is a later
//! Stage 4B slice; no AWS exchange assertions are claimed by this module.
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD, Engine};
use rsa::{pkcs1v15::{SigningKey, VerifyingKey}, pkcs8::{DecodePrivateKey, DecodePublicKey}, signature::{SignatureEncoding, Signer, Verifier}, Oaep, RsaPrivateKey, RsaPublicKey};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::Sha256;

const ALGORITHM: &str = "RSA-OAEP-2048-SHA256+AES-256-GCM";
const SIGNATURE_ALGORITHM: &str = "RSASSA-PKCS1-v1_5-SHA256";
const SIGNATURE_PREFIX: &str = "ffs-transport-v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Envelope {
    pub algorithm: String,
    pub encrypted_key: String,
    pub iv: String,
    pub ciphertext: String,
    pub auth_tag: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WrappedFile {
    pub schema_version: String,
    pub kind: String,
    pub envelope: Envelope,
    pub signature: FileSignature,
    pub signed_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct FileSignature {
    pub algorithm: String,
    pub value: String,
}

pub fn pem_to_der(input: &str, label: &str) -> Result<Vec<u8>, String> {
    let decoded = STANDARD.decode(input.trim()).ok().and_then(|b| String::from_utf8(b).ok());
    let text = decoded.as_deref().filter(|s| s.contains("-----BEGIN ")).unwrap_or(input);
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    if let Some(body) = text.trim().strip_prefix(&begin).and_then(|s| s.trim().strip_suffix(&end)) {
        return STANDARD.decode(body.split_whitespace().collect::<String>()).map_err(|e| e.to_string());
    }
    STANDARD.decode(input.trim()).map_err(|e| e.to_string())
}

pub fn private_key(input: &str) -> Result<RsaPrivateKey, String> {
    RsaPrivateKey::from_pkcs8_der(&pem_to_der(input, "PRIVATE KEY")?).map_err(|e| e.to_string())
}

pub fn public_key(input: &str) -> Result<RsaPublicKey, String> {
    RsaPublicKey::from_public_key_der(&pem_to_der(input, "PUBLIC KEY")?).map_err(|e| e.to_string())
}

pub fn valid_private_key(input: &str) -> bool { private_key(input).is_ok() }
pub fn valid_public_key(input: &str) -> bool { public_key(input).is_ok() }

pub fn canonical_fields(e: &Envelope) -> String {
    format!("{}|{}|{}|{}|{}", e.algorithm, e.encrypted_key, e.iv, e.ciphertext, e.auth_tag)
}

pub fn canonical_message(e: &Envelope) -> String {
    format!("{SIGNATURE_PREFIX}|{}", canonical_fields(e))
}

pub fn encrypt(recipient: &RsaPublicKey, plaintext: &[u8]) -> Result<Envelope, String> {
    use rsa::rand_core::RngCore;
    let mut rng = rsa::rand_core::OsRng;
    let mut key = [0u8; 32];
    let mut iv = [0u8; 12];
    rng.fill_bytes(&mut key);
    rng.fill_bytes(&mut iv);
    let encrypted_key = recipient.encrypt(&mut rng, Oaep::new::<Sha256>(), &key).map_err(|e| e.to_string())?;
    let combined = Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?
        .encrypt(Nonce::from_slice(&iv), plaintext).map_err(|e| e.to_string())?;
    let split = combined.len() - 16;
    Ok(Envelope {
        algorithm: ALGORITHM.into(), encrypted_key: STANDARD.encode(encrypted_key),
        iv: STANDARD.encode(iv), ciphertext: STANDARD.encode(&combined[..split]),
        auth_tag: STANDARD.encode(&combined[split..]),
    })
}

pub fn decrypt(recipient: &RsaPrivateKey, envelope: &Envelope) -> Result<Vec<u8>, String> {
    if envelope.algorithm != ALGORITHM { return Err("unsupported transport algorithm".into()); }
    let decode = |s: &str| STANDARD.decode(s).map_err(|e| e.to_string());
    let key = recipient.decrypt(Oaep::new::<Sha256>(), &decode(&envelope.encrypted_key)?)
        .map_err(|e| e.to_string())?;
    let iv = decode(&envelope.iv)?;
    if iv.len() != 12 { return Err("invalid transport IV".into()); }
    let mut ciphertext = decode(&envelope.ciphertext)?;
    ciphertext.extend(decode(&envelope.auth_tag)?);
    Aes256Gcm::new_from_slice(&key).map_err(|e| e.to_string())?
        .decrypt(Nonce::from_slice(&iv), ciphertext.as_slice()).map_err(|e| e.to_string())
}

pub fn sign(sender: &RsaPrivateKey, envelope: &Envelope) -> String {
    let signature: rsa::pkcs1v15::Signature = SigningKey::<Sha256>::new(sender.clone())
        .sign(canonical_message(envelope).as_bytes());
    STANDARD.encode(signature.to_bytes())
}

pub fn verify(sender: &RsaPublicKey, envelope: &Envelope, signature_b64: &str) -> bool {
    STANDARD.decode(signature_b64).ok()
        .and_then(|bytes| rsa::pkcs1v15::Signature::try_from(bytes.as_slice()).ok())
        .is_some_and(|signature| VerifyingKey::<Sha256>::new(sender.clone())
            .verify(canonical_message(envelope).as_bytes(), &signature).is_ok())
}

/// Structural prefix probe matching the legacy codec, including whitespace.
pub fn is_wrapped(text: &str) -> bool {
    text.trim_start().starts_with("{\"schemaVersion\":\"2.0\"")
}

pub fn wrap(payload: &Value, sender_pem: &str, recipient_pem: &str, kind: &str) -> Result<String, String> {
    if kind != "request" && kind != "response" { return Err("invalid transport kind".into()); }
    let envelope = encrypt(&public_key(recipient_pem)?, &serde_json::to_vec(payload).map_err(|e| e.to_string())?)?;
    let signature = sign(&private_key(sender_pem)?, &envelope);
    let file = WrappedFile {
        schema_version: "2.0".into(), kind: kind.into(), envelope,
        signature: FileSignature { algorithm: SIGNATURE_ALGORITHM.into(), value: signature },
        signed_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    };
    serde_json::to_string(&file).map_err(|e| e.to_string())
}

pub fn unwrap(text: &str, recipient_pem: &str, sender_pem: &str) -> Result<Value, String> {
    // Do not let JSON key reordering downgrade a schema-2 file to plaintext.
    // The prefix probe remains useful for the fast path, but is not a trust boundary.
    if !is_wrapped(text) {
        let parsed: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if parsed.get("schemaVersion").and_then(Value::as_str) != Some("2.0") {
            return Ok(parsed);
        }
    }
    let file: WrappedFile = serde_json::from_str(text).map_err(|e| e.to_string())?;
    if file.schema_version != "2.0" || file.envelope.ciphertext.is_empty() || file.signature.value.is_empty() {
        return Err("inbound schema 2.0 file is malformed".into());
    }
    if !verify(&public_key(sender_pem)?, &file.envelope, &file.signature.value) {
        return Err("inbound file signature verification FAILED".into());
    }
    serde_json::from_slice(&decrypt(&private_key(recipient_pem)?, &file.envelope)?)
        .map_err(|e| e.to_string())
}

/// DB-backed enablement resolver. A missing tenant key opts out of encryption;
/// a configured but invalid tenant key or missing app keypair fails closed.
#[derive(Debug, Clone)]
pub struct TransportKeys {
    pub app_priv_pem: String,
    pub app_pub_pem: String,
    pub tenant_pub_pem: String,
}

pub async fn resolve_transport_keys(
    db: &sea_orm::DatabaseConnection,
    tenant_public_key_b64: Option<&str>,
) -> Result<Option<TransportKeys>, String> {
    let Some(tenant_key) = tenant_public_key_b64.filter(|s| !s.is_empty()) else {
        return Ok(None);
    };
    if !valid_public_key(tenant_key) {
        return Err("AWS transport encryption: the tenant public-key parameter exists but is not a valid RSA public key.".into());
    }
    let app_priv_b64 = crate::app_settings::get_setting_string(db, "aws_encrypt_private_key_pem_b64")
        .await.map_err(|e| e.to_string())?;
    let app_pub_b64 = crate::app_settings::get_setting_string(db, "aws_encrypt_public_key_pem_b64")
        .await.map_err(|e| e.to_string())?;
    if app_priv_b64.is_empty() || app_pub_b64.is_empty() {
        return Err("AWS transport encryption: the tenant public-key parameter is configured, but the app's own key settings are not set.".into());
    }
    if !valid_private_key(&app_priv_b64) || !valid_public_key(&app_pub_b64) {
        return Err("AWS transport encryption: the app key settings are set but do not parse as valid RSA keys.".into());
    }
    let decode = |s: &str| STANDARD.decode(s).ok().and_then(|b| String::from_utf8(b).ok())
        .ok_or_else(|| "AWS transport encryption: invalid base64 PEM".to_string());
    Ok(Some(TransportKeys {
        app_priv_pem: decode(&app_priv_b64)?,
        app_pub_pem: decode(&app_pub_b64)?,
        tenant_pub_pem: decode(tenant_key)?,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reordered_schema_two_cannot_bypass_signature() {
        let fixture = include_str!("../../../../test/fixtures/aws-transport-keys.ts");
        let get = |name: &str| {
            let prefix = format!("export const {name} = ");
            let line = fixture.lines().find(|line| line.starts_with(&prefix)).unwrap();
            serde_json::from_str::<String>(line.strip_prefix(&prefix).unwrap().trim_end_matches(';')).unwrap()
        };
        let tenant_priv = get("TENANT_PRIVATE_KEY_PEM");
        let tenant_pub = get("TENANT_PUBLIC_KEY_PEM");
        let app_priv = get("APP_PRIVATE_KEY_PEM");
        let app_pub = get("APP_PUBLIC_KEY_PEM");
        let text = wrap(&serde_json::json!({"safe": true}), &tenant_priv, &app_pub, "response").unwrap();
        let mut parsed: Value = serde_json::from_str(&text).unwrap();
        parsed["envelope"]["ciphertext"] = Value::String("AA".into());
        let reordered = parsed.to_string(); // serde_json::Value sorts keys; schemaVersion is no longer first.
        assert!(!is_wrapped(&reordered));
        assert!(unwrap(&reordered, &app_priv, &tenant_pub).unwrap_err().contains("verification FAILED"));
    }
}
