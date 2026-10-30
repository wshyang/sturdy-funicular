// Request-wide transaction handle threading.
//
// Replaces the Deno ALS-ambient transaction (pg.tsx:61-112).
// Rust has no safe AsyncLocalStorage equivalent. Instead, every entity method
// and handler accepts a `C: ConnectionTrait` (both DatabaseConnection and
// DatabaseTransaction implement it). The compiler enforces threading —
// no call-site can accidentally escape the transaction.
//
// Pattern mirrors addendum-214 §B / §6:
//   1. The idempotency middleware calls db.begin().await? → TxHandle(txn)
//   2. TxHandle is inserted into axum request Extensions
//   3. Handlers extract &TxHandle from Extensions to get the ConnectionTrait
//   4. 5xx → rollback; 4xx/2xx → commit
//   5. Token rotation happens OUTSIDE the tx (after commit/rollback)

use sea_orm::{DatabaseConnection, DatabaseTransaction, TransactionTrait};
use std::sync::Arc;
use tokio::sync::Mutex;

/// A boxed transaction stored in axum request extensions.
/// Wrapped in Arc<Mutex<...>> so it can be cloned into Extensions (which
/// require Clone) while giving the middleware exclusive commit/rollback access.
#[derive(Clone)]
pub struct TxHandle(pub Arc<Mutex<Option<DatabaseTransaction>>>);

impl TxHandle {
    pub fn new(txn: DatabaseTransaction) -> Self {
        TxHandle(Arc::new(Mutex::new(Some(txn))))
    }

    /// Commit the transaction. Consumes the inner transaction.
    pub async fn commit(self) -> Result<(), sea_orm::DbErr> {
        let txn = self
            .0
            .lock()
            .await
            .take()
            .ok_or_else(|| sea_orm::DbErr::Custom("transaction already consumed".into()))?;
        txn.commit().await
    }

    /// Rollback the transaction. Consumes the inner transaction.
    pub async fn rollback(self) -> Result<(), sea_orm::DbErr> {
        let txn = self
            .0
            .lock()
            .await
            .take()
            .ok_or_else(|| sea_orm::DbErr::Custom("transaction already consumed".into()))?;
        txn.rollback().await
    }
}

/// Begin a transaction on the pool.
pub async fn begin_tx(db: &DatabaseConnection) -> Result<TxHandle, sea_orm::DbErr> {
    let txn = db.begin().await?;
    Ok(TxHandle::new(txn))
}

/// Rust-native seam for the legacy `runInTransaction` helper (server/pg.tsx).
/// Runs `f` inside a real Postgres transaction; commits on `Ok`, rolls back on
/// `Err`. The closure receives a borrowed `DatabaseTransaction` so every write
/// and read inside it shares the same transaction.
pub async fn run_in_transaction<T, F>(db: &DatabaseConnection, f: F) -> anyhow::Result<T>
where
    F: for<'a> FnOnce(
        &'a DatabaseTransaction,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = anyhow::Result<T>> + 'a>,
    >,
{
    let txn = db.begin().await?;
    match f(&txn).await {
        Ok(value) => {
            txn.commit().await?;
            Ok(value)
        }
        Err(err) => {
            let _ = txn.rollback().await;
            Err(err)
        }
    }
}
