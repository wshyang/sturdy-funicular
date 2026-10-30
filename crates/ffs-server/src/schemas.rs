//! Request-body schema contracts (port of server/schemas.tsx safeParse rules).
//! Pure validation seam shared by mutating routes; returns the parsed data with
//! defaults materialised plus human-facing messages on failure.
use serde_json::{json, Value as JsonValue};
use uuid::Uuid;

#[derive(Clone, Debug)]
pub struct ParseResult { pub success: bool, pub data: JsonValue, pub messages: Vec<String> }
impl ParseResult {
    fn ok(data: JsonValue) -> Self { Self { success: true, data, messages: vec![] } }
    fn err(messages: Vec<String>) -> Self { Self { success: false, data: JsonValue::Null, messages } }
}
fn s<'a>(b: &'a JsonValue, k: &str) -> &'a str { b[k].as_str().unwrap_or("") }
fn nonempty(b: &JsonValue, k: &str, msgs: &mut Vec<String>) { if s(b,k).is_empty() { msgs.push(format!("{k} is required.")); } }
fn is_uuid(v: &JsonValue) -> bool { v.as_str().map(|x| Uuid::parse_str(x).is_ok()).unwrap_or(false) }
fn iso(v: &JsonValue) -> bool { v.as_str().map(|x| chrono::DateTime::parse_from_rfc3339(x).is_ok()).unwrap_or(false) }

pub fn signup_schema(b: &JsonValue) -> ParseResult {
    let mut m = vec![];
    let name = s(b,"fullName");
    if name.is_empty() || name.len() > 100 { m.push("Full name is required and must be 1-100 characters.".into()); }
    nonempty(b,"email",&mut m); nonempty(b,"password",&mut m);
    if m.is_empty() { ParseResult::ok(b.clone()) } else { ParseResult::err(m) }
}
pub fn login_schema(b: &JsonValue) -> ParseResult { let mut m=vec![]; nonempty(b,"email",&mut m); nonempty(b,"password",&mut m); if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)} }
pub fn two_fa_verify_schema(b: &JsonValue) -> ParseResult { let mut m=vec![]; nonempty(b,"code",&mut m); if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)} }
pub fn accept_invite_schema(b: &JsonValue) -> ParseResult { let mut m=vec![]; nonempty(b,"token",&mut m); nonempty(b,"password",&mut m); if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)} }
pub fn change_password_schema(b: &JsonValue) -> ParseResult { let mut m=vec![]; nonempty(b,"currentPassword",&mut m); nonempty(b,"newPassword",&mut m); if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)} }

fn grants_valid(grants: &JsonValue, m: &mut Vec<String>) {
    if let Some(arr) = grants.as_array() {
        for g in arr {
            if s(g,"roleKey").is_empty() { m.push("roleKey is required.".into()); }
            let org = &g["organizationId"];
            if !(org.is_null() || is_uuid(org)) { m.push("organizationId must be a UUID or null.".into()); }
        }
    }
}
fn grant_exclusivity(b: &JsonValue, m: &mut Vec<String>) {
    let has_grants = b.get("grants").map(|g| !g.is_null()).unwrap_or(false);
    let full = b["grantFullAdmin"].as_bool().unwrap_or(false);
    let roles_nonempty = b["roleKeys"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
    if has_grants && (full || roles_nonempty) { m.push("Provide either grants or the grantFullAdmin/roleKeys form, not both.".into()); }
    if let Some(g) = b.get("grants") { grants_valid(g, m); }
    if let Some(orgs) = b["organizationIds"].as_array() {
        if orgs.len() > 50 { m.push("organizationIds must contain at most 50 items.".into()); }
        for o in orgs { if !is_uuid(o) { m.push("organizationIds must be UUIDs.".into()); } }
    }
}
pub fn invite_user_schema(b: &JsonValue) -> ParseResult {
    let mut m=vec![]; nonempty(b,"fullName",&mut m); nonempty(b,"email",&mut m);
    if !["agency","vendor"].contains(&s(b,"affiliation")) { m.push("affiliation must be agency or vendor.".into()); }
    grant_exclusivity(b,&mut m);
    if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)}
}
pub fn approve_user_schema(b: &JsonValue) -> ParseResult {
    let mut m=vec![];
    if !["agency","vendor"].contains(&s(b,"affiliation")) { m.push("affiliation must be agency or vendor.".into()); }
    grant_exclusivity(b,&mut m);
    if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)}
}
pub fn update_user_roles_schema(b: &JsonValue) -> ParseResult {
    let has_roles = b.get("roleKeys").map(|v| v.is_array()).unwrap_or(false);
    let has_grants = b.get("grants").map(|v| v.is_array()).unwrap_or(false);
    let mut m=vec![];
    if has_roles == has_grants { m.push("Provide exactly one of roleKeys or grants.".into()); }
    if let Some(g) = b.get("grants") { grants_valid(g,&mut m); }
    if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)}
}

const STAGES: [&str;5] = ["prepare","initiate_handover","verify_return","return_to_inventory","investigate_exception"];
fn custody_rows(rows: &JsonValue, m: &mut Vec<String>) {
    if let Some(arr) = rows.as_array() {
        for r in arr {
            if !STAGES.contains(&s(r,"stage")) { m.push("invalid custody stage.".into()); }
            if !is_uuid(&r["agencyTeamId"]) { m.push("agencyTeamId must be a UUID.".into()); }
            let d = &r["dueInHours"];
            if !d.is_null() {
                match d.as_i64() { Some(n) if (1..=8760).contains(&n) && d.as_f64()==Some(n as f64) => {}, _ => m.push("dueInHours must be an integer between 1 and 8760.".into()) }
            }
            let ins = &r["instructions"];
            if !ins.is_null() { if let Some(t) = ins.as_str() { if t.len()>1000 { m.push("instructions must be at most 1000 characters.".into()); } } else { m.push("instructions must be a string or null.".into()); } }
        }
    }
}
pub fn create_system_schema(b: &JsonValue) -> ParseResult {
    let mut m=vec![];
    for k in ["name","shortCode","primaryOwnerId","agencyClusterId"] { nonempty(b,k,&mut m); }
    if s(b,"shortCode").len()>10 { m.push("shortCode must be at most 10 characters.".into()); }
    if s(b,"name").len()>100 { m.push("System name is required and must be 1-100 characters.".into()); }
    if s(b,"description").len()>500 { m.push("description must be at most 500 characters.".into()); }
    if s(b,"awsRoleArnNote").len()>500 { m.push("awsRoleArnNote must be at most 500 characters.".into()); }
    let custody = b.get("custodyStageConfigs").cloned().unwrap_or(json!([]));
    if let Some(arr)=custody.as_array() { if !arr.is_empty() && arr.len()!=5 { m.push("custodyStageConfigs must contain all five agency stages.".into()); } }
    custody_rows(&custody,&mut m);
    if !m.is_empty() { return ParseResult::err(m); }
    let mut data = b.clone();
    for k in ["vendorClusterIds","workflowDefinition","custodyStageConfigs","participantOrganizationIds"] {
        if data.get(k).map(|v| v.is_null()).unwrap_or(true) { data[k]=json!([]); }
    }
    ParseResult::ok(data)
}
pub fn update_system_schema(b: &JsonValue) -> ParseResult {
    let mut m=vec![];
    if let Some(n)=b["name"].as_str() { if n.len()>100 { m.push("System name is required and must be 1-100 characters.".into()); } }
    if let Some(c)=b.get("custodyStageConfigs") {
        if let Some(arr)=c.as_array() { if arr.len()!=5 { m.push("custodyStageConfigs must contain all five agency stages.".into()); } }
        custody_rows(c,&mut m);
    }
    if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)}
}
pub fn add_delegate_schema(b: &JsonValue) -> ParseResult {
    let mut m=vec![]; nonempty(b,"delegateUserId",&mut m);
    let from=&b["activeFrom"]; let until=&b["activeUntil"];
    for v in [from,until] { if !v.is_null() && !iso(v) { m.push("active window bounds must be ISO timestamps.".into()); } }
    if iso(from) && iso(until) {
        let f=chrono::DateTime::parse_from_rfc3339(from.as_str().unwrap()).unwrap();
        let u=chrono::DateTime::parse_from_rfc3339(until.as_str().unwrap()).unwrap();
        if u<=f { m.push("activeUntil must be after activeFrom.".into()); }
    }
    if m.is_empty(){ParseResult::ok(b.clone())}else{ParseResult::err(m)}
}
