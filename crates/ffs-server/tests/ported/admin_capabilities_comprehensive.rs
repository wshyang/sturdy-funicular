//! Port of test/backend/deno/admin-capabilities-comprehensive.test.tsx (244 parity assertions).
//! Matrix: baseline / grant / revoke for every capability covered by the legacy suite.

use crate::fixtures;
use anyhow::Result;
use ffs_test_support::{parity_assert, parity_assert_eq, TestApp};
use ffs_server::auth::privileges::{has_admin_privilege, require_admin_privilege};
use ffs_server::db::admin_roles::{self as roles, ROLE_CAPABILITIES, ALL_CAPABILITIES};
use sea_orm::DatabaseConnection;
use uuid::Uuid;

async fn clear_grants(db: &DatabaseConnection, user: Uuid) -> Result<()> {
    sea_orm::ConnectionTrait::execute(db, sea_orm::Statement::from_sql_and_values(
        sea_orm::DbBackend::Postgres, "DELETE FROM user_admin_role_grants WHERE user_id=$1", [user.into()],
    )).await?;
    Ok(())
}

fn role_for(cap: &str) -> Option<&'static str> {
    ROLE_CAPABILITIES.iter().find(|(_, caps)| caps.contains(&cap)).map(|(k, _)| *k)
}

#[tokio::test]
async fn capability_matrix_baseline_positive_negative() -> Result<()> {
    TestApp::run("admin_capabilities_matrix", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "CapAdmin!2026").await?;
        let user = fixtures::create_active_user(&app, "Cap Subject", &fixtures::unique_email("capsub"), "CapSubject!2026", "agency", true).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;

        // UserRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:433fd55db65b8fa8-1", !has_admin_privilege(&db, user.id, "UserRead").await?);
        let role = role_for("UserRead");
        parity_assert!("L:715d8a3185474dcd-1", role.is_some(), "No role found for UserRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:0c7ddcc544b2a0e6-1", has_admin_privilege(&db, user.id, "UserRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserRead"));
        parity_assert!("L:02754e69e7274bc5-1", grant.is_some(), "UserRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:699f77c76f6a93bf-1", !has_admin_privilege(&db, user.id, "UserRead").await?);

        // UserInvite
        clear_grants(&db, user.id).await?;
        parity_assert!("L:92d3537251aee730-1", !has_admin_privilege(&db, user.id, "UserInvite").await?);
        let role = role_for("UserInvite");
        parity_assert!("L:1dd67c71aa5734ef-1", role.is_some(), "No role found for UserInvite capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:cb8bf4d5bf9e07c4-1", has_admin_privilege(&db, user.id, "UserInvite").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserInvite"));
        parity_assert!("L:1e5ca81ee5a7d901-1", grant.is_some(), "UserInvite grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:7cb90a2ccd5f11f9-1", !has_admin_privilege(&db, user.id, "UserInvite").await?);

        // UserApprove
        clear_grants(&db, user.id).await?;
        parity_assert!("L:8146eda3180a6ad4-1", !has_admin_privilege(&db, user.id, "UserApprove").await?);
        let role = role_for("UserApprove");
        parity_assert!("L:d5fe9f16b4ce868d-1", role.is_some(), "No role found for UserApprove capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:603ed39751bc773b-1", has_admin_privilege(&db, user.id, "UserApprove").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserApprove"));
        parity_assert!("L:05b2f62375ad2597-1", grant.is_some(), "UserApprove grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:c8c0df56f37fcde6-1", !has_admin_privilege(&db, user.id, "UserApprove").await?);

        // UserReject
        clear_grants(&db, user.id).await?;
        parity_assert!("L:8871de3be3e24030-1", !has_admin_privilege(&db, user.id, "UserReject").await?);
        let role = role_for("UserReject");
        parity_assert!("L:b20abdcaae612ef3-1", role.is_some(), "No role found for UserReject capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:229bbc033c65ce87-1", has_admin_privilege(&db, user.id, "UserReject").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserReject"));
        parity_assert!("L:9f07d494c7219706-1", grant.is_some(), "UserReject grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:e36cefaf1ea40da4-1", !has_admin_privilege(&db, user.id, "UserReject").await?);

        // UserTombstone
        clear_grants(&db, user.id).await?;
        parity_assert!("L:c4f8757afd3f8474-1", !has_admin_privilege(&db, user.id, "UserTombstone").await?);
        let role = role_for("UserTombstone");
        parity_assert!("L:a61a045b49f5f8c1-1", role.is_some(), "No role found for UserTombstone capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:e02472278ab25214-1", has_admin_privilege(&db, user.id, "UserTombstone").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserTombstone"));
        parity_assert!("L:e510d973a4ea86b5-1", grant.is_some(), "UserTombstone grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:71bfbe1ebc1270c0-1", !has_admin_privilege(&db, user.id, "UserTombstone").await?);

        // UserUntombstone
        clear_grants(&db, user.id).await?;
        parity_assert!("L:3b2b474884d7e9f7-1", !has_admin_privilege(&db, user.id, "UserUntombstone").await?);
        let role = role_for("UserUntombstone");
        parity_assert!("L:679237d648259cb9-1", role.is_some(), "No role found for UserUntombstone capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:970bfe94c87bbeab-1", has_admin_privilege(&db, user.id, "UserUntombstone").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserUntombstone"));
        parity_assert!("L:cae7a85b11f11562-1", grant.is_some(), "UserUntombstone grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:ccc6c618a45b9ffb-1", !has_admin_privilege(&db, user.id, "UserUntombstone").await?);

        // UserAffiliationChange
        clear_grants(&db, user.id).await?;
        parity_assert!("L:3b4eca9c91aabf99-1", !has_admin_privilege(&db, user.id, "UserAffiliationChange").await?);
        let role = role_for("UserAffiliationChange");
        parity_assert!("L:0ca60121c73ce2bb-1", role.is_some(), "No role found for UserAffiliationChange capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:baacec757de5e389-1", has_admin_privilege(&db, user.id, "UserAffiliationChange").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserAffiliationChange"));
        parity_assert!("L:0f50e74b3bc6ad60-1", grant.is_some(), "UserAffiliationChange grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:19b8b7f26cbecec0-1", !has_admin_privilege(&db, user.id, "UserAffiliationChange").await?);

        // ClusterRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:2b57a54058b8242d-1", !has_admin_privilege(&db, user.id, "ClusterRead").await?);
        let role = role_for("ClusterRead");
        parity_assert!("L:04b9a8dfda594927-1", role.is_some(), "No role found for ClusterRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:bade405f38557f75-1", has_admin_privilege(&db, user.id, "ClusterRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ClusterRead"));
        parity_assert!("L:57a7b83861f78e99-1", grant.is_some(), "ClusterRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:26384f31c5f0b018-1", !has_admin_privilege(&db, user.id, "ClusterRead").await?);

        // ClusterCreate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:a7e158cfd3d00258-1", !has_admin_privilege(&db, user.id, "ClusterCreate").await?);
        let role = role_for("ClusterCreate");
        parity_assert!("L:fea729cb4792ae82-1", role.is_some(), "No role found for ClusterCreate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:57bbed0e413469c1-1", has_admin_privilege(&db, user.id, "ClusterCreate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ClusterCreate"));
        parity_assert!("L:83ea7356d1647e1f-1", grant.is_some(), "ClusterCreate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:6164e2f881080cab-1", !has_admin_privilege(&db, user.id, "ClusterCreate").await?);

        // ClusterUpdate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:2d0fbe4c213d0ecf-1", !has_admin_privilege(&db, user.id, "ClusterUpdate").await?);
        let role = role_for("ClusterUpdate");
        parity_assert!("L:91e7a60b7389a69e-1", role.is_some(), "No role found for ClusterUpdate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:845482441fd8309f-1", has_admin_privilege(&db, user.id, "ClusterUpdate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ClusterUpdate"));
        parity_assert!("L:ad031026cfa38942-1", grant.is_some(), "ClusterUpdate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:925e5f366aa35389-1", !has_admin_privilege(&db, user.id, "ClusterUpdate").await?);

        // ClusterDelete
        clear_grants(&db, user.id).await?;
        parity_assert!("L:9821ab9c236144df-1", !has_admin_privilege(&db, user.id, "ClusterDelete").await?);
        let role = role_for("ClusterDelete");
        parity_assert!("L:2d8ae439b34a39dc-1", role.is_some(), "No role found for ClusterDelete capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:b45e95659167c5a7-1", has_admin_privilege(&db, user.id, "ClusterDelete").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ClusterDelete"));
        parity_assert!("L:49acdc5022eb5041-1", grant.is_some(), "ClusterDelete grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:917c19deb9036712-1", !has_admin_privilege(&db, user.id, "ClusterDelete").await?);

        // TeamRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:c9e5602cf8190253-1", !has_admin_privilege(&db, user.id, "TeamRead").await?);
        let role = role_for("TeamRead");
        parity_assert!("L:6e1a00f50c6b2bc8-1", role.is_some(), "No role found for TeamRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:ea1c0814b6b22740-1", has_admin_privilege(&db, user.id, "TeamRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("TeamRead"));
        parity_assert!("L:1b02a10f3cabca2d-1", grant.is_some(), "TeamRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:8141cb1444a2024f-1", !has_admin_privilege(&db, user.id, "TeamRead").await?);

        // TeamCreate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:eb1c6bf5854394b5-1", !has_admin_privilege(&db, user.id, "TeamCreate").await?);
        let role = role_for("TeamCreate");
        parity_assert!("L:d0e7a4ea19b65b54-1", role.is_some(), "No role found for TeamCreate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:34ac1740ea083d09-1", has_admin_privilege(&db, user.id, "TeamCreate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("TeamCreate"));
        parity_assert!("L:17916fb4b7ebd6c0-1", grant.is_some(), "TeamCreate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:d294c6278eafcd07-1", !has_admin_privilege(&db, user.id, "TeamCreate").await?);

        // TeamUpdate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:7a86fe95216b2326-1", !has_admin_privilege(&db, user.id, "TeamUpdate").await?);
        let role = role_for("TeamUpdate");
        parity_assert!("L:9e996293e2bfc4ad-1", role.is_some(), "No role found for TeamUpdate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:6b2223abce426f23-1", has_admin_privilege(&db, user.id, "TeamUpdate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("TeamUpdate"));
        parity_assert!("L:04344e4742197700-1", grant.is_some(), "TeamUpdate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:879c4a872a627b39-1", !has_admin_privilege(&db, user.id, "TeamUpdate").await?);

        // TeamDelete
        clear_grants(&db, user.id).await?;
        parity_assert!("L:4df461d37c41367d-1", !has_admin_privilege(&db, user.id, "TeamDelete").await?);
        let role = role_for("TeamDelete");
        parity_assert!("L:30f3c64e27559d0f-1", role.is_some(), "No role found for TeamDelete capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:ced3e2cf712df8f3-1", has_admin_privilege(&db, user.id, "TeamDelete").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("TeamDelete"));
        parity_assert!("L:ec927fd4b93395df-1", grant.is_some(), "TeamDelete grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:9762b2dd217a8973-1", !has_admin_privilege(&db, user.id, "TeamDelete").await?);

        // TeamMemberRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:a76ee40d357ce5e0-1", !has_admin_privilege(&db, user.id, "TeamMemberRead").await?);
        let role = role_for("TeamMemberRead");
        parity_assert!("L:98e332bee9711ace-1", role.is_some(), "No role found for TeamMemberRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:1b0067e59260fe1f-1", has_admin_privilege(&db, user.id, "TeamMemberRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("TeamMemberRead"));
        parity_assert!("L:7f68c2b7b75adcf7-1", grant.is_some(), "TeamMemberRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:b0c575c68e110ac6-1", !has_admin_privilege(&db, user.id, "TeamMemberRead").await?);

        // TeamMemberManage
        clear_grants(&db, user.id).await?;
        parity_assert!("L:665d37159fca709c-1", !has_admin_privilege(&db, user.id, "TeamMemberManage").await?);
        let role = role_for("TeamMemberManage");
        parity_assert!("L:3d2c27116d0e24bc-1", role.is_some(), "No role found for TeamMemberManage capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:485dafd1061d390c-1", has_admin_privilege(&db, user.id, "TeamMemberManage").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("TeamMemberManage"));
        parity_assert!("L:14de3ec325a5fd8e-1", grant.is_some(), "TeamMemberManage grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:82faf6af8f3b5c71-1", !has_admin_privilege(&db, user.id, "TeamMemberManage").await?);

        // SystemRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:f10151aeeec222a0-1", !has_admin_privilege(&db, user.id, "SystemRead").await?);
        let role = role_for("SystemRead");
        parity_assert!("L:c9497851998a4333-1", role.is_some(), "No role found for SystemRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:540f02dc4ad0378d-1", has_admin_privilege(&db, user.id, "SystemRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("SystemRead"));
        parity_assert!("L:1721f9b9a308c5ce-1", grant.is_some(), "SystemRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:9f654636ce53361d-1", !has_admin_privilege(&db, user.id, "SystemRead").await?);

        // SystemCreate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:08a69af2697a0828-1", !has_admin_privilege(&db, user.id, "SystemCreate").await?);
        let role = role_for("SystemCreate");
        parity_assert!("L:11be996e0a9eb556-1", role.is_some(), "No role found for SystemCreate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:d21a2151122f6772-1", has_admin_privilege(&db, user.id, "SystemCreate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("SystemCreate"));
        parity_assert!("L:65c41d878b9151be-1", grant.is_some(), "SystemCreate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:39f70d593b6092e4-1", !has_admin_privilege(&db, user.id, "SystemCreate").await?);

        // SystemUpdate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:3f818e36944dee66-1", !has_admin_privilege(&db, user.id, "SystemUpdate").await?);
        let role = role_for("SystemUpdate");
        parity_assert!("L:2949bcad43665ace-1", role.is_some(), "No role found for SystemUpdate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:0210798c54b2b3ce-1", has_admin_privilege(&db, user.id, "SystemUpdate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("SystemUpdate"));
        parity_assert!("L:e6e224c5d562da86-1", grant.is_some(), "SystemUpdate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:d0ffbb35935b61f5-1", !has_admin_privilege(&db, user.id, "SystemUpdate").await?);

        // SystemDelete
        clear_grants(&db, user.id).await?;
        parity_assert!("L:aaa6e78a21e06bc7-1", !has_admin_privilege(&db, user.id, "SystemDelete").await?);
        let role = role_for("SystemDelete");
        parity_assert!("L:44ebcf046cb4839b-1", role.is_some(), "No role found for SystemDelete capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:9fd265ce12efc362-1", has_admin_privilege(&db, user.id, "SystemDelete").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("SystemDelete"));
        parity_assert!("L:2b3f0c4cb8824b88-1", grant.is_some(), "SystemDelete grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:0a23356c5f8f18ca-1", !has_admin_privilege(&db, user.id, "SystemDelete").await?);

        // SystemMappingRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:93267f3eb4c87e0e-1", !has_admin_privilege(&db, user.id, "SystemMappingRead").await?);
        let role = role_for("SystemMappingRead");
        parity_assert!("L:609a9390366dbd79-1", role.is_some(), "No role found for SystemMappingRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:57401a604dd69447-1", has_admin_privilege(&db, user.id, "SystemMappingRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("SystemMappingRead"));
        parity_assert!("L:658c71f10248f669-1", grant.is_some(), "SystemMappingRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:1a37af574c6e81d1-1", !has_admin_privilege(&db, user.id, "SystemMappingRead").await?);

        // SystemMappableTeamsRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:ac33e036029ccb19-1", !has_admin_privilege(&db, user.id, "SystemMappableTeamsRead").await?);
        let role = role_for("SystemMappableTeamsRead");
        parity_assert!("L:259db9e0a27496a4-1", role.is_some(), "No role found for SystemMappableTeamsRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:d968bef957402cfe-1", has_admin_privilege(&db, user.id, "SystemMappableTeamsRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("SystemMappableTeamsRead"));
        parity_assert!("L:0f74dcceccf2fcff-1", grant.is_some(), "SystemMappableTeamsRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:bde5892a7fe9e29e-1", !has_admin_privilege(&db, user.id, "SystemMappableTeamsRead").await?);

        // SystemOwnerManage
        clear_grants(&db, user.id).await?;
        parity_assert!("L:80945e1299994c01-1", !has_admin_privilege(&db, user.id, "SystemOwnerManage").await?);
        let role = role_for("SystemOwnerManage");
        parity_assert!("L:aa381117786d2dcc-1", role.is_some(), "No role found for SystemOwnerManage capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:e2220b77ff91b276-1", has_admin_privilege(&db, user.id, "SystemOwnerManage").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("SystemOwnerManage"));
        parity_assert!("L:f1a5da15ee97717c-1", grant.is_some(), "SystemOwnerManage grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:67a166aad73e18eb-1", !has_admin_privilege(&db, user.id, "SystemOwnerManage").await?);

        // TeamSystemMappingManage
        clear_grants(&db, user.id).await?;
        parity_assert!("L:ba1d0960da6f0d75-1", !has_admin_privilege(&db, user.id, "TeamSystemMappingManage").await?);
        let role = role_for("TeamSystemMappingManage");
        parity_assert!("L:20e5a7c8410991d6-1", role.is_some(), "No role found for TeamSystemMappingManage capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:72646f6c867f887f-1", has_admin_privilege(&db, user.id, "TeamSystemMappingManage").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("TeamSystemMappingManage"));
        parity_assert!("L:8af5f0396af35f42-1", grant.is_some(), "TeamSystemMappingManage grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:7f441846f0d11995-1", !has_admin_privilege(&db, user.id, "TeamSystemMappingManage").await?);

        // OwnerPAMappingManage
        clear_grants(&db, user.id).await?;
        parity_assert!("L:8ec24f70021831d2-1", !has_admin_privilege(&db, user.id, "OwnerPAMappingManage").await?);
        let role = role_for("OwnerPAMappingManage");
        parity_assert!("L:6e0d50a270eab082-1", role.is_some(), "No role found for OwnerPAMappingManage capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:d54bf5e876fb5d12-1", has_admin_privilege(&db, user.id, "OwnerPAMappingManage").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("OwnerPAMappingManage"));
        parity_assert!("L:95ae4f392c0311f3-1", grant.is_some(), "OwnerPAMappingManage grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:6d88a1fa61c355cc-1", !has_admin_privilege(&db, user.id, "OwnerPAMappingManage").await?);

        // AssetRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:074f4c06506684c0-1", !has_admin_privilege(&db, user.id, "AssetRead").await?);
        let role = role_for("AssetRead");
        parity_assert!("L:1e8e0b585b6cca25-1", role.is_some(), "No role found for AssetRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:612aa3aa1788a1fe-1", has_admin_privilege(&db, user.id, "AssetRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AssetRead"));
        parity_assert!("L:425cae427bfc73e1-1", grant.is_some(), "AssetRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:7c828418af0a20a7-1", !has_admin_privilege(&db, user.id, "AssetRead").await?);

        // AssetCreate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:cd7292bb00eef052-1", !has_admin_privilege(&db, user.id, "AssetCreate").await?);
        let role = role_for("AssetCreate");
        parity_assert!("L:3fa5c2eb621aa27f-1", role.is_some(), "No role found for AssetCreate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:3674256510c41104-1", has_admin_privilege(&db, user.id, "AssetCreate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AssetCreate"));
        parity_assert!("L:8c22b554662c8fb5-1", grant.is_some(), "AssetCreate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:d85d31e5f72879f6-1", !has_admin_privilege(&db, user.id, "AssetCreate").await?);

        // AssetUpdate
        clear_grants(&db, user.id).await?;
        parity_assert!("L:dec0749c45d37638-1", !has_admin_privilege(&db, user.id, "AssetUpdate").await?);
        let role = role_for("AssetUpdate");
        parity_assert!("L:56232a934fc29314-1", role.is_some(), "No role found for AssetUpdate capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:31e49ddfa1b58f28-1", has_admin_privilege(&db, user.id, "AssetUpdate").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AssetUpdate"));
        parity_assert!("L:0a55191bbddd9b0a-1", grant.is_some(), "AssetUpdate grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:ae87d6eae60f1310-1", !has_admin_privilege(&db, user.id, "AssetUpdate").await?);

        // AssetDelete
        clear_grants(&db, user.id).await?;
        parity_assert!("L:2abf571f6382b763-1", !has_admin_privilege(&db, user.id, "AssetDelete").await?);
        let role = role_for("AssetDelete");
        parity_assert!("L:51e051ecca4ea891-1", role.is_some(), "No role found for AssetDelete capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:f46fca7184db58e9-1", has_admin_privilege(&db, user.id, "AssetDelete").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AssetDelete"));
        parity_assert!("L:b9761e062384d5ab-1", grant.is_some(), "AssetDelete grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:932fec7ff212145b-1", !has_admin_privilege(&db, user.id, "AssetDelete").await?);

        // AssetSync
        clear_grants(&db, user.id).await?;
        parity_assert!("L:f2d76b874553d0c7-1", !has_admin_privilege(&db, user.id, "AssetSync").await?);
        let role = role_for("AssetSync");
        parity_assert!("L:0d28096c0dfb8937-1", role.is_some(), "No role found for AssetSync capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:a9f15d5f45170ddf-1", has_admin_privilege(&db, user.id, "AssetSync").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AssetSync"));
        parity_assert!("L:e12b3f9e59be13a5-1", grant.is_some(), "AssetSync grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:d5e4cffb405871f4-1", !has_admin_privilege(&db, user.id, "AssetSync").await?);

        // DataExport
        clear_grants(&db, user.id).await?;
        parity_assert!("L:426ac5c7c34f4a07-1", !has_admin_privilege(&db, user.id, "DataExport").await?);
        let role = role_for("DataExport");
        parity_assert!("L:0f254297c5766bfe-1", role.is_some(), "No role found for DataExport capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:2f88620a9d4a3e29-1", has_admin_privilege(&db, user.id, "DataExport").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("DataExport"));
        parity_assert!("L:a55f3ae49c6dd196-1", grant.is_some(), "DataExport grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:12e44d3591be7d67-1", !has_admin_privilege(&db, user.id, "DataExport").await?);

        // DataImport
        clear_grants(&db, user.id).await?;
        parity_assert!("L:64d5acb2641904fb-1", !has_admin_privilege(&db, user.id, "DataImport").await?);
        let role = role_for("DataImport");
        parity_assert!("L:918446ff5c7ba8b5-1", role.is_some(), "No role found for DataImport capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:bd277c2fb55c4787-1", has_admin_privilege(&db, user.id, "DataImport").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("DataImport"));
        parity_assert!("L:a2c851d6d09173be-1", grant.is_some(), "DataImport grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:b0d0f66680597efc-1", !has_admin_privilege(&db, user.id, "DataImport").await?);

        // DataResetSeed
        clear_grants(&db, user.id).await?;
        parity_assert!("L:17a9672aed41fdb5-1", !has_admin_privilege(&db, user.id, "DataResetSeed").await?);
        let role = role_for("DataResetSeed");
        parity_assert!("L:0f600434b0326945-1", role.is_some(), "No role found for DataResetSeed capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:4b19ac507c17bba7-1", has_admin_privilege(&db, user.id, "DataResetSeed").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("DataResetSeed"));
        parity_assert!("L:3ce3feced7d8c5df-1", grant.is_some(), "DataResetSeed grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:67be520f33ae10ea-1", !has_admin_privilege(&db, user.id, "DataResetSeed").await?);

        // RequestAdminReset
        clear_grants(&db, user.id).await?;
        parity_assert!("L:5a6513b2a76e7c80-1", !has_admin_privilege(&db, user.id, "RequestAdminReset").await?);
        let role = role_for("RequestAdminReset");
        parity_assert!("L:7767fd0cfa107644-1", role.is_some(), "No role found for RequestAdminReset capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:ec2fa17438e2aee6-1", has_admin_privilege(&db, user.id, "RequestAdminReset").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("RequestAdminReset"));
        parity_assert!("L:f45688a7f916aea8-1", grant.is_some(), "RequestAdminReset grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:6506fb2a5eea181f-1", !has_admin_privilege(&db, user.id, "RequestAdminReset").await?);

        // ConfigAppSettingsRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:e141f3c4df1ac8fa-1", !has_admin_privilege(&db, user.id, "ConfigAppSettingsRead").await?);
        let role = role_for("ConfigAppSettingsRead");
        parity_assert!("L:d752ee66435f8259-1", role.is_some(), "No role found for ConfigAppSettingsRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:4f5206937e00261d-1", has_admin_privilege(&db, user.id, "ConfigAppSettingsRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ConfigAppSettingsRead"));
        parity_assert!("L:cb4150fee06060d6-1", grant.is_some(), "ConfigAppSettingsRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:27be3e28de1985f6-1", !has_admin_privilege(&db, user.id, "ConfigAppSettingsRead").await?);

        // ConfigAppSettingsWrite
        clear_grants(&db, user.id).await?;
        parity_assert!("L:559bd11368e2e1aa-1", !has_admin_privilege(&db, user.id, "ConfigAppSettingsWrite").await?);
        let role = role_for("ConfigAppSettingsWrite");
        parity_assert!("L:0b02e83912b3f2a2-1", role.is_some(), "No role found for ConfigAppSettingsWrite capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:c7a3e619488df87f-1", has_admin_privilege(&db, user.id, "ConfigAppSettingsWrite").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ConfigAppSettingsWrite"));
        parity_assert!("L:e868d5da0192088e-1", grant.is_some(), "ConfigAppSettingsWrite grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:ccb1b03273e38a65-1", !has_admin_privilege(&db, user.id, "ConfigAppSettingsWrite").await?);

        // ConfigEmailTemplateRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:a676626ba8e2bccb-1", !has_admin_privilege(&db, user.id, "ConfigEmailTemplateRead").await?);
        let role = role_for("ConfigEmailTemplateRead");
        parity_assert!("L:b3fc4234ae1c2c79-1", role.is_some(), "No role found for ConfigEmailTemplateRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:a8e25b948598a79d-1", has_admin_privilege(&db, user.id, "ConfigEmailTemplateRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ConfigEmailTemplateRead"));
        parity_assert!("L:1ef4d1291446ad60-1", grant.is_some(), "ConfigEmailTemplateRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:2208885ca2fd246a-1", !has_admin_privilege(&db, user.id, "ConfigEmailTemplateRead").await?);

        // ConfigEmailTemplateWrite
        clear_grants(&db, user.id).await?;
        parity_assert!("L:945d3a23b495071b-1", !has_admin_privilege(&db, user.id, "ConfigEmailTemplateWrite").await?);
        let role = role_for("ConfigEmailTemplateWrite");
        parity_assert!("L:ffd749898368df48-1", role.is_some(), "No role found for ConfigEmailTemplateWrite capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:4607438faa3473c7-1", has_admin_privilege(&db, user.id, "ConfigEmailTemplateWrite").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("ConfigEmailTemplateWrite"));
        parity_assert!("L:02a2e5b23384ce41-1", grant.is_some(), "ConfigEmailTemplateWrite grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:e4cc0fb2728ed004-1", !has_admin_privilege(&db, user.id, "ConfigEmailTemplateWrite").await?);

        // AuditLogRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:69aca1edb77a43f9-1", !has_admin_privilege(&db, user.id, "AuditLogRead").await?);
        let role = role_for("AuditLogRead");
        parity_assert!("L:81ec5b986defe17c-1", role.is_some(), "No role found for AuditLogRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:760c1d617cc99c81-1", has_admin_privilege(&db, user.id, "AuditLogRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AuditLogRead"));
        parity_assert!("L:4e5bec5a236a4bf3-1", grant.is_some(), "AuditLogRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:354d9058f54c1783-1", !has_admin_privilege(&db, user.id, "AuditLogRead").await?);

        // AuditAccessLogRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:2e58566d43deac3b-1", !has_admin_privilege(&db, user.id, "AuditAccessLogRead").await?);
        let role = role_for("AuditAccessLogRead");
        parity_assert!("L:3a01ed2983c056e7-1", role.is_some(), "No role found for AuditAccessLogRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:6a26ece5d1c4fe28-1", has_admin_privilege(&db, user.id, "AuditAccessLogRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AuditAccessLogRead"));
        parity_assert!("L:f11da3bde0ab1d2d-1", grant.is_some(), "AuditAccessLogRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:87994802b488a68c-1", !has_admin_privilege(&db, user.id, "AuditAccessLogRead").await?);

        // AuditSentNotificationsRead
        clear_grants(&db, user.id).await?;
        parity_assert!("L:b4c569d40eb6f10d-1", !has_admin_privilege(&db, user.id, "AuditSentNotificationsRead").await?);
        let role = role_for("AuditSentNotificationsRead");
        parity_assert!("L:0cdbc1eb7adc6687-1", role.is_some(), "No role found for AuditSentNotificationsRead capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:bcab70e7eda76f64-1", has_admin_privilege(&db, user.id, "AuditSentNotificationsRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AuditSentNotificationsRead"));
        parity_assert!("L:1db42ea31c407226-1", grant.is_some(), "AuditSentNotificationsRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:ba2963306b442955-1", !has_admin_privilege(&db, user.id, "AuditSentNotificationsRead").await?);

        // AdminRolesManage
        clear_grants(&db, user.id).await?;
        parity_assert!("L:eaf685983559c2cc-1", !has_admin_privilege(&db, user.id, "AdminRolesManage").await?);
        let role = role_for("AdminRolesManage");
        parity_assert!("L:544e6affaca903c0-1", role.is_some(), "No role found for AdminRolesManage capability");
        roles::grant_admin_role(&db, user.id, role.unwrap(), admin.id, Some("Test grant"), None).await?;
        parity_assert!("L:b2e2eeb24e1f6916-1", has_admin_privilege(&db, user.id, "AdminRolesManage").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("AdminRolesManage"));
        parity_assert!("L:3328f1ba3da06a1e-1", grant.is_some(), "AdminRolesManage grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, Some("Test revocation")).await?;
        parity_assert!("L:d42705b2edbdce42-1", !has_admin_privilege(&db, user.id, "AdminRolesManage").await?);
        Ok(())
    }).await
}

#[tokio::test]
async fn capability_additional_and_edge_contracts() -> Result<()> {
    TestApp::run("admin_capabilities_additional", |app| async move {
        fixtures::prepare(&app).await?;
        let admin = fixtures::create_admin(&app, "CapAdmin!2026").await?;
        let user = fixtures::create_active_user(&app, "Cap Subject", &fixtures::unique_email("capsub"), "CapSubject!2026", "agency", true).await?;
        let db = sea_orm::Database::connect(app.db_url()).await?;

        // full_admin has ALL capabilities when granted.
        clear_grants(&db, user.id).await?;
        roles::grant_admin_role(&db, user.id, "full_admin", admin.id, None, None).await?;
        for cap in ALL_CAPABILITIES {
            parity_assert!("L:528c7ee70ca9b4e7-1", has_admin_privilege(&db, user.id, cap).await?, "full_admin should have capability: {cap}");
        }
        // full_admin loses ALL capabilities when revoked.
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let full = grants.iter().find(|g| g.role_key == "full_admin");
        parity_assert!("L:26919d8a46cedb58-1", full.is_some(), "full_admin grant not found");
        roles::revoke_admin_role(&db, full.unwrap().id, admin.id, None).await?;
        for cap in ALL_CAPABILITIES {
            parity_assert!("L:c88b32db889de544-1", !has_admin_privilege(&db, user.id, cap).await?, "User should not have capability {cap} after full_admin revoked");
        }

        // Multiple roles are additive.
        clear_grants(&db, user.id).await?;
        roles::grant_admin_role(&db, user.id, "user_admin", admin.id, None, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, user.id).await?;
        let user_caps = roles::preconfigured_capabilities("user_admin");
        parity_assert_eq!("L:a4f636dd37486704-1", caps.len(), user_caps.len());
        roles::grant_admin_role(&db, user.id, "org_structure_admin", admin.id, None, None).await?;
        let caps = roles::get_effective_admin_capabilities(&db, user.id).await?;
        let expected: std::collections::BTreeSet<String> = user_caps.union(&roles::preconfigured_capabilities("org_structure_admin")).cloned().collect();
        parity_assert_eq!("L:7d688ca6a2485bd9-1", caps.len(), expected.len());
        parity_assert!("L:b1951ffcd594ffd2-1", caps.contains("UserRead"));
        parity_assert!("L:d44b50387d58fa1c-1", caps.contains("ClusterRead"));

        // require_admin_privilege baseline / positive / negative.
        clear_grants(&db, user.id).await?;
        let err = require_admin_privilege(&db, user.id, "UserRead").await.unwrap_err();
        parity_assert!("L:6a144bcc873816dc-1", err.to_string().contains("User lacks required admin capability: UserRead"));
        roles::grant_admin_role(&db, user.id, "user_admin", admin.id, None, None).await?;
        require_admin_privilege(&db, user.id, "UserRead").await?;
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let grant = grants.iter().find(|g| roles::preconfigured_capabilities(&g.role_key).contains("UserRead"));
        parity_assert!("L:75a264e8bd40b937-1", grant.is_some(), "UserRead grant not found");
        roles::revoke_admin_role(&db, grant.unwrap().id, admin.id, None).await?;
        let err = require_admin_privilege(&db, user.id, "UserRead").await.unwrap_err();
        parity_assert!("L:2a064c50afd63655-1", err.to_string().contains("User lacks required admin capability: UserRead"));

        // isAdminUser baseline / positive / negative.
        clear_grants(&db, user.id).await?;
        parity_assert!("L:fe2b606fad167956-1", !roles::user_has_any_admin_role(&db, user.id).await?);
        roles::grant_admin_role(&db, user.id, "user_admin", admin.id, None, None).await?;
        parity_assert!("L:98675c868d48acf1-1", roles::user_has_any_admin_role(&db, user.id).await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        roles::revoke_admin_role(&db, grants[0].id, admin.id, None).await?;
        parity_assert!("L:2380c8eef82bc7a9-1", !roles::user_has_any_admin_role(&db, user.id).await?);

        // Role capability mappings + coverage.
        for (role_key, caps) in ROLE_CAPABILITIES {
            let listed = roles::preconfigured_capabilities(role_key);
            parity_assert_eq!("L:600a63a4ac4879e0-1", listed.len(), caps.len());
            for cap in listed.iter() {
                parity_assert!("L:ab2c03b66c49379f-1", caps.contains(&cap.as_str()), "{role_key} should have {cap}");
            }
        }
        let covered: std::collections::BTreeSet<String> = ROLE_CAPABILITIES.iter().flat_map(|(_, caps)| caps.iter().map(|s| s.to_string())).collect();
        for cap in ALL_CAPABILITIES {
            parity_assert!("L:617176677ea03042-1", covered.contains(*cap), "Capability {cap} not covered by any role");
        }

        // Invalid capability / role handling.
        let err = has_admin_privilege(&db, user.id, "InvalidCapability").await.unwrap_err();
        parity_assert!("L:c2401cbdf25b2564-1", err.to_string().contains("Unknown capability: InvalidCapability"));
        let err = require_admin_privilege(&db, user.id, "InvalidCapability").await.unwrap_err();
        parity_assert!("L:655641a1f5f3c901-1", err.to_string().contains("Unknown capability: InvalidCapability"));
        let err = roles::grant_admin_role(&db, user.id, "invalid_role", admin.id, None, None).await.unwrap_err();
        parity_assert!("L:4a6b72fea9b48e4a-1", err.to_string().contains("Unknown admin role: invalid_role"));

        // Redundant roles: revoking one does not remove a shared capability.
        clear_grants(&db, user.id).await?;
        roles::grant_admin_role(&db, user.id, "full_admin", admin.id, None, None).await?;
        parity_assert!("L:2971c72fbfe8feb2-1", has_admin_privilege(&db, user.id, "UserRead").await?);
        roles::grant_admin_role(&db, user.id, "user_admin", admin.id, None, None).await?;
        parity_assert!("L:539a395e3ebc2d67-1", has_admin_privilege(&db, user.id, "UserRead").await?);
        let caps = roles::get_effective_admin_capabilities(&db, user.id).await?;
        parity_assert!("L:51c64db8abbb482a-1", caps.contains("UserRead"));
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let ua = grants.iter().find(|g| g.role_key == "user_admin");
        parity_assert!("L:485fc8fb61db0661-1", ua.is_some(), "user_admin grant not found");
        roles::revoke_admin_role(&db, ua.unwrap().id, admin.id, None).await?;
        parity_assert!("L:59abb7e5a4f9db4a-1", has_admin_privilege(&db, user.id, "UserRead").await?);

        clear_grants(&db, user.id).await?;
        roles::grant_admin_role(&db, user.id, "full_admin", admin.id, None, None).await?;
        roles::grant_admin_role(&db, user.id, "user_admin", admin.id, None, None).await?;
        parity_assert!("L:f685a07398c1ccca-1", has_admin_privilege(&db, user.id, "UserRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let full = grants.iter().find(|g| g.role_key == "full_admin");
        parity_assert!("L:893ca5c9c11ea87d-1", full.is_some(), "full_admin grant not found");
        roles::revoke_admin_role(&db, full.unwrap().id, admin.id, None).await?;
        parity_assert!("L:fd4ac87fb16a1aca-1", has_admin_privilege(&db, user.id, "UserRead").await?);
        let grants = roles::list_admin_role_grants(&db, user.id, false).await?;
        let ua = grants.iter().find(|g| g.role_key == "user_admin");
        parity_assert!("L:bb786ad1e804b44b-1", ua.is_some(), "user_admin grant not found");
        roles::revoke_admin_role(&db, ua.unwrap().id, admin.id, None).await?;
        parity_assert!("L:135f1a9b7bcd8c56-1", !has_admin_privilege(&db, user.id, "UserRead").await?);
        Ok(())
    }).await
}
