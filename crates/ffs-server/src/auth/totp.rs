// TOTP (RFC 6238) — byte-identical to the Deno `otpauth` library.
// Params: step=30s, digits=6, algorithm=SHA1 (PORT-1.5).
// totp-rs crate is used with matching defaults.

use totp_rs::{Algorithm, TOTP};

/// Generate a new TOTP secret (base32-encoded, 20 bytes).
pub fn generate_totp_secret() -> anyhow::Result<String> {
    let secret = totp_rs::Secret::generate_secret();
    Ok(secret.to_encoded().to_string())
}

/// Build a TOTP instance from a base32-encoded secret.
/// Params match the Deno `otpauth` library defaults (TOTP, SHA1, 6 digits, 30s step).
pub fn build_totp(secret_base32: &str, issuer: &str, account: &str) -> anyhow::Result<TOTP> {
    let secret = totp_rs::Secret::Encoded(secret_base32.to_string())
        .to_bytes()
        .map_err(|e| anyhow::anyhow!("Invalid TOTP secret: {}", e))?;

    Ok(TOTP::new(
        Algorithm::SHA1,
        6,   // digits
        1,   // step multiplier (step = 1 × 30s)
        30,  // step seconds
        secret,
        Some(issuer.to_string()),
        account.to_string(),
    )
    .map_err(|e| anyhow::anyhow!("TOTP creation failed: {}", e))?)
}

/// Verify a 6-digit TOTP code against the secret.
pub fn verify_totp(secret_base32: &str, code: &str) -> anyhow::Result<bool> {
    if secret_base32.is_empty() || code.is_empty() {
        return Ok(false);
    }
    let totp = match build_totp(secret_base32, "FFS", "user") {
        Ok(totp) => totp,
        Err(_) => return Ok(false),
    };
    Ok(totp.check_current(code).unwrap_or(false))
}

/// Generate the current TOTP code (used in tests / seeding).
pub fn generate_totp_code(secret_base32: &str) -> anyhow::Result<String> {
    let totp = build_totp(secret_base32, "FFS", "user")?;
    Ok(totp.generate_current()?)
}

/// Build an otpauth:// URI for QR code display (matches Deno otpauth library output).
pub fn totp_uri(secret_base32: &str, issuer: &str, account: &str) -> anyhow::Result<String> {
    let totp = build_totp(secret_base32, issuer, account)?;
    Ok(totp.get_url())
}

pub struct TotpEnrollment {
    pub qr_data_url: String,
    pub otpauth_uri: String,
    pub secret_base32: String,
}

/// Generate a new TOTP enrollment for an account.
/// Returns QR data URL (PNG base64), otpauth:// URI, and raw base32 secret.
/// QR is rendered at 8px/module with 4-module margin via qrcodegen-image,
/// matching the pixel density required for the e2e jsQR harness (addendum-046).
pub fn generate_enrollment(issuer: &str, account: &str) -> anyhow::Result<TotpEnrollment> {
    let secret_base32 = generate_totp_secret()?;
    let totp = build_totp(&secret_base32, issuer, account)?;
    let otpauth_uri = totp.get_url();
    let qr_data_url = qrcodegen_image::draw_base64(&otpauth_uri)
        .map(|b64| format!("data:image/png;base64,{}", b64))
        .unwrap_or_else(|_| String::new());
    Ok(TotpEnrollment {
        qr_data_url,
        otpauth_uri,
        secret_base32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enrollment_produces_non_empty_qr_data_url() {
        let e = generate_enrollment("Firefighter Station", "e2e-user@test.local").unwrap();
        assert!(
            e.qr_data_url.starts_with("data:image/png;base64,"),
            "qr_data_url empty or wrong format: {:?}",
            &e.qr_data_url[..e.qr_data_url.len().min(60)]
        );
        assert!(e.qr_data_url.len() > 1000, "QR data URL too short: {} bytes", e.qr_data_url.len());
    }
}
