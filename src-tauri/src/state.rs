// Author: Liz
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

use tauri::AppHandle;

use crate::{
    services::{
        agent_codex_registry::AgentCodexRegistry,
        ai_tool_service::{AiToolService, RuntimeAiToolWriter},
        command_completion_service::CommandCompletionService,
        command_history_service::CommandHistoryService,
        credential_service::CredentialService,
        external_launch_service::ExternalLaunchService,
        mcp_service::McpService,
        server_info_service::ServerInfoService,
        sftp_service::SftpService,
        ssh_command_service::SshCommandService,
        terminal_manager::TerminalManager,
        terminal_output_dispatcher::TerminalOutputDispatcher,
        transfer_queue::TransferQueue,
    },
    storage::sqlite::SqliteStore,
};

#[derive(Clone)]
pub struct AppState {
    pub(crate) agent_codex_registry: Arc<AgentCodexRegistry>,
    storage: Arc<SqliteStore>,
    terminal_manager: Arc<TerminalManager>,
    terminal_output_dispatcher: TerminalOutputDispatcher,
    command_completion_service: CommandCompletionService,
    command_history_service: Arc<CommandHistoryService>,
    credential_service: CredentialService,
    external_launch_service: ExternalLaunchService,
    ai_tool_service: AiToolService,
    mcp_service: Arc<McpService>,
    server_info_service: ServerInfoService,
    ssh_command_service: SshCommandService,
    sftp_service: SftpService,
    transfer_queue: TransferQueue,
    shutting_down: Arc<AtomicBool>,
}

impl AppState {
    pub fn new(storage: SqliteStore) -> Self {
        Self::new_inner(storage, None)
    }

    pub fn new_with_app_handle(storage: SqliteStore, app_handle: AppHandle) -> Self {
        Self::new_inner(storage, Some(app_handle))
    }

    fn new_inner(storage: SqliteStore, app_handle: Option<AppHandle>) -> Self {
        let storage = Arc::new(storage);
        let terminal_manager = Arc::new(TerminalManager::default());
        let terminal_output_dispatcher = TerminalOutputDispatcher::new(app_handle.clone());
        let command_history_service = Arc::new(CommandHistoryService::new(Arc::clone(&storage)));
        let credential_service = CredentialService::new(Arc::clone(&storage));
        let external_launch_service = ExternalLaunchService::default();
        let ai_tool_writer = Arc::new(match app_handle {
            Some(app_handle) => RuntimeAiToolWriter::with_app_handle(
                Arc::clone(&terminal_manager),
                Arc::clone(&command_history_service),
                app_handle,
            ),
            None => RuntimeAiToolWriter::new(
                Arc::clone(&terminal_manager),
                Arc::clone(&command_history_service),
            ),
        });
        let transfer_queue = TransferQueue::from_storage(Arc::clone(&storage));
        let sftp_service = SftpService::new();
        let server_info_service = ServerInfoService::new();
        let ssh_command_service = SshCommandService::new();
        Self {
            agent_codex_registry: Arc::new(AgentCodexRegistry::default()),
            command_completion_service: CommandCompletionService::new(),
            command_history_service,
            external_launch_service,
            ai_tool_service: AiToolService::with_runtime_services(
                ai_tool_writer,
                credential_service.clone(),
                transfer_queue.clone(),
                sftp_service.clone(),
                server_info_service.clone(),
                ssh_command_service.clone(),
            ),
            mcp_service: Arc::new(McpService::default()),
            credential_service,
            server_info_service,
            ssh_command_service,
            sftp_service,
            transfer_queue,
            shutting_down: Arc::new(AtomicBool::new(false)),
            storage,
            terminal_manager,
            terminal_output_dispatcher,
        }
    }

    pub fn storage(&self) -> Arc<SqliteStore> {
        Arc::clone(&self.storage)
    }

    pub fn terminal_manager(&self) -> Arc<TerminalManager> {
        Arc::clone(&self.terminal_manager)
    }

    pub fn terminal_output_dispatcher(&self) -> TerminalOutputDispatcher {
        self.terminal_output_dispatcher.clone()
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

    pub fn external_launch_service(&self) -> ExternalLaunchService {
        self.external_launch_service.clone()
    }

    pub fn ai_tool_service(&self) -> AiToolService {
        self.ai_tool_service.clone()
    }

    pub fn mcp_service(&self) -> Arc<McpService> {
        Arc::clone(&self.mcp_service)
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

    pub async fn shutdown(&self) -> crate::error::AppResult<()> {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return Ok(());
        }
        let mut failures = Vec::new();
        if let Err(error) = self.transfer_queue.cancel_all_controls() {
            failures.push(error.to_string());
        }
        if let Err(error) = self.terminal_manager.close_all() {
            failures.push(error.to_string());
        }
        if let Err(error) = self.mcp_service.stop_and_wait().await {
            failures.push(error.to_string());
        }
        if let Err(error) = crate::commands::agent::cleanup_stale_agent_session_directories() {
            failures.push(error.to_string());
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(crate::error::AppError::terminal(format!(
                "应用退出清理部分失败: {}",
                failures.join("；")
            )))
        }
    }
}
