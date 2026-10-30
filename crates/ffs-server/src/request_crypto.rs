//! Request secret key material (legacy server/crypto.tsx).
//! Server fallback wraps a real PKCS#8 private key with AES-256-GCM; the
//! client-key path stores only the supplied SPKI public half plus a fresh KEK.
use aes_gcm::{aead::{Aead, KeyInit}, Aes256Gcm, Nonce};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use rand::{rngs::OsRng, RngCore};
use rsa::traits::PublicKeyParts;
use rsa::{pkcs8::{DecodePublicKey, EncodePrivateKey, EncodePublicKey}, RsaPrivateKey, RsaPublicKey};
use serde_json::json;

use crate::errors::AppError;

pub const KEY_ALGORITHM: &str = "RSA-OAEP-2048-SHA256";

pub fn generate_wrap_key() -> String {
    let mut bytes = [0u8; 32]; OsRng.fill_bytes(&mut bytes); B64.encode(bytes)
}

pub fn is_valid_public_key(public_key_b64: &str) -> bool {
    let Ok(bytes) = B64.decode(public_key_b64) else { return false; };
    let Ok(key) = RsaPublicKey::from_public_key_der(&bytes) else { return false; };
    key.size() >= 256
}

pub struct GeneratedKeyMaterial {
    pub public_key: String,
    pub wrapped_private_key_file: String,
}

pub fn generate_with_wrapped_private_key(wrap_key: &str) -> Result<GeneratedKeyMaterial, AppError> {
    let private = RsaPrivateKey::new(&mut OsRng, 2048)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("RSA keygen: {e}")))?;
    let public_key = B64.encode(private.to_public_key().to_public_key_der()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("SPKI encode: {e}")))?.as_bytes());
    let pkcs8 = private.to_pkcs8_der()
        .map_err(|e| AppError::Internal(anyhow::anyhow!("PKCS8 encode: {e}")))?;
    let (iv, wrapped) = aes_gcm_seal(wrap_key, pkcs8.as_bytes())?;
    let envelope = json!({"schemaVersion":1,"keyAlgorithm":KEY_ALGORITHM,
        "wrapAlgorithm":"AES-256-GCM","iv":iv,"wrappedPrivateKey":wrapped});
    Ok(GeneratedKeyMaterial { public_key, wrapped_private_key_file: B64.encode(envelope.to_string()) })
}

pub fn aes_gcm_seal(key_b64: &str, plaintext: &[u8]) -> Result<(String, String), AppError> {
    let key = B64.decode(key_b64).map_err(|_| AppError::validation("Invalid wrap key."))?;
    let cipher = Aes256Gcm::new_from_slice(&key).map_err(|_| AppError::validation("Invalid wrap key."))?;
    let mut iv = [0u8; 12]; OsRng.fill_bytes(&mut iv);
    let sealed = cipher.encrypt(Nonce::from_slice(&iv), plaintext)
        .map_err(|_| AppError::Internal(anyhow::anyhow!("AES-GCM wrap failed")))?;
    Ok((B64.encode(iv), B64.encode(sealed)))
}
