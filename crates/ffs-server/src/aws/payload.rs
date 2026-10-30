//! Tenant message builders: versioned JSON shared by S3 publish callers.
//! The raw credential secret never belongs in an outbound request.
use serde_json::{json, Value};

pub struct DeliveryRequest<'a> {
    pub id: &'a str,
    pub number: &'a str,
    pub created_at: &'a str,
    pub owner_decision_at: &'a str,
    pub activity_start_at: &'a str,
    pub activity_end_at: &'a str,
    pub closed_at: Option<&'a str>,
    pub closed_by: Option<&'a str>,
}
pub struct DeliverySystem<'a> {
    pub id: &'a str,
    pub short_code: &'a str,
    pub aws_role_arn_note: Option<&'a str>,
}
pub struct CredentialItem<'a> {
    pub userid: &'a str,
    pub hostname: &'a str,
    pub credential_type: &'a str,
    pub management_mode: Option<&'a str>,
}
fn item_json(item: &CredentialItem<'_>) -> Value {
    json!({"userid":item.userid, "hostname":item.hostname, "credentialType":item.credential_type})
}

pub fn build_outbound_payload(
    request: &DeliveryRequest<'_>, system: &DeliverySystem<'_>, public_key: &str,
    key_algorithm: &str, items: &[CredentialItem<'_>],
) -> Value {
    let api_managed: Vec<_> = items.iter().filter(|i| i.management_mode != Some("manual"))
        .map(item_json).collect();
    let manual: Vec<_> = items.iter().filter(|i| i.management_mode == Some("manual"))
        .map(|i| {
            let mut value = item_json(i);
            value["managementMode"] = json!("manual");
            value
        }).collect();
    json!({
        "schemaVersion":"1.0", "requestId":request.id, "requestNumber":request.number,
        "systemId":system.id, "systemShortCode":system.short_code,
        "awsRoleArnNote":system.aws_role_arn_note, "publicKey":public_key,
        "keyAlgorithm":key_algorithm, "credentialItems":api_managed,
        "manualCredentialItems":manual, "requestedAt":request.created_at,
        "approvedAt":request.owner_decision_at, "activityStartAt":request.activity_start_at,
        "activityEndAt":request.activity_end_at,
    })
}

pub fn build_request_close_notification(
    request: &DeliveryRequest<'_>, system: &DeliverySystem<'_>, items: &[CredentialItem<'_>],
    now: &str,
) -> Value {
    json!({
        "schemaVersion":"1.0", "kind":"request_close", "requestId":request.id,
        "requestNumber":request.number, "systemId":system.id,
        "systemShortCode":system.short_code, "awsRoleArnNote":system.aws_role_arn_note,
        "credentialItems":items.iter().map(item_json).collect::<Vec<_>>(),
        "activityStartAt":request.activity_start_at, "activityEndAt":request.activity_end_at,
        "closedAt":request.closed_at.unwrap_or(now),
        "closedByUserId":request.closed_by.unwrap_or(""),
    })
}
