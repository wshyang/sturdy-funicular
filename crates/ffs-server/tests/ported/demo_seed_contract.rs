//! Port of test/backend/deno/demo_seed_contract.test.ts — demo seed SQL targets
//! canonical schema columns, startup order, and current password/custody contracts.
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, workspace_root};
use serde_json::Value;

fn insert_targets(sql: &str) -> Vec<(String, Vec<String>)> {
    let lower = sql.to_lowercase();
    let mut out = Vec::new();
    let mut cursor = 0usize;
    while let Some(pos) = lower[cursor..].find("insert into") {
        let start = cursor + pos + "insert into".len();
        let rest = &sql[start..];
        let table: String = rest.chars().skip_while(|c| c.is_whitespace()).take_while(|c| c.is_ascii_alphanumeric() || *c == '_').collect();
        if table.is_empty() {
            cursor = start;
            continue;
        }
        let after_table = &rest[table.len()..];
        let columns = if let Some(open) = after_table.find('(') {
            if let Some(close) = after_table[open..].find(')') {
                after_table[open + 1..open + close]
                    .split(',')
                    .map(|c| c.trim().trim_matches('"').to_lowercase())
                    .filter(|c| !c.is_empty())
                    .collect()
            } else {
                Vec::new()
            }
        } else {
            Vec::new()
        };
        out.push((table.to_lowercase(), columns));
        cursor = start + table.len();
    }
    out
}

#[test]
fn demo_seed_insert_targets_and_columns_exist_in_canonical_schema() -> Result<()> {
    let root = workspace_root();
    let catalog: Value = serde_json::from_str(&std::fs::read_to_string(root.join("docs/generated/database-schema.json"))?)?;
    for file in ["setup/sql/002_seed_demo.sql", "setup/sql/003_seed_demo_live.sql"] {
        let sql = std::fs::read_to_string(root.join(file))?;
        for (table_name, columns) in insert_targets(&sql) {
            let table = catalog["tables"].get(format!("public.{table_name}"));
            parity_assert!("L:d06f3e69aa1358d5-1", table.is_some());
            if let Some(table) = table {
                for column in columns {
                    parity_assert!("L:715c12c56f3654ad-1", table["columns"].get(&column).is_some());
                }
            }
        }
    }
    Ok(())
}

#[test]
fn demo_startup_seed_matches_canonical_contracts() -> Result<()> {
    let sql = std::fs::read_to_string(workspace_root().join("setup/sql/003_seed_demo_live.sql"))?;
    for required in [
        "Org Aurora", "Org Cobalt", "amanda.scoped@aurora.demo", "greg.global@demo.local",
        "config_audit_admin", "org_structure_admin", "aurora-demo-client-id",
        "system_custody_stage_configs", "management_mode", "pbkdf2-sha256$600000$",
    ] {
        parity_assert!("L:f0187963d7f98eb2-1", sql.contains(required));
    }
    for forbidden in [
        "post_approval", "post_workflow", "attest", "acknowledge",
        "digest('live-demo-placeholder-not-a-real-password'",
    ] {
        parity_assert_eq!("L:fea8b4f3c6a1e531-1", sql.contains(forbidden), false);
    }
    for stage in ["prepare", "initiate_handover", "verify_return", "return_to_inventory", "investigate_exception"] {
        parity_assert!("L:37df5baacbe7baed-1", sql.contains(&format!("'{stage}'")));
    }
    let config_rows = sql.matches("00000000-0000-0000-0001-0000000005").count();
    parity_assert!("L:6b03b6d52bc0dc03-1", config_rows >= 15);
    Ok(())
}

#[test]
fn server_refuses_to_listen_before_demo_seed_initialization_finishes() -> Result<()> {
    let source = std::fs::read_to_string(workspace_root().join("crates/ffs-server/src/main.rs"))?;
    let initialization = source.find("initialize_application").unwrap_or(usize::MAX);
    let listen = source.find("axum::serve").unwrap_or(0);
    parity_assert!("L:e94fb797c8fb7fe9-1", initialization != usize::MAX && listen > initialization);
    parity_assert!("L:aeb48f28c7b24ea0-1", source.contains("run_demo_seed_if_enabled"));
    Ok(())
}

#[test]
fn manual_development_demo_seed_uses_current_password_and_custody_contracts() -> Result<()> {
    let sql = std::fs::read_to_string(workspace_root().join("setup/sql/002_seed_demo.sql"))?;
    parity_assert!("L:037f4557910884ec-1", sql.contains("pbkdf2-sha256$600000$"));
    parity_assert!("L:dd0f04c526a25f2c-1", sql.contains("organization_memberships"));
    parity_assert!("L:8b1d07edac91c248-1", sql.contains("system_custody_stage_configs"));
    parity_assert_eq!("L:ab90d198e157ddae-1", sql.contains("digest(password"), false);
    parity_assert_eq!("L:ca75284083a94514-1", sql.contains("post_approval"), false);
    Ok(())
}
