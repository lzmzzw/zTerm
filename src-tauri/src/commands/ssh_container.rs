// Author: Liz
use std::time::{Duration, Instant};

use tauri::State;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{ssh_container::SshContainerInfo, terminal::RuntimeSessionKind},
    services::{
        external_launch_service::{
            external_ssh_channel_policy_for_username, ExternalSshChannelPolicy,
        },
        ssh_container_service::{
            build_container_exec_command, build_container_list_script, enabled_container_options,
            parse_container_ps_output,
        },
    },
    state::AppState,
    storage::sessions::{get_session, list_sessions},
};

#[tauri::command]
pub async fn ssh_container_list(
    state: State<'_, AppState>,
    saved_session_id: String,
    runtime_session_id: Option<String>,
) -> AppResult<Vec<SshContainerInfo>> {
    let storage = state.storage();
    let external_launch_service = state.external_launch_service();
    let session = match external_launch_service.get_session(&saved_session_id)? {
        Some(session) => session,
        None => get_session(storage.as_ref(), &saved_session_id)?,
    };
    if crate::services::external_launch_service::is_external_session_id(&session.id)
        && external_ssh_channel_policy_for_username(&session.username)
            == ExternalSshChannelPolicy::SingleChannel
    {
        return Err(AppError::unsupported("单通道临时 SSH 不支持容器列表"));
    }
    let container = enabled_container_options(&session)?;
    let script = build_container_list_script(&container.runtime)?;
    if crate::services::external_launch_service::is_external_session_id(&session.id) {
        if let Some(runtime_session_id) = runtime_session_id
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            return list_external_containers_through_runtime(
                &state,
                &session.id,
                runtime_session_id,
                script,
            )
            .await;
        }
    }
    let all_sessions =
        if crate::services::external_launch_service::is_external_session_id(&session.id) {
            Vec::new()
        } else {
            list_sessions(storage.as_ref())?.sessions
        };
    let secrets = external_launch_service.composite_secret_resolver(state.credential_service());
    let output = state
        .ssh_command_service()
        .execute(&session, &all_sessions, script, &secrets)
        .await?;
    if !output.success {
        let detail = if output.stderr.trim().is_empty() {
            output.stdout.trim()
        } else {
            output.stderr.trim()
        };
        return Err(AppError::ssh(if detail.is_empty() {
            "容器列表获取失败".to_string()
        } else {
            detail.to_string()
        }));
    }
    Ok(parse_container_ps_output(&output.stdout))
}

#[tauri::command]
pub async fn ssh_container_enter_runtime(
    state: State<'_, AppState>,
    saved_session_id: String,
    runtime_session_id: String,
    container_id: String,
) -> AppResult<crate::models::terminal::TerminalAccepted> {
    let external_launch_service = state.external_launch_service();
    let session = external_launch_service
        .get_session(&saved_session_id)?
        .ok_or_else(|| AppError::validation("复用当前终端进入容器只支持临时 SSH 连接"))?;
    if external_ssh_channel_policy_for_username(&session.username)
        == ExternalSshChannelPolicy::SingleChannel
    {
        return Err(AppError::unsupported("单通道临时 SSH 不支持进入容器"));
    }
    let container = enabled_container_options(&session)?;
    let manager = state.terminal_manager();
    let info = manager.runtime_info(&runtime_session_id)?;
    if info.saved_session_id.as_deref() != Some(&saved_session_id)
        || info.kind != RuntimeSessionKind::Ssh
    {
        return Err(AppError::validation(
            "临时 SSH 进入容器需要当前 SSH 终端连接",
        ));
    }
    let command = build_container_exec_command(container, &container_id)?;
    manager.write(&runtime_session_id, &format!("{command}\r"))
}

async fn list_external_containers_through_runtime(
    state: &State<'_, AppState>,
    saved_session_id: &str,
    runtime_session_id: &str,
    script: String,
) -> AppResult<Vec<SshContainerInfo>> {
    let manager = state.terminal_manager();
    let info = manager.runtime_info(runtime_session_id)?;
    if info.saved_session_id.as_deref() != Some(saved_session_id)
        || info.kind != RuntimeSessionKind::Ssh
    {
        return Err(AppError::validation(
            "临时 SSH 容器列表需要当前 SSH 终端连接",
        ));
    }

    let cursor = manager.output_cursor(runtime_session_id)?;
    let marker = format!("__ZTERM_CONTAINER_LIST_{}", Uuid::new_v4().simple());
    let end_prefix = format!("{marker}:END:");
    let command = external_container_probe_command(&marker, &script);
    manager.begin_output_suppression(runtime_session_id, &end_prefix)?;
    let result = async {
        manager.write(runtime_session_id, &command)?;
        wait_for_external_container_probe(&manager, runtime_session_id, cursor, &marker).await
    }
    .await;
    manager.end_output_suppression(runtime_session_id);
    let output = result?;
    if !output.success {
        let detail = output.stdout.trim();
        return Err(AppError::ssh(if detail.is_empty() {
            "容器列表获取失败".to_string()
        } else {
            detail.to_string()
        }));
    }
    Ok(parse_container_ps_output(&output.stdout))
}

struct ExternalContainerProbeOutput {
    stdout: String,
    success: bool,
}

async fn wait_for_external_container_probe(
    manager: &crate::services::terminal_manager::TerminalManager,
    runtime_session_id: &str,
    cursor: usize,
    marker: &str,
) -> AppResult<ExternalContainerProbeOutput> {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        let output = manager.output_after_cursor(runtime_session_id, cursor, 24_000)?;
        if let Some(parsed) = parse_external_container_probe_output(&output, marker) {
            return Ok(parsed);
        }
        if Instant::now() >= deadline {
            return Err(AppError::ssh("临时 SSH 容器列表获取超时"));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn external_container_probe_command(marker: &str, script: &str) -> String {
    let script = script.trim();
    format!(
        "__zterm_container_marker='{marker}'; printf '%s\\n' \"${{__zterm_container_marker}}:BEGIN\"; ({script}); __zterm_container_status=$?; printf '%s:%s\\n' \"${{__zterm_container_marker}}:END\" \"$__zterm_container_status\"\n"
    )
}

fn parse_external_container_probe_output(
    output: &str,
    marker: &str,
) -> Option<ExternalContainerProbeOutput> {
    let begin_marker = format!("{marker}:BEGIN");
    let end_prefix = format!("{marker}:END:");
    let mut started = false;
    let mut lines = Vec::new();
    for line in output.lines() {
        let normalized = line.trim().trim_end_matches('\r');
        if !started {
            if normalized == begin_marker {
                started = true;
            }
            continue;
        }
        if let Some(status) = normalized.strip_prefix(&end_prefix) {
            return Some(ExternalContainerProbeOutput {
                stdout: lines.join("\n"),
                success: status.trim() == "0",
            });
        }
        lines.push(line.trim_end_matches('\r').to_string());
    }
    None
}

#[cfg(test)]
mod tests {
    use super::{external_container_probe_command, parse_external_container_probe_output};
    use crate::models::session::SshContainerOptions;
    use crate::services::ssh_container_service::build_container_exec_command;

    #[test]
    fn external_container_probe_parser_ignores_echo_and_reads_marked_output() {
        let marker = "__ZTERM_CONTAINER_LIST_test";
        let output = "\
printf '%s\\n' '__ZTERM_CONTAINER_LIST_test:BEGIN'\r
__ZTERM_CONTAINER_LIST_test:BEGIN\r
abc\tapi\tapp:latest\tUp 3 minutes\r
def\told\tapp:old\tExited (0) 2 hours ago\r
__ZTERM_CONTAINER_LIST_test:END:0\r
[root@host ~]# ";

        let parsed = parse_external_container_probe_output(output, marker).expect("marked output");

        assert!(parsed.success);
        assert_eq!(
            parsed.stdout,
            "abc\tapi\tapp:latest\tUp 3 minutes\ndef\told\tapp:old\tExited (0) 2 hours ago"
        );
    }

    #[test]
    fn external_container_probe_parser_reports_non_zero_status() {
        let marker = "__ZTERM_CONTAINER_LIST_test";
        let output = "\
__ZTERM_CONTAINER_LIST_test:BEGIN
container runtime not found: docker
__ZTERM_CONTAINER_LIST_test:END:127
";

        let parsed = parse_external_container_probe_output(output, marker).expect("marked output");

        assert!(!parsed.success);
        assert_eq!(parsed.stdout, "container runtime not found: docker");
    }

    #[test]
    fn external_container_probe_command_wraps_the_container_script() {
        let command = external_container_probe_command("__ZTERM_CONTAINER_LIST_test", "docker ps");

        assert!(command.contains("__zterm_container_marker='__ZTERM_CONTAINER_LIST_test'"));
        assert!(command.contains("${__zterm_container_marker}:BEGIN"));
        assert!(command.contains("docker ps"));
        assert!(command.contains("${__zterm_container_marker}:END"));
        assert!(!command.contains("__ZTERM_CONTAINER_LIST_test:BEGIN"));
        assert!(!command.contains("__ZTERM_CONTAINER_LIST_test:END"));
    }

    #[test]
    fn external_container_probe_command_keeps_script_on_one_input_line() {
        let command = external_container_probe_command(
            "__ZTERM_CONTAINER_LIST_test",
            "runtime='docker'; docker ps",
        );

        assert_eq!(command.lines().count(), 1);
        assert!(!command.contains("\n("));
        assert!(!command.contains("\n)"));
    }

    #[test]
    fn external_container_enter_command_uses_interactive_exec() {
        let command = build_container_exec_command(
            &SshContainerOptions {
                enabled: true,
                runtime: "docker".to_string(),
                container: String::new(),
                shell: Some("/bin/bash".to_string()),
                user: Some("app user".to_string()),
                workdir: Some("/srv/app".to_string()),
            },
            "api container",
        )
        .expect("command should build");

        assert_eq!(
            command,
            "docker exec -it --user 'app user' --workdir /srv/app 'api container' /bin/bash"
        );
    }
}
