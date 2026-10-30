//! Admin pending-actions oversight report (legacy server/routes/admin/pending-actions.tsx).
//! Importers/callers: main.rs registers GET /admin/pending-actions.
//! Affected API: GET /admin/pending-actions (UserRead scope: global registry / shared-org filter).
//! Data schemas: users, organization_memberships, request_approval_steps, team_memberships,
//!   team_system_mappings, system_owners, system_delegates, breakglass_requests.
//! User instruction: continue the staged Rust port (Stage 2D).

use std::collections::HashMap;
use std::sync::Arc;

use axum::{extract::{Extension, State}, Json};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::admin_roles::{resolve_admin_capability_scope, ScopeKind},
    errors::{AppError, RouteResult},
};

pub async fn get_admin_pending_actions(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
) -> RouteResult<Json<JsonValue>> {
    let scope = resolve_admin_capability_scope(&db, session.user_id, "UserRead").await?;
    let granted = match &scope {
        ScopeKind::Global => None,
        ScopeKind::Scoped(orgs) => Some(orgs.clone()),
        ScopeKind::None => return Err(AppError::Authorization("User lacks required admin capability: UserRead".into())),
    };
    let users = db.query_all(Statement::from_string(DbBackend::Postgres, "SELECT id, full_name, email, affiliation::text AS affiliation FROM users WHERE status='active' AND is_system=false ORDER BY full_name".to_string())).await?;
    let memberships = db.query_all(Statement::from_string(DbBackend::Postgres, "SELECT om.user_id, om.organization_id, o.name FROM organization_memberships om JOIN organizations o ON o.id=om.organization_id WHERE om.expires_after IS NULL AND o.expires_after IS NULL".to_string())).await?;
    let mut orgs_by_user: HashMap<Uuid, Vec<JsonValue>> = HashMap::new();
    for m in memberships {
        let uid: Uuid = m.try_get("", "user_id")?;
        orgs_by_user.entry(uid).or_default().push(json!({"id":m.try_get::<Uuid>("","organization_id")?,"name":m.try_get::<String>("","name")?}));
    }
    // Derive pending review steps per user (current-step reviewers via team mappings).
    let rows = db.query_all(Statement::from_string(DbBackend::Postgres, r#"
        SELECT DISTINCT tm.user_id, r.id AS request_id, r.current_step_ordinal
        FROM breakglass_requests r
        JOIN request_approval_steps ras ON ras.request_id=r.id AND ras.step_ordinal=r.current_step_ordinal
        JOIN teams t ON t.cluster_id=ras.required_cluster_id AND t.level=ras.required_level AND t.expires_after IS NULL
        JOIN team_system_mappings tsm ON tsm.team_id=t.id AND tsm.system_id=r.system_id AND tsm.expires_after IS NULL
        JOIN team_memberships tm ON tm.team_id=t.id AND tm.expires_after IS NULL
        WHERE r.status::text IN ('submitted','under_review') AND r.current_step_ordinal > 1
    "#.to_string())).await?;
    let mut pending: HashMap<Uuid, Vec<JsonValue>> = HashMap::new();
    for r in rows {
        let uid: Uuid = r.try_get("", "user_id")?;
        let rid: Uuid = r.try_get("", "request_id")?;
        let ord: i16 = r.try_get("", "current_step_ordinal")?;
        pending.entry(uid).or_default().push(json!({
            "key": format!("pre_approval:review_step:{rid}:step:{}", ord-1),
            "workflowType":"pre_approval","kind":"review_step","stepRef":format!("step:{}",ord-1),
            "label":format!("Review step {}",ord-1),"urgency":"normal","deeplink":format!("/dashboard/request/{rid}"),
        }));
    }
    // Owner-terminal debtors (ordinal 0) share the same cue vocabulary.
    let owner_rows = db.query_all(Statement::from_string(DbBackend::Postgres, r#"
        SELECT DISTINCT so.user_id, r.id AS request_id
        FROM breakglass_requests r
        JOIN system_owners so ON so.system_id=r.system_id AND so.expires_after IS NULL
        WHERE r.status::text='under_review' AND r.current_step_ordinal=0
        UNION
        SELECT DISTINCT sd.delegate_user_id AS user_id, r.id AS request_id
        FROM breakglass_requests r
        JOIN system_delegates sd ON sd.system_id=r.system_id AND sd.expires_after IS NULL
        WHERE r.status::text='under_review' AND r.current_step_ordinal=0
    "#.to_string())).await?;
    for r in owner_rows {
        let uid: Uuid = r.try_get("", "user_id")?;
        let rid: Uuid = r.try_get("", "request_id")?;
        pending.entry(uid).or_default().push(json!({
            "key": format!("pre_approval:owner_decision:{rid}"),
            "workflowType":"pre_approval","kind":"owner_decision","stepRef":JsonValue::Null,
            "label":"Owner decision","urgency":"normal","deeplink":format!("/dashboard/request/{rid}"),
        }));
    }
    let mut debtors = Vec::new();
    let mut scanned = 0usize;
    for u in users {
        let uid: Uuid = u.try_get("", "id")?;
        let orgs = orgs_by_user.get(&uid).cloned().unwrap_or_default();
        if let Some(g) = &granted {
            let shares = orgs.iter().any(|o| o["id"].as_str().and_then(|s| Uuid::parse_str(s).ok()).map(|id| g.contains(&id)).unwrap_or(false));
            if !shares { continue; }
        }
        scanned += 1;
        let actions = pending.get(&uid).cloned().unwrap_or_default();
        if actions.is_empty() { continue; }
        debtors.push(json!({
            "user":{"id":uid,"fullName":u.try_get::<String>("","full_name")?,"email":u.try_get::<String>("","email")?,"affiliation":u.try_get::<String>("","affiliation")?,"organizations":orgs},
            "pendingActions":actions,"overdueCount":0,"dueSoonCount":0,
        }));
    }
    Ok(Json(json!({"debtors":debtors,"debtorCount":debtors.len(),"scannedUserCount":scanned,"generatedAt":chrono::Utc::now().to_rfc3339()})))
}
