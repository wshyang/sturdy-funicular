//! Outbox notification writer shared by non-request domains (team roster,
//! asset-inventory reconcile). Mirrors `notifyTrigger`'s one-row-many-recipients
//! shape. The request lifecycle keeps its own historical writer untouched.

use sea_orm::{ConnectionTrait, DbBackend, Statement};
use uuid::Uuid;

use crate::errors::AppError;

fn db_err(e: sea_orm::DbErr) -> AppError {
    AppError::Internal(anyhow::anyhow!("DB error: {}", e))
}

pub async fn notify_trigger<C: ConnectionTrait>(
    db: &C,
    trigger_key: &str,
    recipients: &[String],
    target_type: &str,
    target_id: Uuid,
) -> Result<(), AppError> {
    if recipients.is_empty() {
        return Ok(());
    }
    let notification_id = Uuid::now_v7();
    db.execute(Statement::from_sql_and_values(
        DbBackend::Postgres,
        r#"INSERT INTO sent_notifications
             (id, trigger_key, rendered_subject, rendered_body_html, rendered_body_text,
              related_target_type, related_target_id)
           VALUES ($1, $2::email_trigger_key, $3, $4, $5, $6::audit_target_type, $7)"#,
        [
            notification_id.into(),
            trigger_key.to_owned().into(),
            format!("[{}]", trigger_key).into(),
            format!("<p>{}</p>", trigger_key).into(),
            trigger_key.to_owned().into(),
            target_type.to_owned().into(),
            target_id.to_string().into(),
        ],
    ))
    .await
    .map_err(db_err)?;

    for (i, email) in recipients.iter().enumerate() {
        let user_rows = db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Postgres,
                "SELECT id, full_name FROM users WHERE email = $1 LIMIT 1",
                [email.clone().into()],
            ))
            .await
            .map_err(db_err)?;
        let (opt_uid, opt_name): (Option<Uuid>, Option<String>) = if let Some(r) = user_rows.first() {
            (
                Some(r.try_get::<Uuid>("", "id").map_err(db_err)?),
                Some(r.try_get::<String>("", "full_name").map_err(db_err)?),
            )
        } else {
            (None, None)
        };
        db.execute(Statement::from_sql_and_values(
            DbBackend::Postgres,
            r#"INSERT INTO notification_recipients
                 (id, notification_id, ordinal, recipient_user_id, email_snapshot, display_name_snapshot)
               VALUES ($1, $2, $3, $4, $5, $6)"#,
            [
                Uuid::now_v7().into(),
                notification_id.into(),
                ((i + 1) as i16).into(),
                opt_uid.into(),
                email.clone().into(),
                opt_name.into(),
            ],
        ))
        .await
        .map_err(db_err)?;
    }
    Ok(())
}
