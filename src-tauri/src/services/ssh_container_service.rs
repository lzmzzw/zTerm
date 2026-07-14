// Author: Liz
use crate::{
    error::{AppError, AppResult},
    models::{
        session::{SavedSession, SessionType, SshContainerOptions},
        ssh_container::SshContainerInfo,
    },
};

pub fn enabled_container_options(session: &SavedSession) -> AppResult<&SshContainerOptions> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported("容器列表只支持 SSH 会话"));
    }
    let container = session
        .ssh_options
        .as_ref()
        .and_then(|options| options.container.as_ref())
        .ok_or_else(|| AppError::validation("SSH 会话未配置容器入口"))?;
    if !container.enabled {
        return Err(AppError::validation("SSH 会话未启用容器入口"));
    }
    Ok(container)
}

pub fn normalize_container_runtime(runtime: &str) -> AppResult<String> {
    let runtime = runtime.trim().to_ascii_lowercase();
    let runtime = if runtime.is_empty() {
        "docker".to_string()
    } else {
        runtime
    };
    match runtime.as_str() {
        "docker" | "podman" | "nerdctl" => Ok(runtime),
        "containerd" => Ok("nerdctl".to_string()),
        _ => Err(AppError::unsupported(format!(
            "暂不支持的容器运行时: {runtime}"
        ))),
    }
}

pub fn build_container_list_script(runtime: &str) -> AppResult<String> {
    let runtime = normalize_container_runtime(runtime)?;
    Ok(format!(
        "runtime='{runtime}'; if command -v \"$runtime\" >/dev/null 2>&1; then \"$runtime\" ps -a --format '{{{{.ID}}}}\\t{{{{.Names}}}}\\t{{{{.Image}}}}\\t{{{{.Status}}}}'; else printf 'container runtime not found: %s\\n' \"$runtime\" >&2; exit 127; fi",
    ))
}

pub fn build_container_exec_command(
    container: &SshContainerOptions,
    container_id: &str,
) -> AppResult<String> {
    let runtime = normalize_container_runtime(&container.runtime)?;
    let container_id = normalize_text(Some(container_id))
        .ok_or_else(|| AppError::validation("容器 ID 或名称不能为空"))?;
    let shell = normalize_text(container.shell.as_deref()).unwrap_or_else(|| "/bin/sh".to_string());
    let mut parts = vec![runtime, "exec".to_string(), "-it".to_string()];
    if let Some(user) = normalize_text(container.user.as_deref()) {
        parts.push("--user".to_string());
        parts.push(shell_quote(&user));
    }
    if let Some(workdir) = normalize_text(container.workdir.as_deref()) {
        parts.push("--workdir".to_string());
        parts.push(shell_quote(&workdir));
    }
    parts.push(shell_quote(&container_id));
    parts.push(shell_quote(&shell));
    Ok(parts.join(" "))
}

pub fn parse_container_ps_output(stdout: &str) -> Vec<SshContainerInfo> {
    let mut items = stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            if line.trim().is_empty() {
                return None;
            }
            let parts = if line.contains('\t') {
                line.splitn(4, '\t').collect::<Vec<_>>()
            } else {
                line.splitn(4, "\\t").collect::<Vec<_>>()
            };
            if parts.len() != 4 {
                return None;
            }
            let id = parts[0].trim().to_string();
            if !container_id_looks_valid(&id) {
                return None;
            }
            let name = parts[1].trim().to_string();
            let image = parts[2].trim().to_string();
            let status = parts[3].trim().to_string();
            Some(SshContainerInfo {
                id,
                name,
                image,
                running: container_status_is_running(&status),
                status,
            })
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        right
            .running
            .cmp(&left.running)
            .then_with(|| container_sort_name(left).cmp(container_sort_name(right)))
    });
    items
}

fn container_id_looks_valid(id: &str) -> bool {
    !id.is_empty() && id.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn container_status_is_running(status: &str) -> bool {
    let status = status.trim().to_ascii_lowercase();
    status.starts_with("up") || status.starts_with("running")
}

fn container_sort_name(container: &SshContainerInfo) -> &str {
    if container.name.trim().is_empty() {
        container.id.as_str()
    } else {
        container.name.as_str()
    }
}

fn normalize_text(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}
