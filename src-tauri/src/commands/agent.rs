// Author: Liz
use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, State};
use tokio::process::Command;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        ai::AiApprovalMode,
        terminal::{RuntimeSessionInfo, RuntimeSessionKind},
    },
    paths::AppPaths,
    services::mcp_service::AgentMcpBinding,
    services::terminal_manager::AgentCodexPtyOptions,
    state::AppState,
    storage::{ai::get_ai_connection_approval_mode, settings::get_app_settings},
};

use super::terminal::spawn_terminal_reader;

const AGENT_MCP_TOKEN_ENV: &str = "ZTERM_AGENT_MCP_TOKEN";

#[derive(Debug, Serialize)]
pub struct AgentCodexSession {
    pub agent_session_id: String,
    pub target_runtime_session_id: String,
    pub target_saved_session_id: Option<String>,
    pub target_label: String,
    pub approval_mode: AiApprovalMode,
    pub runtime: RuntimeSessionInfo,
}

#[tauri::command]
pub async fn agent_codex_open(
    app: AppHandle,
    state: State<'_, AppState>,
    tab_id: String,
    target_runtime_session_id: String,
    target_saved_session_id: Option<String>,
    target_label: String,
) -> AppResult<AgentCodexSession> {
    let tab_id = required_text("标签页 ID", &tab_id)?;
    let target_runtime_session_id =
        required_text("目标终端 runtime ID", &target_runtime_session_id)?;
    let target_label = required_text("目标终端名称", &target_label)?;
    let target_runtime = state
        .terminal_manager()
        .runtime_info(&target_runtime_session_id)?;
    if !matches!(
        target_runtime.kind,
        RuntimeSessionKind::Ssh | RuntimeSessionKind::SshContainer
    ) {
        return Err(AppError::validation(
            "Codex 侧栏仅可绑定 zTerm 的 SSH 服务器终端",
        ));
    }
    let requested_saved_session_id = target_saved_session_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    if requested_saved_session_id.as_deref() != target_runtime.saved_session_id.as_deref() {
        return Err(AppError::validation("目标 SSH 连接与运行终端绑定不一致"));
    }
    let saved_session_id = target_runtime.saved_session_id.clone();
    let approval_mode = saved_session_id
        .as_deref()
        .map(|session_id| get_ai_connection_approval_mode(state.storage().as_ref(), session_id))
        .transpose()?
        .unwrap_or(AiApprovalMode::Safe);

    let settings = get_app_settings(state.storage().as_ref())?;
    let mcp_status = state
        .mcp_service()
        .ensure_running(state.storage(), state.ai_tool_service(), settings.mcp.port)
        .await?;
    if !mcp_status.enabled {
        return Err(AppError::ai("zTerm MCP 服务未能启动"));
    }

    let agent_session_id = Uuid::new_v4().to_string();
    let access = state
        .mcp_service()
        .register_agent_binding(AgentMcpBinding {
            agent_session_id: agent_session_id.clone(),
            runtime_session_id: target_runtime_session_id.clone(),
            saved_session_id: saved_session_id.clone(),
            target_label: target_label.clone(),
        })?;
    let session_root = AppPaths::default_for_install()?
        .data_dir()
        .join("agent-sessions")
        .join(&agent_session_id);
    let prepare_workspace = fs::create_dir_all(&session_root).and_then(|_| {
        fs::write(
            session_root.join("AGENTS.md"),
            agent_instructions(&target_label, saved_session_id.as_deref(), approval_mode),
        )
    });
    if let Err(error) = prepare_workspace {
        let _ = state
            .mcp_service()
            .unregister_agent_binding(&agent_session_id);
        return Err(error.into());
    }
    let model_catalog_path = match write_codex_mcp_model_catalog(&session_root).await {
        Ok(path) => path,
        Err(error) => {
            let _ = state
                .mcp_service()
                .unregister_agent_binding(&agent_session_id);
            return Err(error);
        }
    };
    let inherited_mcp_servers = match list_inherited_codex_mcp_servers(&session_root).await {
        Ok(servers) => servers,
        Err(error) => {
            let _ = state
                .mcp_service()
                .unregister_agent_binding(&agent_session_id);
            return Err(error);
        }
    };

    let (command, args) = codex_launch_command(
        &access.endpoint,
        approval_mode,
        &model_catalog_path,
        &inherited_mcp_servers,
    );
    let opened = match state
        .terminal_manager()
        .open_agent_codex_session(AgentCodexPtyOptions {
            command_path: command,
            args,
            cwd: session_root.clone(),
            environment: vec![(AGENT_MCP_TOKEN_ENV.to_string(), access.token)],
            pane_id: format!("agent:{tab_id}"),
            title: format!("Codex · {target_label}"),
            cols: 80,
            rows: 30,
        }) {
        Ok(opened) => opened,
        Err(error) => {
            let _ = state
                .mcp_service()
                .unregister_agent_binding(&agent_session_id);
            return Err(error);
        }
    };
    spawn_terminal_reader(
        app,
        state.terminal_manager(),
        state.terminal_output_dispatcher(),
        state.command_history_service(),
        state.command_completion_service(),
        opened.info.runtime_session_id.clone(),
        opened.reader,
        Vec::new(),
    );
    Ok(AgentCodexSession {
        agent_session_id,
        target_runtime_session_id,
        target_saved_session_id: saved_session_id,
        target_label,
        approval_mode,
        runtime: opened.info,
    })
}

#[tauri::command]
pub fn agent_codex_unbind(state: State<'_, AppState>, agent_session_id: String) -> AppResult<()> {
    state
        .mcp_service()
        .unregister_agent_binding(agent_session_id.trim())
}

fn codex_launch_command(
    endpoint: &str,
    _approval_mode: AiApprovalMode,
    model_catalog_path: &Path,
    inherited_mcp_servers: &[String],
) -> (String, Vec<String>) {
    let mut codex_args = vec![
        "--disable".to_string(),
        "apps".to_string(),
        "--disable".to_string(),
        "plugins".to_string(),
        "-c".to_string(),
        "skills.include_instructions=false".to_string(),
        "-c".to_string(),
        "skills.bundled.enabled=false".to_string(),
        "-s".to_string(),
        "read-only".to_string(),
        "-a".to_string(),
        "never".to_string(),
        "-c".to_string(),
        format!("mcp_servers.zterm.url={}", toml_string(endpoint)),
        "-c".to_string(),
        format!(
            "mcp_servers.zterm.bearer_token_env_var={}",
            toml_string(AGENT_MCP_TOKEN_ENV)
        ),
        "-c".to_string(),
        "mcp_servers.zterm.enabled=true".to_string(),
        "-c".to_string(),
        "mcp_servers.zterm.default_tools_approval_mode=\"approve\"".to_string(),
        "-c".to_string(),
        format!(
            "shell_environment_policy.exclude=[{}]",
            toml_string(AGENT_MCP_TOKEN_ENV)
        ),
        "-c".to_string(),
        format!(
            "model_catalog_json={}",
            toml_string(&model_catalog_path.to_string_lossy())
        ),
    ];
    for server in inherited_mcp_servers {
        codex_args.push("-c".to_string());
        codex_args.push(format!("mcp_servers.{server}.enabled=false"));
    }
    if cfg!(windows) {
        let mut args = vec![
            "/D".to_string(),
            "/S".to_string(),
            "/C".to_string(),
            "codex".to_string(),
        ];
        args.extend(codex_args);
        ("cmd.exe".to_string(), args)
    } else {
        ("codex".to_string(), codex_args)
    }
}

async fn list_inherited_codex_mcp_servers(session_root: &Path) -> AppResult<Vec<String>> {
    let mut command = background_codex_command(&["mcp", "list"]);
    let output = command
        .current_dir(session_root)
        .output()
        .await
        .map_err(|error| AppError::ai(format!("无法读取本机 Codex MCP 配置: {error}")))?;
    if !output.status.success() {
        return Err(AppError::ai(format!(
            "本机 Codex MCP 配置读取失败，退出状态: {}",
            output.status
        )));
    }
    parse_codex_mcp_list(&String::from_utf8_lossy(&output.stdout))
}

fn parse_codex_mcp_list(output: &str) -> AppResult<Vec<String>> {
    let mut servers = Vec::new();
    for line in output.lines() {
        let columns = line.split_whitespace().collect::<Vec<_>>();
        if !columns
            .iter()
            .any(|column| matches!(*column, "enabled" | "disabled"))
        {
            continue;
        }
        let Some(name) = columns.first().copied() else {
            continue;
        };
        if name == "zterm" {
            continue;
        }
        if !name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
        {
            return Err(AppError::ai(format!(
                "本机 Codex MCP 名称无法安全隔离: {name}"
            )));
        }
        servers.push(name.to_string());
    }
    servers.sort();
    servers.dedup();
    Ok(servers)
}

async fn write_codex_mcp_model_catalog(session_root: &Path) -> AppResult<PathBuf> {
    let mut command = background_codex_command(&["debug", "models"]);
    let output = command
        .current_dir(session_root)
        .output()
        .await
        .map_err(|error| AppError::ai(format!("无法读取本机 Codex 模型目录: {error}")))?;
    if !output.status.success() {
        return Err(AppError::ai(format!(
            "本机 Codex 模型目录读取失败，退出状态: {}",
            output.status
        )));
    }
    let mut catalog = serde_json::from_slice::<Value>(&output.stdout)
        .map_err(|error| AppError::ai(format!("本机 Codex 模型目录不是有效 JSON: {error}")))?;
    disable_responses_lite(&mut catalog)?;
    let path = session_root.join("codex-model-catalog.json");
    let catalog_bytes = serde_json::to_vec_pretty(&catalog)
        .map_err(|error| AppError::ai(format!("无法生成 Codex 模型目录: {error}")))?;
    fs::write(&path, catalog_bytes)?;
    Ok(path)
}

fn background_codex_command(arguments: &[&str]) -> Command {
    let mut command = if cfg!(windows) {
        let mut command = Command::new("cmd.exe");
        command.args(["/D", "/S", "/C", "codex"]);
        command
    } else {
        Command::new("codex")
    };
    for &argument in arguments {
        command.arg(argument);
    }
    #[cfg(windows)]
    {
        // These short-lived probes capture stdout and do not own an interactive console.
        // Prevent the Windows default terminal host from showing a transient window.
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    command
}

fn disable_responses_lite(catalog: &mut Value) -> AppResult<()> {
    let models = catalog
        .get_mut("models")
        .and_then(Value::as_array_mut)
        .ok_or_else(|| AppError::ai("本机 Codex 模型目录缺少 models 数组"))?;
    if models.is_empty() {
        return Err(AppError::ai("本机 Codex 模型目录为空"));
    }
    for model in models {
        let model = model
            .as_object_mut()
            .ok_or_else(|| AppError::ai("本机 Codex 模型目录包含无效模型项"))?;
        model.insert("use_responses_lite".to_string(), Value::Bool(false));
    }
    Ok(())
}

fn agent_instructions(
    target_label: &str,
    saved_session_id: Option<&str>,
    approval_mode: AiApprovalMode,
) -> String {
    format!(
        "# zTerm Codex 侧栏\n\n\
你仅用于操作 zTerm 当前绑定的服务器终端。\n\n\
- 目标：`{target_label}`\n\
- 已保存连接 ID：`{saved_session_id}`\n\
- zTerm 审批模式：`{approval_mode}`\n\n\
必须使用 zTerm MCP 的 `terminal.read` 和 `terminal.write` 读写已绑定终端。\
远程命令要通过 `terminal.write` 写入 SSH 终端页面，再用 `terminal.read` 读取页面输出。\
不得新建 SSH 连接，不得使用本地 `ssh`/`scp`/`sftp` 或其他网络客户端绕过 zTerm。\
不得把密码、token、私钥或完整连接串写入对话、文件或工具参数。\
写操作是否自动执行由 zTerm 中该 SSH 连接的审批模式决定。\n",
        saved_session_id = saved_session_id.unwrap_or("未保存"),
        approval_mode = approval_mode.as_str(),
    )
}

fn toml_string(value: &str) -> String {
    format!("\"{}\"", value.replace('\\', "\\\\").replace('"', "\\\""))
}

fn required_text(label: &str, value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use std::{ffi::OsStr, path::Path};

    use serde_json::json;

    use super::{
        agent_instructions, background_codex_command, codex_launch_command, disable_responses_lite,
        parse_codex_mcp_list,
    };
    use crate::models::ai::AiApprovalMode;

    #[test]
    fn sidebar_instructions_force_page_terminal_transport() {
        let content = agent_instructions("prod", Some("ssh-1"), AiApprovalMode::FullAccess);
        assert!(content.contains("terminal.read"));
        assert!(content.contains("terminal.write"));
        assert!(content.contains("不得新建 SSH 连接"));
        assert!(content.contains("full_access"));
    }

    #[test]
    fn codex_launch_uses_read_only_local_sandbox_and_scoped_mcp_token() {
        let (_command, args) = codex_launch_command(
            "http://127.0.0.1:9419/mcp",
            AiApprovalMode::Safe,
            Path::new("C:\\zterm-agent\\models.json"),
            &["stitch".to_string(), "node_repl".to_string()],
        );
        assert!(args.windows(2).any(|pair| pair == ["--disable", "apps"]));
        assert!(args.windows(2).any(|pair| pair == ["--disable", "plugins"]));
        assert!(args
            .iter()
            .any(|arg| arg == "skills.include_instructions=false"));
        assert!(args.iter().any(|arg| arg == "skills.bundled.enabled=false"));
        assert!(args.windows(2).any(|pair| pair == ["-s", "read-only"]));
        assert!(args.iter().any(|arg| arg.contains("bearer_token_env_var")));
        assert!(args
            .iter()
            .any(|arg| arg.contains("default_tools_approval_mode=\"approve\"")));
        assert!(args
            .iter()
            .any(|arg| arg.contains("shell_environment_policy.exclude")));
        assert!(args.iter().any(|arg| arg.contains("model_catalog_json")));
        assert!(args
            .iter()
            .any(|arg| arg == "mcp_servers.stitch.enabled=false"));
        assert!(args
            .iter()
            .any(|arg| arg == "mcp_servers.node_repl.enabled=false"));
        assert!(args
            .iter()
            .any(|arg| arg == "mcp_servers.zterm.enabled=true"));
        assert!(!args.iter().any(|arg| arg.contains("ssh.execute")));
    }

    #[test]
    fn inherited_mcp_list_excludes_zterm_and_deduplicates_servers() {
        let output = "Name Url Status Auth\n\
stitch https://example.test/mcp enabled Unknown\n\
zterm http://127.0.0.1:9419/mcp enabled Bearer\n\
node_repl C:\\\\tools\\\\node.exe enabled Unsupported\n\
stitch https://example.test/mcp enabled Unknown\n";
        let servers = parse_codex_mcp_list(output).expect("MCP list should parse");
        assert_eq!(servers, ["node_repl", "stitch"]);
    }

    #[test]
    fn background_codex_command_keeps_discovery_arguments_noninteractive() {
        let command = background_codex_command(&["mcp", "list"]);
        let command = command.as_std();
        #[cfg(windows)]
        assert_eq!(command.get_program(), OsStr::new("cmd.exe"));
        #[cfg(not(windows))]
        assert_eq!(command.get_program(), OsStr::new("codex"));
        let arguments = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect::<Vec<_>>();
        #[cfg(windows)]
        assert_eq!(arguments, ["/D", "/S", "/C", "codex", "mcp", "list"]);
        #[cfg(not(windows))]
        assert_eq!(arguments, ["mcp", "list"]);
    }

    #[test]
    fn sidebar_model_catalog_disables_responses_lite_for_mcp_tool_visibility() {
        let mut catalog = json!({
            "models": [
                { "slug": "gpt-5.6-sol", "use_responses_lite": true },
                { "slug": "gpt-5.5", "use_responses_lite": false }
            ]
        });
        disable_responses_lite(&mut catalog).expect("catalog should patch");
        assert!(catalog["models"]
            .as_array()
            .expect("models")
            .iter()
            .all(|model| model["use_responses_lite"] == false));
    }
}
