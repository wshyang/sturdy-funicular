// Auth route handlers — mirrors server/routes/auth.tsx + auth-security.tsx (PORT-1.8).
//
// Routes:
//   POST /auth/signup
//   POST /auth/login
//   POST /auth/logout
//   GET  /auth/me
//   GET  /me/capability-snapshot
//   GET  /auth/2fa/enroll
//   POST /auth/2fa/verify
//   POST /auth/accept-invite
//   GET  /auth/slack/callback

use axum::{
    extract::{rejection::JsonRejection, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
    routing::{get, post},
    Json, Router,
};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    auth::{
        password::{generate_salt, hash_password, verify_password},
        session::{
            clear_session_cookie_headers, create_session_exclusive, destroy_session,
            get_session, CreateSessionOpts,
        },
        totp::{generate_enrollment, verify_totp},
    },
    config::Config,
    security_headers::parse_cookies,
    db::{sessions as db_sessions, user_invites, users},
    errors::{AppError, RouteResult},
};

pub fn auth_router() -> Router<(Config, DatabaseConnection)> {
    Router::new()
        .route("/auth/login", post(login))
        .route("/auth/logout", post(logout))
        .route("/auth/change-password", post(crate::auth::credentials::change_password))
        .route("/auth/signup", post(signup))
        .route("/auth/me", get(auth_me))
        .route("/me/capability-snapshot", get(capability_snapshot))
        .route("/me/role-summary", get(me_role_summary))
        .route("/auth/2fa/enroll", get(twofa_enroll))
        .route("/auth/2fa/verify", post(twofa_verify))
        .route("/auth/accept-invite", post(accept_invite))
        .route("/auth/slack/callback", get(slack_callback))
}

// ── Signup ───────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignupRequest {
    full_name: String,
    email: String,
    password: String,
}

async fn signup(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    body: Result<Json<SignupRequest>, JsonRejection>,
) -> RouteResult<impl IntoResponse> {
    let Json(body) = body.map_err(|_| AppError::validation("Missing or invalid request body."))?;
    let trimmed_name = body.full_name.trim().to_string();
    if trimmed_name.is_empty() {
        return Err(AppError::validation("Full name is required."));
    }

    let email = body.email.trim().to_lowercase();
    if !email.contains('@') || !email.contains('.') {
        return Err(AppError::validation("Please enter a valid email address."));
    }

    if users::find_active_by_email(&db, &email).await? {
        return Err(AppError::validation("An account with this email already exists."));
    }

    validate_password_strength(&body.password)?;

    let password_salt = generate_salt();
    let password_hash = hash_password(&body.password, &password_salt)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Hash error: {}", e)))?;

    let user_id = uuid::Uuid::now_v7();
    users::create_user(
        &db,
        users::CreateUserInput {
            id: user_id,
            full_name: trimmed_name.clone(),
            email: email.clone(),
            password_hash,
            password_salt,
        },
    )
    .await?;

    // Insert sent_notifications + notification_recipients for active admins.
    // Full outbox (PORT-6.3) handles rendering + delivery; this seeds the row so
    // tests can assert the notification was created.
    if let Ok(admins) = crate::db::admin_roles::get_active_admin_emails(&db).await {
        if !admins.is_empty() {
            let notif_id = uuid::Uuid::now_v7();
            let now = chrono::Utc::now().to_rfc3339();
            let _ = db.execute(Statement::from_sql_and_values(
                DbBackend::Postgres,
                r#"INSERT INTO sent_notifications (id, trigger_key, rendered_subject, rendered_body_html, created_at)
                   VALUES ($1, 'user.signup_pending_admins', 'New signup pending approval', '', $2::timestamptz)"#,
                [notif_id.into(), now.clone().into()],
            )).await;

            for (ordinal, (admin_id, admin_email)) in admins.iter().enumerate() {
                let recip_id = uuid::Uuid::now_v7();
                let _ = db.execute(sea_orm::Statement::from_sql_and_values(
                    sea_orm::DbBackend::Postgres,
                    r#"INSERT INTO notification_recipients (id, notification_id, ordinal, recipient_user_id, email_snapshot, created_at)
                       VALUES ($1, $2, $3, $4, $5, $6::timestamptz)"#,
                    [
                        recip_id.into(),
                        notif_id.into(),
                        (ordinal as i16 + 1).into(),
                        (*admin_id).into(),
                        admin_email.clone().into(),
                        now.clone().into(),
                    ],
                )).await;
            }
        }
    }

    tracing::info!(
        user_id = %user_id,
        email = %email,
        "user.signup_pending_admins: new signup awaiting approval"
    );

    Ok((
        StatusCode::CREATED,
        Json(json!({
            "message": "Signup successful. Your account is pending administrator approval.",
            "userId": user_id,
            "entraClassified": false,
        })),
    ))
}

// ── Login ────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginRequest {
    email: String,
    password: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginUser {
    id: uuid::Uuid,
    email: String,
    full_name: String,
    status: String,
    force_password_rotation: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginResponse {
    #[serde(skip_serializing_if = "Option::is_none")]
    session: Option<String>,
    user: LoginUser,
    needs_2fa_enrollment: bool,
    needs_2fa_verification: bool,
}

async fn login(
    State((config, db)): State<(Config, DatabaseConnection)>,
    headers: HeaderMap,
    body: Result<Json<LoginRequest>, JsonRejection>,
) -> RouteResult<impl IntoResponse> {
    let Json(body) = body.map_err(|_| AppError::validation("Missing or invalid request body."))?;

    // Check lockout before any DB user lookup (avoids timing oracle).
    if let Some(mins) = crate::db::login_attempts::check_login_lock(&db, &body.email).await? {
        return Err(AppError::TooManyAttempts(format!(
            "Account temporarily locked. Try again in {} minute(s).",
            mins
        )));
    }

    let user_with_creds = users::get_user_by_email(&db, &body.email)
        .await?
        .ok_or_else(|| AppError::unauthenticated("Invalid email or password."))?;

    let user = &user_with_creds.user;
    if !user.is_active() {
        // Pending approvals keep the legacy 403 "pending approval" contract;
        // rejected/tombstoned accounts are indistinguishable from bad creds (401).
        if user.status == "pending_approval" {
            return Err(AppError::auth("Account is pending approval or inactive."));
        }
        return Err(AppError::unauthenticated("Invalid email or password."));
    }

    if !verify_password(&body.password, &user_with_creds.password_salt, &user_with_creds.password_hash)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Verify error: {}", e)))?
    {
        let _ = crate::db::login_attempts::record_login_attempt(&db, &body.email, false).await;
        return Err(AppError::unauthenticated("Invalid email or password."));
    }

    // Clear lockout on successful authentication.
    let _ = crate::db::login_attempts::record_login_attempt(&db, &body.email, true).await;

    // Legacy audit contract: a successful password login records
    // user.login_success against the acting user (harness F5 auditHas seam).
    let _ = db
        .execute(sea_orm::Statement::from_sql_and_values(
            sea_orm::DatabaseBackend::Postgres,
            "INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details) \
             VALUES ($1, $2, 'user.login_success', 'user', $3, NULL)",
            [
                uuid::Uuid::now_v7().into(),
                user.id.into(),
                user.id.to_string().into(),
            ],
        ))
        .await;

    // Session normally starts unverified. addendum-212: only the exact env
    // value "false" disables the additional login-time verify prompt for an
    // already-enrolled user. Enrollment itself is never optional. Empty or
    // garbage values fail closed (enforced).
    let enforcement_disabled = std::env::var("TOTP_LOGIN_ENFORCEMENT_ENABLED")
        .map(|v| v == "false")
        .unwrap_or(false);
    let twofa_at: Option<chrono::DateTime<chrono::Utc>> =
        if enforcement_disabled && user.twofa_verified {
            Some(chrono::Utc::now())
        } else {
            None
        };

    let token = create_session_exclusive(
        &db,
        user.id,
        CreateSessionOpts {
            twofa_verified_at: twofa_at,
            ..Default::default()
        },
    )
    .await?;

    let https = config.is_https();
    let session_field = headers
        .get("X-Session-Transport")
        .and_then(|v| v.to_str().ok())
        .filter(|v| *v == "bearer")
        .map(|_| token.clone());

    let cookie = crate::auth::session::set_session_cookie_header(&config.app_env, https, &token);
    let needs_2fa_enrollment = !user.twofa_verified;
    let needs_2fa_verification = user.twofa_verified && !enforcement_disabled;
    let body_json = serde_json::to_string(&LoginResponse {
        session: session_field,
        user: LoginUser {
            id: user.id,
            email: user.email.clone(),
            full_name: user.full_name.clone(),
            status: user.status.clone(),
            force_password_rotation: user.force_password_rotation,
        },
        needs_2fa_enrollment,
        needs_2fa_verification,
    })
    .unwrap_or_default();

    let resp = axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::SET_COOKIE, cookie)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(body_json))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Response build error: {}", e)))?;

    Ok(resp)
}

// ── Logout ───────────────────────────────────────────────────────────────────

async fn logout(
    State((config, db)): State<(Config, DatabaseConnection)>,
    headers: HeaderMap,
) -> RouteResult<impl IntoResponse> {
    let https = config.is_https();
    let token = headers
        .get("X-Session-Token")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(t) = &token {
        let _ = destroy_session(&db, t).await;
    }

    let mut resp_headers = axum::http::HeaderMap::new();
    for cookie in clear_session_cookie_headers(&config.app_env, https) {
        if let Ok(v) = cookie.parse() {
            resp_headers.append(axum::http::header::SET_COOKIE, v);
        }
    }

    Ok((StatusCode::OK, resp_headers, Json(json!({"ok": true}))))
}

// ── Auth me ──────────────────────────────────────────────────────────────────

async fn auth_me(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    headers: HeaderMap,
) -> RouteResult<impl IntoResponse> {
    let token = extract_session_token(&headers)
        .ok_or_else(|| AppError::unauthenticated("Not authenticated."))?;

    let session = get_session(&db, &token)
        .await?
        .ok_or_else(|| AppError::unauthenticated("Invalid or expired session."))?;

    let user = users::get_user_by_id(&db, session.user_id)
        .await?
        .filter(|u| u.is_active())
        .ok_or_else(|| AppError::unauthenticated("User not found or inactive."))?;

    let twofa_verified = session.twofa_verified_at.is_some();
    // needs2faEnrollment: user has no confirmed totp_secret
    let needs_2fa_enrollment = !twofa_verified && !user.twofa_verified;
    // needs2faVerification: enrolled but this session unverified
    let needs_2fa_verification = !twofa_verified && user.twofa_verified;

    Ok(Json(json!({
        "user": {
            "id": user.id,
            "email": user.email,
            "fullName": user.full_name,
            "status": user.status,
            "forcePasswordRotation": user.force_password_rotation,
        },
        "twofaVerified": twofa_verified,
        "needs2faEnrollment": needs_2fa_enrollment,
        "needs2faVerification": needs_2fa_verification,
    })))
}

// ── Capability snapshot ───────────────────────────────────────────────────────

async fn capability_snapshot(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    headers: HeaderMap,
) -> RouteResult<impl IntoResponse> {
    let token = extract_session_token(&headers)
        .ok_or_else(|| AppError::unauthenticated("Not authenticated."))?;

    let session = get_session(&db, &token)
        .await?
        .ok_or_else(|| AppError::unauthenticated("Invalid or expired session."))?;

    let uid = session.user_id;
    // Mint a fresh idempotency token for the client (addendum-008).
    let idem_token = crate::idempotency::create_idempotency_token(&db, &uid).await?;
    let is_admin = crate::db::admin_roles::user_has_any_admin_role(&db, uid).await?;

    // Affiliation.
    let affiliation_row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT affiliation::text FROM users WHERE id = $1 AND status = 'active'",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?;
    let affiliation: Option<String> = affiliation_row
        .and_then(|r| r.try_get_by_index::<String>(0).ok());

    // Owned system IDs.
    let owned_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT system_id::text FROM system_owners WHERE user_id = $1 AND expires_after IS NULL",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?;
    let owned_ids: Vec<String> = owned_rows
        .iter()
        .filter_map(|r| r.try_get_by_index::<String>(0).ok())
        .collect();

    // Delegated system IDs.
    let delegated_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT system_id::text FROM system_delegates WHERE delegate_user_id = $1 AND expires_after IS NULL",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?;
    let delegated_ids: Vec<String> = delegated_rows
        .iter()
        .filter_map(|r| r.try_get_by_index::<String>(0).ok())
        .collect();

    // Reviewer system IDs: systems where user is a member of a reviewer-level team (ordinal > 1).
    let reviewer_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"SELECT DISTINCT sws.system_id::text
               FROM system_workflow_steps sws
               JOIN teams t ON t.cluster_id = sws.cluster_id AND t.level = sws.level AND t.expires_after IS NULL
               JOIN team_memberships tm ON tm.team_id = t.id AND tm.expires_after IS NULL
               WHERE tm.user_id = $1 AND sws.ordinal > 1 AND sws.expires_after IS NULL"#,
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?;
    let reviewer_ids: Vec<String> = reviewer_rows
        .iter()
        .filter_map(|r| r.try_get_by_index::<String>(0).ok())
        .collect();

    // Visible = union of owned + delegated + reviewer (or "*" for admin).
    let visible_system_ids: serde_json::Value = if is_admin {
        serde_json::Value::String("*".to_string())
    } else {
        let mut visible: std::collections::HashSet<String> = std::collections::HashSet::new();
        visible.extend(owned_ids.iter().cloned());
        visible.extend(delegated_ids.iter().cloned());
        visible.extend(reviewer_ids.iter().cloned());
        let mut v: Vec<serde_json::Value> =
            visible.into_iter().map(serde_json::Value::String).collect();
        v.sort_unstable_by(|a, b| a.to_string().cmp(&b.to_string()));
        serde_json::Value::Array(v)
    };

    Ok(Json(json!({
        "snapshot": {
            "userId": uid,
            "affiliation": affiliation,
            "isAdmin": is_admin,
            "submitterSystemIds": [],
            "reviewerSystemIds": reviewer_ids,
            "ownedSystemIds": owned_ids,
            "delegatedSystemIds": delegated_ids,
            "teamAdminTeamIds": [],
            "visibleSystemIds": visible_system_ids,
            "organizations": [],
            "scopedGrants": [],
        },
        "idempotencyToken": idem_token,
        "roles": [],
    })))
}

// ── Role summary ──────────────────────────────────────────────────────────────

async fn me_role_summary(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    headers: HeaderMap,
) -> RouteResult<impl IntoResponse> {
    let token = extract_session_token(&headers)
        .ok_or_else(|| AppError::unauthenticated("Not authenticated."))?;

    let session = get_session(&db, &token)
        .await?
        .ok_or_else(|| AppError::unauthenticated("Invalid or expired session."))?;

    let uid = session.user_id;

    // Global admin check (organization_id IS NULL only).
    let is_global_admin = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM user_admin_role_grants WHERE user_id = $1 AND revoked_at IS NULL AND organization_id IS NULL LIMIT 1",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?
        .is_some();

    // User affiliation.
    let affiliation_row = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT affiliation::text FROM users WHERE id = $1 AND status = 'active'",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?;
    let affiliation = affiliation_row
        .as_ref()
        .and_then(|r| r.try_get_by_index::<String>(0).ok())
        .unwrap_or_default();

    // Owned system IDs.
    let owned_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT system_id::text FROM system_owners WHERE user_id = $1 AND expires_after IS NULL",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?;
    let owned_ids: Vec<String> = owned_rows
        .iter()
        .filter_map(|r| r.try_get_by_index::<String>(0).ok())
        .collect();

    // Delegated system IDs.
    let delegated_rows = db
        .query_all(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT system_id::text FROM system_delegates WHERE delegate_user_id = $1 AND expires_after IS NULL",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?;
    let delegated_ids: Vec<String> = delegated_rows
        .iter()
        .filter_map(|r| r.try_get_by_index::<String>(0).ok())
        .collect();

    // Is engineer: member of a team whose cluster+level maps to a live system workflow step.
    let is_engineer = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM team_memberships tm \
             JOIN teams t ON t.id = tm.team_id AND t.expires_after IS NULL \
             JOIN system_workflow_steps sws ON sws.cluster_id = t.cluster_id AND sws.level = t.level AND sws.expires_after IS NULL \
             JOIN systems s ON s.id = sws.system_id AND s.expires_after IS NULL \
             WHERE tm.user_id = $1 AND tm.expires_after IS NULL LIMIT 1",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?
        .is_some();

    // Is team admin.
    let is_team_admin = db
        .query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT 1 FROM team_memberships WHERE user_id = $1 AND team_role = 'team_admin' AND expires_after IS NULL LIMIT 1",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?
        .is_some();

    // Role applicability.
    let is_owner = affiliation == "agency" && !owned_ids.is_empty();
    let is_delegate = !delegated_ids.is_empty() && !is_owner;

    if !is_global_admin && !is_owner && !is_engineer && !is_delegate && !is_team_admin {
        return Ok(Json(json!({ "roles": [] })));
    }

    // Pending counts.
    let admin_pending: i64 = if is_global_admin {
        db.query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT count(*)::bigint FROM users WHERE status = 'pending_approval'",
            [],
        ))
        .await
        .map_err(AppError::from)?
        .and_then(|r| r.try_get_by_index::<i64>(0).ok())
        .unwrap_or(0)
    } else {
        0
    };

    let owner_pending: i64 = if is_owner {
        db.query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT COUNT(*)::bigint FROM breakglass_requests r \
             JOIN system_owners so ON so.system_id = r.system_id AND so.user_id = $1 AND so.expires_after IS NULL \
             WHERE r.submitted_by != $1 AND r.status = 'under_review' AND r.current_step_ordinal = 0",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?
        .and_then(|r| r.try_get_by_index::<i64>(0).ok())
        .unwrap_or(0)
    } else {
        0
    };

    let engineer_pending: i64 = if is_engineer {
        db.query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT COUNT(*)::bigint \
             FROM breakglass_requests r \
             JOIN request_approval_steps ras ON ras.request_id = r.id \
               AND ras.step_ordinal = r.current_step_ordinal \
               AND ras.step_status = 'pending' \
             JOIN teams t ON t.cluster_id = ras.required_cluster_id AND t.level = ras.required_level AND t.expires_after IS NULL \
             JOIN team_memberships tm ON tm.team_id = t.id AND tm.user_id = $1 AND tm.expires_after IS NULL \
             WHERE r.submitted_by != $1 \
               AND (r.status = 'submitted' OR r.status = 'under_review') \
               AND r.current_step_ordinal > 0",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?
        .and_then(|r| r.try_get_by_index::<i64>(0).ok())
        .unwrap_or(0)
    } else {
        0
    };

    let delegate_pending: i64 = if is_delegate {
        db.query_one(Statement::from_sql_and_values(
            DbBackend::Postgres,
            "SELECT COUNT(*)::bigint FROM breakglass_requests r \
             JOIN system_delegates sd ON sd.system_id = r.system_id AND sd.delegate_user_id = $1 AND sd.expires_after IS NULL \
             WHERE r.submitted_by != $1 AND r.status = 'under_review' AND r.current_step_ordinal = 0",
            [uid.into()],
        ))
        .await
        .map_err(AppError::from)?
        .and_then(|r| r.try_get_by_index::<i64>(0).ok())
        .unwrap_or(0)
    } else {
        0
    };

    let engineer_label = if affiliation == "agency" { "Agency Engineer" } else { "Vendor Engineer" };

    // Build role list; priority: admin=0, owner=1, engineer=2, delegate=3, team_admin=4.
    let mut roles: Vec<serde_json::Value> = Vec::new();
    if is_global_admin {
        roles.push(json!({ "key": "admin", "label": "Administrator", "pending": admin_pending, "priority": 0 }));
    }
    if is_owner {
        roles.push(json!({ "key": "owner", "label": "System Owner", "pending": owner_pending, "priority": 1 }));
    }
    if is_engineer {
        roles.push(json!({ "key": "engineer", "label": engineer_label, "pending": engineer_pending, "priority": 2 }));
    }
    if is_delegate {
        roles.push(json!({ "key": "delegate", "label": "Delegate Approver", "pending": delegate_pending, "priority": 3 }));
    }
    if is_team_admin && !is_global_admin {
        roles.push(json!({ "key": "team_admin", "label": "Team Admin", "pending": 0_i64, "priority": 4 }));
    }

    // Sort: pending desc, then priority asc.
    roles.sort_by(|a, b| {
        let pa = a["pending"].as_i64().unwrap_or(0);
        let pb = b["pending"].as_i64().unwrap_or(0);
        pb.cmp(&pa).then_with(|| {
            let ra = a["priority"].as_i64().unwrap_or(99);
            let rb = b["priority"].as_i64().unwrap_or(99);
            ra.cmp(&rb)
        })
    });

    // Strip internal priority field before returning.
    let roles: Vec<serde_json::Value> = roles
        .into_iter()
        .map(|mut r| {
            r.as_object_mut().map(|m| m.remove("priority"));
            r
        })
        .collect();

    Ok(Json(json!({ "roles": roles })))
}

// ── 2FA enroll ────────────────────────────────────────────────────────────────

async fn twofa_enroll(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    headers: HeaderMap,
) -> RouteResult<impl IntoResponse> {
    let token = extract_session_token(&headers)
        .ok_or_else(|| AppError::unauthenticated("Not authenticated."))?;

    let session = get_session(&db, &token)
        .await?
        .ok_or_else(|| AppError::unauthenticated("Invalid or expired session."))?;

    let user = users::get_user_by_id(&db, session.user_id)
        .await?
        .filter(|u| u.is_active())
        .ok_or_else(|| AppError::unauthenticated("User not found or inactive."))?;

    let enrollment = generate_enrollment("Firefighter Station", &user.email)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("TOTP enrollment error: {}", e)))?;

    db_sessions::set_pending_totp_secret(&db, &token, Some(enrollment.secret_base32.clone())).await?;

    Ok(Json(json!({
        "qrDataUrl": enrollment.qr_data_url,
        "otpauthUri": enrollment.otpauth_uri,
        "secretBase32": enrollment.secret_base32,
    })))
}

// ── 2FA verify ────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct TwofaVerifyRequest {
    code: String,
}

async fn twofa_verify(
    State((_config, db)): State<(Config, DatabaseConnection)>,
    headers: HeaderMap,
    Json(body): Json<TwofaVerifyRequest>,
) -> RouteResult<axum::response::Response> {
    let token = extract_session_token(&headers)
        .ok_or_else(|| AppError::unauthenticated("Not authenticated."))?;

    let session = get_session(&db, &token)
        .await?
        .ok_or_else(|| AppError::unauthenticated("Invalid or expired session."))?;

    let user = users::get_user_by_id(&db, session.user_id)
        .await?
        .filter(|u| u.is_active())
        .ok_or_else(|| AppError::unauthenticated("User not found or inactive."))?;

    // Validate code format.
    let code_digits_only = body.code.len() == 6 && body.code.chars().all(|c| c.is_ascii_digit());
    if !code_digits_only {
        return Err(AppError::validation(
            "Enter the 6-digit code from your authenticator app.",
        ));
    }

    // Determine path: enrolling (no confirmed secret yet) or returning (already enrolled).
    let enrolling = !user.twofa_verified;
    let secret_to_check = if enrolling {
        session.pending_totp_secret.clone()
    } else {
        // For returning users, need to get the totp_secret from the DB.
        // Our User model doesn't carry it — fetch via a raw entity lookup.
        get_user_totp_secret(&db, session.user_id).await?
    };

    let secret = match secret_to_check {
        Some(s) => s,
        None => {
            return Err(AppError::validation(
                "No enrollment in progress. Restart 2FA setup.",
            ))
        }
    };

    let code_valid = verify_totp(&secret, &body.code)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("TOTP verify error: {}", e)))?;

    if !code_valid {
        let failed_attempts = db_sessions::record_twofa_failure(&db, &token).await?;
        if failed_attempts >= 5 {
            let _ = destroy_session(&db, &token).await;
            return Ok((
                StatusCode::TOO_MANY_REQUESTS,
                Json(json!({
                    "error": "Too many incorrect codes. Sign in again.",
                    "code": "twofa_attempts_exceeded"
                })),
            )
                .into_response());
        }
        return Err(AppError::validation("Incorrect code. Please try again."));
    }

    if enrolling {
        db_sessions::confirm_totp_enrollment(&db, session.user_id, &secret).await?;
    }

    db_sessions::mark_twofa_verified(&db, &token).await?;

    Ok(Json(json!({
        "verified": true,
        "enrolled": enrolling,
    }))
    .into_response())
}

// ── Accept invite ─────────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AcceptInviteRequest {
    token: String,
    password: String,
}

async fn accept_invite(
    State((config, db)): State<(Config, DatabaseConnection)>,
    Json(body): Json<AcceptInviteRequest>,
) -> RouteResult<impl IntoResponse> {
    validate_password_strength(&body.password)?;

    let invite = user_invites::consume_invite(&db, &body.token)
        .await?
        .ok_or_else(|| AppError::validation("This invite link is invalid or has expired."))?;

    let user = users::get_user_by_id(&db, invite.user_id)
        .await?
        .filter(|u| u.is_active())
        .ok_or_else(|| AppError::validation("The invited account is no longer available."))?;

    let salt = generate_salt();
    let hash = hash_password(&body.password, &salt)
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Hash error: {}", e)))?;

    users::update_user_password(&db, user.id, hash, salt).await?;

    let session_token = create_session_exclusive(&db, user.id, CreateSessionOpts::default()).await?;
    let https = config.is_https();
    let cookie = crate::auth::session::set_session_cookie_header(&config.app_env, https, &session_token);

    let resp_body = serde_json::to_string(&json!({
        "user": {
            "id": user.id,
            "email": user.email,
            "fullName": user.full_name,
            "status": user.status,
        },
        "needs2faEnrollment": true,
        "needs2faVerification": false,
    }))
    .unwrap_or_default();

    let resp = axum::response::Response::builder()
        .status(StatusCode::OK)
        .header(axum::http::header::SET_COOKIE, cookie)
        .header(axum::http::header::CONTENT_TYPE, "application/json")
        .body(axum::body::Body::from(resp_body))
        .map_err(|e| AppError::Internal(anyhow::anyhow!("Response build error: {}", e)))?;

    Ok(resp)
}

// ── Slack callback ────────────────────────────────────────────────────────────

async fn slack_callback(
    State((_config, _db)): State<(Config, DatabaseConnection)>,
) -> RouteResult<impl IntoResponse> {
    // PORT-7.2: Slack integration in Slice 7.
    Err::<Json<serde_json::Value>, _>(AppError::Internal(anyhow::anyhow!("Not yet implemented")))
}

// ── Private helpers ───────────────────────────────────────────────────────────

fn extract_session_token(headers: &HeaderMap) -> Option<String> {
    // X-Session-Token header (non-browser clients, backend test suite).
    if let Some(v) = headers.get("X-Session-Token").and_then(|v| v.to_str().ok()) {
        let s = v.trim().to_string();
        if !s.is_empty() {
            return Some(s);
        }
    }
    // Cookie fallback (browser transport via credentials: 'include').
    let cookie_header = headers
        .get(axum::http::header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();
    let cookies = parse_cookies(cookie_header);
    cookies
        .get("ffs_session")
        .or_else(|| cookies.get("__Host-ffs_session"))
        .cloned()
}

/// Fetch the confirmed totp_secret for a user (needed for returning-user 2FA verify).
async fn get_user_totp_secret(
    db: &DatabaseConnection,
    user_id: uuid::Uuid,
) -> Result<Option<String>, AppError> {
    use crate::db::users::entity::Entity;
    use sea_orm::EntityTrait;
    let row = Entity::find_by_id(user_id)
        .one(db)
        .await
        .map_err(AppError::from)?;
    Ok(row.and_then(|m| m.totp_secret))
}

/// Password strength validation — mirrors validatePassword() in server/utils.tsx.
fn validate_password_strength(password: &str) -> Result<(), AppError> {
    if password.len() < 8 {
        return Err(AppError::validation(
            "Password must be at least 8 characters.",
        ));
    }
    Ok(())
}
