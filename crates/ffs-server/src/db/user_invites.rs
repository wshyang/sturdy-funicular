// SeaORM entity + consume for user_invites (PORT-1.8, addendum-051).
// Single-use: consume() atomically marks consumed_at; returns None if already consumed/expired.

use chrono::Utc;
use sea_orm::{
    entity::prelude::*, ActiveModelTrait, ActiveValue::Set,
    ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter,
};
use uuid::Uuid;

use crate::errors::AppError;

#[derive(Clone, Debug, PartialEq, DeriveEntityModel)]
#[sea_orm(table_name = "user_invites")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub token: String,
    pub user_id: Uuid,
    pub created_by: Uuid,
    pub created_at: DateTimeWithTimeZone,
    pub expires_at: DateTimeWithTimeZone,
    pub consumed_at: Option<DateTimeWithTimeZone>,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}

pub struct UserInvite {
    pub token: String,
    pub user_id: Uuid,
}

/// Atomically consume an invite token. Returns None if missing, expired, or already consumed.
pub async fn consume_invite(
    db: &DatabaseConnection,
    token: &str,
) -> Result<Option<UserInvite>, AppError> {
    let row = Entity::find()
        .filter(Column::Token.eq(token))
        .filter(Column::ConsumedAt.is_null())
        .filter(Column::ExpiresAt.gt(Utc::now().fixed_offset()))
        .one(db)
        .await
        .map_err(AppError::from)?;

    let row = match row {
        Some(r) => r,
        None => return Ok(None),
    };

    let am = ActiveModel {
        token: Set(row.token.clone()),
        consumed_at: Set(Some(Utc::now().fixed_offset())),
        ..Default::default()
    };
    am.update(db).await.map_err(AppError::from)?;

    Ok(Some(UserInvite {
        token: row.token,
        user_id: row.user_id,
    }))
}
