// SeaORM entity + query helpers for the `users` table.
// Importers/callers: routes/admin/users.rs (list_all_for_admin), auth paths (get_user_by_id, get_user_by_email, create_user, update_user_password).
// Affected API: GET /admin/users (new list_all_for_admin), POST /auth/register, GET /auth/me.
// Data schemas: users(id, full_name, email, password_hash, password_salt, affiliation, status, is_system, is_protected, force_password_rotation, totp_secret, totp_enrolled_at, last_login_at, created_at, updated_at, ...).
// User instruction: "fix the rust port to ensure API and PlayWright suites pass"

use chrono::Utc;
use sea_orm::{
    ActiveModelTrait, ActiveValue::{NotSet, Set},
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder,
};
use uuid::Uuid;

use crate::{errors::AppError, models::User};

pub mod entity {
    use sea_orm::entity::prelude::*;

    /// Mirrors Postgres `user_status` enum.
    #[derive(Clone, Debug, PartialEq, Eq, EnumIter, DeriveActiveEnum)]
    #[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "user_status")]
    pub enum UserStatus {
        #[sea_orm(string_value = "pending_approval")]
        PendingApproval,
        #[sea_orm(string_value = "active")]
        Active,
        #[sea_orm(string_value = "tombstoned")]
        Tombstoned,
        #[sea_orm(string_value = "rejected")]
        Rejected,
    }

    /// Mirrors Postgres `user_affiliation` enum.
    #[derive(Clone, Debug, PartialEq, Eq, EnumIter, DeriveActiveEnum)]
    #[sea_orm(rs_type = "String", db_type = "Enum", enum_name = "user_affiliation")]
    pub enum UserAffiliation {
        #[sea_orm(string_value = "agency")]
        Agency,
        #[sea_orm(string_value = "vendor")]
        Vendor,
    }

    #[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub full_name: String,
        pub email: String,
        pub password_hash: String,
        pub password_salt: String,
        pub affiliation: Option<UserAffiliation>,
        pub status: UserStatus,
        pub is_system: bool,
        pub is_protected: bool,
        pub force_password_rotation: bool,
        pub totp_secret: Option<String>,
        pub totp_enrolled_at: Option<DateTimeWithTimeZone>,
        pub last_login_at: Option<DateTimeWithTimeZone>,
        pub created_at: DateTimeWithTimeZone,
        pub updated_at: DateTimeWithTimeZone,
        pub password_login_disabled_at: Option<DateTimeWithTimeZone>,
        pub password_login_disabled_reason: Option<String>,
        pub password_login_disabled_by: Option<Uuid>,
        pub pending_actions_digest_opt_in: bool,
        pub pending_actions_digest_last_sent_at: Option<DateTimeWithTimeZone>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

fn status_str(s: &entity::UserStatus) -> &'static str {
    match s {
        entity::UserStatus::PendingApproval => "pending_approval",
        entity::UserStatus::Active => "active",
        entity::UserStatus::Tombstoned => "tombstoned",
        entity::UserStatus::Rejected => "rejected",
    }
}

fn model_to_user(m: &entity::Model) -> User {
    User {
        id: m.id,
        status: status_str(&m.status).to_string(),
        full_name: m.full_name.clone(),
        email: m.email.clone(),
        is_system: m.is_system,
        twofa_verified: m.totp_secret.is_some() && m.totp_enrolled_at.is_some(),
        force_password_rotation: m.force_password_rotation,
    }
}

pub async fn get_user_by_id(
    db: &DatabaseConnection,
    id: Uuid,
) -> Result<Option<User>, AppError> {
    let row = entity::Entity::find_by_id(id)
        .one(db)
        .await
        .map_err(AppError::from)?;
    Ok(row.as_ref().map(model_to_user))
}

pub async fn get_user_by_email(
    db: &DatabaseConnection,
    email: &str,
) -> Result<Option<crate::models::UserWithCredentials>, AppError> {
    let row = entity::Entity::find()
        .filter(entity::Column::Email.eq(email))
        .one(db)
        .await
        .map_err(AppError::from)?;

    Ok(row.map(|m| crate::models::UserWithCredentials {
        user: model_to_user(&m),
        password_hash: m.password_hash.clone(),
        password_salt: m.password_salt.clone(),
    }))
}

/// Check if an active (non-tombstoned, non-rejected) email already exists.
pub async fn find_active_by_email(
    db: &DatabaseConnection,
    email: &str,
) -> Result<bool, AppError> {
    let row = entity::Entity::find()
        .filter(entity::Column::Email.eq(email))
        .filter(entity::Column::Status.ne(entity::UserStatus::Tombstoned))
        .filter(entity::Column::Status.ne(entity::UserStatus::Rejected))
        .one(db)
        .await
        .map_err(AppError::from)?;
    Ok(row.is_some())
}

pub struct CreateUserInput {
    pub id: Uuid,
    pub full_name: String,
    pub email: String,
    pub password_hash: String,
    pub password_salt: String,
}

/// Insert a new user with pending_approval status.
pub async fn create_user(
    db: &DatabaseConnection,
    input: CreateUserInput,
) -> Result<(), AppError> {
    let now = Utc::now().fixed_offset();
    let am = entity::ActiveModel {
        id: Set(input.id),
        full_name: Set(input.full_name),
        email: Set(input.email),
        password_hash: Set(input.password_hash),
        password_salt: Set(input.password_salt),
        affiliation: Set(None),
        status: Set(entity::UserStatus::PendingApproval),
        is_system: Set(false),
        is_protected: Set(false),
        force_password_rotation: Set(false),
        totp_secret: Set(None),
        totp_enrolled_at: Set(None),
        last_login_at: Set(None),
        created_at: Set(now),
        updated_at: Set(now),
        password_login_disabled_at: Set(None),
        password_login_disabled_reason: Set(None),
        password_login_disabled_by: Set(None),
        pending_actions_digest_opt_in: Set(false),
        pending_actions_digest_last_sent_at: Set(None),
    };
    am.insert(db).await.map_err(AppError::from)?;
    Ok(())
}

/// Return all users ordered by created_at asc — used by GET /admin/users.
pub async fn list_all_for_admin(db: &DatabaseConnection) -> Result<Vec<entity::Model>, AppError> {
    entity::Entity::find()
        .order_by_asc(entity::Column::CreatedAt)
        .all(db)
        .await
        .map_err(AppError::from)
}

/// Update password hash + salt (invite acceptance / password change).
pub async fn update_user_password(
    db: &DatabaseConnection,
    user_id: Uuid,
    password_hash: String,
    password_salt: String,
) -> Result<(), AppError> {
    let am = entity::ActiveModel {
        id: Set(user_id),
        password_hash: Set(password_hash),
        password_salt: Set(password_salt),
        last_login_at: Set(Some(Utc::now().fixed_offset())),
        updated_at: Set(Utc::now().fixed_offset()),
        full_name: NotSet,
        email: NotSet,
        affiliation: NotSet,
        status: NotSet,
        is_system: NotSet,
        is_protected: NotSet,
        force_password_rotation: NotSet,
        totp_secret: NotSet,
        totp_enrolled_at: NotSet,
        created_at: NotSet,
        password_login_disabled_at: NotSet,
        password_login_disabled_reason: NotSet,
        password_login_disabled_by: NotSet,
        pending_actions_digest_opt_in: NotSet,
        pending_actions_digest_last_sent_at: NotSet,
    };
    am.update(db).await.map_err(AppError::from)?;
    Ok(())
}
