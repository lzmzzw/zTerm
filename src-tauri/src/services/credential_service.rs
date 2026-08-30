// Author: Liz
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        credential::{CredentialDraft, CredentialRecord, CredentialTestResult},
        session::DeleteResult,
    },
    storage::{
        credentials::{
            delete_credential_record, get_credential_record, list_credentials,
            upsert_credential_record,
        },
        sqlite::SqliteStore,
    },
    validation::required_text,
};

pub const KEYRING_SERVICE: &str = "zTerm";

pub trait SecretStore: Send + Sync {
    fn set_secret(&self, credential_ref: &str, secret: &str) -> AppResult<()>;
    fn get_secret(&self, credential_ref: &str) -> AppResult<String>;
    fn delete_secret(&self, credential_ref: &str) -> AppResult<()>;
}

#[derive(Clone)]
pub struct CredentialService {
    storage: Arc<SqliteStore>,
    secret_store: Arc<dyn SecretStore>,
}

impl CredentialService {
    pub fn new(storage: Arc<SqliteStore>) -> Self {
        Self::with_secret_store(storage, Arc::new(SystemSecretStore))
    }

    pub fn with_secret_store(
        storage: Arc<SqliteStore>,
        secret_store: Arc<dyn SecretStore>,
    ) -> Self {
        Self {
            storage,
            secret_store,
        }
    }

    pub fn list_credentials(&self) -> AppResult<Vec<CredentialRecord>> {
        list_credentials(self.storage.as_ref())
    }

    pub fn save_credential(&self, draft: CredentialDraft) -> AppResult<CredentialRecord> {
        let id = normalized_id(draft.id).unwrap_or_else(|| Uuid::new_v4().to_string());
        let name = required_text("凭据名称", draft.name)?;
        let secret = required_text("敏感值", draft.secret)?;
        let credential_ref = credential_ref_for_id(&id);
        let previous_secret = match get_credential_record(self.storage.as_ref(), &id) {
            Ok(record) if record.credential_ref == credential_ref => {
                match self.secret_store.get_secret(&record.credential_ref) {
                    Ok(secret) => Some(secret),
                    Err(AppError::NotFound(_)) => None,
                    Err(error) => return Err(error),
                }
            }
            Ok(_) | Err(AppError::NotFound(_)) => None,
            Err(error) => return Err(error),
        };

        self.secret_store.set_secret(&credential_ref, &secret)?;
        let record = upsert_credential_record(
            self.storage.as_ref(),
            &id,
            &name,
            draft.kind,
            &credential_ref,
        );
        if record.is_err() {
            if let Some(previous_secret) = previous_secret {
                let _ = self
                    .secret_store
                    .set_secret(&credential_ref, &previous_secret);
            } else {
                let _ = self.secret_store.delete_secret(&credential_ref);
            }
        }
        record
    }

    pub fn read_secret(&self, credential_ref: &str) -> AppResult<String> {
        let credential_ref = required_text("凭据引用", credential_ref)?;
        self.secret_store.get_secret(&credential_ref)
    }

    pub fn delete_credential(&self, id: &str) -> AppResult<DeleteResult> {
        let record = get_credential_record(self.storage.as_ref(), id)?;
        match self.secret_store.delete_secret(&record.credential_ref) {
            Ok(()) | Err(AppError::NotFound(_)) => {}
            Err(error) => return Err(error),
        }
        delete_credential_record(self.storage.as_ref(), id)
    }

    pub fn test_credential(&self, id: &str) -> AppResult<CredentialTestResult> {
        let record = get_credential_record(self.storage.as_ref(), id)?;
        let secret = self.read_secret(&record.credential_ref)?;
        if secret.trim().is_empty() {
            return Err(AppError::credential("凭据内容为空"));
        }
        Ok(CredentialTestResult {
            ok: true,
            message: "凭据可从系统钥匙串读取".to_string(),
        })
    }
}

#[derive(Default)]
pub struct MemorySecretStore {
    values: Mutex<HashMap<String, String>>,
}

impl SecretStore for MemorySecretStore {
    fn set_secret(&self, credential_ref: &str, secret: &str) -> AppResult<()> {
        self.values
            .lock()
            .map_err(|_| AppError::credential("memory secret store lock was poisoned"))?
            .insert(credential_ref.to_string(), secret.to_string());
        Ok(())
    }

    fn get_secret(&self, credential_ref: &str) -> AppResult<String> {
        self.values
            .lock()
            .map_err(|_| AppError::credential("memory secret store lock was poisoned"))?
            .get(credential_ref)
            .cloned()
            .ok_or_else(|| {
                AppError::not_found(format!("credential secret not found: {credential_ref}"))
            })
    }

    fn delete_secret(&self, credential_ref: &str) -> AppResult<()> {
        self.values
            .lock()
            .map_err(|_| AppError::credential("memory secret store lock was poisoned"))?
            .remove(credential_ref);
        Ok(())
    }
}

pub struct SystemSecretStore;

impl SecretStore for SystemSecretStore {
    fn set_secret(&self, credential_ref: &str, secret: &str) -> AppResult<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, credential_ref).map_err(|error| {
            AppError::credential(format!("failed to open keyring entry: {error}"))
        })?;
        entry.set_password(secret).map_err(|error| {
            AppError::credential(format!("failed to write keyring entry: {error}"))
        })
    }

    fn get_secret(&self, credential_ref: &str) -> AppResult<String> {
        read_system_secret(credential_ref)
    }

    fn delete_secret(&self, credential_ref: &str) -> AppResult<()> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, credential_ref).map_err(|error| {
            AppError::credential(format!("failed to open keyring entry: {error}"))
        })?;
        entry.delete_credential().map_err(system_keyring_error)
    }
}

pub fn read_system_secret(credential_ref: &str) -> AppResult<String> {
    let credential_ref = required_text("凭据引用", credential_ref)?;
    let entry = keyring::Entry::new(KEYRING_SERVICE, &credential_ref)
        .map_err(|error| AppError::credential(format!("failed to open keyring entry: {error}")))?;
    entry.get_password().map_err(system_keyring_error)
}

fn system_keyring_error(error: keyring::Error) -> AppError {
    match error {
        keyring::Error::NoEntry => AppError::not_found("credential secret not found"),
        error => AppError::credential(format!("keyring operation failed: {error}")),
    }
}

fn credential_ref_for_id(id: &str) -> String {
    format!("credential:{id}")
}

fn normalized_id(id: Option<String>) -> Option<String> {
    id.and_then(|value| {
        let value = value.trim().to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    })
}
