// Author: Liz
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::ai::{
        AiApprovalMode, AiConversation, AiConversationApprovalModeUpdateRequest,
        AiConversationCreateRequest, AiConversationListRequest, AiConversationMessage,
        AiConversationMessageAppendRequest, AiConversationSummary,
    },
    security::redaction::redact_sensitive,
    storage::{
        ai::{
            delete_ai_conversation, get_ai_conversation, insert_ai_conversation,
            insert_ai_conversation_message, list_ai_conversations,
            update_ai_conversation_approval_mode,
        },
        sqlite::SqliteStore,
    },
};

#[derive(Debug, Default, Clone)]
pub struct AiConversationService;

impl AiConversationService {
    pub fn create(
        &self,
        store: &SqliteStore,
        request: AiConversationCreateRequest,
    ) -> AppResult<AiConversation> {
        let scope_kind = required_text("AI 会话 scope", request.scope_kind)?;
        let scope_ref_json = request
            .scope_ref_json
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "{}".to_string());
        let title = request
            .title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| default_title(&scope_kind));
        insert_ai_conversation(
            store,
            &Uuid::new_v4().to_string(),
            &title,
            &scope_kind,
            &scope_ref_json,
            request.approval_mode.unwrap_or(AiApprovalMode::Safe),
        )
    }

    pub fn list(
        &self,
        store: &SqliteStore,
        query: Option<String>,
        limit: Option<usize>,
    ) -> AppResult<Vec<AiConversationSummary>> {
        list_ai_conversations(store, query.as_deref(), limit.unwrap_or(50))
    }

    pub fn list_with_request(
        &self,
        store: &SqliteStore,
        request: AiConversationListRequest,
    ) -> AppResult<Vec<AiConversationSummary>> {
        self.list(store, request.query, request.limit)
    }

    pub fn get(&self, store: &SqliteStore, conversation_id: &str) -> AppResult<AiConversation> {
        get_ai_conversation(store, conversation_id)
    }

    pub fn delete(&self, store: &SqliteStore, conversation_id: &str) -> AppResult<bool> {
        delete_ai_conversation(store, conversation_id).map(|result| result.deleted)
    }

    pub fn update_approval_mode(
        &self,
        store: &SqliteStore,
        request: AiConversationApprovalModeUpdateRequest,
    ) -> AppResult<AiConversation> {
        update_ai_conversation_approval_mode(store, &request.conversation_id, request.approval_mode)
    }

    pub fn append_message(
        &self,
        store: &SqliteStore,
        request: AiConversationMessageAppendRequest,
    ) -> AppResult<AiConversationMessage> {
        let content = redact_sensitive(&request.content);
        insert_ai_conversation_message(
            store,
            &Uuid::new_v4().to_string(),
            &request.conversation_id,
            request.role,
            &content,
            request.metadata_json.as_deref(),
        )
    }
}

fn default_title(scope_kind: &str) -> String {
    match scope_kind {
        "follow_focus" => "跟随当前终端".to_string(),
        "locked_pane" => "终端 Pane 会话".to_string(),
        "no_context" => "普通 AI 会话".to_string(),
        _ => "AI 会话".to_string(),
    }
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}
