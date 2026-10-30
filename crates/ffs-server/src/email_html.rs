//! Email HTML sanitizer (legacy server/email/templates.tsx sanitizeEmailHtml).
//! Parser-allowlist equivalent: strips disallowed tags/attributes and unsafe URL
//! schemes; adds rel="noopener noreferrer" to target=_blank anchors.
//! Importers/callers: admin notification_templates + organization_overrides routes.

use regex::Regex;

const ALLOWED_TAGS: &[&str] = &["p","br","strong","b","em","i","u","ul","ol","li","a","code","pre","blockquote","h1","h2","h3","h4","span"];

pub fn sanitize_email_html(html: &str) -> String {
    // Remove dangerous elements and their content entirely.
    let re_block = Regex::new(r"(?is)<(script|iframe|svg|style|object|embed)\b[^>]*>.*?</\s*(script|iframe|svg|style|object|embed)\s*>").unwrap();
    let mut out = re_block.replace_all(html, "").to_string();
    let re_self = Regex::new(r"(?is)<(script|iframe|svg|style|object|embed)\b[^>]*/?>").unwrap();
    out = re_self.replace_all(&out, "").to_string();
    // Rewrite remaining tags.
    let re_tag = Regex::new(r#"(?is)<\s*(/?)\s*([a-zA-Z0-9]+)([^>]*)>"#).unwrap();
    let result = re_tag.replace_all(&out, |caps: &regex::Captures| {
        let closing = &caps[1];
        let tag = caps[2].to_lowercase();
        if !ALLOWED_TAGS.contains(&tag.as_str()) { return String::new(); }
        if !closing.is_empty() { return format!("</{tag}>"); }
        let attrs = &caps[3];
        if tag == "a" {
            let mut href = String::new(); let mut title = String::new(); let mut target = String::new();
            let re_attr = Regex::new(r#"(?is)([a-zA-Z-]+)\s*=\s*("([^"]*)"|'([^']*)')"#).unwrap();
            for a in re_attr.captures_iter(attrs) {
                let name = a[1].to_lowercase();
                let val = a.get(3).or_else(|| a.get(4)).map(|m| m.as_str()).unwrap_or("");
                match name.as_str() {
                    "href" => { let lower = val.trim().to_lowercase(); if lower.starts_with("http://")||lower.starts_with("https://")||lower.starts_with("mailto:") { href = val.to_string(); } }
                    "title" => title = val.to_string(),
                    "target" => target = val.to_string(),
                    _ => {}
                }
            }
            let mut s = String::from("<a");
            if !href.is_empty() { s.push_str(&format!(" href=\"{}\"", escape_attr(&href))); }
            if !title.is_empty() { s.push_str(&format!(" title=\"{}\"", escape_attr(&title))); }
            if !target.is_empty() { s.push_str(&format!(" target=\"{}\"", escape_attr(&target))); }
            if target == "_blank" { s.push_str(" rel=\"noopener noreferrer\""); }
            s.push('>'); s
        } else {
            format!("<{tag}>")
        }
    });
    result.to_string()
}
fn escape_attr(s: &str) -> String { s.replace('&',"&amp;").replace('"',"&quot;").replace('<',"&lt;").replace('>',"&gt;") }
