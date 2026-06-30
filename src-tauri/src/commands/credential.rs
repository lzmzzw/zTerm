// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::{
        credential::{
            AiProviderDraftTestRequest, AiProviderDraftTestResult, AiProviderProfile,
            AiProviderProfileDraft, AiProviderTestResult, CredentialDraft, CredentialRecord,
            CredentialSecret, CredentialTestResult,
        },
        session::DeleteResult,
    },
    state::AppState,
};

#[tauri::command]
pub fn credentials_list(state: State<'_, AppState>) -> AppResult<Vec<CredentialRecord>> {
    state.credential_service().list_credentials()
}

#[tauri::command]
pub fn credentials_save(
    state: State<'_, AppState>,
    draft: CredentialDraft,
) -> AppResult<CredentialRecord> {
    let record = state.credential_service().save_credential(draft)?;
    state
        .ssh_command_service()
        .evict_reusable_connections_for_credential(&record.credential_ref);
    state
        .sftp_service()
        .evict_cached_sessions_for_credential(&record.credential_ref);
    Ok(record)
}

#[tauri::command]
pub fn credentials_read_secret(
    state: State<'_, AppState>,
    credential_ref: String,
) -> AppResult<CredentialSecret> {
    state
        .credential_service()
        .read_secret(&credential_ref)
        .map(|secret| CredentialSecret { secret })
}

#[tauri::command]
pub fn credentials_delete(state: State<'_, AppState>, id: String) -> AppResult<DeleteResult> {
    let credential_ref = state
        .credential_service()
        .list_credentials()?
        .into_iter()
        .find(|record| record.id == id)
        .map(|record| record.credential_ref);
    let result = state.credential_service().delete_credential(&id)?;
    if let Some(credential_ref) = credential_ref {
        state
            .ssh_command_service()
            .evict_reusable_connections_for_credential(&credential_ref);
        state
            .sftp_service()
            .evict_cached_sessions_for_credential(&credential_ref);
    }
    Ok(result)
}

#[tauri::command]
pub fn credentials_test(state: State<'_, AppState>, id: String) -> AppResult<CredentialTestResult> {
    state.credential_service().test_credential(&id)
}

#[tauri::command]
pub fn llm_provider_list(state: State<'_, AppState>) -> AppResult<Vec<AiProviderProfile>> {
    state.credential_service().list_ai_providers()
}

#[tauri::command]
pub fn llm_provider_save(
    state: State<'_, AppState>,
    draft: AiProviderProfileDraft,
) -> AppResult<AiProviderProfile> {
    state.credential_service().save_ai_provider(draft)
}

#[tauri::command]
pub fn llm_provider_delete(state: State<'_, AppState>, id: String) -> AppResult<DeleteResult> {
    state.credential_service().delete_ai_provider(&id)
}

#[tauri::command]
pub fn llm_provider_test(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<AiProviderTestResult> {
    state.credential_service().test_ai_provider(&id)
}

#[tauri::command]
pub fn llm_provider_test_draft(
    state: State<'_, AppState>,
    request: AiProviderDraftTestRequest,
) -> AppResult<AiProviderDraftTestResult> {
    state.credential_service().test_ai_provider_draft(request)
}
