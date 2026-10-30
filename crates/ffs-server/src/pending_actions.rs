//! Viewer pending-action derivation shared by /requests/my-requests chips and
//! the admin aggregate ledger (legacy deriveViewerPendingActions vocabulary).
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;
use crate::errors::AppError;

pub async fn actions_for(db: &DatabaseConnection, user_id: Uuid, request_id: Uuid, system_id: Uuid, status: &str, ordinal: i16) -> Result<Vec<JsonValue>, AppError> {
    let mut out = Vec::new();
    if (status == "submitted" || status == "under_review") && ordinal > 1 {
        let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres, r#"
            SELECT 1 FROM request_approval_steps ras
            JOIN teams t ON t.cluster_id=ras.required_cluster_id AND t.level=ras.required_level AND t.expires_after IS NULL
            JOIN team_system_mappings tsm ON tsm.team_id=t.id AND tsm.system_id=$2 AND tsm.expires_after IS NULL
            JOIN team_memberships tm ON tm.team_id=t.id AND tm.user_id=$3 AND tm.expires_after IS NULL
            WHERE ras.request_id=$1 AND ras.step_ordinal=$4 LIMIT 1"#,
            [request_id.into(), system_id.into(), user_id.into(), ordinal.into()])).await?;
        if row.is_some() {
            let step = ordinal - 1;
            out.push(json!({"key":format!("pre_approval:review_step:{request_id}:step:{step}"),"workflowType":"pre_approval","kind":"review_step","stepRef":format!("step:{step}"),"label":format!("Review step {step}"),"urgency":"normal","deeplink":format!("/dashboard/request/{request_id}")}));
        }
    } else if status == "under_review" && ordinal == 0 {
        let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres, r#"
            SELECT 1 FROM system_owners WHERE system_id=$1 AND user_id=$2 AND expires_after IS NULL
            UNION ALL
            SELECT 1 FROM system_delegates WHERE system_id=$1 AND delegate_user_id=$2 AND expires_after IS NULL LIMIT 1"#,
            [system_id.into(), user_id.into()])).await?;
        if row.is_some() {
            out.push(json!({"key":format!("pre_approval:owner_decision:{request_id}"),"workflowType":"pre_approval","kind":"owner_decision","stepRef":JsonValue::Null,"label":"Owner decision","urgency":"normal","deeplink":format!("/dashboard/request/{request_id}")}));
        }
    }
    Ok(out)
}
