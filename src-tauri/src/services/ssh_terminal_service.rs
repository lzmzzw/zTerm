// Author: Liz
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{mpsc as std_mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use portable_pty::CommandBuilder;
use russh::{
    client,
    keys::{
        self, agent::AgentIdentity, load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKey,
    },
    ChannelMsg, Pty,
};
use tokio::sync::mpsc as tokio_mpsc;

use crate::{
    error::{AppError, AppResult},
    models::session::{AuthMode, SavedSession, SessionType, SshTunnel, SshTunnelKind},
    services::{
        credential_service::read_system_secret,
        local_pty_service::{spawn_pty_command, PtySpawn},
        ssh_container_service::{enabled_container_options, normalize_container_runtime},
    },
};

pub struct SshTerminalSpawn {
    pub runtime: SshTerminalRuntime,
    pub auth_secret: Option<String>,
}

pub enum SshTerminalRuntime {
    Pty(PtySpawn),
    Native(NativeSshRuntime),
}

pub struct NativeSshRuntime {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub control: NativeSshControl,
    pub exit_status: Arc<Mutex<Option<i32>>>,
}

#[derive(Clone)]
pub struct NativeSshControl {
    sender: tokio_mpsc::UnboundedSender<NativeSshCommand>,
}

impl NativeSshControl {
    pub fn close(&self) {
        let _ = self.sender.send(NativeSshCommand::Close);
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let _ = self.sender.send(NativeSshCommand::Resize { cols, rows });
    }
}

enum NativeSshCommand {
    Input(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
}

pub fn spawn_ssh_terminal(
    session: &SavedSession,
    cols: u16,
    rows: u16,
) -> AppResult<SshTerminalSpawn> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported(
            "only SSH sessions can open an SSH terminal",
        ));
    }

    if requires_system_ssh(session) {
        return spawn_system_ssh_terminal(session, cols, rows);
    }

    spawn_native_ssh_terminal(session, cols, rows)
}

fn spawn_system_ssh_terminal(
    session: &SavedSession,
    cols: u16,
    rows: u16,
) -> AppResult<SshTerminalSpawn> {
    let args = build_ssh_arguments(session)?;
    spawn_system_ssh_terminal_with_args(session, args, cols, rows)
}

pub fn spawn_ssh_container_terminal(
    session: &SavedSession,
    container_id: &str,
    cols: u16,
    rows: u16,
) -> AppResult<SshTerminalSpawn> {
    let args = build_ssh_container_arguments(session, container_id)?;
    spawn_system_ssh_terminal_with_args(session, args, cols, rows)
}

fn spawn_system_ssh_terminal_with_args(
    session: &SavedSession,
    args: Vec<String>,
    cols: u16,
    rows: u16,
) -> AppResult<SshTerminalSpawn> {
    let mut command = CommandBuilder::new("ssh");
    for arg in &args {
        command.arg(arg.as_str());
    }

    let auth_secret = match session.auth_mode {
        AuthMode::Password | AuthMode::Key => session
            .credential_ref
            .as_deref()
            .map(read_system_secret)
            .transpose()?,
        AuthMode::Agent | AuthMode::None => None,
    };

    let pty =
        spawn_pty_command(command, cols, rows).map_err(|error| AppError::ssh(error.to_string()))?;
    Ok(SshTerminalSpawn {
        runtime: SshTerminalRuntime::Pty(pty),
        auth_secret,
    })
}

fn spawn_native_ssh_terminal(
    session: &SavedSession,
    cols: u16,
    rows: u16,
) -> AppResult<SshTerminalSpawn> {
    let target = NativeSshTarget::from_session(session)?;
    let (command_sender, command_receiver) = tokio_mpsc::unbounded_channel();
    let (output_sender, output_receiver) = std_mpsc::channel();
    let exit_status = Arc::new(Mutex::new(None));
    let worker_status = Arc::clone(&exit_status);
    let error_sender = output_sender.clone();

    thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| AppError::ssh(error.to_string()))
            .and_then(|runtime| {
                runtime.block_on(run_native_ssh_terminal(
                    target,
                    cols,
                    rows,
                    command_receiver,
                    output_sender,
                    worker_status.clone(),
                ))
            });
        if let Err(error) = result {
            if let Ok(mut status) = worker_status.lock() {
                *status = Some(-1);
            }
            let _ = error_sender.send(format!("\r\n[SSH] {error}\r\n").into_bytes());
        }
    });

    Ok(SshTerminalSpawn {
        runtime: SshTerminalRuntime::Native(NativeSshRuntime {
            reader: Box::new(NativeSshReader::new(output_receiver)),
            writer: Box::new(NativeSshWriter {
                sender: command_sender.clone(),
            }),
            control: NativeSshControl {
                sender: command_sender,
            },
            exit_status,
        }),
        auth_secret: None,
    })
}

fn requires_system_ssh(session: &SavedSession) -> bool {
    let Some(options) = session.ssh_options.as_ref() else {
        return false;
    };
    options
        .proxy_command
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty())
        || options
            .jump_hosts
            .iter()
            .any(|host| !host.trim().is_empty())
        || options.tunnels.iter().any(|tunnel| tunnel.auto_open)
}

pub fn build_ssh_arguments(session: &SavedSession) -> AppResult<Vec<String>> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported(
            "only SSH sessions can build SSH arguments",
        ));
    }

    let mut args = vec![
        "-tt".to_string(),
        "-o".to_string(),
        "BatchMode=no".to_string(),
        "-o".to_string(),
        "StrictHostKeyChecking=accept-new".to_string(),
    ];
    if session.auth_mode == AuthMode::Password {
        args.push("-o".to_string());
        args.push("PreferredAuthentications=password,keyboard-interactive".to_string());
    } else if session.auth_mode == AuthMode::Key {
        args.push("-o".to_string());
        args.push("PreferredAuthentications=publickey".to_string());
    }
    if let Some(options) = session.ssh_options.as_ref() {
        if session.auth_mode == AuthMode::Key {
            if let Some(identity_file) = options
                .identity_file
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                args.push("-i".to_string());
                args.push(identity_file.to_string());
            }
        }
        if let Some(timeout_ms) = options.connect_timeout_ms {
            args.push("-o".to_string());
            args.push(format!("ConnectTimeout={}", timeout_ms.div_ceil(1000)));
        }
        if let Some(keepalive_ms) = options.keepalive_interval_ms {
            args.push("-o".to_string());
            args.push(format!(
                "ServerAliveInterval={}",
                keepalive_ms.div_ceil(1000)
            ));
        }
        if let Some(proxy_command) = options
            .proxy_command
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            args.push("-o".to_string());
            args.push(format!("ProxyCommand={proxy_command}"));
        }
        let jump_hosts = options
            .jump_hosts
            .iter()
            .map(|host| host.trim())
            .filter(|host| !host.is_empty())
            .collect::<Vec<_>>();
        if !jump_hosts.is_empty() {
            args.push("-J".to_string());
            args.push(jump_hosts.join(","));
        }
        for tunnel in options.tunnels.iter().filter(|tunnel| tunnel.auto_open) {
            push_tunnel_args(&mut args, tunnel)?;
        }
    }
    args.push("-p".to_string());
    args.push(session.port.to_string());
    args.push(ssh_target(session));
    Ok(args)
}

pub fn build_ssh_container_arguments(
    session: &SavedSession,
    container_id: &str,
) -> AppResult<Vec<String>> {
    let mut args = build_ssh_arguments(session)?;
    let container = enabled_container_options(session)?;
    args.push(container_command(container, container_id)?);
    Ok(args)
}

async fn run_native_ssh_terminal(
    target: NativeSshTarget,
    cols: u16,
    rows: u16,
    mut command_receiver: tokio_mpsc::UnboundedReceiver<NativeSshCommand>,
    output_sender: std_mpsc::Sender<Vec<u8>>,
    exit_status: Arc<Mutex<Option<i32>>>,
) -> AppResult<()> {
    let mut handle = connect_native_ssh(&target).await?;
    authenticate_native_ssh(&mut handle, &target).await?;
    let channel = handle.channel_open_session().await.map_err(russh_error)?;
    let pty_modes = native_pty_modes();
    channel
        .request_pty(
            true,
            "xterm-256color",
            u32::from(cols),
            u32::from(rows),
            0,
            0,
            &pty_modes,
        )
        .await
        .map_err(russh_error)?;
    channel.request_shell(true).await.map_err(russh_error)?;
    let (mut reader, writer) = channel.split();

    loop {
        tokio::select! {
            command = command_receiver.recv() => {
                match command {
                    Some(NativeSshCommand::Input(data)) => {
                        writer.data_bytes(data).await.map_err(russh_error)?;
                    }
                    Some(NativeSshCommand::Resize { cols, rows }) => {
                        writer
                            .window_change(u32::from(cols), u32::from(rows), 0, 0)
                            .await
                            .map_err(russh_error)?;
                    }
                    Some(NativeSshCommand::Close) | None => {
                        let _ = writer.close().await;
                        break;
                    }
                }
            }
            message = reader.wait() => {
                let Some(message) = message else {
                    break;
                };
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        if output_sender.send(data.to_vec()).is_err() {
                            let _ = writer.close().await;
                            break;
                        }
                    }
                    ChannelMsg::ExitStatus { exit_status: code } => {
                        if let Ok(mut status) = exit_status.lock() {
                            *status = Some(i32::try_from(code).unwrap_or(i32::MAX));
                        }
                    }
                    ChannelMsg::ExitSignal { signal_name, error_message, .. } => {
                        if let Ok(mut status) = exit_status.lock() {
                            *status = Some(-1);
                        }
                        let mut message = format!("\r\n[SSH] remote shell exited by signal: {signal_name:?}");
                        if !error_message.trim().is_empty() {
                            message.push_str(&format!(" {error_message}"));
                        }
                        message.push_str("\r\n");
                        let _ = output_sender.send(message.into_bytes());
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
        }
    }

    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "terminal closed", "")
        .await;
    Ok(())
}

#[derive(Clone)]
struct NativeSshTarget {
    auth: NativeSshAuth,
    connect_timeout: Option<Duration>,
    host: String,
    keepalive_interval: Option<Duration>,
    port: u16,
    username: String,
}

#[derive(Clone)]
enum NativeSshAuth {
    Agent,
    None,
    Password(String),
    PrivateKey {
        identity_file: PathBuf,
        passphrase: Option<String>,
    },
}

impl NativeSshTarget {
    fn from_session(session: &SavedSession) -> AppResult<Self> {
        let host = required_text("主机", &session.host)?;
        let username = required_text("用户名", &session.username)?;
        if session.port == 0 {
            return Err(AppError::validation("端口必须大于 0"));
        }
        let auth = match session.auth_mode {
            AuthMode::Password => {
                let credential_ref = required_credential_ref(session, "密码认证需要凭据引用")?;
                NativeSshAuth::Password(read_system_secret(credential_ref)?)
            }
            AuthMode::Key => {
                let identity_file = session
                    .ssh_options
                    .as_ref()
                    .and_then(|options| options.identity_file.as_deref())
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        AppError::validation("密钥认证需要 ssh_options.identity_file")
                    })?;
                if identity_file.contains('\n')
                    || identity_file.contains('\r')
                    || identity_file.contains('\0')
                {
                    return Err(AppError::validation("identity_file 不能包含控制字符"));
                }
                let passphrase = session
                    .credential_ref
                    .as_deref()
                    .map(read_system_secret)
                    .transpose()?;
                NativeSshAuth::PrivateKey {
                    identity_file: PathBuf::from(identity_file),
                    passphrase,
                }
            }
            AuthMode::Agent => NativeSshAuth::Agent,
            AuthMode::None => NativeSshAuth::None,
        };
        Ok(Self {
            auth,
            connect_timeout: session
                .ssh_options
                .as_ref()
                .and_then(|options| options.connect_timeout_ms)
                .map(Duration::from_millis),
            host,
            keepalive_interval: session
                .ssh_options
                .as_ref()
                .and_then(|options| options.keepalive_interval_ms)
                .map(Duration::from_millis),
            port: session.port,
            username,
        })
    }
}

#[derive(Debug)]
struct NativeSshHandler;

impl client::Handler for NativeSshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

async fn connect_native_ssh(
    target: &NativeSshTarget,
) -> AppResult<client::Handle<NativeSshHandler>> {
    let config = client::Config {
        inactivity_timeout: None,
        keepalive_interval: target.keepalive_interval,
        ..Default::default()
    };
    let connect = client::connect(
        Arc::new(config),
        (target.host.as_str(), target.port),
        NativeSshHandler,
    );
    if let Some(timeout) = target.connect_timeout {
        tokio::time::timeout(timeout, connect)
            .await
            .map_err(|_| AppError::ssh(format!("SSH 连接超时（{} 秒）", timeout.as_secs())))?
            .map_err(russh_error)
    } else {
        connect.await.map_err(russh_error)
    }
}

async fn authenticate_native_ssh(
    handle: &mut client::Handle<NativeSshHandler>,
    target: &NativeSshTarget,
) -> AppResult<()> {
    let username = target.username.clone();
    let authenticated = match &target.auth {
        NativeSshAuth::Password(password) => handle
            .authenticate_password(username, password.clone())
            .await
            .map_err(russh_error)?
            .success(),
        NativeSshAuth::PrivateKey {
            identity_file,
            passphrase,
        } => {
            let key = load_secret_key(identity_file, passphrase.as_deref()).map_err(key_error)?;
            authenticate_private_key(handle, username, key).await?
        }
        NativeSshAuth::Agent => authenticate_agent(handle, username).await?,
        NativeSshAuth::None => handle
            .authenticate_none(username)
            .await
            .map_err(russh_error)?
            .success(),
    };
    if authenticated {
        Ok(())
    } else {
        Err(AppError::credential(format!(
            "SSH 认证失败: {}@{}:{}",
            target.username, target.host, target.port
        )))
    }
}

async fn authenticate_private_key(
    handle: &mut client::Handle<NativeSshHandler>,
    username: String,
    key: PrivateKey,
) -> AppResult<bool> {
    let hash = handle
        .best_supported_rsa_hash()
        .await
        .map_err(russh_error)?
        .flatten();
    handle
        .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
        .await
        .map_err(russh_error)
        .map(|result| result.success())
}

async fn authenticate_agent(
    handle: &mut client::Handle<NativeSshHandler>,
    username: String,
) -> AppResult<bool> {
    let mut agent = connect_agent().await?;
    let identities = agent.request_identities().await.map_err(agent_error)?;
    for identity in identities {
        let key = match &identity {
            AgentIdentity::PublicKey { key, .. } => key.clone(),
            AgentIdentity::Certificate { .. } => identity.public_key().into_owned(),
        };
        let hash = handle
            .best_supported_rsa_hash()
            .await
            .map_err(russh_error)?
            .flatten();
        let result = handle
            .authenticate_publickey_with(username.clone(), key, hash, &mut agent)
            .await
            .map_err(|error| AppError::credential(format!("SSH agent 认证失败: {error}")))?;
        if result.success() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(unix)]
async fn connect_agent() -> AppResult<
    keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>,
> {
    keys::agent::client::AgentClient::connect_env()
        .await
        .map(|client| client.dynamic())
        .map_err(agent_error)
}

#[cfg(windows)]
async fn connect_agent() -> AppResult<
    keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>,
> {
    const OPENSSH_AGENT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";

    match keys::agent::client::AgentClient::connect_named_pipe(OPENSSH_AGENT_PIPE).await {
        Ok(client) => Ok(client.dynamic()),
        Err(openssh_error) => keys::agent::client::AgentClient::connect_pageant()
            .await
            .map(|client| client.dynamic())
            .map_err(|pageant_error| {
                AppError::credential(format!(
                    "SSH agent 连接失败: OpenSSH agent ({OPENSSH_AGENT_PIPE}) {openssh_error}; Pageant {pageant_error}"
                ))
            }),
    }
}

#[cfg(not(any(unix, windows)))]
async fn connect_agent() -> AppResult<
    keys::agent::client::AgentClient<Box<dyn keys::agent::client::AgentStream + Send + Unpin>>,
> {
    Err(AppError::unsupported("当前平台不支持 SSH agent 认证"))
}

fn required_credential_ref<'a>(session: &'a SavedSession, message: &str) -> AppResult<&'a str> {
    session
        .credential_ref
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::validation(message))
}

fn required_text(label: &str, value: &str) -> AppResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn russh_error(error: russh::Error) -> AppError {
    AppError::ssh(error.to_string())
}

fn key_error(error: keys::Error) -> AppError {
    AppError::credential(format!("SSH 私钥解析失败: {error}"))
}

fn agent_error(error: keys::Error) -> AppError {
    AppError::credential(format!("SSH agent 连接失败: {error}"))
}

struct NativeSshReader {
    receiver: std_mpsc::Receiver<Vec<u8>>,
    pending: Vec<u8>,
    offset: usize,
}

impl NativeSshReader {
    fn new(receiver: std_mpsc::Receiver<Vec<u8>>) -> Self {
        Self {
            receiver,
            pending: Vec::new(),
            offset: 0,
        }
    }
}

impl Read for NativeSshReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        if buffer.is_empty() {
            return Ok(0);
        }

        while self.offset >= self.pending.len() {
            match self.receiver.recv() {
                Ok(next) if next.is_empty() => continue,
                Ok(next) => {
                    self.pending = next;
                    self.offset = 0;
                }
                Err(_) => return Ok(0),
            }
        }

        let available = self.pending.len() - self.offset;
        let read = available.min(buffer.len());
        buffer[..read].copy_from_slice(&self.pending[self.offset..self.offset + read]);
        self.offset += read;
        if self.offset >= self.pending.len() {
            self.pending.clear();
            self.offset = 0;
        }
        Ok(read)
    }
}

struct NativeSshWriter {
    sender: tokio_mpsc::UnboundedSender<NativeSshCommand>,
}

impl Write for NativeSshWriter {
    fn write(&mut self, buffer: &[u8]) -> std::io::Result<usize> {
        self.sender
            .send(NativeSshCommand::Input(buffer.to_vec()))
            .map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::BrokenPipe, "SSH channel closed")
            })?;
        Ok(buffer.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn ssh_target(session: &SavedSession) -> String {
    if session.username.trim().is_empty() {
        session.host.clone()
    } else {
        format!("{}@{}", session.username, session.host)
    }
}

fn push_tunnel_args(args: &mut Vec<String>, tunnel: &SshTunnel) -> AppResult<()> {
    match tunnel.kind {
        SshTunnelKind::Local => {
            let local_port = tunnel_port("本地端口", tunnel.local_port)?;
            let remote_host = tunnel_host("远程主机", tunnel.remote_host.as_deref())?;
            let remote_port = tunnel_port("远程端口", tunnel.remote_port)?;
            args.push("-L".to_string());
            args.push(format!(
                "{}:{local_port}:{remote_host}:{remote_port}",
                tunnel_bind(tunnel)
            ));
        }
        SshTunnelKind::Remote => {
            let local_port = tunnel_port("远程绑定端口", tunnel.local_port)?;
            let remote_host = tunnel_host("目标主机", tunnel.remote_host.as_deref())?;
            let remote_port = tunnel_port("目标端口", tunnel.remote_port)?;
            args.push("-R".to_string());
            args.push(format!(
                "{}:{local_port}:{remote_host}:{remote_port}",
                tunnel_bind(tunnel)
            ));
        }
        SshTunnelKind::Dynamic => {
            let local_port = tunnel_port("动态端口", tunnel.local_port)?;
            args.push("-D".to_string());
            args.push(format!("{}:{local_port}", tunnel_bind(tunnel)));
        }
        SshTunnelKind::RemoteDynamic => {
            let local_port = tunnel_port("远端 SOCKS 端口", tunnel.local_port)?;
            args.push("-R".to_string());
            args.push(format!("{}:{local_port}", tunnel_bind(tunnel)));
        }
    }
    Ok(())
}

fn tunnel_bind(tunnel: &SshTunnel) -> String {
    tunnel
        .bind_address
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string()
}

fn tunnel_host(label: &str, value: Option<&str>) -> AppResult<String> {
    value
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .map(ToOwned::to_owned)
        .ok_or_else(|| AppError::validation(format!("SSH 隧道{label}不能为空")))
}

fn tunnel_port(label: &str, value: Option<u16>) -> AppResult<u16> {
    value
        .filter(|port| *port > 0)
        .ok_or_else(|| AppError::validation(format!("SSH 隧道{label}必须在 1 到 65535 之间")))
}

fn container_command(
    container: &crate::models::session::SshContainerOptions,
    container_id: &str,
) -> AppResult<String> {
    let runtime = normalize_container_runtime(&container.runtime)?;
    let container_id = normalize_token(container_id)
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

fn normalize_token(value: &str) -> Option<String> {
    normalize_text(Some(value))
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

fn native_pty_modes() -> Vec<(Pty, u32)> {
    vec![
        (Pty::VINTR, 3),
        (Pty::VEOF, 4),
        (Pty::VERASE, 127),
        (Pty::ICRNL, 1),
        (Pty::IXON, 1),
        (Pty::ISIG, 1),
        (Pty::ICANON, 1),
        (Pty::ECHO, 1),
        (Pty::ECHOE, 1),
        (Pty::ECHOK, 1),
        (Pty::IEXTEN, 1),
        (Pty::OPOST, 1),
        (Pty::ONLCR, 1),
        (Pty::CS8, 1),
        (Pty::TTY_OP_ISPEED, 38400),
        (Pty::TTY_OP_OSPEED, 38400),
    ]
}
