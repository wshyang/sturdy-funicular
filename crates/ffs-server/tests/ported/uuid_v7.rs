//! Port of test/backend/deno/uuid_v7.test.tsx — UUIDv7 shape/ordering and the
//! real-insert ordering property that motivates v7 entity ids (addendum-041).
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use uuid::Uuid;

use crate::fixtures;

fn timestamp_ms(id: &Uuid) -> u64 {
    let hex = id.simple().to_string();
    u64::from_str_radix(&hex[..12], 16).expect("uuid hex")
}

#[test]
fn generate_id_has_uuidv7_shape() {
    for _ in 0..20 {
        let id = Uuid::now_v7().to_string();
        let bytes = id.as_bytes();
        let version7 = bytes[14] == b'7';
        let variant = matches!(bytes[19], b'8' | b'9' | b'a' | b'b');
        parity_assert!("L:0df036a38e3a0d01-1", version7 && variant);
    }
}

#[test]
fn successive_uuidv7_timestamps_are_non_decreasing() {
    let ids: Vec<Uuid> = (0..50).map(|_| Uuid::now_v7()).collect();
    let timestamps: Vec<u64> = ids.iter().map(timestamp_ms).collect();
    for i in 1..timestamps.len() {
        parity_assert!("L:b738832e75cf3ad2-1", timestamps[i] >= timestamps[i - 1]);
    }
}

#[tokio::test]
async fn real_insert_ordering_matches_created_at_ordering() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "UuidV7Admin!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let mut created: Vec<(Uuid, String)> = Vec::new();
    for i in 0..5 {
        let id = Uuid::now_v7();
        let name = format!("uuidv7-order-{i}-{}", Uuid::now_v7().simple());
        sqlx::query(
            r#"INSERT INTO clusters (id, name, "type", description, organization_id, created_by, created_at, updated_at)
               VALUES ($1, $2, 'vendor', NULL, $3, $4, now(), now())"#,
        )
        .bind(id)
        .bind(&name)
        .bind(org_id)
        .bind(admin.id)
        .execute(app.db())
        .await?;
        created.push((id, name));
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let mut sorted = created.clone();
    sorted.sort_by_key(|(id, _)| *id);
    let sorted_names: Vec<String> = sorted.into_iter().map(|(_, n)| n).collect();
    let created_names: Vec<String> = created.into_iter().map(|(_, n)| n).collect();
    parity_assert_eq!("L:73fba49816bd4b50-1", sorted_names, created_names);
    Ok(())
}
