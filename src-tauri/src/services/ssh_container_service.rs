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

pub fn parse_container_ps_output(stdout: &str) -> Vec<SshContainerInfo> {
    let mut items = stdout
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            if line.trim().is_empty() {
                return None;
            }
            let mut parts = line.splitn(4, '\t');
            let id = parts.next()?.trim().to_string();
            if !container_id_looks_valid(&id) {
                return None;
            }
            let name = parts.next()?.trim().to_string();
            let image = parts.next()?.trim().to_string();
            let status = parts.next()?.trim().to_string();
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
