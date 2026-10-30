//! Canonical S3 naming contract exercised against the production AWS channel.
use ffs_server::aws::channel::{outbound_object_key, inbound_object_key};
use ffs_test_support::parity_assert_eq;

#[test]
fn canonical_v1_object_keys() {
    parity_assert_eq!("L:a9687af2b8f5ce60-1", outbound_object_key("exchange", "credential_request", "req-1").unwrap(), "exchange/v1/outbound/credential-request/req-1.json");
    parity_assert_eq!("L:ace5f69996def7bc-1", outbound_object_key("exchange", "request_close", "req-1").unwrap(), "exchange/v1/outbound/request-close/req-1.json");
    parity_assert_eq!("L:6edd95cc007730c3-1", outbound_object_key("exchange", "inventory_request", "sys-1").unwrap(), "exchange/v1/outbound/inventory-request/sys-1.json");
    parity_assert_eq!("L:395b1e16c1779b12-1", inbound_object_key("exchange", "credential_response", "req-1").unwrap(), "exchange/v1/inbound/credential-response/req-1.json");
    parity_assert_eq!("L:ee5da38707205cae-1", inbound_object_key("exchange", "request_close_ack", "req-1").unwrap(), "exchange/v1/inbound/request-close-ack/req-1.json");
    parity_assert_eq!("L:f67aec78e37c0841-1", inbound_object_key("exchange", "inventory_response", "sys-1").unwrap(), "exchange/v1/inbound/inventory-response/sys-1.json");
}

#[tokio::test]
async fn correlation_bound_ledger() -> anyhow::Result<()> {
    use ffs_server::aws::exchange;
    use ffs_test_support::TestApp;
    use sqlx::Row;
    use uuid::Uuid;
    TestApp::run("aws_exchange_ledger", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let admin = crate::fixtures::create_admin(&app, "AwsExAdmin!2026").await?;
        let owner = crate::fixtures::create_active_user(&app, "AwsExOwner", &crate::fixtures::unique_email("awsexowner"), "OwnerPass!2026", "agency", true).await?;
        let system = crate::fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        let correlation = Uuid::now_v7();
        let key = outbound_object_key("exchange", "credential_request", &correlation.to_string()).map_err(anyhow::Error::msg)?;
        let id = exchange::create(&db, system.system_id, correlation, "credential_request", true, Some("credential_response"), &key).await.map_err(anyhow::Error::msg)?;
        parity_assert_eq!("L:390e35192386696e-1", id.to_string().is_empty(), false);
        let matched = exchange::find_awaiting(&db, system.system_id, correlation, "credential_response").await.map_err(anyhow::Error::msg)?;
        parity_assert_eq!("L:df209f706b32c6a1-1", matched.is_some(), true);
        parity_assert_eq!("L:87422d55b5cd2b9b-1", matched, Some(id));
        parity_assert_eq!("L:e5f81daa958d937d-1", exchange::find_awaiting(&db, system.system_id, correlation, "inventory_response").await.map_err(anyhow::Error::msg)?, None);
        parity_assert_eq!("L:eceef771858640df-1", exchange::find_awaiting(&db, Uuid::now_v7(), correlation, "credential_response").await.map_err(anyhow::Error::msg)?, None);
        let published = chrono::DateTime::parse_from_rfc3339("2026-07-21T06:00:00.000Z")?.to_utc();
        let received = chrono::DateTime::parse_from_rfc3339("2026-07-21T06:00:01.000Z")?.to_utc();
        let processed = chrono::DateTime::parse_from_rfc3339("2026-07-21T06:00:02.000Z")?.to_utc();
        let inbound_key = inbound_object_key("exchange", "credential_response", &correlation.to_string()).map_err(anyhow::Error::msg)?;
        anyhow::ensure!(exchange::mark_received(&db, id, &inbound_key, published, received, "\"abc123\"").await.map_err(anyhow::Error::msg)?, "receiving failed");
        let row = sqlx::query("SELECT inbound_status, inbound_published_at, inbound_etag FROM aws_tenant_exchanges WHERE id=$1")
            .bind(id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:509e4bf76beb5d7c-1", row.get::<String,_>("inbound_status"), "received");
        parity_assert_eq!("L:216c7e556d76c7a8-1", row.get::<chrono::DateTime<chrono::Utc>,_>("inbound_published_at"), published);
        parity_assert_eq!("L:04e97970ba574538-1", row.get::<String,_>("inbound_etag"), "\"abc123\"");
        anyhow::ensure!(exchange::mark_processed(&db, id, processed).await.map_err(anyhow::Error::msg)?, "processing failed");
        let row = sqlx::query("SELECT inbound_status, inbound_processed_at FROM aws_tenant_exchanges WHERE id=$1")
            .bind(id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:1a43b96a92dc547c-1", row.get::<String,_>("inbound_status"), "processed");
        parity_assert_eq!("L:966b8410869e6b11-1", row.get::<chrono::DateTime<chrono::Utc>,_>("inbound_processed_at"), processed);
        parity_assert_eq!("L:792b22772903004e-1", exchange::find_awaiting(&db, system.system_id, correlation, "credential_response").await.map_err(anyhow::Error::msg)?, None);
        let wrong_one_way = exchange::create(&db, system.system_id, Uuid::now_v7(), "request_close", false, Some("request_close_ack"), &key).await;
        parity_assert_eq!("L:2f87397a9d06e16a-1", wrong_one_way.unwrap_err().contains("aws_tenant_exchanges_expects_inbound_consistency"), true);
        let missing_type = exchange::create(&db, system.system_id, Uuid::now_v7(), "credential_request", true, None, &key).await;
        parity_assert_eq!("L:b3ca33174d5fd6ff-1", missing_type.unwrap_err().contains("aws_tenant_exchanges_expects_inbound_consistency"), true);
        let failed_correlation = Uuid::now_v7();
        let failed = exchange::create(&db, system.system_id, failed_correlation, "inventory_request", true, Some("inventory_response"), &key).await.map_err(anyhow::Error::msg)?;
        anyhow::ensure!(exchange::mark_failed(&db, failed, "correlation_mismatch", "decoded system id did not match exchange").await.map_err(anyhow::Error::msg)?, "failure transition failed");
        let row = sqlx::query("SELECT inbound_status, failure_code FROM aws_tenant_exchanges WHERE id=$1")
            .bind(failed).fetch_one(app.db()).await?;
        parity_assert_eq!("L:4df80c4f3d0f4794-1", row.get::<String,_>("inbound_status"), "failed");
        parity_assert_eq!("L:88b8d47fa1b7f083-1", row.get::<String,_>("failure_code"), "correlation_mismatch");
        parity_assert_eq!("L:1392e262744094f7-1", exchange::find_awaiting(&db, system.system_id, failed_correlation, "inventory_response").await.map_err(anyhow::Error::msg)?, None);
        Ok(())
    }).await
}

#[tokio::test]
async fn close_ack_is_audit_only() -> anyhow::Result<()> {
    use ffs_server::aws::exchange;
    use ffs_test_support::TestApp;
    use sqlx::Row;
    use uuid::Uuid;
    TestApp::run("aws_close_ack", |app| async move {
        crate::fixtures::prepare(&app).await?;
        let admin = crate::fixtures::create_admin(&app, "AwsExAdmin!2026").await?;
        let owner = crate::fixtures::create_active_user(&app, "AwsExOwner", &crate::fixtures::unique_email("awsexowner"), "OwnerPass!2026", "agency", true).await?;
        let system = crate::fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let request = Uuid::now_v7();
        let closed_at = chrono::Utc::now();
        sqlx::query("INSERT INTO breakglass_requests (id,request_number,system_id,submitted_by,vendor_cluster_id,justification,sr_number,activity_start_at,activity_end_at,status,current_step_ordinal,owner_decision_by,owner_decision_at,credential_issued_by,credential_issued_at,closed_by,closing_notes,closed_at) VALUES ($1,$2,$3,$4,$5,'Close ack test.','SR-CA-1',now()-interval '1 hour',now()+interval '1 hour','closed',0,$4,now()-interval '2 minutes',$4,now()-interval '1 minute',$4,'done',$6)")
            .bind(request).bind(format!("BG-CA-{}", &request.simple().to_string()[..16])).bind(system.system_id).bind(owner.id)
            .bind(system.vendor_cluster_id).bind(closed_at).execute(app.db()).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        let key = outbound_object_key("exchange", "request_close", &request.to_string()).map_err(anyhow::Error::msg)?;
        let _exchange = exchange::create(&db, system.system_id, request, "request_close", true, Some("request_close_ack"), &key).await.map_err(anyhow::Error::msg)?;
        let ack = serde_json::json!({"schemaVersion":"1.0","kind":"request_close_ack","requestId":request,"systemId":system.system_id,"status":"success","processedAt":"2026-07-21T12:05:00.000Z","actionSummary":"rotation_requested","errorMessage":null});
        exchange::reconcile_close_acknowledgement(&db, system.system_id, request, &ack).await.map_err(anyhow::Error::msg)?;
        let rows = sqlx::query("SELECT details FROM audit_log WHERE target_type='breakglass_request' AND target_id=$1 AND action='request.aws_close_acknowledged'")
            .bind(request.to_string()).fetch_all(app.db()).await?;
        parity_assert_eq!("L:ebc05d851bc36180-1", rows.len(), 1);
        let details: serde_json::Value = rows[0].get("details");
        parity_assert_eq!("L:02c92facf3b081ab-1", details["status"].as_str(), Some("success"));
        parity_assert_eq!("L:bad7e2b7b3cb868c-1", details["actionSummary"].as_str(), Some("rotation_requested"));
        let after = sqlx::query("SELECT status::text AS status, closed_at FROM breakglass_requests WHERE id=$1")
            .bind(request).fetch_one(app.db()).await?;
        parity_assert_eq!("L:7674c029d4de9336-1", after.get::<String,_>("status"), "closed");
        parity_assert_eq!("L:8113fe587ce8f5e8-1", after.get::<Option<chrono::DateTime<chrono::Utc>>,_>("closed_at").is_some(), true);
        Ok(())
    }).await
}
