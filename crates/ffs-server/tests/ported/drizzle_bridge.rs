//! Port of test/backend/deno/drizzle_bridge.test.tsx — the Rust-native seam is
//! SeaORM helpers sharing the same ConnectionTrait transaction as raw SQL.
use anyhow::{bail, Result};
use ffs_server::{db::clusters::{self, CreateClusterInput}, tx::run_in_transaction};
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};
use uuid::Uuid;

use crate::fixtures;

async fn cluster_name(app: &TestApp, id: Uuid) -> Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT name FROM clusters WHERE id = $1")
        .bind(id)
        .fetch_optional(app.db())
        .await?)
}

#[tokio::test]
async fn orm_writes_share_the_request_transaction() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let admin = fixtures::create_admin(&app, "BridgeAdmin!2026").await?;
    let org_id = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
    let sea = Database::connect(app.db_url()).await?;

    // Commit path.
    let id = Uuid::now_v7();
    run_in_transaction(&sea, |txn| {
        let input = CreateClusterInput {
            id, name: "Bridge Commit".into(), type_: "vendor".into(), description: None,
            organization_id: org_id, created_by: admin.id,
        };
        Box::pin(async move {
            clusters::create(txn, input).await?;
            Ok(())
        })
    })
    .await?;
    let name = cluster_name(&app, id).await?;
    parity_assert_eq!("L:c10aeca470be400a-1", name.is_some(), true);
    parity_assert_eq!("L:a41903f513fa082f-1", name.as_deref(), Some("Bridge Commit"));

    // Rollback path, with a mid-transaction read proving same-connection writes.
    let rollback_id = Uuid::now_v7();
    let result: Result<()> = run_in_transaction(&sea, |txn| {
        let input = CreateClusterInput {
            id: rollback_id, name: "Bridge Rollback".into(), type_: "vendor".into(), description: None,
            organization_id: org_id, created_by: admin.id,
        };
        Box::pin(async move {
            clusters::create(txn, input).await?;
            let row = txn
                .query_one(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    "SELECT count(*)::bigint AS n FROM clusters WHERE id = $1",
                    [rollback_id.into()],
                ))
                .await?
                .expect("count row");
            let n: i64 = row.try_get("", "n")?;
            parity_assert_eq!("L:f4382415083c21e7-1", n, 1);
            bail!("intentional rollback");
        })
    })
    .await;
    parity_assert_eq!("L:c1e810fe5f74b54f-1", result.is_err(), true);
    parity_assert_eq!("L:e255933c38f2c3c6-1", cluster_name(&app, rollback_id).await?.is_none(), true);

    // Outside any transaction, an ORM write commits directly.
    let no_tx_id = Uuid::now_v7();
    clusters::create(
        &sea,
        CreateClusterInput {
            id: no_tx_id, name: "Bridge No-Tx".into(), type_: "agency".into(), description: None,
            organization_id: org_id, created_by: admin.id,
        },
    )
    .await?;
    let name = cluster_name(&app, no_tx_id).await?;
    parity_assert_eq!("L:454e9dcd576f9ac5-1", name.is_some(), true);
    parity_assert_eq!("L:41a153b559872f47-1", name.as_deref(), Some("Bridge No-Tx"));

    // Typed SELECT round-trip through the Rust entity helper.
    let rows = clusters::find_live_by_type(&sea, "agency").await?;
    let no_tx = rows.iter().find(|r| r.name == "Bridge No-Tx");
    parity_assert!("L:f929dcb010faaab2-1", no_tx.is_some());
    let no_tx = no_tx.unwrap();
    parity_assert_eq!("L:acccae345b1b28a4-1", no_tx.type_.as_str(), "agency");
    parity_assert_eq!("L:2c579529d4493b21-1", no_tx.created_by, admin.id);
    Ok(())
}
