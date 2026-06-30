// Author: Liz
use zterm_lib::{
    error::AppError,
    security::redaction::{redact_error, redact_sensitive},
};

#[test]
fn redacts_password_api_key_and_private_key_fragments() {
    let password = "Phase8Password!";
    let api_key = "sk-phase8-secret-token";
    let private_key = "-----BEGIN OPENSSH PRIVATE KEY-----abc123-----END OPENSSH PRIVATE KEY-----";
    let input = format!("password={password}; Authorization: Bearer {api_key}; key={private_key}");

    let redacted = redact_sensitive(&input);

    assert!(!redacted.contains(password));
    assert!(!redacted.contains(api_key));
    assert!(!redacted.contains("abc123"));
    assert!(redacted.contains("<redacted-secret>"));
}

#[test]
fn credential_errors_are_redacted_before_logging() {
    let secret = "Phase8Password!";
    let error = AppError::credential(format!("keyring failed for password={secret}"));

    let redacted = redact_error(&error);

    assert!(!redacted.contains(secret));
    assert!(redacted.contains("credential error"));
    assert!(redacted.contains("<redacted-secret>"));
}

#[test]
fn redacts_bearer_tokens_without_fixed_provider_prefix() {
    let bearer = "eyJhbGciOiJIUzI1NiJ9.phase9-token.signature";
    let input = format!("Authorization: Bearer {bearer}");

    let redacted = redact_sensitive(&input);

    assert!(!redacted.contains(bearer));
    assert!(redacted.contains("Bearer <redacted-secret>"));
}
