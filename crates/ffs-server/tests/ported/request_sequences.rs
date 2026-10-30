//! Port of test/backend/deno/request_sequences.test.tsx (14 parity assertions).
use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert_eq, TestApp};

#[tokio::test]
async fn request_sequences_atomic_counter() -> Result<()> {
    TestApp::run("request_sequences", |app| async move {
        fixtures::prepare(&app).await?;
        use ffs_server::routes::requests::next_request_sequence;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        parity_assert_eq!("L:4f78a1aa3b71ce2b-1", next_request_sequence(&db, "SEQA", "2026-07-24").await?, 1);
        parity_assert_eq!("L:8126d4446c98379f-1", next_request_sequence(&db, "SEQA", "2026-07-24").await?, 2);
        parity_assert_eq!("L:91aa13f739cf92b3-1", next_request_sequence(&db, "SEQA", "2026-07-24").await?, 3);
        parity_assert_eq!("L:74a609a87b0d68df-1", next_request_sequence(&db, "SEQB", "2026-07-24").await?, 1);
        parity_assert_eq!("L:88c179971c4a75d9-1", next_request_sequence(&db, "SEQB", "2026-07-24").await?, 2);
        parity_assert_eq!("L:a0fe5a51861e9b63-1", next_request_sequence(&db, "SEQB", "2026-07-25").await?, 1);
        parity_assert_eq!("L:98e29d00b8cfb9d2-1", next_request_sequence(&db, "SEQC", "2026-07-26").await?, 1);
        parity_assert_eq!("L:f26ee4c91682f53b-1", next_request_sequence(&db, "SEQD", "2026-07-26").await?, 1);
        parity_assert_eq!("L:2603af1346660167-1", next_request_sequence(&db, "SEQC", "2026-07-26").await?, 2);
        parity_assert_eq!("L:0e6e3480be52f2e8-1", next_request_sequence(&db, "SEQD", "2026-07-26").await?, 2);
        let n = 20usize;
        let mut set = tokio::task::JoinSet::new();
        for _ in 0..n {
            let db = db.clone();
            set.spawn(async move { next_request_sequence(&db, "SEQE", "2026-07-27").await });
        }
        let mut results = Vec::new();
        while let Some(r) = set.join_next().await { results.push(r.map_err(|e| anyhow::anyhow!(e.to_string()))?.map_err(|e| anyhow::anyhow!(e.to_string()))?); }
        let unique: std::collections::HashSet<i32> = results.iter().copied().collect();
        parity_assert_eq!("L:59839e6af3fbda98-1", unique.len(), n);
        parity_assert_eq!("L:14a4ed6a5f449bb6-1", *results.iter().min().unwrap(), 1);
        parity_assert_eq!("L:4c13081fd84eee84-1", *results.iter().max().unwrap() as usize, n);
        let counter: i32 = sqlx::query_scalar("SELECT counter FROM request_number_sequences WHERE system_short_code='SEQE' AND seq_date='2026-07-27'").fetch_one(app.db()).await?;
        parity_assert_eq!("L:4c17539847065bc9-1", counter as usize, n);
        Ok(())
    }).await
}
