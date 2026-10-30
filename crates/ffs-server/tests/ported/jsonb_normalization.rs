//! Port of test/backend/deno/jsonb_normalization.test.tsx — addendum-146
//! RED-first schema contract: business JSONB is forbidden; only retained
//! observability documents may remain, and normalized replacements need FKs.
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use sqlx::Row;
use std::collections::BTreeSet;

use crate::fixtures;

#[tokio::test]
async fn business_jsonb_columns_are_normalized_with_fk_backed_replacements() -> Result<()> {
    let app = TestApp::spawn().await?;
    fixtures::prepare(&app).await?;
    let rows = sqlx::query(
        "SELECT table_name, column_name FROM information_schema.columns \
         WHERE table_schema = 'public' AND data_type = 'jsonb' \
         ORDER BY table_name, ordinal_position",
    )
    .fetch_all(app.db())
    .await?;
    let actual: BTreeSet<String> = rows
        .iter()
        .map(|r| -> Result<String, sqlx::Error> {
            Ok(format!("{}.{}", r.try_get::<String, _>("table_name")?, r.try_get::<String, _>("column_name")?))
        })
        .collect::<Result<_, _>>()?;
    let allowed: BTreeSet<String> = [
        "access_log.request_headers",
        "audit_log.details",
        "audit_log_changes.changes",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    parity_assert_eq!("L:e0d7c1a9c5a33d96-1", actual, allowed);

    for table in [
        "system_vendor_clusters",
        "system_workflow_steps",
        "asset_tags",
        "request_asset_custody_run_items",
        "notification_template_variables",
        "notification_recipients",
    ] {
        let n: i64 = sqlx::query_scalar(
            "SELECT count(*)::bigint FROM information_schema.table_constraints \
             WHERE table_schema='public' AND table_name=$1 AND constraint_type='FOREIGN KEY'",
        )
        .bind(table)
        .fetch_one(app.db())
        .await?;
        parity_assert!("L:097bd2b23bb666a0-1", n > 0);
    }
    Ok(())
}
