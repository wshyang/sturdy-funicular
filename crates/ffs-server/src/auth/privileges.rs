//! Canonical authorization decisions (legacy server/auth.tsx boundary).
//! Role/grant storage lives in `db::admin_roles`; HTTP-facing allow/deny
//! decisions are exported only here so route code has one privilege seam.

use sea_orm::ConnectionTrait;
use uuid::Uuid;

use crate::{db::admin_roles, errors::AppError};

pub async fn has_admin_privilege<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    capability: &str,
) -> Result<bool, AppError> {
    admin_roles::has_effective_admin_capability(db, user_id, capability).await
}

pub async fn require_admin_privilege<C: ConnectionTrait>(
    db: &C,
    user_id: Uuid,
    capability: &str,
) -> Result<(), AppError> {
    if !has_admin_privilege(db, user_id, capability).await? {
        return Err(AppError::auth(format!(
            "User lacks required admin capability: {capability}"
        )));
    }
    Ok(())
}
