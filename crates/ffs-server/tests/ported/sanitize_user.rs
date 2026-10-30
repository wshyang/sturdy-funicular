//! Port of test/backend/deno/sanitize-user.test.tsx (10 assertions).

use ffs_server::sanitize_user::sanitize_user;
use serde_json::{json, Value};

fn full_user(totp_secret: Option<&str>) -> Value {
    let mut user = json!({
        "id": "00000000-0000-7000-8000-0000000000aa",
        "fullName": "Test User",
        "email": "test@example.gov",
        "passwordHash": "SUPER_SECRET_HASH",
        "passwordSalt": "SUPER_SECRET_SALT",
        "role": null,
        "affiliation": "vendor",
        "status": "active",
        "approvedBy": null,
        "approvedAt": null,
        "tombstonedBy": null,
        "tombstonedAt": null,
        "untombstonedBy": null,
        "untombstonedAt": null,
        "lastLoginAt": null,
        "totpEnrolledAt": "2026-07-01T00:00:00.000Z",
        "createdAt": "2026-07-01T00:00:00.000Z",
        "updatedAt": "2026-07-01T00:00:00.000Z"
    });
    if let Some(secret) = totp_secret {
        user["totpSecret"] = json!(secret);
    }
    user
}

#[test]
fn strips_all_secret_material() {
    let safe = sanitize_user(&full_user(Some("BASE32SECRET")));
    // parity-assert: L:96c1562851eeb638-1
    assert!(!safe.as_object().unwrap().contains_key("passwordHash"));
    // parity-assert: L:1728250761d4ee59-1
    assert!(!safe.as_object().unwrap().contains_key("passwordSalt"));
    // parity-assert: L:cef22c43dce22796-1
    assert!(!safe.as_object().unwrap().contains_key("totpSecret"));
}

#[test]
fn derives_totp_enrolled() {
    let safe = sanitize_user(&full_user(Some("BASE32SECRET")));
    // parity-assert: L:9f065819d2df72dc-1
    assert_eq!(safe["totpEnrolled"], true);

    let safe = sanitize_user(&full_user(None));
    // parity-assert: L:6c75f96e1feb4051-1
    assert_eq!(safe["totpEnrolled"], false);
    let mut undefined_secret = full_user(Some("BASE32SECRET"));
    undefined_secret.as_object_mut().unwrap().remove("totpSecret");
    let safe = sanitize_user(&undefined_secret);
    // parity-assert: L:661ad0977991b6d9-1
    assert_eq!(safe["totpEnrolled"], false);
}

#[test]
fn preserves_non_secret_fields() {
    let safe = sanitize_user(&full_user(Some("BASE32SECRET")));
    // parity-assert: L:bb7d4499235c5444-1
    assert_eq!(safe["id"], "00000000-0000-7000-8000-0000000000aa");
    // parity-assert: L:b8e8e43d6af31119-1
    assert_eq!(safe["email"], "test@example.gov");
    // parity-assert: L:2b5302cd05f38549-1
    assert_eq!(safe["affiliation"], "vendor");
    // parity-assert: L:f0efffb084e505ed-1
    assert_eq!(safe["status"], "active");
}
