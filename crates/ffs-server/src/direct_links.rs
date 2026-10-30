//! Opaque email deep-link mappings (legacy server/direct-links.tsx).
//! Keys are locators, not authorization grants; resolution re-checks live visibility.
use chrono::{DateTime, Duration, Utc};
use rand::{rngs::OsRng, RngCore};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use uuid::Uuid;

use crate::{app_settings, errors::AppError};

const ALPHABET: &[u8] = b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[derive(Clone, Debug)]
pub struct LinkMapping {
    pub key: String,
    pub target_type: String,
    pub target_id: Uuid,
    pub intended_user_id: Option<Uuid>,
    pub used_at: Option<DateTime<chrono::FixedOffset>>,
    pub used_count: i32,
}

pub fn generate_mapping_key() -> String {
    let mut bytes = [0u8; 12];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| ALPHABET[(*b as usize) % ALPHABET.len()] as char).collect()
}

pub async fn create_link_mapping(
    db: &DatabaseConnection,
    target_type: &str,
    target_id: Uuid,
    created_by: Uuid,
    intended_user_id: Option<Uuid>,
) -> Result<String, AppError> {
    let key = generate_mapping_key();
    let ttl = app_settings::get_setting_int(db, "direct_link_ttl_days").await?;
    let expires = if ttl > 0 { Some((Utc::now() + Duration::days(ttl)).to_rfc3339()) } else { None };
    db.execute(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"INSERT INTO link_mappings
           (key,target_type,target_id,created_by,created_at,intended_user_id,expires_at,used_count)
           VALUES ($1,$2::link_target_type,$3,$4,now(),$5,$6::timestamptz,0)"#,
        [key.clone().into(), target_type.to_owned().into(), target_id.into(), created_by.into(),
         intended_user_id.into(), expires.into()])).await?;
    Ok(key)
}

pub async fn build_direct_link_url(db: &DatabaseConnection, key: &str) -> Result<String, AppError> {
    let configured = app_settings::get_setting_string(db, "public_base_url").await?;
    let base = if configured.trim().is_empty() {
        std::env::var("FRONTEND_URL").unwrap_or_else(|_| "http://localhost:5173".into())
    } else { configured };
    Ok(format!("{}?dl={}", base.trim_end_matches('/'), key))
}

pub async fn create_direct_link_url(
    db: &DatabaseConnection, target_type: &str, target_id: Uuid,
    created_by: Uuid, intended_user_id: Option<Uuid>,
) -> Result<String, AppError> {
    let key = create_link_mapping(db, target_type, target_id, created_by, intended_user_id).await?;
    build_direct_link_url(db, &key).await
}

/// Atomic scope + TTL check and usage bump. Every invalid case is the same None.
pub async fn consume_if_valid_for_user<C: ConnectionTrait>(
    db: &C, key: &str, user_id: Uuid,
) -> Result<Option<LinkMapping>, AppError> {
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"UPDATE link_mappings
           SET used_at=COALESCE(used_at,now()), used_count=used_count+1
           WHERE key=$1 AND (intended_user_id IS NULL OR intended_user_id=$2)
             AND (expires_at IS NULL OR expires_at>now())
           RETURNING key,target_type::text AS target_type,target_id,intended_user_id,used_at,used_count"#,
        [key.into(), user_id.into()])).await?;
    row.map(|r| -> Result<LinkMapping, AppError> {
        Ok(LinkMapping {
            key: r.try_get("", "key")?, target_type: r.try_get("", "target_type")?,
            target_id: r.try_get("", "target_id")?, intended_user_id: r.try_get("", "intended_user_id")?,
            used_at: r.try_get("", "used_at")?, used_count: r.try_get("", "used_count")?,
        })
    }).transpose()
}

pub async fn sweep_expired_link_mappings(db: &DatabaseConnection) -> Result<u64, AppError> {
    Ok(db.execute(Statement::from_string(DbBackend::Postgres,
        "DELETE FROM link_mappings WHERE expires_at IS NOT NULL AND expires_at<=now()")).await?.rows_affected())
}
