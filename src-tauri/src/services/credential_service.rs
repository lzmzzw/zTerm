// Author: Liz
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        credential::{
            AiProviderDraftTestRequest, AiProviderDraftTestResult, AiProviderKind,
            AiProviderProfile, AiProviderProfileDraft, AiProviderTestResult, CredentialDraft,
            CredentialKind, CredentialRecord, CredentialTestResult,
        },
        session::DeleteResult,
    },
    storage::{
        ai::{
            delete_ai_provider_profile, get_ai_provider_profile, list_ai_provider_profiles,
            upsert_ai_provider_profile,
        },
        credentials::{
            delete_credential_record, get_credential_record, list_credentials,
            upsert_credential_record,
        },
        sqlite::SqliteStore,
    },
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

    pub fn list_ai_providers(&self) -> AppResult<Vec<AiProviderProfile>> {
        list_ai_provider_profiles(self.storage.as_ref())
    }

    pub fn save_ai_provider(&self, draft: AiProviderProfileDraft) -> AppResult<AiProviderProfile> {
        let id = normalized_id(draft.id).unwrap_or_else(|| Uuid::new_v4().to_string());
        let name = required_text("Provider 名称", draft.name)?;
        let base_url = required_text("Base URL", draft.base_url)?;
        let model = required_text("模型", draft.model)?;
        let api_key_ref = match draft.api_key {
            Some(secret) if !secret.trim().is_empty() => {
                let credential_id = draft
                    .api_key_ref
                    .as_deref()
                    .and_then(credential_id_from_ref)
                    .unwrap_or_else(|| format!("ai-provider-{id}-api-key"));
                let record = self.save_credential(CredentialDraft {
                    id: Some(credential_id),
                    name: format!("{name} API Key"),
                    kind: CredentialKind::AiApiKey,
                    secret,
                })?;
                record.credential_ref
            }
            _ => {
                let existing_ref = draft.api_key_ref.or_else(|| {
                    get_ai_provider_profile(self.storage.as_ref(), &id)
                        .ok()
                        .map(|profile| profile.api_key_ref)
                });
                match existing_ref {
                    Some(value) if !value.trim().is_empty() => value,
                    _ if allows_empty_api_key(draft.kind) => String::new(),
                    _ => {
                        return Err(AppError::validation("AI Provider API Key 不能为空"));
                    }
                }
            }
        };

        upsert_ai_provider_profile(
            self.storage.as_ref(),
            &id,
            &name,
            draft.kind,
            &base_url,
            &model,
            &api_key_ref,
            draft.enabled,
            draft.is_default,
        )
    }

    pub fn delete_ai_provider(&self, id: &str) -> AppResult<DeleteResult> {
        let profile = get_ai_provider_profile(self.storage.as_ref(), id)?;
        if let Some(credential_id) = credential_id_from_ref(&profile.api_key_ref) {
            match self.delete_credential(&credential_id) {
                Ok(_) | Err(AppError::NotFound(_)) => {}
                Err(error) => return Err(error),
            }
        }
        delete_ai_provider_profile(self.storage.as_ref(), id)
    }

    pub fn test_ai_provider(&self, id: &str) -> AppResult<AiProviderTestResult> {
        let profile = get_ai_provider_profile(self.storage.as_ref(), id)?;
        let secret = if profile.api_key_ref.trim().is_empty() {
            if allows_empty_api_key(profile.kind) {
                String::new()
            } else {
                return Err(AppError::credential("AI Provider API Key 为空"));
            }
        } else {
            self.read_secret(&profile.api_key_ref)?
        };
        if secret.trim().is_empty() && !allows_empty_api_key(profile.kind) {
            return Err(AppError::credential("AI Provider API Key 为空"));
        };
        crate::services::llm_provider_service::test_provider_sync(&profile, &secret)
    }

    pub fn test_ai_provider_draft(
        &self,
        request: AiProviderDraftTestRequest,
    ) -> AppResult<AiProviderDraftTestResult> {
        let (profile, secret, prompt) = self.prepare_ai_provider_draft_test(&request)?;
        crate::services::llm_provider_service::test_provider_draft_sync(&profile, &secret, &prompt)
    }

    pub fn prepare_ai_provider_draft_test(
        &self,
        request: &AiProviderDraftTestRequest,
    ) -> AppResult<(AiProviderProfile, String, String)> {
        let prompt = required_text("测试输入", &request.prompt)?;
        let profile = profile_from_draft_for_test(&request.draft)?;
        let secret = match request.draft.api_key.as_deref() {
            Some(secret) if !secret.trim().is_empty() => secret.trim().to_string(),
            _ => match request.draft.api_key_ref.as_deref() {
                Some(api_key_ref) if !api_key_ref.trim().is_empty() => {
                    self.read_secret(api_key_ref)?
                }
                _ if allows_empty_api_key(request.draft.kind) => String::new(),
                _ => return Err(AppError::credential("AI Provider API Key 为空")),
            },
        };
        Ok((profile, secret, prompt))
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

fn credential_id_from_ref(credential_ref: &str) -> Option<String> {
    credential_ref
        .strip_prefix("credential:")
        .map(ToOwned::to_owned)
        .filter(|value| !value.trim().is_empty())
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

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn profile_from_draft_for_test(draft: &AiProviderProfileDraft) -> AppResult<AiProviderProfile> {
    Ok(AiProviderProfile {
        id: normalized_id(draft.id.clone()).unwrap_or_else(|| "draft-provider".to_string()),
        name: required_text("Provider 名称", &draft.name)?,
        kind: draft.kind,
        base_url: required_text("Base URL", &draft.base_url)?,
        model: required_text("模型", &draft.model)?,
        api_key_ref: draft.api_key_ref.clone().unwrap_or_default(),
        enabled: draft.enabled,
        is_default: draft.is_default,
        created_at_ms: 0,
        updated_at_ms: 0,
    })
}

pub fn allows_empty_api_key(kind: AiProviderKind) -> bool {
    matches!(
        kind,
        AiProviderKind::OpenAiChat | AiProviderKind::OpenAiResponses
    )
}
