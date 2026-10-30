//! PORT-4A — test/backend/deno/user_credentials_lifecycle.test.tsx (31 assertions).
//! Password rotation and administrator recovery against the real HTTP binary.
use super::fixtures::*;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use serde_json::{json, Value};
use sqlx::Row;
use uuid::Uuid;

async fn password_matches(app: &TestApp, id: Uuid, password: &str) -> Result<bool> {
    let row = sqlx::query("SELECT password_hash, password_salt FROM users WHERE id=$1")
        .bind(id).fetch_one(app.db()).await?;
    let hash: String = row.try_get("password_hash")?;
    let salt: String = row.try_get("password_salt")?;
    Ok(ffs_server::auth::password::verify_password(password, &salt, &hash)?)
}
async fn session_count(app: &TestApp, id: Uuid) -> Result<i64> {
    Ok(sqlx::query_scalar("SELECT count(*) FROM sessions WHERE user_id=$1").bind(id).fetch_one(app.db()).await?)
}
async fn has_session(app: &TestApp, token: &str) -> Result<bool> {
    Ok(sqlx::query_scalar::<_, i64>("SELECT count(*) FROM sessions WHERE id=$1").bind(token).fetch_one(app.db()).await? == 1)
}
async fn login_status(app: &TestApp, email: &str, password: &str) -> Result<u16> {
    Ok(app.post_json("/auth/login", json!({"email":email,"password":password})).await?.0.as_u16())
}
async fn change(app: &TestApp, session: &str, current: &str, new: &str) -> Result<(u16, Value)> {
    let (st, body) = app.auth_post_json("/auth/change-password", session,
        json!({"currentPassword":current,"newPassword":new})).await?;
    Ok((st.as_u16(), body))
}

#[tokio::test]
async fn user_credentials_lifecycle() -> Result<()> {
    TestApp::run("user_credentials_lifecycle", |app| async move {
        prepare(&app).await?;
        let admin = create_admin(&app, "CredAdmin!2026").await?;
        let admin_session = session_of(&login_user(&app, &admin).await?)?;
        let (st, _) = app.post_json("/auth/change-password", json!({"currentPassword":"x","newPassword":"NewPass!2026"})).await?;
        parity_assert_eq!("L:cf7a6722a3be0756-1", st.as_u16(), 401);

        let user = create_active_user(&app, "Changer", &unique_email("chg"), "OldPass!2026", "agency", true).await?;
        sqlx::query("UPDATE users SET force_password_rotation=true WHERE id=$1").bind(user.id).execute(app.db()).await?;
        let a = session_of(&login_user(&app, &user).await?)?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        let b = ffs_server::auth::session::create_session(&db, user.id, Default::default()).await?;
        parity_assert!("L:a1e3713e1088a14e-1", !a.is_empty());
        parity_assert!("L:016326a640878a2c-1", !b.is_empty());
        let (st, _) = change(&app, &a, "OldPass!2026", "NewPass!2026").await?;
        parity_assert_eq!("L:9690cee4355d6a3a-1", st, 200);
        let force: bool = sqlx::query_scalar("SELECT force_password_rotation FROM users WHERE id=$1").bind(user.id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:023fa091246f2822-1", force, false);
        parity_assert_eq!("L:49a169039658070f-1", password_matches(&app, user.id, "NewPass!2026").await?, true);
        parity_assert_eq!("L:ef62a3f885957ff6-1", has_session(&app, &a).await?, true);
        parity_assert_eq!("L:7e022b8fca3b5b16-1", has_session(&app, &b).await?, false);
        parity_assert_eq!("L:95304b0ee3186503-1", login_status(&app, &user.email, "OldPass!2026").await?, 401);

        let wrong = create_active_user(&app, "WrongCurrent", &unique_email("wc"), "OldPass!2026", "agency", true).await?;
        let ws = session_of(&login_user(&app, &wrong).await?)?;
        let (st, _) = change(&app, &ws, "not-the-password", "NewPass!2026").await?;
        parity_assert_eq!("L:c9822e5ad1e9b854-1", st, 400);
        let weak = create_active_user(&app, "WeakNew", &unique_email("wn"), "OldPass!2026", "agency", true).await?;
        let ns = session_of(&login_user(&app, &weak).await?)?;
        let (st, _) = change(&app, &ns, "OldPass!2026", "short").await?;
        parity_assert_eq!("L:25d0c03a929097c4-1", st, 400);
        let (st, _) = change(&app, &ns, "OldPass!2026", "OldPass!2026").await?;
        parity_assert_eq!("L:9e2b2235df69eb30-1", st, 400);

        let locked = create_active_user(&app, "LockedOut", &unique_email("lo"), "LockedOut!2026", "agency", true).await?;
        let ls = session_of(&login_user(&app, &locked).await?)?;
        parity_assert!("L:7cd8daa9acd54cbd-1", !ls.is_empty());
        parity_assert!("L:62928b591f69a849-1", session_count(&app, locked.id).await? >= 1);
        let (st, _) = app.auth_post_json(&format!("/admin/users/{}/reset-2fa", locked.id), &admin_session, json!({})).await?;
        parity_assert_eq!("L:5b93a00cfcef50fa-1", st.as_u16(), 200);
        let row = sqlx::query("SELECT totp_secret, totp_enrolled_at FROM users WHERE id=$1").bind(locked.id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:40119f75d55ed6dc-1", row.try_get::<Option<String>, _>("totp_secret")?, None);
        parity_assert_eq!("L:f8f43f1ffea29e15-1", row.try_get::<Option<chrono::DateTime<chrono::Utc>>, _>("totp_enrolled_at")?, None);
        parity_assert_eq!("L:9ff5aba7ecd70966-1", session_count(&app, locked.id).await?, 0);
        let unenrolled = create_active_user(&app, "NoEnroll", &unique_email("ne"), "NoEnroll!2026", "agency", false).await?;
        let us = session_of(&login_user(&app, &unenrolled).await?)?;
        let (st, _) = app.auth_post_json(&format!("/admin/users/{}/reset-2fa", unenrolled.id), &us, json!({})).await?;
        parity_assert_eq!("L:2a08858b64ef0c73-1", st.as_u16(), 403);
        let (st, _) = app.auth_post_json(&format!("/admin/users/{}/reset-2fa", unenrolled.id), &admin_session, json!({})).await?;
        parity_assert_eq!("L:a0715b02828c72b1-1", st.as_u16(), 400);

        let forgot = create_active_user(&app, "ForgotIt", &unique_email("fi"), "ForgotIt!2026", "agency", true).await?;
        let fs = session_of(&login_user(&app, &forgot).await?)?;
        parity_assert!("L:60d0121b3e939602-1", !fs.is_empty());
        let (st, data) = app.auth_post_json(&format!("/admin/users/{}/reset-password", forgot.id), &admin_session, json!({})).await?;
        parity_assert_eq!("L:f8ecd896e61b6e5b-1", st.as_u16(), 200);
        parity_assert!("L:1b3d480263232b9e-1", !data["tempPassword"].is_null());
        parity_assert_eq!("L:ef1394b4081e75ea-1", data["tempPassword"].is_string(), true);
        let temp = data["tempPassword"].as_str().unwrap();
        parity_assert!("L:cec1324fd2643c46-1", temp.len() >= 12);
        let force: bool = sqlx::query_scalar("SELECT force_password_rotation FROM users WHERE id=$1").bind(forgot.id).fetch_one(app.db()).await?;
        parity_assert_eq!("L:358e703e3fd5a76f-1", force, true);
        parity_assert_eq!("L:4dc33dde1e30ae30-1", password_matches(&app, forgot.id, temp).await?, true);
        parity_assert_eq!("L:c2f89aab4c592067-1", password_matches(&app, forgot.id, "ForgotIt!2026").await?, false);
        parity_assert_eq!("L:1f75e59eca40011a-1", session_count(&app, forgot.id).await?, 0);
        parity_assert_eq!("L:9549d79e909f3c63-1", login_status(&app, &forgot.email, temp).await?, 200);
        let other = create_active_user(&app, "NR", &unique_email("nr"), "NRPass!2026", "agency", true).await?;
        let os = session_of(&login_user(&app, &other).await?)?;
        let (st, _) = app.auth_post_json(&format!("/admin/users/{}/reset-password", other.id), &os, json!({})).await?;
        parity_assert_eq!("L:4f58deff8dbc15e8-1", st.as_u16(), 403);
        Ok(())
    }).await
}
