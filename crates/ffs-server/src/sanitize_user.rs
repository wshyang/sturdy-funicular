//! Single secret-strip point for User payloads.
//! Mirrors server/utils.tsx sanitizeUser (addendum-215 Stage 1B seam).

use serde_json::Value;

pub fn sanitize_user(user: &Value) -> Value {
    let mut safe = user.clone();
    if let Some(obj) = safe.as_object_mut() {
        let totp_enrolled = obj
            .get("totpSecret")
            .and_then(Value::as_str)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        obj.remove("passwordHash");
        obj.remove("passwordSalt");
        obj.remove("totpSecret");
        obj.insert("totpEnrolled".to_string(), Value::Bool(totp_enrolled));
    }
    safe
}
