//! Port of test/backend/deno/request_schemas.test.tsx (78 parity assertions).
use ffs_server::schemas::*;
use ffs_test_support::{parity_assert, parity_assert_eq};
use serde_json::json;

const UUID_A: &str = "00000000-0000-7000-8000-00000000000a";
fn all_stages() -> serde_json::Value {
    json!(["prepare","initiate_handover","verify_return","return_to_inventory","investigate_exception"].iter().map(|stage| json!({"stage":stage,"agencyTeamId":UUID_A,"instructions":null,"dueInHours":24})).collect::<Vec<_>>())
}
fn has_msg(r: &ParseResult, needle: &str) -> bool { r.messages.iter().any(|m| m.contains(needle)) }

#[test]
fn request_schemas_contracts() {
    parity_assert_eq!("L:dc678f008c6d62cc-1", signup_schema(&json!({"fullName":"Ada","email":"a@b.co","password":"pw"})).success, true);
    for body in [json!({"fullName":"","email":"a@b.co","password":"pw"}), json!({"fullName":"Ada","email":"","password":"pw"}), json!({"fullName":"Ada","email":"a@b.co","password":""}), json!({"email":"a@b.co","password":"pw"}), json!({})] {
        parity_assert_eq!("L:229593eedaadfc92-1", signup_schema(&body).success, false);
    }
    let out = signup_schema(&json!({"fullName":"x".repeat(101),"email":"a@b.co","password":"pw"}));
    parity_assert_eq!("L:0d5a68d5ffcf70bb-1", out.success, false);
    parity_assert!("L:c352224ea1658f86-1", has_msg(&out, "1-100 characters"));
    parity_assert_eq!("L:79b953a37e553c35-1", login_schema(&json!({"email":"a@b.co","password":"pw"})).success, true);
    parity_assert_eq!("L:427c0397addfe3e9-1", login_schema(&json!({"email":"","password":"pw"})).success, false);
    parity_assert_eq!("L:0d943ec40bd8c05d-1", two_fa_verify_schema(&json!({"code":"123456"})).success, true);
    parity_assert_eq!("L:1602f943d7839c6d-1", two_fa_verify_schema(&json!({"code":""})).success, false);
    parity_assert_eq!("L:519d12c30cabf5d1-1", accept_invite_schema(&json!({"token":"t","password":"pw"})).success, true);
    parity_assert_eq!("L:cdd2673af10c7820-1", accept_invite_schema(&json!({"token":"","password":"pw"})).success, false);
    parity_assert_eq!("L:c3c305180002650b-1", change_password_schema(&json!({"currentPassword":"a","newPassword":"b"})).success, true);
    parity_assert_eq!("L:960716756cb6b932-1", change_password_schema(&json!({"currentPassword":"a","newPassword":""})).success, false);
    parity_assert_eq!("L:fed21f173c99bd72-1", two_fa_verify_schema(&json!({"code":"abc"})).success, true);
    let base = json!({"fullName":"Ada","email":"a@b.co","affiliation":"agency"});
    let mut b = base.clone(); b["grants"] = json!([{"roleKey":"user_admin","organizationId":UUID_A}]);
    parity_assert_eq!("L:6b9d9dacbb55f76e-1", invite_user_schema(&b).success, true);
    let mut b = base.clone(); b["grantFullAdmin"] = json!(true);
    parity_assert_eq!("L:807b442542580290-1", invite_user_schema(&b).success, true);
    let mut b = base.clone(); b["roleKeys"] = json!(["user_admin"]);
    parity_assert_eq!("L:eb9c3a0bf743a7e2-1", invite_user_schema(&b).success, true);
    let mut b = base.clone(); b["grantFullAdmin"] = json!(true); b["grants"] = json!([{"roleKey":"user_admin","organizationId":null}]);
    let out = invite_user_schema(&b);
    parity_assert_eq!("L:460f6a5fbe76b5ad-1", out.success, false);
    parity_assert!("L:67aa9b8fda7722fd-1", has_msg(&out, "not both"));
    let mut b = base.clone(); b["roleKeys"] = json!(["user_admin"]); b["grants"] = json!([{"roleKey":"user_admin","organizationId":null}]);
    parity_assert_eq!("L:b75c656c65cfb429-1", invite_user_schema(&b).success, false);
    let mut b = base.clone(); b["roleKeys"] = json!([]); b["grants"] = json!([{"roleKey":"user_admin","organizationId":null}]);
    parity_assert_eq!("L:73122beb3865b42a-1", invite_user_schema(&b).success, true);
    parity_assert_eq!("L:0434ecf427836ebf-1", approve_user_schema(&json!({"affiliation":"vendor"})).success, true);
    parity_assert_eq!("L:4b06c1f28fd5f82e-1", approve_user_schema(&json!({"affiliation":"vendor","grants":[{"roleKey":"user_admin","organizationId":null}]})).success, true);
    parity_assert_eq!("L:c9275e0ee89497c9-1", approve_user_schema(&json!({"affiliation":"vendor","grantFullAdmin":true,"grants":[{"roleKey":"user_admin","organizationId":null}]})).success, false);
    parity_assert_eq!("L:63a599bc98baa5d7-1", approve_user_schema(&json!({"affiliation":"contractor"})).success, false);
    parity_assert_eq!("L:1f20021781929e89-1", approve_user_schema(&json!({})).success, false);
    parity_assert_eq!("L:d9da64e753e9db77-1", approve_user_schema(&json!({"affiliation":"agency","grants":[{"roleKey":"user_admin","organizationId":"not-a-uuid"}]})).success, false);
    parity_assert_eq!("L:220293334a42f488-1", approve_user_schema(&json!({"affiliation":"agency","grants":[{"roleKey":"user_admin","organizationId":null}]})).success, true);
    let mut b = base.clone(); b["organizationIds"] = json!([UUID_A]);
    parity_assert_eq!("L:93ca59ee661be2e9-1", invite_user_schema(&b).success, true);
    let mut b = base.clone(); b["organizationIds"] = json!([]);
    parity_assert_eq!("L:e9f10fae3221f6b0-1", invite_user_schema(&b).success, true);
    let mut b = base.clone(); b["organizationIds"] = json!(["nope"]);
    parity_assert_eq!("L:3f8b34601124ed42-1", invite_user_schema(&b).success, false);
    let mut b = base.clone(); b["organizationIds"] = json!(vec![UUID_A;51]);
    parity_assert_eq!("L:b51ee6cd248de438-1", invite_user_schema(&b).success, false);
    parity_assert_eq!("L:0e8296978d354679-1", update_user_roles_schema(&json!({"roleKeys":["user_admin"]})).success, true);
    parity_assert_eq!("L:a9c5e659de2a8c4d-1", update_user_roles_schema(&json!({"roleKeys":[]})).success, true);
    parity_assert_eq!("L:b214ed71cc5861a8-1", update_user_roles_schema(&json!({"grants":[{"roleKey":"user_admin","organizationId":null}]})).success, true);
    let out = update_user_roles_schema(&json!({"roleKeys":["user_admin"],"grants":[{"roleKey":"user_admin","organizationId":null}]}));
    parity_assert_eq!("L:2b704b6465866182-1", out.success, false);
    parity_assert!("L:033f99b676428a96-1", has_msg(&out, "exactly one"));
    parity_assert_eq!("L:245b00f0ec1b8feb-1", update_user_roles_schema(&json!({})).success, false);
    let valid = json!({"name":"HR Information System","shortCode":"HRIS","primaryOwnerId":"u1","agencyClusterId":"c1"});
    let out = create_system_schema(&valid);
    parity_assert_eq!("L:ec4d2e18a0ebd1a4-1", out.success, true);
    parity_assert_eq!("L:f73066ff1ab57729-1", out.data["vendorClusterIds"], json!([]));
    parity_assert_eq!("L:7aa258dacc2195ef-1", out.data["workflowDefinition"], json!([]));
    parity_assert_eq!("L:4b34d00d3906692f-1", out.data["custodyStageConfigs"], json!([]));
    parity_assert_eq!("L:78cb78a50ae5c47c-1", out.data["participantOrganizationIds"], json!([]));
    for key in ["name","shortCode","primaryOwnerId","agencyClusterId"] {
        let mut b = valid.clone(); b.as_object_mut().unwrap().remove(key);
        parity_assert_eq!("L:44e4ed38661a5710-1", create_system_schema(&b).success, false);
        let mut b = valid.clone(); b[key] = json!("");
        parity_assert_eq!("L:767fb47c583981fc-1", create_system_schema(&b).success, false);
    }
    let mut b = valid.clone(); b["shortCode"] = json!("x".repeat(11)); parity_assert_eq!("L:f82052dd704c064f-1", create_system_schema(&b).success, false);
    let mut b = valid.clone(); b["name"] = json!("x".repeat(101)); parity_assert_eq!("L:7e94ef07aea27668-1", create_system_schema(&b).success, false);
    let mut b = valid.clone(); b["description"] = json!("x".repeat(501)); parity_assert_eq!("L:67f16c0ffe652480-1", create_system_schema(&b).success, false);
    let mut b = valid.clone(); b["awsRoleArnNote"] = json!("x".repeat(501)); parity_assert_eq!("L:e189f229fb97a71d-1", create_system_schema(&b).success, false);
    let mut b = valid.clone(); b["shortCode"] = json!("x".repeat(10)); parity_assert_eq!("L:fd7878b7c62b064f-1", create_system_schema(&b).success, true);
    let mut b = valid.clone(); b["description"] = json!("x".repeat(500)); parity_assert_eq!("L:66488a34764c8c77-1", create_system_schema(&b).success, true);
    let mut b = valid.clone(); b["custodyStageConfigs"] = json!([]); parity_assert_eq!("L:3448ae0b2d96d543-1", create_system_schema(&b).success, true);
    let mut b = valid.clone(); b["custodyStageConfigs"] = all_stages(); parity_assert_eq!("L:f3ad3af39452f5ba-1", create_system_schema(&b).success, true);
    let mut b = valid.clone(); b["custodyStageConfigs"] = json!(all_stages().as_array().unwrap()[..2].to_vec());
    let out = create_system_schema(&b);
    parity_assert_eq!("L:7753374ebd14896c-1", out.success, false);
    parity_assert!("L:ed62dd611fa26233-1", has_msg(&out, "all five agency stages"));
    let bad = |patch: serde_json::Value| { let mut rows = all_stages(); rows[0].as_object_mut().unwrap().extend(patch.as_object().unwrap().clone()); let mut b = valid.clone(); b["custodyStageConfigs"] = rows; create_system_schema(&b).success };
    parity_assert_eq!("L:2a3d8118812a8d53-1", bad(json!({"stage":"not_a_stage"})), false);
    parity_assert_eq!("L:62f6f376059014bb-1", bad(json!({"agencyTeamId":"not-a-uuid"})), false);
    parity_assert_eq!("L:0fb152fcb5ad1734-1", bad(json!({"dueInHours":0})), false);
    parity_assert_eq!("L:911f89e514652b67-1", bad(json!({"dueInHours":8761})), false);
    parity_assert_eq!("L:797fd73b6b38e320-1", bad(json!({"dueInHours":1.5})), false);
    parity_assert_eq!("L:1f496b22c1b0209b-1", bad(json!({"dueInHours":null})), true);
    parity_assert_eq!("L:37fe8c467cad8908-1", bad(json!({"instructions":null})), true);
    parity_assert_eq!("L:4ed4970c62f75e6b-1", bad(json!({"instructions":"x".repeat(1001)})), false);
    parity_assert_eq!("L:043244fbeba6c151-1", update_system_schema(&json!({})).success, true);
    parity_assert_eq!("L:5fb83783af4e041c-1", update_system_schema(&json!({"name":"New name"})).success, true);
    parity_assert_eq!("L:9c26d6823b1c42b0-1", update_system_schema(&json!({"name":"x".repeat(101)})).success, false);
    parity_assert_eq!("L:8c19c0c341c5c22d-1", update_system_schema(&json!({"custodyStageConfigs":[all_stages()[0].clone()]})).success, false);
    parity_assert_eq!("L:8e29ace389aaf076-1", update_system_schema(&json!({"custodyStageConfigs":all_stages()})).success, true);
    let from = "2026-08-24T00:00:00.000Z"; let until = "2026-08-25T00:00:00.000Z";
    parity_assert_eq!("L:83fd1e729a609204-1", add_delegate_schema(&json!({"delegateUserId":"u1"})).success, true);
    parity_assert_eq!("L:9cec7495828143a7-1", add_delegate_schema(&json!({"delegateUserId":"u1","activeFrom":null,"activeUntil":null})).success, true);
    parity_assert_eq!("L:8f0469b60076eb21-1", add_delegate_schema(&json!({"delegateUserId":"u1","activeFrom":from,"activeUntil":until})).success, true);
    parity_assert_eq!("L:be58d0dad3c913d6-1", add_delegate_schema(&json!({"delegateUserId":"u1","activeFrom":from})).success, true);
    parity_assert_eq!("L:7c41abcfbda25d1a-1", add_delegate_schema(&json!({"delegateUserId":"u1","activeUntil":until})).success, true);
    let out = add_delegate_schema(&json!({"delegateUserId":"u1","activeFrom":until,"activeUntil":from}));
    parity_assert_eq!("L:ceb0b1cd1af78c99-1", out.success, false);
    parity_assert!("L:a70a031f618e8484-1", has_msg(&out, "after activeFrom"));
    parity_assert_eq!("L:8359beef67ca00fc-1", add_delegate_schema(&json!({"delegateUserId":"u1","activeFrom":from,"activeUntil":from})).success, false);
    parity_assert_eq!("L:9cf68367eec6a7ad-1", add_delegate_schema(&json!({"delegateUserId":"u1","activeFrom":"24/08/2026"})).success, false);
    parity_assert_eq!("L:876de3d6d09e9cc0-1", add_delegate_schema(&json!({"delegateUserId":""})).success, false);
    parity_assert_eq!("L:e55d53c8cd453ce7-1", add_delegate_schema(&json!({})).success, false);
}
