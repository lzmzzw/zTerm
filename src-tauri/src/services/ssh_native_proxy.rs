// Author: Liz
use std::{
    io,
    pin::Pin,
    process::Stdio,
    task::{Context, Poll},
};

use tokio::{
    io::{AsyncRead, AsyncWrite, ReadBuf},
    process::{Child, ChildStdin, ChildStdout, Command},
};

use crate::error::{AppError, AppResult};

/// Raw proxy pipes must never pass through a local console/ConPTY.
pub struct ProxyCommandStream {
    child: Child,
    _process_guard: super::ssh_proxy_process_guard::ProxyProcessGuard,
    stdin: ChildStdin,
    stdout: ChildStdout,
    jump: bool,
}

impl AsyncRead for ProxyCommandStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        match Pin::new(&mut self.stdout).poll_read(cx, buf) {
            Poll::Ready(Ok(())) if buf.filled().len() == before && buf.remaining() > 0 => {
                if self.jump {
                    return Poll::Ready(Err(io::Error::new(io::ErrorKind::ConnectionAborted,
                        "SSH 跳板通道已关闭；请检查跳板配置及 SSH agent/密钥认证。跳板需要交互密码或验证码时无法使用非交互通道")));
                }
                if self
                    .child
                    .try_wait()
                    .ok()
                    .flatten()
                    .is_some_and(|status| !status.success())
                {
                    return Poll::Ready(Err(io::Error::new(
                        io::ErrorKind::ConnectionAborted,
                        "SSH 代理进程失败，请检查代理配置",
                    )));
                }
                Poll::Ready(Ok(()))
            }
            result => result,
        }
    }
}

impl AsyncWrite for ProxyCommandStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

impl Drop for ProxyCommandStream {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}

pub fn spawn_target_stream(
    host: &str,
    port: u16,
    username: &str,
    proxy_command: Option<&str>,
    jump_hosts: &[String],
) -> AppResult<Option<ProxyCommandStream>> {
    if let Some(template) = proxy_command
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        validate_text(host, "SSH 目标主机")?;
        validate_text(username, "SSH 用户名")?;
        validate_text(template, "SSH 代理命令")?;
        validate_port(port)?;
        let expanded = expand_proxy_command(template, host, port, username);
        return spawn_command(shell_command(&expanded), false).map(Some);
    }
    let jumps: Vec<_> = jump_hosts
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .collect();
    if jumps.is_empty() {
        return Ok(None);
    }
    let args = jump_arguments(host, port, &jumps)?;
    let mut command = Command::new("ssh");
    command.args(args);
    // Do not let GUI askpass silently turn a raw jump connection into an interactive login.
    command.env("SSH_ASKPASS_REQUIRE", "never");
    spawn_command(command, true).map(Some)
}

fn spawn_command(mut command: Command, jump: bool) -> AppResult<ProxyCommandStream> {
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000); // CREATE_NO_WINDOW; pipes, not a local console.
    let mut child = command
        .spawn()
        .map_err(|error| AppError::ssh(format!("SSH 代理进程启动失败: {error}")))?;
    let process_guard = super::ssh_proxy_process_guard::ProxyProcessGuard::attach(&child)?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| AppError::ssh("SSH 代理 stdin 不可用"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| AppError::ssh("SSH 代理 stdout 不可用"))?;
    Ok(ProxyCommandStream {
        child,
        _process_guard: process_guard,
        stdin,
        stdout,
        jump,
    })
}

fn validate_text(value: &str, label: &str) -> AppResult<()> {
    if value.trim().is_empty() || value.chars().any(char::is_control) {
        return Err(AppError::validation(format!(
            "{label}不能为空或包含控制字符"
        )));
    }
    Ok(())
}

fn validate_port(port: u16) -> AppResult<()> {
    if port == 0 {
        return Err(AppError::validation("SSH 端口必须大于 0"));
    }
    Ok(())
}

fn jump_arguments(host: &str, port: u16, jumps: &[&str]) -> AppResult<Vec<String>> {
    validate_text(host, "SSH 目标主机")?;
    validate_port(port)?;
    for jump in jumps {
        validate_text(jump, "SSH 跳板")?;
        if jump.starts_with('-') || jump.contains(',') || jump.chars().any(char::is_whitespace) {
            return Err(AppError::validation(
                "SSH 跳板格式无效，使用 [user@]host[:port]",
            ));
        }
    }
    let (last, previous) = jumps
        .split_last()
        .ok_or_else(|| AppError::validation("SSH 跳板为空"))?;
    let mut args = vec![
        "-T".into(),
        "-o".into(),
        "BatchMode=yes".into(),
        "-o".into(),
        "StrictHostKeyChecking=accept-new".into(),
    ];
    if !previous.is_empty() {
        args.extend(["-J".into(), previous.join(",")]);
    }
    let host = host.trim();
    let endpoint = if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]:{port}")
    } else {
        format!("{host}:{port}")
    };
    let (user, address) = last
        .rsplit_once('@')
        .map_or((None, *last), |(user, host)| (Some(user), host));
    let (hostname, port) = if let Some(bracketed) = address.strip_prefix('[') {
        let (hostname, suffix) = bracketed
            .split_once(']')
            .ok_or_else(|| AppError::validation("SSH 跳板 IPv6 格式无效"))?;
        (hostname, suffix.strip_prefix(':'))
    } else if address.matches(':').count() == 1 {
        let (hostname, port) = address.rsplit_once(':').unwrap();
        (hostname, Some(port))
    } else {
        (address, None)
    };
    validate_text(hostname, "SSH 跳板主机")?;
    if let Some(port) = port {
        let port = port
            .parse::<u16>()
            .ok()
            .filter(|port| *port != 0)
            .ok_or_else(|| AppError::validation("SSH 跳板端口无效"))?;
        args.extend(["-p".into(), port.to_string()]);
    }
    if let Some(user) = user {
        validate_text(user, "SSH 跳板用户名")?;
        args.extend(["-l".into(), user.into()]);
    }
    args.extend(["-W".into(), endpoint, "--".into(), hostname.into()]);
    Ok(args)
}

fn expand_proxy_command(template: &str, host: &str, port: u16, username: &str) -> String {
    let mut expanded = String::with_capacity(template.len());
    let mut chars = template.chars();
    while let Some(ch) = chars.next() {
        if ch != '%' {
            expanded.push(ch);
            continue;
        }
        match chars.next() {
            Some('%') => expanded.push('%'),
            Some('h') => expanded.push_str(host),
            Some('p') => expanded.push_str(&port.to_string()),
            Some('r') => expanded.push_str(username),
            Some(other) => {
                expanded.push('%');
                expanded.push(other);
            }
            None => expanded.push('%'),
        }
    }
    expanded
}

#[cfg(windows)]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("cmd.exe");
    // cmd.exe does not use the C runtime's backslash escaping for quotes.
    // /S strips this outer pair, preserving quotes inside the user command.
    command.raw_arg(format!("/D /S /C \"{command_line}\""));
    command
}

#[cfg(not(windows))]
fn shell_command(command_line: &str) -> Command {
    let mut command = Command::new("sh");
    command.args(["-c", command_line]);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn expands_proxy_tokens_without_recursive_expansion() {
        assert_eq!(
            expand_proxy_command("%% %h:%p %r %x %", "host%p", 2222, "user"),
            "% host%p:2222 user %x %"
        );
    }

    #[test]
    fn jump_arguments_preserve_chain_and_ipv6() {
        assert_eq!(
            jump_arguments("2001:db8::1", 2222, &["alice@first:2200", "bob@[::1]:2201"]).unwrap(),
            [
                "-T",
                "-o",
                "BatchMode=yes",
                "-o",
                "StrictHostKeyChecking=accept-new",
                "-J",
                "alice@first:2200",
                "-p",
                "2201",
                "-l",
                "bob",
                "-W",
                "[2001:db8::1]:2222",
                "--",
                "::1"
            ]
        );
        assert!(jump_arguments("target", 22, &["-oProxyCommand=evil"]).is_err());
        assert!(jump_arguments("target", 22, &["bad\nidentity"]).is_err());
        assert!(jump_arguments("target", 0, &["jump"]).is_err());
    }

    #[test]
    fn direct_target_does_not_start_a_child() {
        assert!(
            spawn_target_stream("host", 22, "user", Some(" "), &[" ".into()])
                .unwrap()
                .is_none()
        );
    }

    #[tokio::test]
    async fn raw_pipes_preserve_all_bytes_and_isolate_stderr() {
        #[cfg(windows)]
        let command = {
            let mut command = Command::new("powershell.exe");
            command.args(["-NoProfile", "-NonInteractive", "-Command", "$i=[Console]::OpenStandardInput(); $o=[Console]::OpenStandardOutput(); [Console]::Error.WriteLine('diagnostic-only'); $i.CopyTo($o)"]);
            command
        };
        #[cfg(not(windows))]
        let command = shell_command("printf diagnostic-only >&2; cat");
        let mut stream = spawn_command(command, false).unwrap();
        let payload: Vec<u8> = (0..=255).cycle().take(1024).collect();
        stream.write_all(&payload).await.unwrap();
        stream.shutdown().await.unwrap();
        let mut received = vec![0; payload.len()];
        tokio::time::timeout(
            std::time::Duration::from_secs(10),
            stream.read_exact(&mut received),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(received, payload);
    }
}
