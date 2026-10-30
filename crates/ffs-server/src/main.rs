// ffs-server binary entry point.
// Builds the axum Router with full middleware chain (addendum-214 §D Slice 0),
// mounts /health, static SPA fallback, and listens on $PORT.
//
// Middleware order (PORT-0.6, mirrors app-middleware.tsx:43-409):
//   access_log → request_logger → CORS → security+Cache-Control → CSRF
//   → session_gate → idempotency-in-transaction

use std::net::SocketAddr;

use axum::{
    http::Method,
    middleware,
    response::{Html, IntoResponse},
    routing::{get, post, put},
    Json, Router,
};
use sea_orm::DatabaseConnection;
use serde_json::json;
use tower_http::services::ServeDir;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use ffs_server::routes::assets;
use ffs_server::{
    auth::routes::auth_router,
    config::Config,
    database,
    middleware::{
        access_log::access_log_middleware,
        cors::cors_layer,
        csrf::csrf_middleware,
        idempotency::idempotency_middleware,
        request_logger::request_logger_middleware,
        security::security_headers_middleware,
        session_gate::session_gate_middleware,
    },
    routes::{admin, audit, custody, direct_links, owner, requests, secret_material, setup, stubs, teams},
};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Tracing.
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "ffs_server=info,tower_http=info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = Config::from_env()?;
    let db = database::connect(&config.database_url).await?;

    // Initialization (including optional DEMO seed) must finish before listen.
    ffs_server::bootstrap::initialize_application(&db).await?;
    ffs_server::bootstrap::run_demo_seed_if_enabled(&db).await?;

    let state = (config.clone(), db);

    let app = build_app(state);

    let addr: SocketAddr = format!("0.0.0.0:{}", config.port).parse()?;
    tracing::info!("ffs-server listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;
    Ok(())
}

fn build_app(state: (Config, DatabaseConnection)) -> Router {
    let (config, _db) = state.clone();

    let dist_path = std::env::current_dir()
        .unwrap_or_default()
        .join("dist");

    // All routes — middleware wraps the entire router (including fallback) so
    // the session gate fires on every request, including browser navigations to "/".
    Router::new()
        .route("/health", get(health))
        .route("/setup", get(setup::setup_handler))
        .merge(auth_router())
        // Gate G1 stub routes (PORT-1.8 parity for sessions/authz-matrix/idempotency/exceptional-conditions).
        .route("/requests", post(requests::post_request))
        .route("/requests/:id", get(requests::get_request))
        .route("/requests/:id/asset-custody/exceptions", post(custody::post_exception))
        .route("/requests/:id/secret-material", get(secret_material::get_secret_material))
        .route("/link/resolve/:key", get(direct_links::resolve_direct_link))
        .route("/requests/:id/step-decision", post(requests::post_step_decision))
        .route("/requests/:id/owner-decision", post(requests::post_owner_decision))
        .route("/requests/:id/issue-credential", post(requests::post_issue_credential))
        .route("/requests/:id/close", post(requests::post_close_request))
        .route("/requests/:id/approver-edit", put(requests::put_approver_edit))
        .route("/requests/:id/resubmit", put(requests::put_resubmit))
        .route("/requests/:id/admin-reset", post(requests::post_admin_reset))
        .route("/requests/my-requests", get(requests::get_my_requests))
        .route("/requests/search", get(requests::get_search_requests))
        .route("/admin/users", get(admin::users::list_users))
        .route("/admin/users/:id", get(stubs::admin_users_by_id))
        .route("/admin/users/invite", post(admin::users::invite_user))
        .route("/admin/users/:id/approve", post(admin::users::approve_user))
        .route("/admin/users/:id/reset-2fa", post(admin::users_lifecycle::reset_user_twofa))
        .route("/admin/users/:id/reset-password", post(admin::users_lifecycle::reset_user_password))
        .route("/admin/users/pending", get(admin::users_lifecycle::list_pending_users))
        .route("/admin/users/:id/reject", post(admin::users_lifecycle::reject_user))
        .route("/admin/users/:id/tombstone", post(admin::users_lifecycle::tombstone_user))
        .route("/admin/users/:id/untombstone", post(admin::users_lifecycle::untombstone_user))
        .route("/admin/users/:id/affiliation", put(admin::users_lifecycle::change_affiliation))
        .route("/admin/systems", get(admin::systems::list_systems).post(admin::systems::create_system))
        .route("/my-systems", get(admin::systems::my_systems))
        .route("/admin/data/export", get(admin::data::export_data))
        .route("/admin/data/import", post(admin::data::import_data))
        .route("/admin/data/reset-seed", post(admin::data::reset_seed))
        .route("/admin/app-settings/export", get(admin::app_settings::export_settings))
        .route("/admin/app-settings/import", post(admin::app_settings::import_settings))
        .route("/admin/runtime-info", get(admin::app_settings::runtime_info))
        .route("/admin/app-settings", get(admin::app_settings::list_settings))
        .route("/admin/app-settings/:key", put(admin::app_settings::update_setting))
        .route("/admin/notification-templates", get(admin::notification_templates::list_notification_templates))
        .route("/admin/notification-templates/:id", put(admin::notification_templates::update_notification_template))
        .route("/admin/sent-notifications", get(admin::notification_templates::list_sent_notifications))
        .route("/admin/pending-actions", get(admin::pending_actions::get_admin_pending_actions))
        .route("/admin/organizations/:id/settings", get(admin::organization_overrides::get_org_settings))
        .route("/admin/organizations/:id/settings/:key", put(admin::organization_overrides::update_org_setting).delete(admin::organization_overrides::delete_org_setting))
        .route("/admin/organizations/:id/templates", get(admin::organization_overrides::get_org_templates))
        .route("/admin/organizations/:id/templates/:trigger_key", put(admin::organization_overrides::update_org_template).delete(admin::organization_overrides::delete_org_template))
        .route("/admin/access-log", get(stubs::admin_access_log))
        .route("/admin/capabilities", get(admin::capabilities::get_capabilities))
        .route("/admin/capabilities/check", get(admin::capabilities::check_capability))
        .route("/admin/capabilities/all", get(admin::capabilities::get_all_capabilities))
        .route("/admin/capabilities/check-multiple", post(admin::capabilities::check_multiple))
        .route("/admin/roles", get(admin::capabilities::list_roles).post(admin::roles::create_role))
        .route("/admin/roles/:key", put(admin::roles::update_role).delete(admin::roles::delete_role))
        .route("/admin/users/:id/roles", put(admin::roles::update_user_roles).get(admin::roles::get_user_roles))
        .route("/admin/roles/my-grants", get(admin::capabilities::my_grants))
        .route("/admin/is-admin", get(admin::capabilities::is_admin))
        .route("/admin/clusters", get(admin::clusters::list_clusters).post(admin::clusters::create_cluster))
        .route("/admin/clusters/:id", put(admin::clusters::update_cluster).delete(admin::clusters::delete_cluster))
        .route("/admin/organizations", get(admin::organizations::list_organizations).post(admin::organizations::create_organization))
        .route("/admin/organizations/:id", put(admin::organizations::update_organization).delete(admin::organizations::delete_organization))
        .route("/admin/organizations/:id/members", get(admin::organizations::list_org_members).post(admin::organizations::add_org_member))
        .route("/admin/organizations/:id/members/:user_id", axum::routing::delete(admin::organizations::remove_org_member))
        .route("/admin/teams", get(admin::teams::list_teams).post(admin::teams::create_team))
        .route("/admin/teams/:id", put(admin::teams::update_team).delete(admin::teams::delete_team))
        .route("/admin/systems/:id", put(admin::systems::update_system).delete(admin::systems::delete_system))
        .route("/admin/systems/:id/mappings", get(admin::systems::get_system_mappings))
        .route("/admin/systems/:id/mappable-teams", get(admin::systems::get_mappable_teams))
        .route("/admin/systems/:id/owners", post(admin::systems::add_system_owner))
        .route("/admin/systems/:id/owners/:owner_id", axum::routing::delete(admin::systems::remove_system_owner))
        .route("/admin/systems/:id/org-edges", get(admin::systems::get_system_org_edges))
        .route("/admin/systems/:id/org-edges/owner", post(admin::systems::transfer_system_owner_org))
        .route("/admin/systems/:id/org-edges/participants", post(admin::systems::add_system_org_participant))
        .route("/admin/systems/:id/org-edges/participants/:org_id", axum::routing::delete(admin::systems::remove_system_org_participant))
        .route("/admin/systems/:id/assets", get(admin::systems::list_system_assets).post(admin::systems::create_system_asset))
        .route("/admin/systems/:id/assets/sync", post(admin::systems::sync_system_assets))
        .route("/systems/:id/assets/search", get(assets::search_assets))
        .route("/admin/systems/:id/assets/:asset_id", put(admin::systems::update_system_asset).delete(admin::systems::delete_system_asset))
        .route("/admin/mappings/team-system", post(admin::mappings::post_team_system_mapping))
        .route("/admin/mappings/team-system/:id", axum::routing::delete(admin::mappings::delete_team_system_mapping))
        .route("/admin/mappings/owner-pa", post(admin::mappings::post_owner_pa_mapping))
        .route("/admin/mappings/owner-pa/:id", axum::routing::delete(admin::mappings::delete_owner_pa_mapping))
        .route("/teams/:team_id/eligible-members", get(teams::get_eligible_team_members))
        .route("/teams/:team_id/members", get(teams::list_team_members).post(teams::add_team_member))
        .route("/teams/:team_id/members/:id/role", put(teams::set_team_member_role))
        .route("/me/managed-teams", get(teams::get_my_managed_teams))
        .route("/teams/:team_id/members/:id", axum::routing::delete(teams::delete_team_member))
        .route("/audit/request/:id", get(audit::get_request_audit))
        .route("/audit/logs", get(stubs::audit_logs))
        .route("/owner/systems", get(owner::get_owner_systems))
        .route("/owner/systems/:id/eligible-delegates", get(owner::get_eligible_delegates))
        .route("/owner/statistics", get(owner::get_owner_statistics))
        .route("/owner/systems/:id/delegates", post(owner::post_system_delegate))
        .route("/owner/systems/:id/delegates/:delegate_id", axum::routing::delete(owner::delete_system_delegate))
        .route("/me/integrations", get(stubs::me_integrations))
        .route("/__audit_test__/internal-error", post(stubs::audit_test_internal_error))
        .nest_service("/assets", ServeDir::new(dist_path.join("assets")))
        .fallback(spa_fallback)
        // Middleware order (PORT-0.6, mirrors app-middleware.tsx:43-409):
        //   idempotency → session_gate → csrf → security → cors → logger → access_log
        .layer(middleware::from_fn_with_state(
            state.clone(),
            idempotency_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            session_gate_middleware,
        ))
        .layer(middleware::from_fn_with_state(state.clone(), csrf_middleware))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            security_headers_middleware,
        ))
        .layer(cors_layer(&config))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            request_logger_middleware,
        ))
        .layer(middleware::from_fn_with_state(
            state.clone(),
            access_log_middleware,
        ))
        .with_state(state)
}

async fn health() -> impl IntoResponse {
    Json(json!({"status": "ok"}))
}

async fn spa_fallback(method: Method) -> impl IntoResponse {
    // Non-GET/HEAD: return JSON 404 so tests can assert structured error responses.
    // GET/HEAD: serve the SPA shell (index.html or placeholder).
    if method != Method::GET && method != Method::HEAD {
        return (
            axum::http::StatusCode::NOT_FOUND,
            Json(json!({"error": "Not found."})),
        )
            .into_response();
    }
    let index = std::fs::read_to_string("dist/index.html")
        .unwrap_or_else(|_| "<html><body>App loading...</body></html>".to_string());
    Html(index).into_response()
}
