//! Port of test/backend/deno/auth-admin-roles.test.tsx (192 parity assertions).

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use ffs_server::auth::privileges::{has_admin_privilege, require_admin_privilege};
use ffs_server::db::admin_roles::{self as roles, ALL_CAPABILITIES, ROLE_CAPABILITIES};
use reqwest::StatusCode;
use serde_json::json;

#[tokio::test]
async fn auth_admin_roles_catalogue() -> Result<()> {
    TestApp::run("auth_admin_roles_catalogue", |app| async move {
        fixtures::prepare(&app).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;

        // Authorization decisions live in auth::privileges, not the role-storage module.
        let auth_src = include_str!("../../src/auth/privileges.rs");
        parity_assert!("L:3f4fe04f1c854c92-1", auth_src.contains("pub async fn has_admin_privilege"));
        parity_assert!("L:19758b68a98dcf69-1", auth_src.contains("pub async fn require_admin_privilege"));
        let role_src = include_str!("../../src/db/admin_roles.rs");
        parity_assert_eq!("L:7fd7939f4a6e3645-1", role_src.contains("pub async fn has_admin_privilege"), false);
        parity_assert_eq!("L:8ebbe037468a8baf-1", role_src.contains("pub async fn require_admin_privilege"), false);
        parity_assert_eq!("L:cbeaf8f0e502342c-1", role_src.contains("pub async fn has_admin_privilege_for_organization"), false);

        let expected = [
            "UserRead","UserInvite","UserApprove","UserReject","UserTombstone","UserUntombstone","UserAffiliationChange","UserResetTwofa","UserResetPassword",
            "OrgRead","OrgCreate","OrgUpdate","OrgDelete","ClusterRead","ClusterCreate","ClusterUpdate","ClusterDelete","TeamRead","TeamCreate","TeamUpdate","TeamDelete","TeamMemberRead","TeamMemberManage",
            "SystemRead","SystemCreate","SystemUpdate","SystemDelete","SystemMappingRead","SystemMappableTeamsRead","SystemOwnerManage","TeamSystemMappingManage","OwnerPAMappingManage","AssetRead","AssetCreate","AssetUpdate","AssetDelete","AssetSync",
            "DataExport","DataImport","DataResetSeed","RequestAdminReset","ConfigAppSettingsRead","ConfigAppSettingsWrite","ConfigAppSettingsBulkTransfer","ConfigEmailTemplateRead","ConfigEmailTemplateWrite",
            "AuditLogRead","AuditAccessLogRead","AuditSentNotificationsRead","OrgAppSettingsRead","OrgAppSettingsWrite","OrgTemplateRead","OrgTemplateWrite","AdminRolesManage",
        ];
        for cap in expected { parity_assert!("L:297bda6322bb3678-1", ALL_CAPABILITIES.contains(&cap), "Missing capability: {cap}"); }
        parity_assert_eq!("L:b051d240a2e529fd-1", ALL_CAPABILITIES.len(), expected.len());
        parity_assert!("L:e7d7931d4cc4f2f9-1", roles::is_valid_capability("UserRead"));
        parity_assert!("L:05a9125020b18f6f-1", roles::is_valid_capability("SystemDelete"));
        parity_assert!("L:0d6c9c1cf1f4b901-1", roles::is_valid_capability("AdminRolesManage"));
        parity_assert!("L:d449f88823ac10ff-1", !roles::is_valid_capability("InvalidCapability"));
        parity_assert!("L:4c2cbd599301984a-1", !roles::is_valid_capability(""));
        parity_assert!("L:a5604c250040373b-1", !roles::is_valid_capability("user_read"));

        let expected_roles = ["user_admin","org_structure_admin","systems_assets_admin","data_operator","config_audit_admin","full_admin"];
        for key in expected_roles { parity_assert!("L:91ece1f135ef1336-1", ROLE_CAPABILITIES.iter().any(|(k,_)| *k==key), "Missing role: {key}"); }
        parity_assert_eq!("L:e36bcd30aa99eb48-1", ROLE_CAPABILITIES.len(), expected_roles.len());
        parity_assert!("L:6a499c1666ed3b63-1", roles::is_valid_role(&db, "user_admin").await?);
        parity_assert!("L:0adcbd9cfe42d225-1", roles::is_valid_role(&db, "full_admin").await?);
        parity_assert!("L:a4b3d0ad32376ee0-1", roles::is_valid_role(&db, "config_audit_admin").await?);
        parity_assert!("L:93d4807447c978cb-1", !roles::is_valid_role(&db, "invalid_role").await?);
        parity_assert!("L:d60a038aad0f352f-1", !roles::is_valid_role(&db, "").await?);
        for (key, _) in ROLE_CAPABILITIES { parity_assert!("L:b439c9b22e952dfc-1", roles::is_system_role(key), "Role {key} should be a system role"); }
        parity_assert!("L:bfad8f8104bcf025-1", roles::is_system_role("user_admin"));
        parity_assert!("L:4b4e9b38c4525261-1", roles::is_system_role("full_admin"));
        parity_assert!("L:864590a38a8c5788-1", !roles::is_system_role("non_existent_role"));

        let ua = roles::preconfigured_capabilities("user_admin");
        parity_assert!("L:6812d0fe44ff9e53-1", !ua.is_empty());
        parity_assert!("L:44cbe879e19d13e6-1", ua.contains("UserRead"));
        parity_assert!("L:f55db7b50f60ec1a-1", ua.contains("UserInvite"));
        parity_assert!("L:21d1a06f89aad6c0-1", ua.contains("UserApprove"));
        parity_assert!("L:d568f6ee521d0d67-1", ua.contains("UserReject"));
        parity_assert!("L:3f2fe0f964058ed2-1", ua.contains("UserTombstone"));
        parity_assert!("L:310cac454834b977-1", ua.contains("UserUntombstone"));
        parity_assert!("L:dd50dfdbc4608d7f-1", ua.contains("UserAffiliationChange"));
        parity_assert!("L:93f94c8f73f3f964-1", !ua.contains("SystemRead"));
        parity_assert!("L:0fdf5ac0c90633d8-1", !ua.contains("ClusterRead"));

        let os = roles::preconfigured_capabilities("org_structure_admin");
        parity_assert!("L:a24b508b6cf71770-1", !os.is_empty());
        parity_assert!("L:705769d23c42a2c7-1", os.contains("ClusterRead"));
        parity_assert!("L:df1ddf81fe30cc16-1", os.contains("ClusterCreate"));
        parity_assert!("L:4c8ffee936b26315-1", os.contains("ClusterUpdate"));
        parity_assert!("L:d6f58deee986d53a-1", os.contains("ClusterDelete"));
        parity_assert!("L:2dbe9ec941849c4b-1", os.contains("TeamRead"));
        parity_assert!("L:faa2ed5c9fd4ffe7-1", os.contains("TeamCreate"));
        parity_assert!("L:079ee8c68f2d30e0-1", os.contains("TeamUpdate"));
        parity_assert!("L:109752be953010d3-1", os.contains("TeamDelete"));
        parity_assert!("L:344fbc76ece4295a-1", os.contains("TeamMemberRead"));
        parity_assert!("L:2f41740e2678edaf-1", os.contains("TeamMemberManage"));
        let sa = roles::preconfigured_capabilities("systems_assets_admin");
        parity_assert!("L:4a258629bd20859f-1", !sa.is_empty());
        parity_assert!("L:943809cf3f5e2595-1", sa.contains("SystemRead"));
        parity_assert!("L:243f01d1d3bfac11-1", sa.contains("SystemCreate"));
        parity_assert!("L:8f76ed6e80bd6976-1", sa.contains("SystemUpdate"));
        parity_assert!("L:8e48ce2253914fe9-1", sa.contains("SystemDelete"));
        parity_assert!("L:b90198b242b6a8c4-1", sa.contains("AssetRead"));
        parity_assert!("L:c26e00ca3a446ecc-1", sa.contains("AssetCreate"));
        parity_assert!("L:4b2acc363a6106fd-1", sa.contains("AssetUpdate"));
        parity_assert!("L:d582e74d2faa7680-1", sa.contains("AssetDelete"));
        parity_assert!("L:60c2cd434aabe892-1", sa.contains("AssetSync"));
        let do_ = roles::preconfigured_capabilities("data_operator");
        parity_assert!("L:41ed86d7d19e6939-1", !do_.is_empty());
        parity_assert!("L:f681bcd9fc6ca1de-1", do_.contains("DataExport"));
        parity_assert!("L:7f25badb2ccfd826-1", do_.contains("DataImport"));
        parity_assert!("L:3a8e52cc570664e6-1", do_.contains("DataResetSeed"));
        parity_assert!("L:2bee7404538a37d9-1", do_.contains("RequestAdminReset"));
        let ca = roles::preconfigured_capabilities("config_audit_admin");
        parity_assert!("L:1520e9609d92c303-1", !ca.is_empty());
        parity_assert!("L:829cc4b836d749f3-1", ca.contains("ConfigAppSettingsRead"));
        parity_assert!("L:e748c6b6a9a22343-1", ca.contains("ConfigAppSettingsWrite"));
        parity_assert!("L:5136c20d1b73c953-1", ca.contains("ConfigEmailTemplateRead"));
        parity_assert!("L:0c2e01155d003fb5-1", ca.contains("ConfigEmailTemplateWrite"));
        parity_assert!("L:00da9f3b81de69af-1", ca.contains("AuditLogRead"));
        parity_assert!("L:aedbfc162018957e-1", ca.contains("AuditAccessLogRead"));
        parity_assert!("L:d217e4e8714d4eba-1", ca.contains("AuditSentNotificationsRead"));
        let fa = roles::preconfigured_capabilities("full_admin");
        parity_assert!("L:a142a0f44c548db7-1", !fa.is_empty());
        for cap in ALL_CAPABILITIES { parity_assert!("L:4da1fb93930c7035-1", fa.contains(*cap), "full_admin missing capability: {cap}"); }

        let udb = roles::get_role_capabilities(&db, "user_admin").await?;
        parity_assert!("L:47faaa21ab7e86c5-1", udb.contains("UserRead"));
        parity_assert!("L:28b54593f6a9bc7c-1", udb.contains("UserInvite"));
        parity_assert!("L:305fc788649db156-1", !udb.contains("SystemRead"));
        let fdb = roles::get_role_capabilities(&db, "full_admin").await?;
        parity_assert!("L:26f99b86862ee16e-1", fdb.contains("UserRead"));
        parity_assert!("L:347cda8805150487-1", fdb.contains("SystemRead"));
        parity_assert!("L:e38dc6f76973f519-1", roles::role_has_capability(&db, "user_admin", "UserRead").await?);
        parity_assert!("L:f21ed581f3727205-1", roles::role_has_capability(&db, "user_admin", "UserInvite").await?);
        parity_assert!("L:b186ec3fa8782dbb-1", !roles::role_has_capability(&db, "user_admin", "SystemRead").await?);
        parity_assert!("L:9d04f32305114f84-1", roles::role_has_capability(&db, "full_admin", "UserRead").await?);
        parity_assert!("L:6c85b0eab626060b-1", roles::role_has_capability(&db, "full_admin", "SystemRead").await?);
        parity_assert!("L:0bf236cbb9fce111-1", roles::role_has_capability(&db, "full_admin", "AdminRolesManage").await?);
        parity_assert!("L:e82bd0d25fea33f4-1", !roles::role_has_capability(&db, "invalid_role", "UserRead").await?);

        // Seed roles (clear grants first for FK).
        sea_orm::ConnectionTrait::execute(&db, sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres, "DELETE FROM user_admin_role_grants")).await?;
        sea_orm::ConnectionTrait::execute(&db, sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres, "DELETE FROM admin_roles")).await?;
        roles::seed_admin_roles(&db).await?;
        let listed = roles::list_admin_roles(&db).await?;
        parity_assert_eq!("L:9c26001330a16868-1", listed.len(), 6);
        parity_assert!("L:08a98c1a46d17e38-1", listed.iter().any(|r| r.key == "user_admin"));
        parity_assert!("L:bbb858a3602d3f41-1", listed.iter().any(|r| r.key == "org_structure_admin"));
        parity_assert!("L:89f79587819b0a7a-1", listed.iter().any(|r| r.key == "systems_assets_admin"));
        parity_assert!("L:5202444ab3902bfa-1", listed.iter().any(|r| r.key == "data_operator"));
        parity_assert!("L:5feeb834662fc0cc-1", listed.iter().any(|r| r.key == "config_audit_admin"));
        parity_assert!("L:5e25a1b1b7a23547-1", listed.iter().any(|r| r.key == "full_admin"));
        let meta = roles::get_admin_role_metadata(&db, "user_admin").await?;
        parity_assert!("L:e54313c44d8c61cd-1", meta.is_some());
        parity_assert_eq!("L:b3a342b4475adc3c-1", meta.as_ref().unwrap().key, "user_admin");
        parity_assert_eq!("L:d3af99a9c90b5fca-1", meta.as_ref().unwrap().name, "User Administrator");
        Ok(())
    }).await
}

#[tokio::test]
async fn auth_admin_roles_grants_and_effective_capabilities() -> Result<()> {
    TestApp::run("auth_admin_roles_grants", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "GrantAdmin!2026").await?;
        let u1 = fixtures::create_active_user(&app, "User One", &fixtures::unique_email("u1"), "UserOne!2026", "agency", true).await?;
        let u2 = fixtures::create_active_user(&app, "User Two", &fixtures::unique_email("u2"), "UserTwo!2026", "agency", true).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        let clear = || async {
            sea_orm::ConnectionTrait::execute(&db, sea_orm::Statement::from_string(sea_orm::DbBackend::Postgres, "DELETE FROM user_admin_role_grants")).await
        };

        let meta = roles::get_admin_role_metadata(&db, "non_existent").await?;
        parity_assert!("L:0e0a46cb9fd0bfda-1", meta.is_none());

        clear().await?;
        let grant = roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:e33ac26138e605ff-1", !grant.id.is_nil());
        parity_assert_eq!("L:31045244eb3e10bc-1", grant.user_id, u1.id);
        parity_assert_eq!("L:7ba550399f3b30ee-1", grant.role_key, "user_admin");
        parity_assert_eq!("L:5872bbbe03e9e0fb-1", grant.granted_by, admin.id);
        parity_assert!("L:09187a3a02943745-1", grant.revoked_at.is_none());
        let grants = roles::list_admin_role_grants(&db, u1.id, false).await?;
        parity_assert_eq!("L:90ce36a6d50176f8-1", grants.len(), 1);
        parity_assert_eq!("L:1edeb7babbea7b32-1", grants[0].role_key, "user_admin");

        let err = roles::grant_admin_role(&db, u1.id, "invalid_role", admin.id, None, None).await.unwrap_err();
        parity_assert!("L:c1a8b2b353d82d1c-1", err.to_string().contains("Unknown admin role: invalid_role"));

        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, u1.id, "org_structure_admin", admin.id, None, None).await?;
        let grants = roles::list_admin_role_grants(&db, u1.id, false).await?;
        parity_assert_eq!("L:3a77eb700d22734f-1", grants.len(), 2);
        parity_assert!("L:1cfd9f9e19472ec4-1", grants.iter().any(|g| g.role_key == "user_admin"));
        parity_assert!("L:8668ba58aabb712e-1", grants.iter().any(|g| g.role_key == "org_structure_admin"));

        clear().await?;
        let g = roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::revoke_admin_role(&db, g.id, admin.id, Some("Test revocation")).await?;
        parity_assert_eq!("L:2e9b2c2a6ed1bf5e-1", roles::list_admin_role_grants(&db, u1.id, false).await?.len(), 0);
        let all = roles::list_admin_role_grants(&db, u1.id, true).await?;
        parity_assert_eq!("L:5c506c5bb6801f60-1", all.len(), 1);
        parity_assert!("L:c76ad2a07371e5c4-1", all[0].revoked_at.is_some());

        clear().await?;
        let g = roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        let revoked = roles::revoke_admin_role(&db, g.id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:6232fa5351fc4d32-1", revoked.is_some());
        let revoked = revoked.unwrap();
        parity_assert!("L:45b5a5fd968d742a-1", revoked.revoked_at.is_some());
        parity_assert_eq!("L:a6f93fc054ae8eda-1", revoked.revoked_by, Some(admin.id));
        parity_assert_eq!("L:80f5fbc4d567f9e2-1", revoked.revocation_reason.as_deref(), Some("Test revocation"));
        parity_assert!("L:7158ee767620cc9d-1", roles::revoke_admin_role(&db, uuid::Uuid::nil(), admin.id, None).await?.is_none());
        parity_assert!("L:d220fe0b05aa80cf-1", roles::revoke_admin_role(&db, g.id, admin.id, None).await?.is_none());

        clear().await?;
        for role in ["user_admin","org_structure_admin","systems_assets_admin"] { roles::grant_admin_role(&db, u1.id, role, admin.id, None, None).await?; }
        let revoked = roles::revoke_all_admin_roles(&db, u1.id, admin.id, Some("Bulk revocation")).await?;
        parity_assert_eq!("L:44afbc563cf88357-1", revoked.len(), 3);
        parity_assert_eq!("L:5eecd2b0007e92bd-1", roles::list_admin_role_grants(&db, u1.id, false).await?.len(), 0);

        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, u2.id, "org_structure_admin", admin.id, None, None).await?;
        parity_assert_eq!("L:4e2bc884438e459c-1", roles::list_all_active_admin_role_grants(&db).await?.len(), 2);

        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, u2.id, "user_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, u1.id, "org_structure_admin", admin.id, None, None).await?;
        let u1_grants = roles::list_admin_role_grants(&db, u1.id, false).await?;
        parity_assert_eq!("L:c55ded50e04da4f8-1", u1_grants.iter().filter(|g| g.role_key == "user_admin").count(), 1);
        let users = roles::get_users_with_role(&db, "user_admin", false).await?;
        parity_assert_eq!("L:0e15b1006ed050d6-1", users.len(), 2);
        parity_assert!("L:863b1da685f21f4d-1", users.contains(&u1.id));
        parity_assert!("L:38b0696c410316de-1", users.contains(&u2.id));

        // Capability checking.
        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        parity_assert!("L:77ad481d8cb33954-1", has_admin_privilege(&db, u1.id, "UserRead").await?);
        parity_assert!("L:5af1fbdbe05c314b-1", !has_admin_privilege(&db, u1.id, "SystemRead").await?);
        clear().await?;
        parity_assert!("L:3a451b1cc24cf828-1", !has_admin_privilege(&db, u1.id, "UserRead").await?);
        roles::grant_admin_role(&db, u1.id, "full_admin", admin.id, None, None).await?;
        for cap in ALL_CAPABILITIES { parity_assert!("L:79373cec32da108d-1", has_admin_privilege(&db, u1.id, cap).await?, "full_admin should have capability: {cap}"); }
        let err = has_admin_privilege(&db, u1.id, "InvalidCapability").await.unwrap_err();
        parity_assert!("L:0e9d8db4c60b97da-1", err.to_string().contains("Unknown capability: InvalidCapability"));
        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        require_admin_privilege(&db, u1.id, "UserRead").await?;
        let err = require_admin_privilege(&db, u1.id, "SystemRead").await.unwrap_err();
        parity_assert!("L:2058cf7b00baaf16-1", err.to_string().contains("User lacks required admin capability: SystemRead"));

        // Effective capabilities.
        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, u1.id, "org_structure_admin", admin.id, None, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, u1.id).await?;
        parity_assert!("L:9582f252389a046d-1", caps.contains("UserRead"));
        parity_assert!("L:f64a70917f18bb0b-1", caps.contains("ClusterRead"));
        parity_assert!("L:408d703b0101af2d-1", caps.contains("TeamRead"));
        parity_assert!("L:d8b6254272f4deb6-1", !caps.contains("DataExport"));
        clear().await?;
        parity_assert_eq!("L:3fca03739fa7cbd5-1", roles::get_effective_admin_capabilities(&db, u1.id).await?.len(), 0);

        // isAdminUser.
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        parity_assert!("L:ff0be39458ec646e-1", roles::user_has_any_admin_role(&db, u1.id).await?);
        clear().await?;
        parity_assert!("L:70ad44636af6279b-1", !roles::user_has_any_admin_role(&db, u1.id).await?);
        let g = roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::revoke_admin_role(&db, g.id, admin.id, None).await?;
        parity_assert!("L:bb7ef352d0e4897e-1", !roles::user_has_any_admin_role(&db, u1.id).await?);

        // Additive model.
        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, u1.id, "config_audit_admin", admin.id, None, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, u1.id).await?;
        parity_assert!("L:1b80ced613b2abab-1", caps.contains("UserRead"));
        parity_assert!("L:e3f69e63c9f7bd6b-1", caps.contains("UserInvite"));
        parity_assert!("L:89653e5ea775fc14-1", caps.contains("AuditLogRead"));
        parity_assert!("L:8450460525c8c82e-1", caps.contains("ConfigAppSettingsRead"));
        clear().await?;
        roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, u1.id).await?;
        let initial = caps.len();
        parity_assert!("L:185bc9a8aabfd0c5-1", caps.contains("UserRead"));
        parity_assert!("L:3da7cb5301352f8b-1", !caps.contains("ClusterRead"));
        roles::grant_admin_role(&db, u1.id, "org_structure_admin", admin.id, None, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, u1.id).await?;
        parity_assert!("L:f77b1a67906d5e45-1", caps.len() > initial);
        parity_assert!("L:185bc9a8aabfd0c5-2", caps.contains("UserRead"));
        parity_assert!("L:2912154aad18c79e-1", caps.contains("ClusterRead"));
        clear().await?;
        let g1 = roles::grant_admin_role(&db, u1.id, "user_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, u1.id, "org_structure_admin", admin.id, None, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, u1.id).await?;
        parity_assert!("L:9c594e00acea9ed5-1", caps.contains("UserRead"));
        parity_assert!("L:2985d60b8d370293-1", caps.contains("ClusterRead"));
        roles::revoke_admin_role(&db, g1.id, admin.id, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, u1.id).await?;
        parity_assert!("L:eb63c9b78a2d689f-1", !caps.contains("UserRead"));
        parity_assert!("L:2985d60b8d370293-2", caps.contains("ClusterRead"));

        // Capability hygiene.
        parity_assert!("L:dc04e19a4b7098d5-1", !ALL_CAPABILITIES.contains(&"AdminCapabilitiesDebugView"));
        parity_assert_eq!("L:be9de6959010d1ec-1", roles::is_valid_capability("AdminCapabilitiesDebugView"), false);
        let fa = roles::preconfigured_capabilities("full_admin");
        parity_assert!("L:dd6057f563ca3858-1", !fa.is_empty());
        parity_assert!("L:6c9da03172ccf547-1", !fa.contains("AdminCapabilitiesDebugView"));
        let org_meta = roles::get_admin_role_metadata(&db, "org_structure_admin").await?;
        parity_assert!("L:7e37f82da16ed95b-1", org_meta.is_some());
        parity_assert_eq!("L:2745efb562ddd943-1", org_meta.unwrap().name, "Cluster & Team Structure Administrator");
        Ok(())
    }).await
}

#[tokio::test]
async fn auth_admin_roles_introspection_routes() -> Result<()> {
    TestApp::run("auth_admin_roles_introspection", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "IntroAdmin!2026").await?;
        let admin_session = fixtures::session_of(&fixtures::login_user(&app, &admin).await?)?;
        let plain = fixtures::create_active_user(&app, "Grantless User", &fixtures::unique_email("grantless"), "Grantless!2026", "agency", true).await?;
        let plain_session = fixtures::session_of(&fixtures::login_user(&app, &plain).await?)?;
        let db = sea_orm::Database::connect(app.db_url()).await?;
        parity_assert!("L:a589ab9df4c0f90d-1", !roles::user_has_any_admin_role(&db, plain.id).await?, "fresh user must be grant-free");

        let (status, body) = app.auth_get_json("/admin/capabilities", &admin_session).await?;
        parity_assert_eq!("L:26534ef4158cbe95-1", status, StatusCode::OK);
        parity_assert!("L:2d0a8f5ce86b9529-1", body["capabilities"].is_array());
        parity_assert_eq!("L:a176b04a54a98636-1", body["count"], json!(ALL_CAPABILITIES.len()));
        let set: std::collections::BTreeSet<&str> = body["capabilities"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        parity_assert_eq!("L:fbd1cb1448af59a7-1", set.len(), ALL_CAPABILITIES.len());
        parity_assert!("L:9e29b87a8272d045-1", set.contains("UserRead"));
        parity_assert!("L:124916472cc3ab26-1", set.contains("AdminRolesManage"));
        let (status, _) = app.auth_get_json("/admin/capabilities", &plain_session).await?;
        parity_assert_eq!("L:0bbbdda4dba92790-1", status, StatusCode::FORBIDDEN);
        let (status, _) = app.get_json("/admin/capabilities").await?;
        parity_assert_eq!("L:e5842569446c1a48-1", status, StatusCode::UNAUTHORIZED);

        let (status, body) = app.auth_get_json("/admin/capabilities/check?capability=UserRead", &admin_session).await?;
        parity_assert_eq!("L:5ee27ef99fabd6c8-1", status, StatusCode::OK);
        parity_assert_eq!("L:aee0d87122dbd231-1", body, json!({"capability":"UserRead","hasCapability":true}));
        let (status, _) = app.auth_get_json("/admin/capabilities/check?capability=UserRead", &plain_session).await?;
        parity_assert_eq!("L:647f35cfe3040875-1", status, StatusCode::FORBIDDEN);
        let (status, _) = app.auth_get_json("/admin/capabilities/check", &admin_session).await?;
        parity_assert_eq!("L:55d1cd64920870e1-1", status, StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_get_json("/admin/capabilities/check?capability=NotARealCapability", &admin_session).await?;
        parity_assert_eq!("L:a7c0e0d584a77ff8-1", status, StatusCode::BAD_REQUEST);
        let (status, _) = app.get_json("/admin/capabilities/check?capability=UserRead").await?;
        parity_assert_eq!("L:ccf8bb48c774b72c-1", status, StatusCode::UNAUTHORIZED);

        let (status, body) = app.auth_post_json("/admin/capabilities/check-multiple", &admin_session, json!({"capabilities":["UserRead","SystemDelete"]})).await?;
        parity_assert_eq!("L:0575b03337ee01a0-1", status, StatusCode::OK);
        parity_assert_eq!("L:506b9b29bfda61c0-1", body["results"], json!([{"capability":"UserRead","hasCapability":true},{"capability":"SystemDelete","hasCapability":true}]));
        let (status, _) = app.auth_post_json("/admin/capabilities/check-multiple", &admin_session, json!({"capabilities":"UserRead"})).await?;
        parity_assert_eq!("L:88d8deb45454dca0-1", status, StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json("/admin/capabilities/check-multiple", &admin_session, json!({"capabilities":["UserRead","NotARealCapability"]})).await?;
        parity_assert_eq!("L:04d86dd8707172e9-1", status, StatusCode::BAD_REQUEST);
        let (status, _) = app.auth_post_json("/admin/capabilities/check-multiple", &plain_session, json!({"capabilities":["UserRead"]})).await?;
        parity_assert_eq!("L:2aaf35bb53c83b45-1", status, StatusCode::FORBIDDEN);
        let (status, _) = app.post_json("/admin/capabilities/check-multiple", json!({"capabilities":["UserRead"]})).await?;
        parity_assert_eq!("L:8dbee438222068fa-1", status, StatusCode::UNAUTHORIZED);

        let (status, body) = app.auth_get_json("/admin/capabilities/all", &admin_session).await?;
        parity_assert_eq!("L:2efeb42c50cbc8ab-1", status, StatusCode::OK);
        parity_assert_eq!("L:f8300deb4ddbe1cc-1", body["count"], json!(ALL_CAPABILITIES.len()));
        let got: std::collections::BTreeSet<&str> = body["capabilities"].as_array().unwrap().iter().map(|v| v.as_str().unwrap()).collect();
        let want: std::collections::BTreeSet<&str> = ALL_CAPABILITIES.iter().copied().collect();
        parity_assert_eq!("L:6a0d2a7a6c8301ab-1", got, want);
        let (status, _) = app.auth_get_json("/admin/capabilities/all", &plain_session).await?;
        parity_assert_eq!("L:c0486b57526cefa4-1", status, StatusCode::FORBIDDEN);
        let (status, _) = app.get_json("/admin/capabilities/all").await?;
        parity_assert_eq!("L:8ceffd7dddc6da69-1", status, StatusCode::UNAUTHORIZED);

        let (status, body) = app.auth_get_json("/admin/roles/my-grants", &admin_session).await?;
        parity_assert_eq!("L:28d57fa1fe77ad6a-1", status, StatusCode::OK);
        parity_assert!("L:43b192b7d91e899a-1", body["grants"].is_array());
        let full = body["grants"].as_array().unwrap().iter().find(|g| g["roleKey"] == "full_admin");
        parity_assert!("L:6f0bbeb23f5a866c-1", full.is_some(), "admin's full_admin grant must be present");
        parity_assert_eq!("L:6270f0251e4255d2-1", full.unwrap()["roleName"], json!("Full Administrator"));
        parity_assert_eq!("L:34538fca6e938aad-1", full.unwrap()["roleDescription"], json!("Full access to all admin capabilities and role management"));
        let (status, _) = app.auth_get_json("/admin/roles/my-grants", &plain_session).await?;
        parity_assert_eq!("L:71f12ef01edeedc9-1", status, StatusCode::FORBIDDEN);
        let (status, _) = app.get_json("/admin/roles/my-grants").await?;
        parity_assert_eq!("L:689aa9d531e6e686-1", status, StatusCode::UNAUTHORIZED);

        let (status, body) = app.auth_get_json("/admin/is-admin", &admin_session).await?;
        parity_assert_eq!("L:678b2c627e116f80-1", status, StatusCode::OK);
        parity_assert_eq!("L:9fbb5ab1ba8fef53-1", body, json!({"isAdmin":true}));
        let (status, body) = app.auth_get_json("/admin/is-admin", &plain_session).await?;
        parity_assert_eq!("L:9e6af369cb0c2df3-1", status, StatusCode::OK);
        parity_assert_eq!("L:25ee3d87ca97a032-1", body, json!({"isAdmin":false}));
        let (status, body) = app.get_json("/admin/is-admin").await?;
        parity_assert_eq!("L:5123cb3adb131824-1", status, StatusCode::OK);
        parity_assert_eq!("L:4c73bd43ef68acf4-1", body, json!({"isAdmin":false}));
        Ok(())
    }).await
}
