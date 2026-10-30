//! Base identity strategy for STS AssumeRole. Never use this base identity
//! directly for tenant S3 access: the S3 client must receive STS credentials.
use aws_sdk_sts::config::SharedCredentialsProvider;

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum CredentialStrategy { Ambient, Static, X509 }

pub fn parse_strategy(raw: Option<&str>) -> Result<CredentialStrategy, String> {
    match raw.unwrap_or("ambient") {
        "ambient" => Ok(CredentialStrategy::Ambient),
        "static" => Ok(CredentialStrategy::Static),
        "x509" => Ok(CredentialStrategy::X509),
        other => Err(format!("Unknown AWS_CREDENTIAL_STRATEGY \"{other}\" — expected static, ambient, or x509.")),
    }
}

pub fn configured_strategy() -> Result<CredentialStrategy, String> {
    parse_strategy(std::env::var("AWS_CREDENTIAL_STRATEGY").ok().as_deref())
}

/// Return a *lazy* provider. Missing static env keys fail when the provider is
/// used to sign an AWS request, not when it is selected; ambient uses the SDK's
/// actual default chain. X509 is deliberately unsupported (no signing helper).
pub async fn resolve_base_credentials(strategy: CredentialStrategy) -> Result<SharedCredentialsProvider, String> {
    match strategy {
        CredentialStrategy::Static => Ok(SharedCredentialsProvider::new(
            aws_config::environment::credentials::EnvironmentVariableCredentialsProvider::new(),
        )),
        CredentialStrategy::Ambient => Ok(SharedCredentialsProvider::new(
            aws_config::default_provider::credentials::default_provider().await,
        )),
        CredentialStrategy::X509 => Err("AWS_CREDENTIAL_STRATEGY=x509 is not yet implemented — requires aws_signing_helper and a credential_process policy.".into()),
    }
}
