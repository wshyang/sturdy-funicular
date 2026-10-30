//! Port of test/backend/deno/system_org_edges.test.tsx (68 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use reqwest::Method;
use serde_json::{json, Value};
use uuid::Uuid;


async fn actor(app: &TestApp, label: &str) -> Result<(fixtures::FixtureUser, String)> {
    let user = fixtures::create_active_user(app, label, &fixtures::unique_email(label), "OrgEdges!2026", "agency", true).await?;
    let session = fixtures::session_of(&fixtures::login_user(app, &user).await?)?;
    Ok((user, session))
}

fn create_body(owner: Uuid, vendor: Uuid, agency: Uuid) -> Value {
    json!({
        "shortCode": fixtures::unique_short_code(), "name": fixtures::unique_name("Edge Sys"),
        "primaryOwnerId": owner, "vendorClusterIds": [vendor], "agencyClusterId": agency,
        "workflowDefinition": [{ "ordinal": 1, "clusterId": agency, "level": 1, "stepKind": "hierarchical", "notes": null }],
    })
}

#[tokio::test]
async fn system_org_edges_admin_plane_and_org_delete_guard() -> Result<()> {
    TestApp::run("system_org_edges", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "EdgeAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let (owner, owner_session) = actor(&app, "edgeowner").await?;
        let org_a = fixtures::create_organization(&app, &fixtures::unique_name("Edges Org A"), &fixtures::unique_short_code(), admin.id).await?;
        let org_b = fixtures::create_organization(&app, &fixtures::unique_name("Edges Org B"), &fixtures::unique_short_code(), admin.id).await?;
        let org_c_name = fixtures::unique_name("Edges Org C");
        let org_c = fixtures::create_organization(&app, &org_c_name, &fixtures::unique_short_code(), admin.id).await?;
        parity_assert!("L:bd1c43c1842cc6ca-1", org_a != org_b && org_b != org_c);

        let vendor = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org_a).await?;
        let agency = fixtures::create_cluster_in_org(&app, "agency", admin.id, org_a).await?;
        let mut body = create_body(owner.id, vendor, agency);
        body["ownerOrganizationId"] = json!(org_b);
        body["participantOrganizationIds"] = json!([org_c, org_c]);
        let (status, created) = app.auth_post_json("/admin/systems", &admin_session, body).await?;
        parity_assert_eq!("L:9499d37e7dcea4cc-1", status, reqwest::StatusCode::CREATED);
        let system_id = created["system"]["id"].as_str().unwrap().to_string();
        let (status, read) = app.auth_get_json(&format!("/admin/systems/{system_id}/org-edges"), &admin_session).await?;
        parity_assert_eq!("L:039b3d03f6fe14b6-1", status, reqwest::StatusCode::OK);
        let edges = read["edges"].as_array().unwrap();
        parity_assert_eq!("L:61dd58dcb03f6e1e-1", edges.len(), 2);
        let owner_edge = edges.iter().find(|e| e["role"] == "owner").unwrap();
        let part_edge = edges.iter().find(|e| e["role"] == "participant").unwrap();
        parity_assert_eq!("L:47015e9e67c30318-1", owner_edge["organizationId"], json!(org_b));
        parity_assert_eq!("L:5ebb60b9af00b8a9-1", part_edge["organizationId"], json!(org_c));
        parity_assert!("L:d1ca15907245a81b-1", owner_edge["organizationName"].is_string());
        parity_assert_eq!("L:190ee597d0082299-1", part_edge["organizationName"], json!(org_c_name));

        let vendor = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org_a).await?;
        let agency = fixtures::create_cluster_in_org(&app, "agency", admin.id, org_a).await?;
        let mut body = create_body(owner.id, vendor, agency);
        body["ownerOrganizationId"] = json!(org_b);
        body["participantOrganizationIds"] = json!([org_b]);
        let (status, body) = app.auth_post_json("/admin/systems", &admin_session, body).await?;
        parity_assert_eq!("L:5cfb64e945217411-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:421f1630c98f7f67-1", body["error"], json!("This organisation is already the system's owner."));

        let (scoped, scoped_session) = actor(&app, "edgescopedcreate").await?;
        fixtures::grant_scoped(&app, scoped.id, "systems_assets_admin", org_a, admin.id).await?;
        let vendor = fixtures::create_cluster_in_org(&app, "vendor", admin.id, org_a).await?;
        let agency = fixtures::create_cluster_in_org(&app, "agency", admin.id, org_a).await?;
        let base = create_body(owner.id, vendor, agency);
        let mut denied_body = base.clone();
        denied_body["ownerOrganizationId"] = json!(org_a);
        let (status, denied) = app.auth_post_json("/admin/systems", &scoped_session, denied_body).await?;
        parity_assert_eq!("L:f6369b9c2e511b41-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:4943de2de91c21b8-1", denied["error"], json!("Organisation selection is outside your granted organisations."));
        let (status, allowed) = app.auth_post_json("/admin/systems", &scoped_session, base).await?;
        parity_assert_eq!("L:50cc94525eeeaa48-1", status, reqwest::StatusCode::CREATED);
        let allowed_id = allowed["system"]["id"].as_str().unwrap();
        let (_, read) = app.auth_get_json(&format!("/admin/systems/{allowed_id}/org-edges"), &admin_session).await?;
        let edges = read["edges"].as_array().unwrap();
        parity_assert_eq!("L:009a36d009dc2c6b-1", edges.len(), 1);
        parity_assert_eq!("L:27f4273438d74080-1", edges[0]["role"], json!("owner"));
        parity_assert_eq!("L:c5720bbc73fba1ef-1", edges[0]["organizationId"], json!(org_a));

        let (in_scope, in_session) = actor(&app, "edgeinscope").await?;
        fixtures::grant_scoped(&app, in_scope.id, "systems_assets_admin", org_b, admin.id).await?;
        let (status, _) = app.auth_get_json(&format!("/admin/systems/{system_id}/org-edges"), &in_session).await?;
        parity_assert_eq!("L:658e80fcc2c0edba-1", status, reqwest::StatusCode::OK);
        let (out_scope, out_session) = actor(&app, "edgeoutscope").await?;
        fixtures::grant_scoped(&app, out_scope.id, "systems_assets_admin", org_a, admin.id).await?;
        let (status, hidden) = app.auth_get_json(&format!("/admin/systems/{system_id}/org-edges"), &out_session).await?;
        parity_assert_eq!("L:c292b47a2d52dd8d-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:af0f8d78acb0c8c1-1", hidden["error"], json!("System not found."));

        let (status, same) = app.auth_post_json(&format!("/admin/systems/{system_id}/org-edges/owner"), &admin_session, json!({ "organizationId": org_b })).await?;
        parity_assert_eq!("L:579b6bdbc63d2b97-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:ff13054ba1c92bac-1", same["error"], json!("This organisation is already the system's owner."));
        let (status, unknown_org) = app.auth_post_json(&format!("/admin/systems/{system_id}/org-edges/owner"), &admin_session, json!({ "organizationId": Uuid::now_v7() })).await?;
        parity_assert_eq!("L:52cd6058f9e4cc27-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:a9d58ee3a56a6d22-1", unknown_org["error"], json!("Organisation not found."));
        let (status, unknown_system) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/owner", Uuid::now_v7()), &admin_session, json!({ "organizationId": org_a })).await?;
        parity_assert_eq!("L:30547b3c5c8ce229-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:c832d8af71cd0673-1", unknown_system["error"], json!("System not found."));
        let (scoped_write, scoped_write_session) = actor(&app, "edgescopedwrite").await?;
        fixtures::grant_scoped(&app, scoped_write.id, "systems_assets_admin", org_b, admin.id).await?;
        let (status, forbidden) = app.auth_post_json(&format!("/admin/systems/{system_id}/org-edges/owner"), &scoped_write_session, json!({ "organizationId": org_a })).await?;
        parity_assert_eq!("L:cf54a061d1cc4fc7-1", status, reqwest::StatusCode::FORBIDDEN);
        parity_assert_eq!("L:339c508cd7b7cdba-1", forbidden["error"], json!("User lacks required admin capability: SystemUpdate"));

        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let fallback_org = wired.agency_org_id;
        let candidate = fixtures::create_active_user(&app, "Edges Delegate A", &fixtures::unique_email("edgesdelegate-a"), "DelegateA!2026", "agency", true).await?;
        fixtures::add_org_membership(&app, fallback_org, candidate.id, admin.id).await?;
        let (status, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", wired.system_id), &owner_session, json!({ "delegateUserId": candidate.id })).await?;
        parity_assert_eq!("L:294399051f025a94-1", status, reqwest::StatusCode::CREATED);
        let (status, blocked) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/owner", wired.system_id), &admin_session, json!({ "organizationId": org_b })).await?;
        parity_assert_eq!("L:bd9613f2aa0ce436-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:268d819366fbc41f-1", blocked["error"], json!("Remove all delegates before transferring this system's organisation."));
        let row = sqlx::query("SELECT id FROM system_delegates WHERE system_id = $1 AND delegate_user_id = $2 AND expires_after IS NULL")
            .bind(wired.system_id).bind(candidate.id).fetch_optional(app.db()).await?;
        parity_assert!("L:2fef71dda53edc30-1", row.is_some());
        let delegate_id: Uuid = sqlx::Row::try_get(&row.unwrap(), "id")?;
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/owner/systems/{}/delegates/{delegate_id}", wired.system_id), &owner_session, json!({})).await?;
        parity_assert_eq!("L:3f4f5b81a9a0c65b-1", status, reqwest::StatusCode::OK);
        let (status, _) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", wired.system_id), &admin_session, json!({ "organizationId": org_c })).await?;
        parity_assert_eq!("L:21984f22affefabf-1", status, reqwest::StatusCode::CREATED);
        let (status, transferred) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/owner", wired.system_id), &admin_session, json!({ "organizationId": org_c })).await?;
        parity_assert_eq!("L:7706ff0a922ec7cd-1", status, reqwest::StatusCode::OK);
        let edges = transferred["edges"].as_array().unwrap();
        parity_assert_eq!("L:a69650dc6f923eb4-1", edges.len(), 1);
        parity_assert_eq!("L:a49ccc5a00ac28e8-1", edges[0]["role"], json!("owner"));
        parity_assert_eq!("L:86dd801a6fa72526-1", edges[0]["organizationId"], json!(org_c));
        let detail = fixtures::latest_audit_detail(&app, "system_org_edge.owner_transferred").await?;
        parity_assert!("L:6211f4533f90c927-1", detail.is_some());
        let detail = detail.unwrap();
        parity_assert_eq!("L:448a4cb0037920d5-1", detail["systemId"], json!(wired.system_id));
        parity_assert_eq!("L:3297e57e137816d4-1", detail["toOrganizationId"], json!(org_c));
        parity_assert_eq!("L:51a990430caf5a2c-1", detail["fromOrganizationId"], json!(fallback_org));

        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let fallback_org = wired.agency_org_id;
        let (status, dup_owner) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", wired.system_id), &admin_session, json!({ "organizationId": fallback_org })).await?;
        parity_assert_eq!("L:dc39ca68dd766896-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:491ba95b01ca708c-1", dup_owner["error"], json!("This organisation is already the system's owner."));
        let (status, unknown_org) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", wired.system_id), &admin_session, json!({ "organizationId": Uuid::now_v7() })).await?;
        parity_assert_eq!("L:ba5f0e976c35722e-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:b559c0db06d42569-1", unknown_org["error"], json!("Organisation not found."));
        let (status, _) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", wired.system_id), &admin_session, json!({ "organizationId": org_a })).await?;
        parity_assert_eq!("L:3220f17644f8fd27-1", status, reqwest::StatusCode::CREATED);
        let added_detail = fixtures::latest_audit_detail(&app, "system_org_edge.participant_added").await?;
        parity_assert!("L:81b594512409503b-1", added_detail.is_some());
        let added_detail = added_detail.unwrap();
        parity_assert_eq!("L:bf93107dc5b41600-1", added_detail["systemId"], json!(wired.system_id));
        parity_assert_eq!("L:8daf52e70591a7a0-1", added_detail["organizationId"], json!(org_a));
        let (status, dup_edge) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", wired.system_id), &admin_session, json!({ "organizationId": org_a })).await?;
        parity_assert_eq!("L:ec0afe8aa7392841-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:8b93835c96e27708-1", dup_edge["error"], json!("This organisation is already linked to this system."));
        let (status, _) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", Uuid::now_v7()), &admin_session, json!({ "organizationId": org_a })).await?;
        parity_assert_eq!("L:a52aac4846b891a7-1", status, reqwest::StatusCode::NOT_FOUND);

        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let fallback_org = wired.agency_org_id;
        let (status, missing) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}/org-edges/participants/{org_c}", wired.system_id), &admin_session, json!({})).await?;
        parity_assert_eq!("L:f8bf7afeba7d4089-1", status, reqwest::StatusCode::NOT_FOUND);
        parity_assert_eq!("L:f4d218140afae71c-1", missing["error"], json!("Organisation is not a participant of this system."));
        let (status, _) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", wired.system_id), &admin_session, json!({ "organizationId": org_c })).await?;
        parity_assert_eq!("L:d2ab3c1921119368-1", status, reqwest::StatusCode::CREATED);
        let candidate = fixtures::create_active_user(&app, "Edges Delegate B", &fixtures::unique_email("edgesdelegate-b"), "DelegateB!2026", "agency", true).await?;
        fixtures::add_org_membership(&app, org_c, candidate.id, admin.id).await?;
        let (status, _) = app.auth_post_json(&format!("/owner/systems/{}/delegates", wired.system_id), &owner_session, json!({ "delegateUserId": candidate.id })).await?;
        parity_assert_eq!("L:78b93646b551fdf9-1", status, reqwest::StatusCode::CREATED);
        let (status, orphan) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}/org-edges/participants/{org_c}", wired.system_id), &admin_session, json!({})).await?;
        parity_assert_eq!("L:9cda18c809f62678-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:6a90987be6389aa9-1", orphan["error"], json!("Removing this organisation would leave delegates without a serving organisation; remove those delegates first."));
        fixtures::add_org_membership(&app, fallback_org, candidate.id, admin.id).await?;
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}/org-edges/participants/{org_c}", wired.system_id), &admin_session, json!({})).await?;
        parity_assert_eq!("L:6c32460fafe4dcab-1", status, reqwest::StatusCode::OK);
        let removed_detail = fixtures::latest_audit_detail(&app, "system_org_edge.participant_removed").await?;
        parity_assert!("L:f9ddfb590b39fc9b-1", removed_detail.is_some());
        let removed_detail = removed_detail.unwrap();
        parity_assert_eq!("L:bacfc8cff6b6db25-1", removed_detail["systemId"], json!(wired.system_id));
        parity_assert_eq!("L:ddb131f60409de1d-1", removed_detail["organizationId"], json!(org_c));

        let wired = fixtures::create_wired_system(&app, admin.id, &owner).await?;
        let org_d = fixtures::create_organization(&app, &fixtures::unique_name("Edges Org D"), &fixtures::unique_short_code(), admin.id).await?;
        let (status, _) = app.auth_post_json(&format!("/admin/systems/{}/org-edges/participants", wired.system_id), &admin_session, json!({ "organizationId": org_d })).await?;
        parity_assert_eq!("L:63a5b6c7ffcb043b-1", status, reqwest::StatusCode::CREATED);
        let (status, blocked) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org_d}"), &admin_session, json!({})).await?;
        parity_assert_eq!("L:9bf07c94f8bb1917-1", status, reqwest::StatusCode::BAD_REQUEST);
        parity_assert_eq!("L:cddd7375e4405984-1", blocked["error"], json!("Cannot delete organisation linked to systems. Transfer or remove the system organisation links first."));
        let (status, _) = app.auth_send_json(Method::DELETE, &format!("/admin/systems/{}/org-edges/participants/{org_d}", wired.system_id), &admin_session, json!({})).await?;
        parity_assert_eq!("L:c89f1010278e7ad0-1", status, reqwest::StatusCode::OK);
        let (status, clean) = app.auth_send_json(Method::DELETE, &format!("/admin/organizations/{org_d}"), &admin_session, json!({})).await?;
        parity_assert_eq!("L:2730230a6d8acdbb-1", status, reqwest::StatusCode::OK);
        parity_assert_eq!("L:22b7e474ac7826f2-1", clean["message"], json!("Organisation deleted successfully."));
        Ok(())
    }).await
}
