//! Handlebars email rendering (legacy server/email/templates.tsx).
//! The directLink helper emits a complete anchor from request_direct_link and
//! never leaves a dangling href when the URL is absent.
use std::collections::HashMap;

use handlebars::{Context, Handlebars, Helper, HelperDef, HelperResult, Output, RenderContext};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

use crate::errors::AppError;

struct DirectLink;
impl HelperDef for DirectLink {
    fn call<'reg: 'rc, 'rc>(
        &self, h: &Helper<'rc>, _r: &'reg Handlebars<'reg>, ctx: &'rc Context,
        _rc: &mut RenderContext<'reg, 'rc>, out: &mut dyn Output,
    ) -> HelperResult {
        let url = ctx.data().get("request_direct_link").and_then(|v| v.as_str()).unwrap_or("");
        if url.is_empty() { return Ok(()); }
        let href = url.replace('&', "&amp;").replace('"', "&quot;");
        let label = h.hash_get("label").and_then(|v| v.value().as_str()).unwrap_or("Open request");
        out.write(&format!("<a href=\"{}\">{}</a>", href, handlebars::html_escape(label)))?;
        Ok(())
    }
}

pub fn interpolate(template: &str, data: &HashMap<String, String>) -> Result<String, AppError> {
    let mut hb = Handlebars::new();
    hb.register_helper("directLink", Box::new(DirectLink));
    hb.register_template_string("email", template)
        .map_err(|e| AppError::Validation(format!("Invalid email template: {e}")))?;
    hb.render("email", data).map_err(|e| AppError::Validation(format!("Email render failed: {e}")))
}

pub struct RenderedEmail {
    pub subject: String,
    pub html: String,
    pub plain_text: String,
}

pub async fn render_notification(
    db: &DatabaseConnection, trigger_key: &str, data: &HashMap<String, String>,
) -> Result<Option<RenderedEmail>, AppError> {
    let row = db.query_one(Statement::from_sql_and_values(DbBackend::Postgres,
        r#"SELECT subject,body_html,body_text FROM notification_templates
           WHERE trigger_key::text=$1 AND organization_id IS NULL AND is_active=true
             AND expires_after IS NULL LIMIT 1"#, [trigger_key.into()])).await?;
    let Some(r) = row else { return Ok(None); };
    let subject: String = r.try_get("", "subject")?;
    let html: String = r.try_get("", "body_html")?;
    let text: Option<String> = r.try_get("", "body_text")?;
    let html = interpolate(&html, data)?;
    let plain_text = match text {
        Some(t) => interpolate(&t, data)?,
        None => html_to_plain_text(&html),
    };
    Ok(Some(RenderedEmail { subject: interpolate(&subject, data)?, html, plain_text }))
}

pub fn html_to_plain_text(html: &str) -> String {
    let anchors = regex::Regex::new(r#"(?is)<a\s+[^>]*href="([^"]*)"[^>]*>(.*?)</a>"#).unwrap();
    let s = anchors.replace_all(html, "$2 ($1)");
    let blocks = regex::Regex::new(r"(?i)</(p|div|li|h[1-6])>|<br\s*/?>").unwrap();
    let s = blocks.replace_all(&s, "\n");
    let tags = regex::Regex::new(r"<[^>]+>").unwrap();
    tags.replace_all(&s, "").replace("&nbsp;", " ").replace("&amp;", "&")
        .replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&#39;", "'")
        .trim().to_string()
}
