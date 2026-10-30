// Security headers + CSRF cookie helpers.
// Mirrors server/security-headers.ts exactly for wire parity.

use crate::config::AppEnv;

pub const SESSION_COOKIE_NAME: &str = "ffs_session";
pub const SESSION_COOKIE_HOST_PREFIXED: &str = "__Host-ffs_session";
pub const CSRF_COOKIE_DEV: &str = "ffs_csrf";
pub const CSRF_COOKIE_PROD: &str = "__Host-ffs_csrf";

/// Returns the CSRF cookie name depending on env/https (matches csrfCookieName()).
pub fn csrf_cookie_name(env: &AppEnv, https: bool) -> &'static str {
    if *env == AppEnv::Prod && https {
        CSRF_COOKIE_PROD
    } else {
        CSRF_COOKIE_DEV
    }
}

/// Returns the session cookie name (matches SESSION_COOKIE_NAME / HOST_PREFIXED).
pub fn session_cookie_name(env: &AppEnv, https: bool) -> &'static str {
    if *env == AppEnv::Prod && https {
        SESSION_COOKIE_HOST_PREFIXED
    } else {
        SESSION_COOKIE_NAME
    }
}

/// Security headers to inject on every response.
/// Matches securityHeaders() in server/security-headers.ts.
pub fn security_headers(env: &AppEnv, https: bool) -> Vec<(&'static str, String)> {
    let mut headers = vec![
        ("X-Content-Type-Options", "nosniff".to_string()),
        ("X-Frame-Options", "DENY".to_string()),
        (
            "Referrer-Policy",
            "strict-origin-when-cross-origin".to_string(),
        ),
        ("X-XSS-Protection", "1; mode=block".to_string()),
        (
            "Permissions-Policy",
            "geolocation=(), microphone=(), camera=()".to_string(),
        ),
    ];

    if https && *env == AppEnv::Prod {
        headers.push((
            "Strict-Transport-Security",
            "max-age=31536000; includeSubDomains".to_string(),
        ));
    }

    // CSP: dev vs prod variant.
    let csp = if *env == AppEnv::Dev {
        "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://localhost:*;"
    } else {
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;"
    };
    headers.push(("Content-Security-Policy", csp.to_string()));

    headers
}

/// True when the Secure attribute should be set on cookies.
pub fn is_secure_cookie(env: &AppEnv, https: bool) -> bool {
    *env == AppEnv::Prod && https
}

/// Parse a Cookie header value into a name→value map.
pub fn parse_cookies(cookie_header: &str) -> std::collections::HashMap<String, String> {
    cookie_header
        .split(';')
        .filter_map(|part| {
            let mut iter = part.splitn(2, '=');
            let name = iter.next()?.trim().to_string();
            let value = iter.next().unwrap_or("").trim().to_string();
            if name.is_empty() {
                None
            } else {
                Some((name, value))
            }
        })
        .collect()
}
