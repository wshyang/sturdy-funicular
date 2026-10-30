//! AWS AssumeRole naming convention shared with SSM discovery (addendum-038).
/// The CloudFormation AssumeRoleTest resource prepends `ffs-test-` but the
/// SSM namespace uses the unprefixed base name.
pub fn derive_role_base_name(role_arn: &str) -> &str {
    let role_name = role_arn.rsplit('/').next().unwrap_or(role_arn);
    role_name.strip_prefix("ffs-test-").unwrap_or(role_name)
}

pub fn tenant_public_key_param_path(base_name: &str) -> String {
    format!("/ffs-test/{base_name}/tenant-public-key-b64")
}
