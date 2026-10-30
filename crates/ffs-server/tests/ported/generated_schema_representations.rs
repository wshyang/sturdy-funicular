//! Port of test/backend/deno/generated_schema_representations.test.ts —
//! addendum-160 generated schema representation contracts.
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, workspace_root};
use serde_json::Value;

fn read_generated() -> Result<(Value, String)> {
    let root = workspace_root().join("docs/generated");
    let catalog: Value = serde_json::from_str(&std::fs::read_to_string(root.join("database-schema.json"))?)?;
    let sql = std::fs::read_to_string(root.join("database-schema.sql"))?;
    Ok((catalog, sql))
}

#[test]
fn generated_representations_identify_drizzle_as_source() -> Result<()> {
    let (catalog, sql) = read_generated()?;
    parity_assert_eq!("L:44670abf17ccbf70-1", catalog["generatedFrom"], "server/db/schema.ts");
    parity_assert_eq!("L:bf02d0b8097899fc-1", catalog["tables"].as_object().map(|m| m.len()).unwrap_or(0), 56);
    parity_assert_eq!("L:ccb8de3eef977ec4-1", catalog["enums"].as_object().map(|m| m.len()).unwrap_or(0), 28);
    parity_assert!("L:027eb05a53df6fc7-1", sql.starts_with("-- GENERATED FILE — DO NOT EDIT."));
    parity_assert!("L:a7df9373edcfb715-1", sql.contains("-- Source: server/db/schema.ts"));
    Ok(())
}

#[test]
fn generated_catalog_and_sql_contain_critical_normalized_aggregates() -> Result<()> {
    let (catalog, sql) = read_generated()?;
    for table in [
        "public.system_workflow_steps",
        "public.asset_tags",
        "public.request_asset_custody_run_items",
        "public.notification_recipients",
        "public.notification_deliveries",
        "public.notification_delivery_attempts",
        "public.request_asset_custody_cases",
    ] {
        parity_assert!("L:c070385eb5242172-1", catalog["tables"].get(table).is_some());
        let sql_name = table.replace("public.", "");
        parity_assert!("L:fbf1592565df3bef-1", sql.contains(&format!("CREATE TABLE IF NOT EXISTS \"{sql_name}\"")));
    }
    parity_assert!("L:e485a1bf3543962c-1", catalog["enums"].get("public.email_trigger_key").is_some());
    parity_assert!("L:91485dabf5a3c7b2-1", catalog["enums"].get("public.asset_custody_state").is_some());
    Ok(())
}

#[test]
fn generated_representations_contain_structure_only_never_seed_dml() -> Result<()> {
    let (_catalog, sql) = read_generated()?;
    let upper = sql.to_uppercase();
    parity_assert_eq!("L:3926a0d234ac1bce-1", upper.contains("INSERT INTO"), false);
    parity_assert_eq!("L:9927a536d7a1e8dc-1", sql.contains("CREATE TRIGGER"), false);
    parity_assert_eq!("L:8edef6b0c674ba81-1", sql.contains("CREATE OR REPLACE FUNCTION"), false);
    Ok(())
}
