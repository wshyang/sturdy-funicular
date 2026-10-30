//! Team roster plane: GET/POST /teams/:id/members, eligible-members,
//! PUT role, DELETE member, GET /me/managed-teams.
//! Global/scoped admins go through capability scope; non-admin team_admins
//! manage only their own team (addendum-137 / Constraint #15/#16).

use std::sync::Arc;

use axum::{
    extract::{Path, State},
    response::IntoResponse,
    Extension, Json,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

use crate::{
    auth::session::Session,
    config::Config,
    db::admin_roles::{resolve_admin_capability_scope, user_has_any_admin_role, ScopeKind},
    errors::{AppError, RouteResult},
    notifications::notify_trigger,
};

fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB error: {}", e))
}

async fn is_admin(db: &DatabaseConnection, user_id: Uuid) -> Result<bool, AppError> {
    user_has_any_admin_role(db, user_id).await
}

/// Admin capability scope (404-disguise) OR own-team team_admin.
async fn manager_scope(
    db: &DatabaseConnection, user_id: Uuid, cap: &str, team_id: Uuid,
) -> Result<(), AppError> {
    let team_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT c.organization_id FROM teams t JOIN clusters c ON c.id = t.cluster_id
           WHERE t.id = $1 AND t.expires_after IS NULL AND c.expires_after IS NULL LIMIT 1"#,
        [team_id.into()],
    )).await.map_err(db_err)?;
    if team_rows.is_empty() {
        return Err(AppError::NotFound("Team not found.".to_string()));
    }
    if is_admin(db, user_id).await? {
        let scope = resolve_admin_capability_scope(db, user_id, cap).await?;
        match scope {
            ScopeKind::None => return Err(AppError::Authorization(format!("User lacks required admin capability: {}", cap))),
            ScopeKind::Global => return Ok(()),
            ScopeKind::Scoped(org_ids) => {
                let org: Uuid = team_rows[0].try_get("", "organization_id").map_err(db_err)?;
                if !org_ids.contains(&org) {
                    return Err(AppError::NotFound("Team not found.".to_string()));
                }
                return Ok(());
            }
        }
    }
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT 1 FROM team_memberships tm JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = $1 AND tm.user_id = $2 AND tm.team_role = 'team_admin'
             AND tm.expires_after IS NULL AND u.status = 'active' LIMIT 1"#,
        [team_id.into(), user_id.into()],
    )).await.map_err(db_err)?;
    if rows.is_empty() {
        return Err(AppError::Authorization("You do not have permission to manage members of this team.".to_string()));
    }
    Ok(())
}

async fn team_type(db: &DatabaseConnection, team_id: Uuid) -> Result<String, AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT c.type::TEXT AS t FROM teams tm JOIN clusters c ON c.id = tm.cluster_id WHERE tm.id = $1 LIMIT 1",
        [team_id.into()],
    )).await.map_err(db_err)?;
    rows.first().and_then(|r| r.try_get::<String>("", "t").ok())
        .ok_or_else(|| AppError::NotFound("Team not found.".to_string()))
}

fn affiliation_compatible(affiliation: Option<&str>, team_type: &str) -> bool {
    match affiliation {
        Some("vendor") => team_type == "vendor",
        Some("agency") => team_type == "agency" || team_type == "pa",
        _ => false,
    }
}

pub async fn get_eligible_team_members(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(team_id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    manager_scope(&db, session.user_id, "TeamMemberRead", team_id).await?;
    let tt = team_type(&db, team_id).await?;
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT u.id, u.full_name, u.email, u.affiliation::TEXT AS affiliation, u.status::TEXT AS status
           FROM users u
           WHERE u.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = $1 AND tm.user_id = u.id AND tm.expires_after IS NULL)
             AND NOT EXISTS (
               SELECT 1 FROM team_memberships tm JOIN teams t ON t.id = tm.team_id
               WHERE tm.user_id = u.id AND tm.expires_after IS NULL AND t.expires_after IS NULL
                 AND t.cluster_id = (SELECT cluster_id FROM teams WHERE id = $1)
             )
           ORDER BY u.full_name"#,
        [team_id.into()],
    )).await.map_err(db_err)?;
    let users: Vec<JsonValue> = rows.iter().filter_map(|r| {
        let aff: Option<String> = r.try_get("", "affiliation").ok();
        if !affiliation_compatible(aff.as_deref(), &tt) { return None; }
        Some(json!({
            "id": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
            "fullName": r.try_get::<String>("", "full_name").unwrap_or_default(),
            "email": r.try_get::<String>("", "email").unwrap_or_default(),
            "affiliation": aff,
            "status": r.try_get::<String>("", "status").unwrap_or_default(),
        }))
    }).collect();
    Ok(Json(json!({ "users": users })))
}

pub async fn list_team_members(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(team_id): Path<Uuid>,
) -> RouteResult<impl IntoResponse> {
    manager_scope(&db, session.user_id, "TeamMemberRead", team_id).await?;
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT tm.id, tm.user_id, tm.team_role::TEXT AS team_role, tm.added_by, tm.created_at,
                  u.full_name, u.email, u.affiliation::TEXT AS affiliation, u.status::TEXT AS status
           FROM team_memberships tm JOIN users u ON u.id = tm.user_id
           WHERE tm.team_id = $1 AND tm.expires_after IS NULL ORDER BY u.full_name"#,
        [team_id.into()],
    )).await.map_err(db_err)?;
    let members: Vec<JsonValue> = rows.iter().map(|r| {
        let uid: Uuid = r.try_get("", "user_id").unwrap_or(Uuid::nil());
        json!({
            "membershipId": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
            "id": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
            "userId": uid,
            "teamRole": r.try_get::<String>("", "team_role").unwrap_or_else(|_| "member".into()),
            "addedBy": r.try_get::<Uuid>("", "added_by").unwrap_or(Uuid::nil()),
            "createdAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "created_at").map(|t| t.to_rfc3339()).unwrap_or_default(),
            "user": {
                "id": uid,
                "fullName": r.try_get::<String>("", "full_name").unwrap_or_default(),
                "email": r.try_get::<String>("", "email").unwrap_or_default(),
                "affiliation": r.try_get::<Option<String>>("", "affiliation").unwrap_or(None),
                "status": r.try_get::<String>("", "status").unwrap_or_default(),
            },
        })
    }).collect();
    Ok(Json(json!({ "members": members })))
}

pub async fn add_team_member(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path(team_id): Path<Uuid>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    manager_scope(&db, session.user_id, "TeamMemberManage", team_id).await?;
    let user_id_str = body["userId"].as_str().unwrap_or("");
    if user_id_str.is_empty() {
        return Err(AppError::Validation("User ID is required.".to_string()));
    }
    let user_id = Uuid::parse_str(user_id_str)
        .map_err(|_| AppError::Validation("The specified user does not exist or is not active.".to_string()))?;
    let user_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT status::TEXT AS status, affiliation::TEXT AS affiliation, email, full_name FROM users WHERE id = $1 LIMIT 1",
        [user_id.into()],
    )).await.map_err(db_err)?;
    let user = user_rows.first().ok_or_else(|| AppError::Validation("The specified user does not exist or is not active.".to_string()))?;
    let status: String = user.try_get("", "status").unwrap_or_default();
    if status != "active" {
        return Err(AppError::Validation("The specified user does not exist or is not active.".to_string()));
    }
    let tt = team_type(&db, team_id).await?;
    let aff: Option<String> = user.try_get("", "affiliation").ok();
    if !affiliation_compatible(aff.as_deref(), &tt) {
        return Err(AppError::Validation(format!(
            "A user with affiliation {} cannot be added to a {} team.",
            aff.as_deref().unwrap_or("none"), tt
        )));
    }
    let dup = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT 1 FROM team_memberships WHERE team_id = $1 AND user_id = $2 AND expires_after IS NULL LIMIT 1",
        [team_id.into(), user_id.into()],
    )).await.map_err(db_err)?;
    if !dup.is_empty() {
        return Err(AppError::Validation("This user is already a member of this team.".to_string()));
    }
    let cluster_clash = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"SELECT 1 FROM team_memberships tm JOIN teams t ON t.id = tm.team_id
           WHERE tm.user_id = $1 AND tm.expires_after IS NULL AND t.expires_after IS NULL
             AND t.cluster_id = (SELECT cluster_id FROM teams WHERE id = $2) LIMIT 1"#,
        [user_id.into(), team_id.into()],
    )).await.map_err(db_err)?;
    if !cluster_clash.is_empty() {
        return Err(AppError::Validation("This user already belongs to another team in this cluster.".to_string()));
    }
    let requested_role = body["teamRole"].as_str().unwrap_or("member");
    if requested_role != "member" && requested_role != "team_admin" {
        return Err(AppError::Validation("team_role must be 'team_admin' or 'member'.".to_string()));
    }
    let count_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT count(*)::INT AS n FROM team_memberships WHERE team_id = $1 AND expires_after IS NULL",
        [team_id.into()],
    )).await.map_err(db_err)?;
    let count: i32 = count_rows.first().and_then(|r| r.try_get("", "n").ok()).unwrap_or(0);
    let resolved_role = if count == 0 { "team_admin" } else if requested_role == "team_admin" { "team_admin" } else { "member" };

    let membership_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO team_memberships (id, user_id, team_id, team_role, added_by, created_at, updated_at)
           VALUES ($1,$2,$3,$4::team_role,$5,now(),now())"#,
        [membership_id.into(), user_id.into(), team_id.into(), resolved_role.into(), session.user_id.into()],
    )).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO organization_memberships (id, organization_id, user_id, added_by, created_at)
           SELECT $1, c.organization_id, $2, $3, now()
           FROM teams t JOIN clusters c ON c.id = t.cluster_id WHERE t.id = $4
           ON CONFLICT (organization_id, user_id) WHERE expires_after IS NULL DO NOTHING"#,
        [Uuid::now_v7().into(), user_id.into(), session.user_id.into(), team_id.into()],
    )).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'team_membership.added','team_membership',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), membership_id.to_string().into(),
         json!({ "userId": user_id, "teamId": team_id, "teamRole": resolved_role, "addedBy": session.user_id }).into()],
    )).await.map_err(db_err)?;
    let email: String = user.try_get("", "email").unwrap_or_default();
    let _ = notify_trigger(&db, "team_membership.added", &[email], "team_membership", membership_id).await;

    Ok((axum::http::StatusCode::CREATED, Json(json!({ "membership": {
        "id": membership_id, "userId": user_id, "teamId": team_id, "teamRole": resolved_role,
        "addedBy": session.user_id,
    } }))))
}

async fn load_membership(db: &DatabaseConnection, team_id: Uuid, membership_id: Uuid) -> Result<(Uuid, String), AppError> {
    let rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "SELECT user_id, team_role::TEXT AS team_role FROM team_memberships WHERE id = $1 AND team_id = $2 AND expires_after IS NULL LIMIT 1",
        [membership_id.into(), team_id.into()],
    )).await.map_err(db_err)?;
    let r = rows.first().ok_or_else(|| AppError::NotFound("Membership not found.".to_string()))?;
    Ok((r.try_get("", "user_id").map_err(db_err)?, r.try_get::<String>("", "team_role").unwrap_or_else(|_| "member".into())))
}

pub async fn delete_team_member(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path((team_id, membership_id)): Path<(Uuid, Uuid)>,
) -> RouteResult<impl IntoResponse> {
    manager_scope(&db, session.user_id, "TeamMemberManage", team_id).await?;
    let (member_user, old_role) = load_membership(&db, team_id, membership_id).await?;
    if member_user == session.user_id && !is_admin(&db, session.user_id).await? {
        return Err(AppError::Validation("You cannot remove yourself from a team you administer. Ask another team admin or a global admin.".to_string()));
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE team_memberships SET expires_after = now(), updated_at = now() WHERE id = $1",
        [membership_id.into()],
    )).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'team_membership.removed','team_membership',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), membership_id.to_string().into(),
         json!({ "userId": member_user, "teamId": team_id, "removedRole": old_role, "removedBy": session.user_id }).into()],
    )).await.map_err(db_err)?;
    let user_rows = db.query_all(Statement::from_sql_and_values(
        DbBackend::Postgres, "SELECT email FROM users WHERE id = $1", [member_user.into()],
    )).await.map_err(db_err)?;
    if let Some(r) = user_rows.first() {
        let email: String = r.try_get("", "email").unwrap_or_default();
        let _ = notify_trigger(&db, "team_membership.removed", &[email], "team_membership", membership_id).await;
    }
    Ok(Json(json!({ "message": "Team member removed successfully." })))
}

pub async fn set_team_member_role(
    State((_, db)): State<(Config, DatabaseConnection)>,
    Extension(session): Extension<Arc<Session>>,
    Path((team_id, membership_id)): Path<(Uuid, Uuid)>,
    Json(body): Json<JsonValue>,
) -> RouteResult<impl IntoResponse> {
    manager_scope(&db, session.user_id, "TeamMemberManage", team_id).await?;
    let new_role = body["teamRole"].as_str().unwrap_or("");
    if new_role != "team_admin" && new_role != "member" {
        return Err(AppError::Validation("team_role must be 'team_admin' or 'member'.".to_string()));
    }
    let (member_user, old_role) = load_membership(&db, team_id, membership_id).await?;
    if old_role == new_role {
        return Ok(Json(json!({ "membership": { "id": membership_id, "userId": member_user, "teamId": team_id, "teamRole": old_role } })));
    }
    if old_role == "team_admin" && new_role == "member" {
        let others = db.query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT count(*)::INT AS n FROM team_memberships WHERE team_id = $1 AND id <> $2 AND team_role = 'team_admin' AND expires_after IS NULL",
            [team_id.into(), membership_id.into()],
        )).await.map_err(db_err)?;
        let n: i32 = others.first().and_then(|r| r.try_get("", "n").ok()).unwrap_or(0);
        if n == 0 {
            return Err(AppError::Validation("Cannot demote the sole team admin. Promote another member first.".to_string()));
        }
        if member_user == session.user_id && !is_admin(&db, session.user_id).await? {
            return Err(AppError::Validation("You cannot demote yourself. Ask another team admin or a global admin.".to_string()));
        }
    }
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "UPDATE team_memberships SET team_role = $1::team_role, updated_at = now() WHERE id = $2",
        [new_role.into(), membership_id.into()],
    )).await.map_err(db_err)?;
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) VALUES ($1,$2,'team_membership.role_changed','team_membership',$3,$4)",
        [Uuid::now_v7().into(), session.user_id.into(), membership_id.to_string().into(),
         json!({ "userId": member_user, "teamId": team_id, "oldRole": old_role, "newRole": new_role, "changedBy": session.user_id }).into()],
    )).await.map_err(db_err)?;
    Ok(Json(json!({ "message": "Member role updated." })))
}

pub async fn get_my_managed_teams(
    State((_, db)): State<(Config, DatabaseConnection)>,
    session: Option<Extension<Arc<Session>>>,
) -> RouteResult<impl IntoResponse> {
    let session = match session {
        Some(Extension(s)) => s,
        None => return Err(AppError::Unauthenticated("Authentication required.".to_string())),
    };
    let sql = if is_admin(&db, session.user_id).await? {
        r#"SELECT t.id, t.cluster_id, t.name, t.level, t.description, t.created_by, t.created_at, t.updated_at, t.expires_after,
                  c.type::TEXT AS cluster_type, c.name AS cluster_name, c.organization_id
           FROM teams t LEFT JOIN clusters c ON c.id = t.cluster_id
           WHERE t.expires_after IS NULL ORDER BY t.name"#.to_string()
    } else {
        format!(r#"SELECT t.id, t.cluster_id, t.name, t.level, t.description, t.created_by, t.created_at, t.updated_at, t.expires_after,
                  c.type::TEXT AS cluster_type, c.name AS cluster_name, c.organization_id
           FROM teams t LEFT JOIN clusters c ON c.id = t.cluster_id
           JOIN team_memberships tm ON tm.team_id = t.id AND tm.user_id = '{}' AND tm.team_role = 'team_admin' AND tm.expires_after IS NULL
           WHERE t.expires_after IS NULL ORDER BY t.name"#, session.user_id)
    };
    let rows = db.query_all(Statement::from_sql_and_values(DbBackend::Postgres, &sql, [])).await.map_err(db_err)?;
    let teams: Vec<JsonValue> = rows.iter().map(|r| json!({
        "id": r.try_get::<Uuid>("", "id").unwrap_or(Uuid::nil()),
        "clusterId": r.try_get::<Uuid>("", "cluster_id").unwrap_or(Uuid::nil()),
        "name": r.try_get::<String>("", "name").unwrap_or_default(),
        "level": r.try_get::<i16>("", "level").unwrap_or(0),
        "description": r.try_get::<Option<String>>("", "description").unwrap_or(None),
        "createdBy": r.try_get::<Uuid>("", "created_by").unwrap_or(Uuid::nil()),
        "createdAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "created_at").map(|t| t.to_rfc3339()).unwrap_or_default(),
        "updatedAt": r.try_get::<chrono::DateTime<chrono::FixedOffset>>("", "updated_at").map(|t| t.to_rfc3339()).unwrap_or_default(),
        "expiresAfter": r.try_get::<Option<chrono::DateTime<chrono::FixedOffset>>>("", "expires_after").unwrap_or(None).map(|t| t.to_rfc3339()),
        "type": r.try_get::<Option<String>>("", "cluster_type").unwrap_or(None),
        "clusterName": r.try_get::<Option<String>>("", "cluster_name").unwrap_or(None),
        "organizationId": r.try_get::<Option<Uuid>>("", "organization_id").unwrap_or(None),
    })).collect();
    Ok(Json(json!({ "teams": teams })))
}
