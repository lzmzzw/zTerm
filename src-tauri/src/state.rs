// Author: Liz
use std::sync::Arc;

use crate::{
    services::{
        ai_chat_service::AiChatService,
        ai_chat_stream_service::AiChatStreamService,
        ai_conversation_service::AiConversationService,
        ai_tool_service::{AiToolService, RuntimeAiToolWriter},
        command_completion_service::CommandCompletionService,
        command_history_service::CommandHistoryService,
        credential_service::CredentialService,
        llm_provider_test_stream_service::LlmProviderTestStreamService,
        server_info_service::ServerInfoService,
        sftp_service::SftpService,
        ssh_command_service::SshCommandService,
        terminal_manager::TerminalManager,
        transfer_queue::TransferQueue,
    },
    storage::sqlite::SqliteStore,
};

#[derive(Clone)]
pub struct AppState {
    storage: Arc<SqliteStore>,
    terminal_manager: Arc<TerminalManager>,
    command_completion_service: CommandCompletionService,
    command_history_service: Arc<CommandHistoryService>,
    credential_service: CredentialService,
    llm_provider_test_stream_service: LlmProviderTestStreamService,
    ai_chat_stream_service: AiChatStreamService,
    ai_chat_service: AiChatService,
    ai_conversation_service: AiConversationService,
    ai_tool_service: AiToolService,
    server_info_service: ServerInfoService,
    ssh_command_service: SshCommandService,
    sftp_service: SftpService,
    transfer_queue: TransferQueue,
}

impl AppState {
    pub fn new(storage: SqliteStore) -> Self {
        let storage = Arc::new(storage);
        let terminal_manager = Arc::new(TerminalManager::default());
        let command_history_service = Arc::new(CommandHistoryService::new(Arc::clone(&storage)));
        let credential_service = CredentialService::new(Arc::clone(&storage));
        let ai_tool_writer = Arc::new(RuntimeAiToolWriter::new(
            Arc::clone(&terminal_manager),
            Arc::clone(&command_history_service),
        ));
        Self {
            command_completion_service: CommandCompletionService::new(),
            command_history_service,
            llm_provider_test_stream_service: LlmProviderTestStreamService::default(),
            ai_chat_stream_service: AiChatStreamService::default(),
            ai_chat_service: AiChatService,
            ai_conversation_service: AiConversationService,
            ai_tool_service: AiToolService::with_writer(ai_tool_writer),
            credential_service,
            server_info_service: ServerInfoService::new(),
            ssh_command_service: SshCommandService::new(),
            sftp_service: SftpService::new(),
            transfer_queue: TransferQueue::from_storage(Arc::clone(&storage)),
            storage,
            terminal_manager,
        }
    }

    pub fn storage(&self) -> Arc<SqliteStore> {
        Arc::clone(&self.storage)
    }

    pub fn terminal_manager(&self) -> Arc<TerminalManager> {
        Arc::clone(&self.terminal_manager)
    }

    pub fn command_history_service(&self) -> Arc<CommandHistoryService> {
        Arc::clone(&self.command_history_service)
    }

    pub fn command_completion_service(&self) -> CommandCompletionService {
        self.command_completion_service.clone()
    }

    pub fn credential_service(&self) -> CredentialService {
        self.credential_service.clone()
    }

    pub fn llm_provider_test_stream_service(&self) -> LlmProviderTestStreamService {
        self.llm_provider_test_stream_service.clone()
    }

    pub fn ai_chat_stream_service(&self) -> AiChatStreamService {
        self.ai_chat_stream_service.clone()
    }

    pub fn ai_chat_service(&self) -> AiChatService {
        self.ai_chat_service.clone()
    }

    pub fn ai_conversation_service(&self) -> AiConversationService {
        self.ai_conversation_service.clone()
    }

    pub fn ai_tool_service(&self) -> AiToolService {
        self.ai_tool_service.clone()
    }

    pub fn server_info_service(&self) -> ServerInfoService {
        self.server_info_service.clone()
    }

    pub fn ssh_command_service(&self) -> SshCommandService {
        self.ssh_command_service.clone()
    }

    pub fn sftp_service(&self) -> SftpService {
        self.sftp_service.clone()
    }

    pub fn transfer_queue(&self) -> TransferQueue {
        self.transfer_queue.clone()
    }
}
