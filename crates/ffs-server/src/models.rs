// Shared domain types used across the request lifecycle.
// Full SeaORM entities live in src/db/; these are the read-side structs
// passed through axum extensions and middleware.

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// Minimal user representation for middleware and auth use.
/// Full user model with all fields: src/db/users.rs (PORT-2.4).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: Uuid,
    pub status: String,
    pub full_name: String,
    pub email: String,
    pub is_system: bool,
    pub twofa_verified: bool,
    pub force_password_rotation: bool,
}

impl User {
    pub fn is_active(&self) -> bool {
        self.status == "active"
    }
}

/// User struct extended with credentials — used only in auth paths.
/// Never serialized over the wire.
#[derive(Debug, Clone)]
pub struct UserWithCredentials {
    pub user: User,
    pub password_hash: String,
    pub password_salt: String,
}

impl std::ops::Deref for UserWithCredentials {
    type Target = User;
    fn deref(&self) -> &User {
        &self.user
    }
}
