//! Faithful port of test/backend/deno/admin_systems.test.tsx (104 parity
//! assertions across admin-systems-suite/{01,02,03}.steps.ts).
//! IDs are filled from the frozen inventory only after the scenario order has
//! been reviewed against those three legacy step modules.

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;

fn wf(steps: &[(Uuid, i64)]) -> Value {
    json!(steps.iter().enumerate().map(|(i, (c, l))| json!({
        "ordinal": i + 1, "clusterId": c, "level": l, "stepKind": "hierarchical", "notes": null
    })).collect::<Vec<_>>())
}

fn body(owner: Uuid, vc: Uuid, ac: Uuid, workflow: Value) -> Value {
    json!({ "shortCode": fixtures::unique_short_code(), "name": fixtures::unique_name("Sys"),
        "primaryOwnerId": owner, "vendorClusterIds": [vc], "agencyClusterId": ac,
        "workflowDefinition": workflow })
}

async fn mapping_ids(app: &TestApp, system: Uuid) -> Result<Vec<Uuid>> {
    let mut ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT team_id FROM team_system_mappings WHERE system_id=$1 AND expires_after IS NULL")
        .bind(system).fetch_all(app.db()).await?;
    ids.sort();
    Ok(ids)
}

#[tokio::test]
async fn admin_systems_crud_mappings_and_auto_sync() -> Result<()> {
    TestApp::run("admin_systems", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "SysAdmin!2026").await?;
        let auth = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let org = fixtures::fixture_fallback_org_id(&app, admin.id).await?;
        let nonadmin = fixtures::create_active_user(&app, "SysNonAdmin", &fixtures::unique_email("sysnonadmin"), "NonAdminPass!2026", "vendor", true).await?;
        let ns = fixtures::session_of(&fixtures::login_user(&app, &nonadmin).await?)?;
        let owner = fixtures::create_active_user(&app, "SysOwner", &fixtures::unique_email("sysowner"), "OwnerPass!2026", "agency", true).await?;
        let w = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let system = w.system_id;
        let primary_row = fixtures::primary_owner_row(&app, system).await?;
        let new_agency_team = fixtures::create_team_in_cluster(&app, w.agency_cluster_id, 3, admin.id).await?;
        let mapping_id: Uuid = sqlx::query_scalar("SELECT id FROM team_system_mappings WHERE system_id=$1 AND team_id=$2 AND expires_after IS NULL")
            .bind(system).bind(w.vendor_l1).fetch_one(app.db()).await?;
        let sys_name: String = sqlx::query_scalar("SELECT name FROM systems WHERE id=$1").bind(system).fetch_one(app.db()).await?;

        // 01 #1–14: authorization and no-mutation checks.
        let (s, _) = app.auth_get_json("/admin/systems", &ns).await?;
        parity_assert_eq!("L:9f97fcb1bab1c2b0-1", s, reqwest::StatusCode::FORBIDDEN); // 1
        let (s, _) = app.auth_post_json("/admin/systems", &ns, json!({})).await?;
        parity_assert_eq!("L:ee4d5096832c2f77-1", s, reqwest::StatusCode::FORBIDDEN); // 2
        let (s, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{system}"), &ns, json!({"name":"x"})).await?;
        parity_assert_eq!("L:da68be57c543a25a-1", s, reqwest::StatusCode::FORBIDDEN); // 3
        let (s, _) = app.auth_get_json(&format!("/admin/systems/{system}/mappings"), &ns).await?;
        parity_assert_eq!("L:a9c4815441c34325-1", s, reqwest::StatusCode::FORBIDDEN); // 4
        let (s, _) = app.auth_get_json(&format!("/admin/systems/{system}/mappable-teams"), &ns).await?;
        parity_assert_eq!("L:4130d4f92f903f1c-1", s, reqwest::StatusCode::FORBIDDEN); // 5
        let (s, _) = app.auth_post_json(&format!("/admin/systems/{system}/owners"), &ns, json!({"userId":owner.id,"kind":"backup"})).await?;
        parity_assert_eq!("L:90ca4904be8ceac7-1", s, reqwest::StatusCode::FORBIDDEN); // 6
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{system}/owners/{primary_row}"), &ns, json!({})).await?;
        parity_assert_eq!("L:3474c34528f6d480-1", s, reqwest::StatusCode::FORBIDDEN); // 7
        let (s, _) = app.auth_post_json("/admin/mappings/team-system", &ns, json!({"teamId":w.vendor_l1,"systemId":system})).await?;
        parity_assert_eq!("L:ae18faa0ab39ed9b-1", s, reqwest::StatusCode::FORBIDDEN); // 8
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/mappings/team-system/{mapping_id}"), &ns, json!({})).await?;
        parity_assert_eq!("L:d93fd56696236f60-1", s, reqwest::StatusCode::FORBIDDEN); // 9
        let (s, _) = app.auth_post_json("/admin/mappings/owner-pa", &ns, json!({"systemOwnerId":primary_row,"paTeamId":new_agency_team})).await?;
        parity_assert_eq!("L:c22dbd65fec92091-1", s, reqwest::StatusCode::FORBIDDEN); // 10
        let (_, list) = app.auth_get_json("/admin/systems", &auth).await?;
        let still = list["systems"].as_array().unwrap().iter().find(|x| x["id"] == json!(system.to_string()));
        parity_assert!("L:085b9c9231c4f61c-1", still.is_some()); // 11
        parity_assert_eq!("L:56874b6c1c717b13-1", still.unwrap()["name"], json!(sys_name)); // 12
        let (_, md) = app.auth_get_json(&format!("/admin/systems/{system}/mappings"), &auth).await?;
        parity_assert!("L:3c987a48b3eab0a9-1", md["mappings"].as_array().unwrap().iter().any(|m| m["team"]["id"] == json!(w.vendor_l1.to_string()))); // 13
        parity_assert!("L:55a0d80c8d19752a-1", !md["mappings"].as_array().unwrap().iter().any(|m| m["team"]["id"] == json!(new_agency_team.to_string()))); // 14

        // 01 #15–21: list projection and organisation derivation.
        let (status, data) = app.auth_get_json("/admin/systems", &auth).await?;
        parity_assert_eq!("L:536aa64cfbc22a4b-1", status, reqwest::StatusCode::OK); // 15
        parity_assert!("L:67bac3ec594af86e-1", data["systems"].as_array().unwrap().iter().any(|x| x["id"] == json!(system.to_string()))); // 16
        let row = data["systems"].as_array().unwrap().iter().find(|x| x["id"] == json!(system.to_string()));
        parity_assert!("L:0f1f262180bb595e-1", row.is_some()); // 17
        parity_assert_eq!("L:97c2c650e6f16c76-1", row.unwrap()["primaryOwnerId"], json!(owner.id.to_string())); // 18
        parity_assert_eq!("L:1323bb6d587f9f2c-1", row.unwrap()["backupOwnerId"], json!(null)); // 19
        let org_rows: Vec<Uuid> = sqlx::query_scalar("SELECT c.organization_id FROM systems s JOIN clusters c ON c.id=s.agency_cluster_id WHERE s.id=$1")
            .bind(system).fetch_all(app.db()).await?;
        parity_assert_eq!("L:d0e7038ba86c0315-1", org_rows.len(), 1); // 20
        parity_assert_eq!("L:46fa786220f0bcaf-1", org_rows[0], org); // 21

        // 01 #22–31: create, AWS note persistence/clearing, empty workflow.
        let (s, _) = app.auth_post_json("/admin/systems", &auth, body(owner.id, w.vendor_cluster_id, w.agency_cluster_id, json!([]))).await?;
        parity_assert_eq!("L:eeee3a73c0bc4838-1", s, reqwest::StatusCode::BAD_REQUEST); // 22
        let (status, data) = app.auth_post_json("/admin/systems", &auth, body(owner.id, w.vendor_cluster_id, w.agency_cluster_id, wf(&[(w.agency_cluster_id, 1)]))).await?;
        parity_assert_eq!("L:e4c588ccf7493ce5-1", status, reqwest::StatusCode::CREATED); // 23
        parity_assert_eq!("L:15a445408037a8f9-1", data["system"]["vendorClusterIds"], json!([w.vendor_cluster_id.to_string()])); // 24
        let minimal = Uuid::parse_str(data["system"]["id"].as_str().unwrap())?;
        let owner_row: Option<Uuid> = sqlx::query_scalar("SELECT user_id FROM system_owners WHERE system_id=$1 AND kind='primary' AND expires_after IS NULL")
            .bind(minimal).fetch_optional(app.db()).await?;
        parity_assert!("L:8ce37638ddc577b0-1", owner_row.is_some()); // 25
        parity_assert_eq!("L:a299875ba87f5452-1", owner_row.unwrap(), owner.id); // 26
        let mut b = body(owner.id, w.vendor_cluster_id, w.agency_cluster_id, wf(&[(w.agency_cluster_id, 1)]));
        b["awsRoleArnNote"] = json!("arn:aws:iam::123456789012:role/example");
        let (status, data) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:dcddd659b87b7753-1", status, reqwest::StatusCode::CREATED); // 27
        parity_assert_eq!("L:206fe9db39057bbe-1", data["system"]["awsRoleArnNote"], json!("arn:aws:iam::123456789012:role/example")); // 28
        let aws_sys = data["system"]["id"].as_str().unwrap().to_string();
        let (status, data) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{aws_sys}"), &auth, json!({"awsRoleArnNote":""})).await?;
        parity_assert_eq!("L:86eea6cc5aae688c-1", status, reqwest::StatusCode::OK); // 29
        parity_assert_eq!("L:68162e77ba697d14-1", data["system"]["awsRoleArnNote"], json!(null)); // 30
        let mut b = body(owner.id, w.vendor_cluster_id, w.agency_cluster_id, wf(&[(w.agency_cluster_id, 1)]));
        b["awsRoleArnNote"] = json!("x".repeat(501));
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:bb0c617d83a053df-1", s, reqwest::StatusCode::BAD_REQUEST); // 31

        // 01 #32–48: create/update validation and workflow rules.
        let base = body(owner.id, w.vendor_cluster_id, w.agency_cluster_id, wf(&[(w.vendor_cluster_id, 1)]));
        let (s, _) = app.auth_post_json("/admin/systems", &auth, json!({"name":"missing"})).await?;
        parity_assert_eq!("L:8b80eb458d04de63-1", s, reqwest::StatusCode::BAD_REQUEST); // 32
        let mut b = base.clone(); b["vendorClusterIds"] = json!([]);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:02eb4415c9528129-1", s, reqwest::StatusCode::BAD_REQUEST); // 33
        let mut b = base.clone(); b["agencyClusterId"] = json!(w.vendor_cluster_id);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:b3e35630b21afd43-1", s, reqwest::StatusCode::BAD_REQUEST); // 34
        let dead_vc = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        sqlx::query("UPDATE clusters SET expires_after=now() WHERE id=$1").bind(dead_vc).execute(app.db()).await?;
        let mut b = base.clone(); b["vendorClusterIds"] = json!([dead_vc]);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:8b60e5cd84ccf8c8-1", s, reqwest::StatusCode::BAD_REQUEST); // 35
        let dead_ac = fixtures::create_cluster_in_org(&app, "agency", admin.id, org).await?;
        sqlx::query("UPDATE clusters SET expires_after=now() WHERE id=$1").bind(dead_ac).execute(app.db()).await?;
        let mut b = base.clone(); b["agencyClusterId"] = json!(dead_ac);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:bb9af8eedd9e707c-1", s, reqwest::StatusCode::BAD_REQUEST); // 36
        let (s, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{system}"), &auth, json!({"vendorClusterIds":[w.vendor_cluster_id,dead_vc]})).await?;
        parity_assert_eq!("L:397df896bf32ddd0-1", s, reqwest::StatusCode::BAD_REQUEST); // 37
        let mut b = base.clone(); b["shortCode"] = json!("bad code!");
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:62b3151b282106fa-1", s, reqwest::StatusCode::BAD_REQUEST); // 38
        let sc = fixtures::unique_short_code();
        let mut b = base.clone(); b["shortCode"] = json!(sc);
        let (first, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        let mut b = base.clone(); b["shortCode"] = json!(sc);
        let (second, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:64b0b806a07faf0e-1", first, reqwest::StatusCode::CREATED); // 39
        parity_assert_eq!("L:005a1214eb5e55b6-1", second, reqwest::StatusCode::BAD_REQUEST); // 40
        let mut b = base.clone(); b["primaryOwnerId"] = json!(nonadmin.id);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:9218afe6cadd5020-1", s, reqwest::StatusCode::BAD_REQUEST); // 41
        let mut b = base.clone(); b["backupOwnerId"] = json!(owner.id);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:0d7183c329b848e8-1", s, reqwest::StatusCode::BAD_REQUEST); // 42
        let pa = fixtures::create_cluster_in_org(&app, "pa", admin.id, org).await?;
        let mut b = base.clone(); b["workflowDefinition"] = wf(&[(pa, 1)]);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:f75aa3b2ef3483dd-1", s, reqwest::StatusCode::BAD_REQUEST); // 43
        let other_vc = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let mut b = base.clone(); b["vendorClusterIds"] = json!([w.vendor_cluster_id, other_vc]);
        b["workflowDefinition"] = wf(&[(w.vendor_cluster_id, 1), (other_vc, 1)]);
        b["name"] = json!(fixtures::unique_name("Sys")); b["shortCode"] = json!(fixtures::unique_short_code());
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:1322261952c52242-1", s, reqwest::StatusCode::CREATED); // 44
        let mut b = base.clone(); b["workflowDefinition"] = wf(&[(w.vendor_cluster_id, 1), (w.vendor_cluster_id, 1)]);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:c5d0e431c8160596-1", s, reqwest::StatusCode::BAD_REQUEST); // 45
        let mut b = base.clone(); b["workflowDefinition"] = json!([]);
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:7b2ff5097a65444b-1", s, reqwest::StatusCode::BAD_REQUEST); // 46
        let mut b = base.clone(); b["workflowDefinition"] = wf(&[(w.agency_cluster_id, 1), (w.vendor_cluster_id, 2)]);
        b["name"] = json!(fixtures::unique_name("Sys")); b["shortCode"] = json!(fixtures::unique_short_code());
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:dbecc83e3b1e997d-1", s, reqwest::StatusCode::CREATED); // 47
        let mut b = base.clone(); b["workflowDefinition"] = wf(&[(w.vendor_cluster_id, 1), (w.agency_cluster_id, 1), (w.vendor_cluster_id, 2)]);
        b["name"] = json!(fixtures::unique_name("Sys")); b["shortCode"] = json!(fixtures::unique_short_code());
        let (s, _) = app.auth_post_json("/admin/systems", &auth, b).await?;
        parity_assert_eq!("L:14fd912b62ad11d6-1", s, reqwest::StatusCode::CREATED); // 48

        // 01 #49–53: rename, unknown update, primary reassignment.
        let new_name = fixtures::unique_name("Renamed");
        let (status, data) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{system}"), &auth, json!({"name":new_name})).await?;
        parity_assert_eq!("L:2a53f5c576c68acf-1", status, reqwest::StatusCode::OK); // 49
        parity_assert_eq!("L:dc9f416c0a117630-1", data["system"]["name"], json!(new_name)); // 50
        let (s, _) = app.auth_send_json(Method::PUT, "/admin/systems/00000000-0000-0000-0000-000000000999", &auth, json!({"name":"x"})).await?;
        parity_assert_eq!("L:412276a86d822fc9-1", s, reqwest::StatusCode::NOT_FOUND); // 51
        let new_owner = fixtures::create_active_user(&app, "NewOwner", &fixtures::unique_email("newowner"), "OwnerPass!2026", "agency", true).await?;
        let (status, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{system}"), &auth, json!({"primaryOwnerId":new_owner.id})).await?;
        parity_assert_eq!("L:4cb7dbd75e61f66b-1", status, reqwest::StatusCode::OK); // 52
        let pr: Uuid = sqlx::query_scalar("SELECT user_id FROM system_owners WHERE system_id=$1 AND kind='primary' AND expires_after IS NULL").bind(system).fetch_one(app.db()).await?;
        parity_assert_eq!("L:d6f34e280ff172d6-1", pr, new_owner.id); // 53

        // 02 #54–65: delete, mappings, unmapped clusters, mappable teams.
        let del_owner = fixtures::create_active_user(&app, "DelOwner", &fixtures::unique_email("delowner"), "OwnerPass!2026", "agency", true).await?;
        let dw = fixtures::create_wired_system(&app, admin.id, &del_owner).await?;
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}", dw.system_id), &auth, json!({})).await?;
        parity_assert_eq!("L:c7ea7e4c5091842e-1", s, reqwest::StatusCode::OK); // 54
        let (s, _) = app.auth_send_json(Method::DELETE, "/admin/systems/00000000-0000-0000-0000-000000000999", &auth, json!({})).await?;
        parity_assert_eq!("L:9eecd1cb8bd9e310-1", s, reqwest::StatusCode::NOT_FOUND); // 55
        let (status, data) = app.auth_get_json(&format!("/admin/systems/{system}/mappings"), &auth).await?;
        parity_assert_eq!("L:5a84c6f08c050aec-1", status, reqwest::StatusCode::OK); // 56
        parity_assert!("L:b40969df7183ac52-1", data["mappings"].as_array().unwrap().iter().any(|m| m["team"]["id"] == json!(w.vendor_l1.to_string()))); // 57
        let second_vc = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let (s, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{system}"), &auth, json!({"vendorClusterIds":[w.vendor_cluster_id,second_vc]})).await?;
        parity_assert_eq!("L:8077d3e0fcad86af-1", s, reqwest::StatusCode::OK); // 58
        let (status, data) = app.auth_get_json(&format!("/admin/systems/{system}/mappings"), &auth).await?;
        parity_assert_eq!("L:9d052303484ec1e4-1", status, reqwest::StatusCode::OK); // 59
        parity_assert!("L:c0ee55747c956b84-1", data["unmappedClusters"].as_array().unwrap().iter().any(|c| c["id"] == json!(second_vc.to_string()))); // 60
        parity_assert!("L:cf79db06e42be060-1", !data["unmappedClusters"].as_array().unwrap().iter().any(|c| c["id"] == json!(w.vendor_cluster_id.to_string()))); // 61
        let eligible = fixtures::create_team_in_cluster(&app, w.agency_cluster_id, 4, admin.id).await?;
        let unrelated_c = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let unrelated = fixtures::create_team_in_cluster(&app, unrelated_c, 1, admin.id).await?;
        let (status, data) = app.auth_get_json(&format!("/admin/systems/{system}/mappable-teams"), &auth).await?;
        parity_assert_eq!("L:200d29bab15b27ef-1", status, reqwest::StatusCode::OK); // 62
        parity_assert!("L:55149e6a4a718e28-1", data["teams"].as_array().unwrap().iter().any(|t| t["id"] == json!(eligible.to_string()))); // 63
        parity_assert!("L:2a40fbebe6bb7670-1", !data["teams"].as_array().unwrap().iter().any(|t| t["id"] == json!(w.vendor_l1.to_string()))); // 64
        parity_assert!("L:57e91c7e34cc7aa7-1", !data["teams"].as_array().unwrap().iter().any(|t| t["id"] == json!(unrelated.to_string()))); // 65

        // 02 #66–71: owner add/kind/sole-primary/cross-system/backup removal.
        let backup = fixtures::create_active_user(&app, "Backup", &fixtures::unique_email("sysbackup"), "OwnerPass!2026", "agency", true).await?;
        let (s, _) = app.auth_post_json(&format!("/admin/systems/{system}/owners"), &auth, json!({"userId":backup.id,"kind":"backup"})).await?;
        parity_assert_eq!("L:a663bfe4bfb3bcdb-1", s, reqwest::StatusCode::CREATED); // 66
        let (s, _) = app.auth_post_json(&format!("/admin/systems/{system}/owners"), &auth, json!({"userId":backup.id,"kind":"tertiary"})).await?;
        parity_assert_eq!("L:59848257a67e9d41-1", s, reqwest::StatusCode::BAD_REQUEST); // 67
        let sole_owner = fixtures::create_active_user(&app, "SoleOwner", &fixtures::unique_email("soleowner"), "OwnerPass!2026", "agency", true).await?;
        let sw = fixtures::create_wired_system(&app, admin.id, &sole_owner).await?;
        let sole_row = fixtures::primary_owner_row(&app, sw.system_id).await?;
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}/owners/{sole_row}", sw.system_id), &auth, json!({})).await?;
        parity_assert_eq!("L:d86712033bf4736c-1", s, reqwest::StatusCode::BAD_REQUEST); // 68
        let other_owner = fixtures::create_active_user(&app, "OtherOwner", &fixtures::unique_email("otherowner"), "OwnerPass!2026", "agency", true).await?;
        let ow = fixtures::create_wired_system(&app, admin.id, &other_owner).await?;
        let other_row = fixtures::primary_owner_row(&app, ow.system_id).await?;
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{system}/owners/{other_row}"), &auth, json!({})).await?;
        parity_assert_eq!("L:e71527b8937c80e3-1", s, reqwest::StatusCode::NOT_FOUND); // 69
        let alive: Option<Uuid> = sqlx::query_scalar("SELECT id FROM system_owners WHERE id=$1 AND expires_after IS NULL").bind(other_row).fetch_optional(app.db()).await?;
        parity_assert!("L:f4572261eb0732ed-1", alive.is_some()); // 70
        let backup_row: Uuid = sqlx::query_scalar("SELECT id FROM system_owners WHERE system_id=$1 AND kind='backup' AND expires_after IS NULL").bind(system).fetch_one(app.db()).await?;
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{system}/owners/{backup_row}"), &auth, json!({})).await?;
        parity_assert_eq!("L:677f740f6d7d5b19-1", s, reqwest::StatusCode::OK); // 71

        // 02 #72–78: team-system mapping positives/negatives/delete.
        let (s, _) = app.auth_post_json("/admin/mappings/team-system", &auth, json!({"teamId":eligible,"systemId":system})).await?;
        parity_assert_eq!("L:f14c31bc64ceb59e-1", s, reqwest::StatusCode::CREATED); // 72
        let (s, _) = app.auth_post_json("/admin/mappings/team-system", &auth, json!({"teamId":unrelated,"systemId":system})).await?;
        parity_assert_eq!("L:40c1a2988ff24530-1", s, reqwest::StatusCode::BAD_REQUEST); // 73
        let (s, _) = app.auth_post_json("/admin/mappings/team-system", &auth, json!({"teamId":w.vendor_l1,"systemId":system})).await?;
        parity_assert_eq!("L:d21e4cb5bab48289-1", s, reqwest::StatusCode::BAD_REQUEST); // 74
        let pa_team = fixtures::create_team_in_cluster(&app, pa, 1, admin.id).await?;
        let (s, _) = app.auth_post_json("/admin/mappings/team-system", &auth, json!({"teamId":pa_team,"systemId":system})).await?;
        parity_assert_eq!("L:b577455818799cd2-1", s, reqwest::StatusCode::BAD_REQUEST); // 75
        let inv_team = fixtures::create_team_in_cluster(&app, w.agency_cluster_id, 5, admin.id).await?;
        sqlx::query("UPDATE teams SET expires_after=now() WHERE id=$1").bind(inv_team).execute(app.db()).await?;
        let (s, _) = app.auth_post_json("/admin/mappings/team-system", &auth, json!({"teamId":inv_team,"systemId":system})).await?;
        parity_assert_eq!("L:0b928a0b1a1da8b2-1", s, reqwest::StatusCode::NOT_FOUND); // 76
        let (s, _) = app.auth_post_json("/admin/mappings/team-system", &auth, json!({"teamId":eligible,"systemId":dw.system_id})).await?;
        parity_assert_eq!("L:54bae5ce72c71a0b-1", s, reqwest::StatusCode::BAD_REQUEST); // 77
        let (s, data) = app.auth_post_json("/admin/mappings/team-system", &auth, json!({"teamId":new_agency_team,"systemId":system})).await?;
        anyhow::ensure!(s == reqwest::StatusCode::CREATED, "fixture mapping create failed: {s}");
        let mid = data["mapping"]["id"].as_str().unwrap().to_string();
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/mappings/team-system/{mid}"), &auth, json!({})).await?;
        parity_assert_eq!("L:af832a3773de0d67-1", s, reqwest::StatusCode::OK); // 78

        // 03 #79–86: owner-PA mappings and my-systems.
        let pa_owner = fixtures::create_active_user(&app, "PAOwner", &fixtures::unique_email("paowner"), "OwnerPass!2026", "agency", true).await?;
        let pw = fixtures::create_wired_system(&app, admin.id, &pa_owner).await?;
        let pa_row = fixtures::primary_owner_row(&app, pw.system_id).await?;
        let pa_c = fixtures::create_cluster_in_org(&app, "pa", admin.id, org).await?;
        let pa_t = fixtures::create_team_in_cluster(&app, pa_c, 1, admin.id).await?;
        let (s, _) = app.auth_post_json("/admin/mappings/owner-pa", &auth, json!({"systemOwnerId":pa_row,"paTeamId":pa_t})).await?;
        parity_assert_eq!("L:8df5708f5f7c627b-1", s, reqwest::StatusCode::CREATED); // 79
        let pa_t2 = fixtures::create_team_in_cluster(&app, pa_c, 2, admin.id).await?;
        let (s, _) = app.auth_post_json("/admin/mappings/owner-pa", &auth, json!({"systemOwnerId":pa_row,"paTeamId":pa_t2})).await?;
        parity_assert_eq!("L:03bd7eba4e326975-1", s, reqwest::StatusCode::BAD_REQUEST); // 80
        let (s, _) = app.auth_post_json("/admin/mappings/owner-pa", &auth, json!({"systemOwnerId":pa_row,"paTeamId":pw.vendor_l1})).await?;
        parity_assert_eq!("L:be6debb2c2ba024b-1", s, reqwest::StatusCode::BAD_REQUEST); // 81
        let dead_pa = fixtures::create_team_in_cluster(&app, pa_c, 3, admin.id).await?;
        sqlx::query("UPDATE teams SET expires_after=now() WHERE id=$1").bind(dead_pa).execute(app.db()).await?;
        let (s, _) = app.auth_post_json("/admin/mappings/owner-pa", &auth, json!({"systemOwnerId":pa_row,"paTeamId":dead_pa})).await?;
        parity_assert_eq!("L:22f0d36e2d02764b-1", s, reqwest::StatusCode::NOT_FOUND); // 82
        let pa_map: Uuid = sqlx::query_scalar("SELECT id FROM system_owner_pa_mappings WHERE system_owner_id=$1 AND expires_after IS NULL").bind(pa_row).fetch_one(app.db()).await?;
        let (s, _) = app.auth_send_json(Method::DELETE, &format!("/admin/mappings/owner-pa/{pa_map}"), &auth, json!({})).await?;
        parity_assert_eq!("L:77e2ff460e45ac58-1", s, reqwest::StatusCode::OK); // 83
        let submitter = fixtures::create_active_user(&app, "MySysVendor", &fixtures::unique_email("mysysvendor"), "MySysVPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, w.vendor_l1, &submitter, admin.id).await?;
        let sub_session = fixtures::session_of(&fixtures::login_user(&app, &submitter).await?)?;
        let (status, data) = app.auth_get_json("/my-systems", &sub_session).await?;
        parity_assert_eq!("L:0ab5c5aa5f5e414b-1", status, reqwest::StatusCode::OK); // 84
        parity_assert!("L:c3efd782b0a39a67-1", data["systems"].as_array().unwrap().iter().any(|x| x["id"] == json!(system.to_string()))); // 85
        let (s, _) = app.get_json("/my-systems").await?;
        parity_assert_eq!("L:d30cbc9fe37eb537-1", s, reqwest::StatusCode::FORBIDDEN); // 86

        // 03 #87–93: create auto-binds; repeated saves are idempotent + audited.
        let vc = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org).await?;
        let ac = fixtures::create_cluster_in_org(&app, "agency", admin.id, org).await?;
        let v1 = fixtures::create_team_in_cluster(&app, vc, 1, admin.id).await?;
        let a1 = fixtures::create_team_in_cluster(&app, ac, 1, admin.id).await?;
        let o = fixtures::create_active_user(&app, "SyncOwner", &fixtures::unique_email("syncowner"), "SyncPass!2026", "agency", true).await?;
        let (status, data) = app.auth_post_json("/admin/systems", &auth, body(o.id, vc, ac, wf(&[(vc, 1), (ac, 1)]))).await?;
        parity_assert_eq!("L:ad785b3838580c4e-1", status, reqwest::StatusCode::CREATED); // 87
        let sid = Uuid::parse_str(data["system"]["id"].as_str().unwrap())?;
        let mut expected = vec![a1, v1]; expected.sort();
        parity_assert_eq!("L:8f4f2cf1e4426dd2-1", mapping_ids(&app, sid).await?, expected); // 88
        let (upd, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{sid}"), &auth, json!({"workflowDefinition":wf(&[(vc,1),(ac,1)])})).await?;
        parity_assert_eq!("L:3f514787c29b3533-1", upd, reqwest::StatusCode::OK); // 89
        parity_assert_eq!("L:2527016ba17d72b0-1", mapping_ids(&app, sid).await?, expected); // 90
        let audit_count: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM audit_log WHERE target_type='team_system_mapping' AND details->>'via'='workflow_save_auto_sync'").fetch_one(app.db()).await?;
        parity_assert!("L:7c233d6574e909b1-1", audit_count >= 2); // 91
        let (upd2, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{sid}"), &auth, json!({"workflowDefinition":wf(&[(vc,1),(ac,1)])})).await?;
        parity_assert_eq!("L:0b3891163991791e-1", upd2, reqwest::StatusCode::OK); // 92
        parity_assert_eq!("L:9b0df06a97d456bf-1", mapping_ids(&app, sid).await?, expected); // 93

        // 03 #94–98: step edit expires surplus mapping, binds new team.
        let v2 = fixtures::create_team_in_cluster(&app, vc, 2, admin.id).await?;
        let o2 = fixtures::create_active_user(&app, "SyncOwner2", &fixtures::unique_email("syncowner2"), "SyncPass!2026", "agency", true).await?;
        let (status, data) = app.auth_post_json("/admin/systems", &auth, body(o2.id, vc, ac, wf(&[(vc, 1), (ac, 1)]))).await?;
        parity_assert_eq!("L:36e269d1ac855d24-1", status, reqwest::StatusCode::CREATED); // 94
        let sid2 = Uuid::parse_str(data["system"]["id"].as_str().unwrap())?;
        let (initial, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{sid2}"), &auth, json!({"workflowDefinition":wf(&[(vc,1),(ac,1)])})).await?;
        parity_assert_eq!("L:8bc565662cf926ec-1", initial, reqwest::StatusCode::OK); // 95
        let (upd, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{sid2}"), &auth, json!({"workflowDefinition":wf(&[(vc,1),(vc,2)])})).await?;
        parity_assert_eq!("L:9e8229304659adc9-1", upd, reqwest::StatusCode::OK); // 96
        let mut expected2 = vec![v1, v2]; expected2.sort();
        parity_assert_eq!("L:5811e22f07bcb58c-1", mapping_ids(&app, sid2).await?, expected2); // 97
        let expired: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM team_system_mappings WHERE system_id=$1 AND team_id=$2 AND expires_after IS NOT NULL").bind(sid2).bind(a1).fetch_one(app.db()).await?;
        parity_assert_eq!("L:e4893ba8e90596b2-1", expired, 1); // 98

        // 03 #99–101: in-flight request retains the removed step's mapping.
        let o3 = fixtures::create_active_user(&app, "SyncOwner3", &fixtures::unique_email("syncowner3"), "SyncPass!2026", "agency", true).await?;
        let w3 = fixtures::create_wired_system(&app, admin.id, &o3).await?;
        let asset = fixtures::create_asset(&app, w3.system_id, "sync-host").await?;
        let sub = fixtures::create_active_user(&app, "SyncSub", &fixtures::unique_email("syncsub"), "SyncSubPass!2026", "vendor", true).await?;
        fixtures::add_serving_member(&app, w3.vendor_l1, &sub, admin.id).await?;
        let sub_session = fixtures::session_of(&fixtures::login_user(&app, &sub).await?)?;
        let (submitted, _) = fixtures::submit_request(&app, &sub_session, w3.system_id, asset, "SR-9300").await?;
        parity_assert_eq!("L:a59b36b1ad2e9986-1", submitted, reqwest::StatusCode::CREATED); // 99
        let (upd, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{}", w3.system_id), &auth, json!({"workflowDefinition":wf(&[(w3.vendor_cluster_id,1),(w3.vendor_cluster_id,2)])})).await?;
        parity_assert_eq!("L:8e8b9b4bf4110711-1", upd, reqwest::StatusCode::OK); // 100
        let retained: i32 = sqlx::query_scalar("SELECT count(*)::INT FROM team_system_mappings WHERE system_id=$1 AND team_id=$2 AND expires_after IS NULL").bind(w3.system_id).bind(w3.agency_l1).fetch_one(app.db()).await?;
        parity_assert_eq!("L:ed1e77f6bddc0d1b-1", retained, 1); // 101

        // 03 #102–104: team-less step tolerated; no mapping row invented.
        let o4 = fixtures::create_active_user(&app, "SyncOwner4", &fixtures::unique_email("syncowner4"), "SyncPass!2026", "agency", true).await?;
        let (status, data) = app.auth_post_json("/admin/systems", &auth, body(o4.id, vc, ac, wf(&[(vc, 1), (ac, 5)]))).await?;
        parity_assert_eq!("L:546956fdf4c722a6-1", status, reqwest::StatusCode::CREATED); // 102
        let sid4 = Uuid::parse_str(data["system"]["id"].as_str().unwrap())?;
        let (upd, _) = app.auth_send_json(Method::PUT, &format!("/admin/systems/{sid4}"), &auth, json!({"workflowDefinition":wf(&[(vc,1),(ac,5)])})).await?;
        parity_assert_eq!("L:d65e2c6be6d07a92-1", upd, reqwest::StatusCode::OK); // 103
        parity_assert_eq!("L:347bd19ca029e7d7-1", mapping_ids(&app, sid4).await?.len(), 1); // 104
        Ok(())
    }).await
}
