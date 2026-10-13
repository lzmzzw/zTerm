// Author: Liz
//! Expands local OpenSSH aliases without opening a network connection.
use std::{path::PathBuf, process::Stdio, time::Duration};

use tokio::{io::AsyncReadExt, process::Command};

use crate::error::{AppError, AppResult};

const MAX_CONFIG_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenSshHopConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub identity_files: Vec<PathBuf>,
    pub identities_only: bool,
    pub use_agent: bool,
    pub proxy_command: Option<String>,
}

pub async fn resolve_jump(value: &str) -> AppResult<OpenSshHopConfig> {
    let args = config_arguments(value)?;
    let mut command = Command::new("ssh");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command
        .spawn()
        .map_err(|_| AppError::ssh("无法启动 OpenSSH 本地配置解析"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::ssh("无法读取 OpenSSH 本地配置"))?;
    let operation = async {
        let mut bytes = Vec::new();
        stdout
            .take((MAX_CONFIG_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| AppError::ssh("读取 OpenSSH 本地配置失败"))?;
        if bytes.len() > MAX_CONFIG_BYTES {
            return Err(AppError::ssh("OpenSSH 本地配置输出超过 64 KiB"));
        }
        let status = child
            .wait()
            .await
            .map_err(|_| AppError::ssh("OpenSSH 本地配置解析失败"))?;
        if !status.success() {
            return Err(AppError::ssh(
                "OpenSSH 无法解析跳板配置；请检查本机 SSH 配置",
            ));
        }
        parse_config(&bytes)
    };
    tokio::time::timeout(Duration::from_secs(5), operation)
        .await
        .map_err(|_| AppError::ssh("OpenSSH 本地配置解析超时"))?
}

fn config_arguments(value: &str) -> AppResult<Vec<String>> {
    let value = value.trim();
    if value.is_empty()
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
    {
        return Err(AppError::validation("SSH 跳板格式无效"));
    }
    let endpoint = value.strip_prefix("ssh://").unwrap_or(value);
    if endpoint.contains('/')
        || endpoint.contains(',')
        || endpoint.contains('?')
        || endpoint.contains('#')
    {
        return Err(AppError::validation("SSH 跳板格式无效"));
    }
    let (user, endpoint) = if let Some((user, host)) = endpoint.rsplit_once('@') {
        if user.is_empty() || user.contains('@') {
            return Err(AppError::validation("SSH 跳板用户名无效"));
        }
        (Some(user), host)
    } else {
        (None, endpoint)
    };
    let (host, port) = if let Some(bracketed) = endpoint.strip_prefix('[') {
        let (host, tail) = bracketed
            .split_once(']')
            .ok_or_else(|| AppError::validation("SSH 跳板 IPv6 格式无效"))?;
        if host.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(AppError::validation("SSH 跳板 IPv6 地址无效"));
        }
        let port = if tail.is_empty() {
            None
        } else {
            Some(parse_port(
                tail.strip_prefix(':')
                    .ok_or_else(|| AppError::validation("SSH 跳板端口无效"))?,
            )?)
        };
        (host, port)
    } else if endpoint.matches(':').count() > 1 {
        if endpoint.parse::<std::net::Ipv6Addr>().is_err() {
            return Err(AppError::validation("SSH 跳板 IPv6 地址无效"));
        }
        (endpoint, None)
    } else if let Some((host, port)) = endpoint.split_once(':') {
        (host, Some(parse_port(port)?))
    } else {
        (endpoint, None)
    };
    if host.is_empty() || host.starts_with('-') || host.contains(['[', ']']) {
        return Err(AppError::validation("SSH 跳板主机无效"));
    }
    let mut args = vec!["-G".into()];
    if let Some(user) = user {
        args.extend(["-l".into(), user.into()]);
    }
    if let Some(port) = port {
        args.extend(["-p".into(), port.to_string()]);
    }
    args.extend(["--".into(), host.into()]);
    Ok(args)
}

fn parse_port(value: &str) -> AppResult<u16> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| AppError::validation("SSH 跳板端口必须在 1 到 65535 之间"))
}

fn parse_config(bytes: &[u8]) -> AppResult<OpenSshHopConfig> {
    let text = std::str::from_utf8(bytes).map_err(|_| AppError::ssh("OpenSSH 本地配置编码无效"))?;
    let mut host = None;
    let mut username = None;
    let mut port = None;
    let mut identity_files = Vec::new();
    let mut identities_only = false;
    let mut use_agent = true;
    let mut proxy_command = None;
    for line in text.lines() {
        let Some((key, value)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let value = value.trim();
        match key {
            "hostname" => host = Some(value.to_owned()),
            "user" => username = Some(value.to_owned()),
            "port" => port = Some(parse_port(value)?),
            "identityfile" if !value.is_empty() && value != "none" => {
                identity_files.push(value.to_owned())
            }
            "identitiesonly" => {
                identities_only = match value {
                    "yes" => true,
                    "no" => false,
                    _ => return Err(AppError::validation("OpenSSH IdentitiesOnly 配置无效")),
                }
            }
            "identityagent" => match value {
                "none" => use_agent = false,
                "SSH_AUTH_SOCK" | "$SSH_AUTH_SOCK" => use_agent = true,
                _ => return Err(AppError::unsupported(
                    "自定义 OpenSSH IdentityAgent 路径暂不支持；请使用默认 SSH_AUTH_SOCK 或 none",
                )),
            },
            "proxycommand" if !value.is_empty() && value != "none" => {
                proxy_command = Some(value.to_owned())
            }
            "proxyjump" if !value.is_empty() && value != "none" => {
                return Err(AppError::unsupported(
                    "跳板本机配置包含额外 ProxyJump；请将全部跳板明确配置到连接的跳板列表",
                ))
            }
            _ => {}
        }
    }
    let host = host
        .filter(|v| !v.is_empty() && !v.chars().any(char::is_control))
        .ok_or_else(|| AppError::ssh("OpenSSH 配置缺少有效 hostname"))?;
    let username = username
        .filter(|v| !v.is_empty() && !v.chars().any(char::is_control))
        .ok_or_else(|| AppError::ssh("OpenSSH 配置缺少有效 user"))?;
    let port = port.ok_or_else(|| AppError::ssh("OpenSSH 配置缺少有效 port"))?;
    let identity_files = identity_files
        .iter()
        .map(|value| expand_identity(value, &host, &username, port))
        .collect::<AppResult<_>>()?;
    Ok(OpenSshHopConfig {
        host,
        port,
        username,
        identity_files,
        identities_only,
        use_agent,
        proxy_command,
    })
}

fn user_home() -> AppResult<PathBuf> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or_else(|| AppError::ssh("无法解析 SSH 密钥路径的用户目录"))
}

fn expand_identity(value: &str, host: &str, username: &str, port: u16) -> AppResult<PathBuf> {
    // This is path substitution only. Never evaluate shell syntax or environment expressions.
    if value.contains("${") || value.contains("$(") || value.contains('`') {
        return Err(AppError::unsupported(
            "SSH 密钥路径不支持环境表达式或命令替换",
        ));
    }
    let mut expanded = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            expanded.push(ch);
            continue;
        }
        match chars.next() {
            Some('%') => expanded.push('%'),
            Some('h') => expanded.push_str(host),
            Some('r') => expanded.push_str(username),
            Some('p') => expanded.push_str(&port.to_string()),
            Some('d') => expanded.push_str(
                user_home()?
                    .to_str()
                    .ok_or_else(|| AppError::unsupported("SSH 用户目录不是 UTF-8 路径"))?,
            ),
            _ => {
                return Err(AppError::unsupported(
                    "SSH 密钥路径包含暂不支持的百分号 token；支持 %d %h %r %p %%",
                ))
            }
        }
    }
    expand_home(&expanded)
}

fn expand_home(value: &str) -> AppResult<PathBuf> {
    if let Some(relative) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix("~\\"))
    {
        return Ok(user_home()?.join(relative));
    }
    Ok(PathBuf::from(value))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_user_port_and_alias_are_separate_arguments() {
        assert_eq!(
            config_arguments("alice@alias:2200").unwrap(),
            ["-G", "-l", "alice", "-p", "2200", "--", "alias"]
        );
        assert_eq!(config_arguments("alias").unwrap(), ["-G", "--", "alias"]);
    }

    #[test]
    fn ipv6_and_uri_keep_explicit_port() {
        assert_eq!(
            config_arguments("ssh://bob@[::1]:2222").unwrap(),
            ["-G", "-l", "bob", "-p", "2222", "--", "::1"]
        );
        assert_eq!(
            config_arguments("2001:db8::1").unwrap(),
            ["-G", "--", "2001:db8::1"]
        );
        assert_eq!(config_arguments("[::1]").unwrap(), ["-G", "--", "::1"]);
    }

    #[test]
    fn malformed_targets_are_rejected() {
        for value in [
            "",
            "-oProxyCommand=evil",
            "user@host:0",
            "host:65536",
            "host:no",
            "[::1",
            "[::1]:",
            "ssh://host/path",
            "a,b",
            "a\nb",
            "@host",
            "a@b@host",
        ] {
            assert!(config_arguments(value).is_err(), "{value:?}");
        }
    }

    #[test]
    fn parses_config_without_reading_keys_and_ignores_unknown_fields() {
        let config = parse_config(b"host alias\nuser alice\nhostname 127.0.0.1\nport 2222\nidentityfile C:/key with spaces\nidentityfile none\nproxycommand bridge %h %p\nnewoption unknown\n").unwrap();
        assert_eq!(config.host, "127.0.0.1");
        assert_eq!(config.port, 2222);
        assert_eq!(config.username, "alice");
        assert_eq!(config.identity_files, [PathBuf::from("C:/key with spaces")]);
        assert_eq!(config.proxy_command.as_deref(), Some("bridge %h %p"));
    }

    #[test]
    fn missing_invalid_or_implicit_chain_config_is_rejected() {
        for bytes in [
            b"user alice\nport 22\n".as_slice(),
            b"hostname host\nport 22\n",
            b"hostname host\nuser alice\nport 0\n",
            b"hostname host\nuser alice\nport 22\nproxyjump hidden\n",
        ] {
            assert!(parse_config(bytes).is_err());
        }
        assert!(parse_config(
            b"hostname host\nuser alice\nport 22\nproxyjump none\nproxycommand none\n"
        )
        .unwrap()
        .proxy_command
        .is_none());
    }

    #[test]
    fn identity_tokens_expand_once_without_shell_execution() {
        assert_eq!(
            expand_identity("keys/%h_%r_%p_%%", "host%p", "alice", 2222).unwrap(),
            PathBuf::from("keys/host%p_alice_2222_%")
        );
        assert_eq!(
            expand_identity("%d/.ssh/key", "host", "alice", 22).unwrap(),
            user_home().unwrap().join(".ssh/key")
        );
        assert_eq!(
            expand_identity("~/.ssh/%r", "host", "alice", 22).unwrap(),
            user_home().unwrap().join(".ssh/alice")
        );
        for value in [
            "keys/%C",
            "keys/%",
            "keys/${HOME}",
            "keys/$(echo bad)",
            "keys/`echo bad`",
        ] {
            assert!(expand_identity(value, "host", "alice", 22).is_err());
        }
    }

    #[test]
    fn identity_policy_preserves_explicit_agent_restrictions() {
        let base = "hostname host\nuser alice\nport 22\n";
        let config = parse_config(
            format!("{base}identitiesonly yes\nidentityagent none\nidentityfile keys/%h_%r_%p\n")
                .as_bytes(),
        )
        .unwrap();
        assert!(config.identities_only);
        assert!(!config.use_agent);
        assert_eq!(config.identity_files, [PathBuf::from("keys/host_alice_22")]);
        let config = parse_config(
            format!("{base}identitiesonly no\nidentityagent SSH_AUTH_SOCK\n").as_bytes(),
        )
        .unwrap();
        assert!(!config.identities_only);
        assert!(config.use_agent);
        assert!(parse_config(format!("{base}identityagent C:/custom-agent\n").as_bytes()).is_err());
        assert!(parse_config(format!("{base}identitiesonly invalid\n").as_bytes()).is_err());
    }
}
