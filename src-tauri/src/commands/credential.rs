// Author: Liz
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::{
    error::AppResult,
    models::{
        credential::{
            AiProviderDraftTestCancelResult, AiProviderDraftTestCancelledEvent,
            AiProviderDraftTestChunkEvent, AiProviderDraftTestDoneEvent,
            AiProviderDraftTestErrorEvent, AiProviderDraftTestRequest, AiProviderDraftTestResult,
            AiProviderDraftTestStreamStartResult, AiProviderProfile, AiProviderProfileDraft,
            AiProviderTestResult, CredentialDraft, CredentialRecord, CredentialSecret,
            CredentialTestResult,
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

#[tauri::command]
pub fn llm_provider_test_draft_stream(
    app: AppHandle,
    state: State<'_, AppState>,
    request: AiProviderDraftTestRequest,
) -> AppResult<AiProviderDraftTestStreamStartResult> {
    let (profile, secret, prompt) = state
        .credential_service()
        .prepare_ai_provider_draft_test(&request)?;
    let test_id = Uuid::new_v4().to_string();
    let stream_service = state.llm_provider_test_stream_service();
    let cancel = stream_service.register(&test_id)?;
    let app_for_task = app.clone();
    let stream_service_for_task = stream_service.clone();
    let test_id_for_task = test_id.clone();
    tauri::async_runtime::spawn(async move {
        let emit_test_id = test_id_for_task.clone();
        let result = crate::services::llm_provider_service::generate_text_stream(
            &profile,
            &secret,
            &prompt,
            cancel,
            move |delta| {
                let _ = app_for_task.emit(
                    "llm-provider-test:chunk",
                    AiProviderDraftTestChunkEvent {
                        test_id: emit_test_id.clone(),
                        delta,
                    },
                );
                Ok(())
            },
        )
        .await;
        match result {
            Ok(crate::services::llm_provider_service::ProviderTextStreamResult::Complete(
                output,
            )) => {
                let _ = app.emit(
                    "llm-provider-test:done",
                    AiProviderDraftTestDoneEvent {
                        test_id: test_id_for_task.clone(),
                        message: format!("模型测试通过：{}", profile.kind.as_str()),
                        output,
                    },
                );
            }
            Ok(crate::services::llm_provider_service::ProviderTextStreamResult::Cancelled(_)) => {
                let _ = app.emit(
                    "llm-provider-test:cancelled",
                    AiProviderDraftTestCancelledEvent {
                        test_id: test_id_for_task.clone(),
                    },
                );
            }
            Err(error) => {
                let _ = app.emit(
                    "llm-provider-test:error",
                    AiProviderDraftTestErrorEvent {
                        test_id: test_id_for_task.clone(),
                        message: app_error_message(error),
                    },
                );
            }
        }
        stream_service_for_task.finish(&test_id_for_task);
    });
    Ok(AiProviderDraftTestStreamStartResult { test_id })
}

#[tauri::command]
pub fn llm_provider_test_draft_cancel(
    state: State<'_, AppState>,
    test_id: String,
) -> AppResult<AiProviderDraftTestCancelResult> {
    let cancelled = state.llm_provider_test_stream_service().cancel(&test_id)?;
    Ok(AiProviderDraftTestCancelResult { cancelled })
}

fn app_error_message(error: crate::error::AppError) -> String {
    match error {
        crate::error::AppError::Validation(message)
        | crate::error::AppError::NotFound(message)
        | crate::error::AppError::Storage(message)
        | crate::error::AppError::Credential(message)
        | crate::error::AppError::Terminal(message)
        | crate::error::AppError::Ssh(message)
        | crate::error::AppError::Sftp(message)
        | crate::error::AppError::Ftp(message)
        | crate::error::AppError::Ai(message)
        | crate::error::AppError::Unsupported(message) => message,
    }
}
