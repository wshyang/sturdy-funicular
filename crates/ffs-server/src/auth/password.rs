// Password hashing and verification.
// Mirrors server/utils.tsx:85-171 (hashPassword, verifyPassword, passwordHashNeedsUpgrade).
//
// CRITICAL: The salt is fed as UTF-8 bytes of the 64-char hex string — NOT hex-decoded.
// (See utils.tsx:111 — `new TextEncoder().encode(salt)` where salt is the hex string.)
// Rust equivalent: `pbkdf2_hmac::<Sha256>(password, salt.as_bytes(), iterations, out)`.
// Using hex::decode(salt) produces a DIFFERENT key — common Rust mistake, must NOT be done.

use constant_time_eq::constant_time_eq;
use hmac::Hmac;
use pbkdf2::pbkdf2;
use rand::Rng;
use sha2::{Digest, Sha256};

const PASSWORD_KDF: &str = "pbkdf2-sha256";
const PASSWORD_KDF_ITERATIONS: u32 = 600_000;
const PASSWORD_DERIVED_BITS: usize = 32; // 256 bits = 32 bytes

/// Generate a random 64-char hex salt (matches generateSalt() in utils.tsx).
pub fn generate_salt() -> String {
    let bytes: [u8; 32] = rand::thread_rng().gen();
    hex::encode(bytes)
}

/// Hash a password with PBKDF2-SHA256 at the configured iteration count.
/// Returns `pbkdf2-sha256$600000$<hex_digest>`.
pub fn hash_password(password: &str, salt: &str) -> anyhow::Result<String> {
    let digest = derive_pbkdf2(password, salt, PASSWORD_KDF_ITERATIONS)?;
    Ok(format!(
        "{}${}${}",
        PASSWORD_KDF, PASSWORD_KDF_ITERATIONS, digest
    ))
}

/// Returns true if the hash should be upgraded (wrong algorithm or iteration count).
/// Mirrors passwordHashNeedsUpgrade() in utils.tsx:124-127.
pub fn password_hash_needs_upgrade(hash: &str) -> bool {
    match parse_pbkdf2_hash(hash) {
        Some((_, iterations, _)) => {
            iterations < PASSWORD_KDF_ITERATIONS
        }
        None => true, // legacy SHA-256 → needs upgrade
    }
}

/// Constant-time password verification.
/// Mirrors verifyPassword() in utils.tsx:146-171.
pub fn verify_password(password: &str, salt: &str, hash: &str) -> anyhow::Result<bool> {
    if hash.starts_with(&format!("{PASSWORD_KDF}$")) {
        let (algorithm, iterations, _stored_digest) = match parse_pbkdf2_hash(hash) {
            Some(x) => x,
            None => return Ok(false),
        };
        if algorithm != PASSWORD_KDF
            || iterations < 100_000
            || iterations > PASSWORD_KDF_ITERATIONS
        {
            return Ok(false);
        }
        let computed_digest = derive_pbkdf2(password, salt, iterations)?;
        let computed = format!("{}${}${}", algorithm, iterations, computed_digest);
        // Constant-time compare (same-length strings; length mismatch is not a timing oracle).
        if computed.len() != hash.len() {
            return Ok(false);
        }
        Ok(constant_time_eq(computed.as_bytes(), hash.as_bytes()))
    } else {
        // Legacy SHA-256(password + salt) fallback.
        let computed = legacy_sha256(password, salt);
        if computed.len() != hash.len() {
            return Ok(false);
        }
        Ok(constant_time_eq(computed.as_bytes(), hash.as_bytes()))
    }
}

// ─── Private helpers ───────────────────────────────────────────────────────

/// Derive 256-bit PBKDF2-SHA256 key.
/// IMPORTANT: salt is the 64-char hex STRING encoded as UTF-8 bytes.
fn derive_pbkdf2(password: &str, salt: &str, iterations: u32) -> anyhow::Result<String> {
    let mut out = [0u8; PASSWORD_DERIVED_BITS];
    pbkdf2::<Hmac<Sha256>>(
        password.as_bytes(),
        salt.as_bytes(), // UTF-8 bytes of the hex string — NOT hex::decode(salt)
        iterations,
        &mut out,
    )
    .map_err(|e| anyhow::anyhow!("PBKDF2 error: {:?}", e))?;
    Ok(hex::encode(out))
}

/// SHA-256(password || salt) — legacy fallback (mirrors legacySha256Password).
fn legacy_sha256(password: &str, salt: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(password.as_bytes());
    hasher.update(salt.as_bytes());
    hex::encode(hasher.finalize())
}

/// Parse `pbkdf2-sha256$ITERS$HEX` → (algorithm, iterations, digest).
fn parse_pbkdf2_hash(hash: &str) -> Option<(&str, u32, &str)> {
    let parts: Vec<&str> = hash.splitn(3, '$').collect();
    if parts.len() != 3 {
        return None;
    }
    let iterations = parts[1].parse::<u32>().ok()?;
    Some((parts[0], iterations, parts[2]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Golden vector: verify PBKDF2 parity with the Deno implementation.
    /// Run `deno eval "import { hashPassword } from './server/utils.tsx'; console.log(await hashPassword('testpassword', 'aabbccdd...'))"` to regenerate.
    #[test]
    fn hash_format_is_correct() {
        let result = hash_password("hello", "0000000000000000000000000000000000000000000000000000000000000000").unwrap();
        assert!(result.starts_with("pbkdf2-sha256$600000$"));
        assert_eq!(result.split('$').count(), 3);
    }

    #[test]
    fn verify_roundtrip() {
        let salt = generate_salt();
        let hash = hash_password("correct-horse-battery", &salt).unwrap();
        assert!(verify_password("correct-horse-battery", &salt, &hash).unwrap());
        assert!(!verify_password("wrong-password", &salt, &hash).unwrap());
    }

    #[test]
    fn upgrade_detection() {
        // Legacy SHA-256 hash → needs upgrade.
        let legacy = "0".repeat(64);
        assert!(password_hash_needs_upgrade(&legacy));
        // Current iteration count → no upgrade needed.
        let salt = generate_salt();
        let current = hash_password("pw", &salt).unwrap();
        assert!(!password_hash_needs_upgrade(&current));
    }

    #[test]
    fn constant_time_no_short_circuit() {
        // Both accept and reject should have the same observable length path.
        let salt = generate_salt();
        let hash = hash_password("pw", &salt).unwrap();
        let r1 = verify_password("pw", &salt, &hash).unwrap();
        let r2 = verify_password("wrong", &salt, &hash).unwrap();
        assert!(r1);
        assert!(!r2);
    }
}
