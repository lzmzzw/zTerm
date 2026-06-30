// Author: Liz
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use zterm_lib::{
    error::{AppError, AppResult},
    models::credential::{CredentialDraft, CredentialKind},
    services::credential_service::{CredentialService, SecretStore},
    storage::{credentials::list_credentials, sqlite::SqliteStore},
};

#[derive(Default)]
struct FakeSecretStore {
    values: Mutex<HashMap<String, String>>,
    fail_set: Mutex<Option<String>>,
}

impl FakeSecretStore {
    fn failing(message: &str) -> Self {
        Self {
            values: Mutex::new(HashMap::new()),
            fail_set: Mutex::new(Some(message.to_string())),
        }
    }

    fn remove_secret(&self, credential_ref: &str) {
        self.values
            .lock()
            .expect("fake lock")
            .remove(credential_ref);
    }
}

impl SecretStore for FakeSecretStore {
    fn set_secret(&self, credential_ref: &str, secret: &str) -> AppResult<()> {
        if let Some(message) = self.fail_set.lock().expect("fake lock").clone() {
            return Err(AppError::credential(message));
        }
        self.values
            .lock()
            .expect("fake lock")
            .insert(credential_ref.to_string(), secret.to_string());
        Ok(())
    }

    fn get_secret(&self, credential_ref: &str) -> AppResult<String> {
        self.values
            .lock()
            .expect("fake lock")
            .get(credential_ref)
            .cloned()
            .ok_or_else(|| {
                AppError::not_found(format!("credential secret not found: {credential_ref}"))
            })
    }

    fn delete_secret(&self, credential_ref: &str) -> AppResult<()> {
        self.values
            .lock()
            .expect("fake lock")
            .remove(credential_ref)
            .map(|_| ())
            .ok_or_else(|| {
                AppError::not_found(format!("credential secret not found: {credential_ref}"))
            })
    }
}

#[test]
fn credential_save_returns_error_when_keyring_write_fails() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let secrets = Arc::new(FakeSecretStore::failing(
        "secret backend rejected password=do-not-leak",
    ));
    let service = CredentialService::with_secret_store(Arc::clone(&store), secrets);

    let error = service
        .save_credential(CredentialDraft {
            id: Some("ssh-prod".to_string()),
            name: "生产 SSH 密码".to_string(),
            kind: CredentialKind::SshPassword,
            secret: "do-not-leak".to_string(),
        })
        .expect_err("keyring write failure should reject the save");

    assert!(matches!(error, AppError::Credential(message) if !message.contains("do-not-leak")));
    assert!(list_credentials(store.as_ref())
        .expect("credentials should list")
        .is_empty());
}

#[test]
fn credential_read_missing_does_not_return_empty_secret() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(FakeSecretStore::default()),
    );

    let error = service
        .read_secret("missing-ref")
        .expect_err("missing keyring secret should be an error");

    assert!(matches!(error, AppError::NotFound(message) if message.contains("missing-ref")));
}

#[test]
fn credential_metadata_never_persists_plain_secret() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let secret = "phase8-plain-secret";
    let service = CredentialService::with_secret_store(
        Arc::clone(&store),
        Arc::new(FakeSecretStore::default()),
    );

    let record = service
        .save_credential(CredentialDraft {
            id: Some("ssh-prod".to_string()),
            name: "生产 SSH 密码".to_string(),
            kind: CredentialKind::SshPassword,
            secret: secret.to_string(),
        })
        .expect("credential should save");

    assert_ne!(record.credential_ref, secret);
    assert_eq!(
        service
            .read_secret(&record.credential_ref)
            .expect("secret should be readable from fake keyring"),
        secret
    );
    assert_eq!(credential_plaintext_hits(store.as_ref(), secret), 0);
}

#[test]
fn credential_update_failure_restores_existing_secret() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let secrets = Arc::new(FakeSecretStore::default());
    let service = CredentialService::with_secret_store(Arc::clone(&store), secrets);
    let record = service
        .save_credential(CredentialDraft {
            id: Some("ssh-prod".to_string()),
            name: "生产 SSH 密码".to_string(),
            kind: CredentialKind::SshPassword,
            secret: "old-secret".to_string(),
        })
        .expect("initial credential should save");

    store
        .with_connection(|connection| {
            connection.execute_batch(
                "
                create trigger fail_credential_update
                before update on credential_records
                begin
                  select raise(fail, 'metadata update failed');
                end;
                ",
            )?;
            Ok(())
        })
        .expect("failure trigger should install");

    let error = service
        .save_credential(CredentialDraft {
            id: Some("ssh-prod".to_string()),
            name: "生产 SSH 密码 2".to_string(),
            kind: CredentialKind::SshPassword,
            secret: "new-secret".to_string(),
        })
        .expect_err("metadata failure should reject update");

    assert!(matches!(error, AppError::Storage(_)));
    assert_eq!(
        service
            .read_secret(&record.credential_ref)
            .expect("old secret should remain readable"),
        "old-secret"
    );
}

#[test]
fn credential_delete_removes_metadata_when_secret_is_already_missing() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let secrets = Arc::new(FakeSecretStore::default());
    let secret_store: Arc<dyn SecretStore> = secrets.clone();
    let service = CredentialService::with_secret_store(Arc::clone(&store), secret_store);
    let record = service
        .save_credential(CredentialDraft {
            id: Some("ssh-prod".to_string()),
            name: "生产 SSH 密码".to_string(),
            kind: CredentialKind::SshPassword,
            secret: "old-secret".to_string(),
        })
        .expect("credential should save");
    secrets.remove_secret(&record.credential_ref);

    service
        .delete_credential(&record.id)
        .expect("missing secret should not block metadata cleanup");

    assert!(list_credentials(store.as_ref())
        .expect("credentials should list")
        .is_empty());
}

fn credential_plaintext_hits(store: &SqliteStore, secret: &str) -> i64 {
    store
        .with_connection(|connection| {
            let hits = connection.query_row(
                "
                select
                  (select count(*) from credential_records
                   where id = ?1 or name = ?1 or kind = ?1 or credential_ref = ?1)
                  +
                  (select count(*) from ai_provider_profiles
                   where id = ?1 or name = ?1 or base_url = ?1 or model = ?1 or api_key_ref = ?1)
                ",
                [secret],
                |row| row.get::<_, i64>(0),
            )?;
            Ok(hits)
        })
        .expect("plaintext scan should run")
}
