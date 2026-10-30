// ffs-server crate root.
// Each pub mod corresponds to one bounded context (addendum-214 slices).

pub mod access_log;
pub mod aws;
pub mod mapping_sync;
pub mod direct_links;
pub mod email_templates;
pub mod request_crypto;
pub mod notifications;
pub mod app_settings;
pub mod workflow_machine;
pub mod pending_actions;
pub mod request_helpers;
pub mod schemas;
pub mod audit;
pub mod email_html;
pub mod auth;
pub mod bootstrap;
pub mod config;
pub mod database;  // connection pool
pub mod db;        // entity modules
pub mod errors;
pub mod idempotency;
pub mod middleware;
pub mod models;
pub mod routes;
pub mod sanitize_user;
pub mod security_headers;
pub mod tx;
