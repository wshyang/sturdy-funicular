//! Port of test/backend/deno/schema_snapshot_vs_migrations.test.tsx —
//! addendum-079 snapshot ⇄ migration convergence (static invariants + DB probe).
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, workspace_root, TestApp};
use sea_orm::{ConnectionTrait, Database, DatabaseBackend, Statement};
use sqlx::Row;
use std::collections::{BTreeMap, BTreeSet};

use crate::fixtures;

fn migration_files() -> Result<Vec<String>> {
    let dir = workspace_root().join("migrations");
    let mut files = Vec::new();
    if dir.exists() {
        for entry in std::fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().to_string();
            if name.ends_with(".sql") {
                files.push(name);
            }
        }
    }
    files.sort();
    Ok(files)
}

fn version_of(file: &str) -> u32 {
    file.split('_').next().and_then(|v| v.parse().ok()).unwrap_or(0)
}

#[test]
fn static_invariants_no_db() -> Result<()> {
    let root = workspace_root();
    let snapshot = std::fs::read_to_string(root.join("setup/sql/001_schema.sql"))?;
    let files = migration_files()?;
    let versions: Vec<u32> = files.iter().map(|f| version_of(f)).collect();
    let unique: BTreeSet<u32> = versions.iter().copied().collect();

    let alters: Vec<&str> = snapshot
        .lines()
        .filter(|line| {
            let t = line.trim_start().to_uppercase();
            t.starts_with("ALTER TABLE") || t.starts_with("ALTER TYPE")
        })
        .collect();
    parity_assert_eq!("L:d72708a1940e60ea-1", alters, Vec::<&str>::new());

    if files.is_empty() {
        parity_assert!(
            "L:da2b86a10ea9dc74-1",
            snapshot.contains("INSERT INTO schema_migrations") && snapshot.contains("'001'")
        );
        return Ok(());
    }

    let min_v = *versions.iter().min().unwrap();
    let max_v = *versions.iter().max().unwrap();
    for v in min_v..=max_v {
        parity_assert!("L:555386c57985d3fa-1", unique.contains(&v));
    }
    for f in &files {
        let sql = std::fs::read_to_string(root.join("migrations").join(f))?;
        let v = format!("{:03}", version_of(f));
        parity_assert!("L:c74fccaff96ec522-1", sql.contains("INSERT INTO schema_migrations") && sql.contains(&format!("'{v}'")));
        parity_assert!("L:3227b069392b18f8-1", sql.lines().any(|l| l.trim_start().to_uppercase().starts_with("BEGIN")));
        parity_assert!("L:0acc8e457731e4cb-1", sql.lines().any(|l| l.trim_start().to_uppercase().starts_with("COMMIT")));
    }
    let preseed: Vec<u32> = snapshot
        .split("FROM unnest(ARRAY[")
        .nth(1)
        .and_then(|s| s.split("])").next())
        .map(|block| {
            block.match_indices('\'')
                .collect::<Vec<_>>()
                .chunks(2)
                .filter_map(|pair| {
                    if pair.len() == 2 {
                        block[pair[0].0 + 1..pair[1].0].parse().ok()
                    } else {
                        None
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    parity_assert!("L:0e44487bd038d0bd-1", !preseed.is_empty());
    for i in 1..preseed.len() {
        parity_assert_eq!("L:9ebf97d95517defb-1", preseed[i], preseed[i - 1] + 1);
    }
    let preseed_set: BTreeSet<u32> = preseed.iter().copied().collect();
    let max_pre = *preseed.last().unwrap_or(&0);
    for v in &unique {
        if *v <= max_pre {
            parity_assert!("L:62ce1c6a2ab83a24-1", preseed_set.contains(v));
        } else {
            parity_assert!("L:1198d8b2e2db8342-1", !preseed_set.contains(v));
        }
    }
    for v in &preseed {
        parity_assert!("L:100671f7cea4ed52-1", unique.contains(v));
    }
    Ok(())
}

async fn grab(app: &TestApp, key: &str, sql: &str) -> Result<(String, Vec<String>)> {
    let rows = sqlx::query(sql).fetch_all(app.db()).await?;
    let mut values = Vec::new();
    for row in rows {
        let mut parts = Vec::new();
        for i in 0..row.columns().len() {
            let value: Option<String> = row.try_get(i).ok();
            parts.push(value.unwrap_or_default());
        }
        values.push(parts.join("|"));
    }
    values.sort();
    Ok((key.to_string(), values))
}

async fn fingerprint(app: &TestApp) -> Result<BTreeMap<String, Vec<String>>> {
    let mut out = BTreeMap::new();
    let (k, v) = grab(app, "tables", "SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'') FROM information_schema.columns WHERE table_schema='public' ORDER BY table_name, ordinal_position").await?;
    out.insert(k, v);
    let (k, v) = grab(app, "enums", "SELECT t.typname, e.enumlabel FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY t.typname, e.enumsortorder").await?;
    out.insert(k, v);
    let (k, v) = grab(app, "indexes", "SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY indexname").await?;
    out.insert(k, v);
    let (k, v) = grab(app, "constraints", "SELECT conname, conrelid::regclass::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY conname").await?;
    out.insert(k, v);
    Ok(out)
}

#[tokio::test]
async fn db_convergence_snapshot_plus_migrations_is_schema_noop() -> Result<()> {
    let probe_a = TestApp::spawn().await?;
    let probe_b = TestApp::spawn().await?;
    fixtures::prepare(&probe_a).await?;
    fixtures::prepare(&probe_b).await?;
    let files = migration_files()?;
    if !files.is_empty() {
        let sea = Database::connect(probe_b.db_url()).await?;
        for f in files {
            let sql = std::fs::read_to_string(workspace_root().join("migrations").join(f))?;
            sea.execute(Statement::from_string(DatabaseBackend::Postgres, sql)).await?;
        }
    }
    let fa = fingerprint(&probe_a).await?;
    let fb = fingerprint(&probe_b).await?;
    let diverged: Vec<String> = fa
        .keys()
        .filter(|k| fa.get(*k) != fb.get(*k))
        .cloned()
        .collect();
    parity_assert_eq!("L:81a635e45ba1d84e-1", diverged.clone(), Vec::<String>::new());
    for k in diverged {
        parity_assert_eq!("L:51c64c23999f643c-1", fb.get(&k), fa.get(&k));
    }
    Ok(())
}
