// Author: Liz
use std::{
    fs::OpenOptions,
    io::{Cursor, Read, Write},
    net::{Shutdown, SocketAddr, TcpStream as StdTcpStream},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use portable_pty::{ChildKiller, CommandBuilder};
use russh::{
    client,
    keys::{
        self, agent::AgentIdentity, load_secret_key, PrivateKey, PrivateKeyWithHashAlg, PublicKey,
    },
    ChannelMsg, Pty,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::{mpsc as tokio_mpsc, oneshot},
};

use crate::{
    error::{AppError, AppResult},
    models::session::{AuthMode, SavedSession, SessionType, SshTunnel, SshTunnelKind},
    services::{
        credential_service::read_system_secret,
        local_pty_service::{spawn_pty_command, PtySpawn},
        ssh_command_service::SshCommandSecretResolver,
        ssh_container_service::{build_container_exec_command, enabled_container_options},
    },
};

const TUNNEL_BRIDGE_READY_MARKER: &str = "__ZTERM_TUNNEL_BRIDGE_READY__";
const TUNNEL_BRIDGE_AUTH_TIMEOUT: Duration = Duration::from_secs(30);

pub struct SshTerminalSpawn {
    pub runtime: SshTerminalRuntime,
    pub auth_secret: Option<String>,
    pub tunnel_bridges: Vec<SshTunnelBridge>,
}

pub enum SshTerminalRuntime {
    Pty(PtySpawn),
    Native(NativeSshRuntime),
    TunnelOnly(TunnelOnlySshRuntime),
}

pub struct TunnelOnlySshRuntime {
    pub reader: Box<dyn Read + Send>,
    pub keepalive: std_mpsc::Sender<Vec<u8>>,
}

pub struct NativeSshRuntime {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    pub control: NativeSshControl,
    pub exit_status: Arc<Mutex<Option<i32>>>,
}

pub struct SshTunnelBridge {
    shutdown: Option<oneshot::Sender<()>>,
    cancelled: Arc<AtomicBool>,
    child_killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    _thread: Option<JoinHandle<()>>,
}

impl Drop for SshTunnelBridge {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        if let Ok(mut child_killer) = self.child_killer.lock() {
            if let Some(killer) = child_killer.as_mut() {
                let _ = killer.kill();
            }
            child_killer.take();
        }
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SshTerminalLaunchMode {
    Interactive,
    ExclusiveTunnel,
}

pub fn spawn_ssh_terminal(
    session: &SavedSession,
    cols: u16,
    rows: u16,
) -> AppResult<SshTerminalSpawn> {
    spawn_ssh_terminal_with_resolver(session, cols, rows, &SystemSshSecretResolver, false)
}

pub fn spawn_ssh_terminal_with_resolver(
    session: &SavedSession,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
    single_channel: bool,
) -> AppResult<SshTerminalSpawn> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported(
            "only SSH sessions can open an SSH terminal",
        ));
    }

    if ssh_terminal_launch_mode(session, single_channel) == SshTerminalLaunchMode::ExclusiveTunnel {
        return spawn_exclusive_tunnel_terminal(session, secrets);
    }

    if requires_system_ssh(session) {
        return spawn_system_ssh_terminal(session, cols, rows, secrets);
    }

    spawn_native_ssh_terminal(session, cols, rows, secrets)
}

pub fn ssh_terminal_launch_mode(
    session: &SavedSession,
    single_channel: bool,
) -> SshTerminalLaunchMode {
    let has_open_tunnel = session
        .ssh_options
        .as_ref()
        .is_some_and(|options| options.tunnels.iter().any(|tunnel| tunnel.auto_open));
    if single_channel && has_open_tunnel {
        SshTerminalLaunchMode::ExclusiveTunnel
    } else {
        SshTerminalLaunchMode::Interactive
    }
}

fn spawn_exclusive_tunnel_terminal(
    session: &SavedSession,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    let tunnel = session
        .ssh_options
        .as_ref()
        .and_then(|options| options.tunnels.iter().find(|tunnel| tunnel.auto_open))
        .ok_or_else(|| AppError::validation("隧道独占模式需要一条自动打开的 SSH 隧道"))?;
    let auth_secret = match session.auth_mode {
        AuthMode::Password | AuthMode::Key => session
            .credential_ref
            .as_deref()
            .map(|credential_ref| secrets.secret_for(credential_ref))
            .transpose()?,
        AuthMode::Agent | AuthMode::None => None,
    };
    let mut bridge_session = session.clone();
    if let Some(options) = bridge_session.ssh_options.as_mut() {
        options.tunnels.clear();
    }
    let (keepalive, receiver) = std_mpsc::channel();
    let target = NativeSshTarget::from_session_with_auth_secret(&bridge_session, auth_secret)?;
    let bridge = spawn_native_exclusive_tunnel_bridge(target, tunnel, Some(keepalive.clone()))?;
    let _ = keepalive.send(
        "\r\n单通道临时 SSH 已进入隧道独占模式。\r\n首次本地连接将使用一次性凭据，当前终端不可交互。\r\n"
            .as_bytes()
            .to_vec(),
    );
    Ok(SshTerminalSpawn {
        runtime: SshTerminalRuntime::TunnelOnly(TunnelOnlySshRuntime {
            reader: Box::new(TunnelOnlyReader::new(receiver)),
            keepalive,
        }),
        auth_secret: None,
        tunnel_bridges: vec![bridge],
    })
}

struct TunnelOnlyReader {
    receiver: std_mpsc::Receiver<Vec<u8>>,
    pending: Cursor<Vec<u8>>,
}

impl TunnelOnlyReader {
    fn new(receiver: std_mpsc::Receiver<Vec<u8>>) -> Self {
        Self {
            receiver,
            pending: Cursor::new(Vec::new()),
        }
    }
}

impl Read for TunnelOnlyReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let read = Read::read(&mut self.pending, buffer)?;
            if read > 0 {
                return Ok(read);
            }
            match self.receiver.recv() {
                Ok(data) => self.pending = Cursor::new(data),
                Err(_) => return Ok(0),
            }
        }
    }
}

fn spawn_system_ssh_terminal(
    session: &SavedSession,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    let args = build_ssh_arguments(session)?;
    spawn_system_ssh_terminal_with_args(session, args, cols, rows, secrets)
}

pub fn spawn_ssh_container_terminal(
    session: &SavedSession,
    container_id: &str,
    cols: u16,
    rows: u16,
) -> AppResult<SshTerminalSpawn> {
    spawn_ssh_container_terminal_with_resolver(
        session,
        container_id,
        cols,
        rows,
        &SystemSshSecretResolver,
    )
}

pub fn spawn_ssh_container_terminal_with_resolver(
    session: &SavedSession,
    container_id: &str,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    if ssh_container_terminal_transport(session) == SshContainerTerminalTransport::Native {
        let container = enabled_container_options(session)?;
        let command = container_command(container, container_id)?;
        return spawn_native_ssh_exec_terminal(session, command, cols, rows, secrets);
    }
    let args = build_ssh_container_arguments(session, container_id)?;
    spawn_system_ssh_terminal_with_args(session, args, cols, rows, secrets)
}

fn spawn_system_ssh_terminal_with_args(
    session: &SavedSession,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    let mut command = CommandBuilder::new("ssh");
    for arg in &args {
        command.arg(arg.as_str());
    }

    let auth_secret = match session.auth_mode {
        AuthMode::Password | AuthMode::Key => session
            .credential_ref
            .as_deref()
            .map(|credential_ref| secrets.secret_for(credential_ref))
            .transpose()?,
        AuthMode::Agent | AuthMode::None => None,
    };

    let pty =
        spawn_pty_command(command, cols, rows).map_err(|error| AppError::ssh(error.to_string()))?;
    let tunnel_bridges = spawn_session_tunnel_bridges(session, secrets)?;
    Ok(SshTerminalSpawn {
        runtime: SshTerminalRuntime::Pty(pty),
        auth_secret,
        tunnel_bridges,
    })
}

fn spawn_native_ssh_terminal(
    session: &SavedSession,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    spawn_native_ssh_runtime(session, NativeSshStartup::Shell, cols, rows, secrets)
}

fn spawn_native_ssh_exec_terminal(
    session: &SavedSession,
    command: String,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    spawn_native_ssh_runtime(
        session,
        NativeSshStartup::Exec(command),
        cols,
        rows,
        secrets,
    )
}

fn spawn_native_ssh_runtime(
    session: &SavedSession,
    startup: NativeSshStartup,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    let target = NativeSshTarget::from_session(session, secrets)?;
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
                    startup,
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
        tunnel_bridges: Vec::new(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeSshStartup {
    Shell,
    Exec(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SshContainerTerminalTransport {
    Native,
    System,
}

fn ssh_container_terminal_transport(session: &SavedSession) -> SshContainerTerminalTransport {
    if requires_system_ssh(session) {
        SshContainerTerminalTransport::System
    } else {
        SshContainerTerminalTransport::Native
    }
}

fn requires_system_ssh(session: &SavedSession) -> bool {
    if requires_system_ssh_for_gateway_identity(session) {
        return true;
    }
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

fn requires_system_ssh_for_gateway_identity(session: &SavedSession) -> bool {
    session.username.trim().starts_with("b64>>")
}

fn requires_session_tunnel_bridge(session: &SavedSession) -> bool {
    requires_system_ssh_for_gateway_identity(session)
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
        if !requires_session_tunnel_bridge(session) {
            for tunnel in options.tunnels.iter().filter(|tunnel| tunnel.auto_open) {
                push_tunnel_args(&mut args, tunnel)?;
            }
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
    startup: NativeSshStartup,
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
    match startup {
        NativeSshStartup::Shell => {
            channel.request_shell(true).await.map_err(russh_error)?;
        }
        NativeSshStartup::Exec(command) => {
            channel.exec(true, command).await.map_err(russh_error)?;
        }
    }
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
    fn from_session(
        session: &SavedSession,
        secrets: &dyn SshCommandSecretResolver,
    ) -> AppResult<Self> {
        let auth_secret = match session.auth_mode {
            AuthMode::Password => {
                let credential_ref = required_credential_ref(session, "密码认证需要凭据引用")?;
                Some(secrets.secret_for(credential_ref)?)
            }
            AuthMode::Key => session
                .credential_ref
                .as_deref()
                .map(|credential_ref| secrets.secret_for(credential_ref))
                .transpose()?,
            AuthMode::Agent | AuthMode::None => None,
        };
        Self::from_session_with_auth_secret(session, auth_secret)
    }

    fn from_session_with_auth_secret(
        session: &SavedSession,
        auth_secret: Option<String>,
    ) -> AppResult<Self> {
        let host = required_text("主机", &session.host)?;
        let username = required_text("用户名", &session.username)?;
        if session.port == 0 {
            return Err(AppError::validation("端口必须大于 0"));
        }
        let auth = match session.auth_mode {
            AuthMode::Password => NativeSshAuth::Password(
                auth_secret.ok_or_else(|| AppError::credential("密码认证需要凭据"))?,
            ),
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
                NativeSshAuth::PrivateKey {
                    identity_file: PathBuf::from(identity_file),
                    passphrase: auth_secret,
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

struct SystemSshSecretResolver;

impl SshCommandSecretResolver for SystemSshSecretResolver {
    fn secret_for(&self, credential_ref: &str) -> AppResult<String> {
        read_system_secret(credential_ref)
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

fn spawn_native_exclusive_tunnel_bridge(
    target: NativeSshTarget,
    tunnel: &SshTunnel,
    status: Option<std_mpsc::Sender<Vec<u8>>>,
) -> AppResult<SshTunnelBridge> {
    if tunnel.kind != SshTunnelKind::Local {
        return Err(AppError::unsupported(
            "单通道临时 SSH 当前只支持访问主机服务本地隧道",
        ));
    }
    let local_port = tunnel_port("本地端口", tunnel.local_port)?;
    let remote_host = tunnel_host("远程主机", tunnel.remote_host.as_deref())?;
    let remote_port = tunnel_port("远程端口", tunnel.remote_port)?;
    let bind_addr = format!("{}:{local_port}", tunnel_bind(tunnel))
        .parse::<SocketAddr>()
        .map_err(|_| AppError::validation("SSH 隧道本地监听地址无效"))?;
    let (shutdown_sender, shutdown_receiver) = oneshot::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let child_killer = Arc::new(Mutex::new(None));
    let failure_status = status.clone();
    let thread = thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| AppError::ssh(error.to_string()))
            .and_then(|runtime| {
                runtime.block_on(run_native_exclusive_tunnel_bridge(
                    bind_addr,
                    remote_host,
                    remote_port,
                    target,
                    status,
                    shutdown_receiver,
                ))
            });
        if let Err(error) = result {
            eprintln!("[zTerm] native exclusive SSH tunnel failed: {error}");
            send_tunnel_status(
                failure_status.as_ref(),
                format!("\r\nSSH 隧道启动失败：{error}\r\n"),
            );
        }
    });
    Ok(SshTunnelBridge {
        shutdown: Some(shutdown_sender),
        cancelled,
        child_killer,
        _thread: Some(thread),
    })
}

async fn run_native_exclusive_tunnel_bridge(
    bind_addr: SocketAddr,
    remote_host: String,
    remote_port: u16,
    target: NativeSshTarget,
    status: Option<std_mpsc::Sender<Vec<u8>>>,
    mut shutdown: oneshot::Receiver<()>,
) -> AppResult<()> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|error| AppError::ssh(format!("SSH 隧道监听 {bind_addr} 失败: {error}")))?;
    let accepted = tokio::select! {
        _ = &mut shutdown => return Ok(()),
        accepted = listener.accept() => accepted,
    };
    let (local, _) =
        accepted.map_err(|error| AppError::ssh(format!("SSH 隧道接收连接失败: {error}")))?;
    drop(listener);
    send_tunnel_status(status.as_ref(), "\r\n正在建立独占 SSH 隧道…\r\n");
    let connection =
        run_native_exclusive_tunnel_connection(local, target, remote_host, remote_port);
    tokio::select! {
        _ = &mut shutdown => Ok(()),
        result = connection => result,
    }?;
    send_tunnel_status(status.as_ref(), "\r\n独占 SSH 隧道已关闭。\r\n");
    Ok(())
}

async fn run_native_exclusive_tunnel_connection(
    mut local: TcpStream,
    target: NativeSshTarget,
    remote_host: String,
    remote_port: u16,
) -> AppResult<()> {
    let mut handle = connect_native_ssh(&target).await?;
    authenticate_native_ssh(&mut handle, &target).await?;
    let channel = handle.channel_open_session().await.map_err(russh_error)?;
    let pty_modes = native_pty_modes();
    channel
        .request_pty(true, "xterm-256color", 120, 32, 0, 0, &pty_modes)
        .await
        .map_err(russh_error)?;
    channel.request_shell(true).await.map_err(russh_error)?;
    let (mut channel_reader, channel_writer) = channel.split();
    let start_command = system_tunnel_bridge_start_command(&remote_host, remote_port);

    tokio::time::timeout(TUNNEL_BRIDGE_AUTH_TIMEOUT, async {
        let mut output = Vec::new();
        let mut wrote_start_command = false;
        loop {
            let message = channel_reader
                .wait()
                .await
                .ok_or_else(|| AppError::ssh("SSH 隧道桥接远端连接已关闭"))?;
            match message {
                ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                    output.extend_from_slice(data.as_ref());
                    let text = String::from_utf8_lossy(&output);
                    if !wrote_start_command && system_bridge_shell_prompt_seen(&text) {
                        channel_writer
                            .data_bytes(format!("{start_command}\r").into_bytes())
                            .await
                            .map_err(russh_error)?;
                        wrote_start_command = true;
                    }
                    if wrote_start_command && text.contains(TUNNEL_BRIDGE_READY_MARKER) {
                        return Ok(());
                    }
                    if output.len() > 64 * 1024 {
                        let keep_from = output.len().saturating_sub(16 * 1024);
                        output = output.split_off(keep_from);
                    }
                }
                ChannelMsg::Close => {
                    return Err(AppError::ssh("SSH 隧道桥接远端连接已关闭"));
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| AppError::ssh("SSH 隧道桥接等待远端 shell 超时"))??;

    let mut local_buffer = vec![0_u8; 16 * 1024];
    loop {
        tokio::select! {
            read = local.read(&mut local_buffer) => {
                let read = read.map_err(|error| AppError::ssh(format!("SSH 隧道读取本地连接失败: {error}")))?;
                if read == 0 {
                    let _ = channel_writer.eof().await;
                    break;
                }
                channel_writer
                    .data_bytes(local_buffer[..read].to_vec())
                    .await
                    .map_err(russh_error)?;
            }
            message = channel_reader.wait() => {
                let Some(message) = message else { break; };
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        local
                            .write_all(data.as_ref())
                            .await
                            .map_err(|error| AppError::ssh(format!("SSH 隧道写入本地连接失败: {error}")))?;
                    }
                    ChannelMsg::Close | ChannelMsg::Eof => break,
                    _ => {}
                }
            }
        }
    }
    let _ = channel_writer.close().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "tunnel closed", "")
        .await;
    Ok(())
}

fn spawn_session_tunnel_bridges(
    session: &SavedSession,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<Vec<SshTunnelBridge>> {
    if !requires_session_tunnel_bridge(session) {
        return Ok(Vec::new());
    }
    let Some(options) = session.ssh_options.as_ref() else {
        return Ok(Vec::new());
    };
    let tunnels = options
        .tunnels
        .iter()
        .filter(|tunnel| tunnel.auto_open)
        .collect::<Vec<_>>();
    if tunnels.is_empty() {
        return Ok(Vec::new());
    }

    let auth_secret = match session.auth_mode {
        AuthMode::Password | AuthMode::Key => session
            .credential_ref
            .as_deref()
            .map(|credential_ref| secrets.secret_for(credential_ref))
            .transpose()?,
        AuthMode::Agent | AuthMode::None => None,
    };
    tunnels
        .into_iter()
        .map(|tunnel| spawn_session_tunnel_bridge(session, auth_secret.clone(), tunnel, None))
        .collect()
}

fn spawn_session_tunnel_bridge(
    session: &SavedSession,
    auth_secret: Option<String>,
    tunnel: &SshTunnel,
    status: Option<std_mpsc::Sender<Vec<u8>>>,
) -> AppResult<SshTunnelBridge> {
    if tunnel.kind != SshTunnelKind::Local {
        return Err(AppError::unsupported(
            "BHost 临时 SSH 当前只支持访问主机服务本地隧道",
        ));
    }
    let local_port = tunnel_port("本地端口", tunnel.local_port)?;
    let remote_host = tunnel_host("远程主机", tunnel.remote_host.as_deref())?;
    let remote_port = tunnel_port("远程端口", tunnel.remote_port)?;
    let bind = tunnel_bind(tunnel);
    let bind_addr = format!("{bind}:{local_port}")
        .parse::<SocketAddr>()
        .map_err(|_| AppError::validation("SSH 隧道本地监听地址无效"))?;
    let session = session.clone();
    let (shutdown_sender, shutdown_receiver) = oneshot::channel();
    let cancelled = Arc::new(AtomicBool::new(false));
    let child_killer = Arc::new(Mutex::new(None));
    let bridge_cancelled = Arc::clone(&cancelled);
    let bridge_child_killer = Arc::clone(&child_killer);
    let failure_status = status.clone();
    let thread = thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| AppError::ssh(error.to_string()))
            .and_then(|runtime| {
                runtime.block_on(run_session_tunnel_bridge(
                    bind_addr,
                    remote_host,
                    remote_port,
                    session,
                    auth_secret,
                    status,
                    bridge_cancelled,
                    bridge_child_killer,
                    shutdown_receiver,
                ))
            });
        if let Err(error) = result {
            eprintln!("[zTerm] SSH tunnel bridge failed: {error}");
            send_tunnel_status(
                failure_status.as_ref(),
                format!("\r\nSSH 隧道启动失败：{error}\r\n"),
            );
        }
    });
    Ok(SshTunnelBridge {
        shutdown: Some(shutdown_sender),
        cancelled,
        child_killer,
        _thread: Some(thread),
    })
}

async fn run_session_tunnel_bridge(
    bind_addr: SocketAddr,
    remote_host: String,
    remote_port: u16,
    session: SavedSession,
    auth_secret: Option<String>,
    status: Option<std_mpsc::Sender<Vec<u8>>>,
    cancelled: Arc<AtomicBool>,
    child_killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
    mut shutdown: oneshot::Receiver<()>,
) -> AppResult<()> {
    let listener = TcpListener::bind(bind_addr)
        .await
        .map_err(|error| AppError::ssh(format!("SSH 隧道监听 {bind_addr} 失败: {error}")))?;
    let accepted = tokio::select! {
        _ = &mut shutdown => return Ok(()),
        accepted = listener.accept() => accepted,
    };
    let (stream, _) =
        accepted.map_err(|error| AppError::ssh(format!("SSH 隧道接收连接失败: {error}")))?;
    drop(listener);
    send_tunnel_status(status.as_ref(), "\r\n正在建立独占 SSH 隧道…\r\n");
    handle_session_tunnel_connection(
        stream,
        remote_host,
        remote_port,
        session,
        auth_secret,
        cancelled,
        child_killer,
    )
    .await?;
    send_tunnel_status(status.as_ref(), "\r\n独占 SSH 隧道已关闭。\r\n");
    Ok(())
}

async fn handle_session_tunnel_connection(
    local: TcpStream,
    remote_host: String,
    remote_port: u16,
    session: SavedSession,
    auth_secret: Option<String>,
    cancelled: Arc<AtomicBool>,
    child_killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
) -> AppResult<()> {
    let result = match local.into_std() {
        Ok(local) => tokio::task::spawn_blocking(move || {
            handle_system_session_tunnel_connection(
                local,
                session,
                auth_secret,
                remote_host,
                remote_port,
                cancelled,
                child_killer,
            )
        })
        .await
        .unwrap_or_else(|error| Err(AppError::ssh(format!("SSH 隧道桥接线程失败: {error}")))),
        Err(error) => Err(AppError::ssh(format!("SSH 隧道本地连接转换失败: {error}"))),
    };
    if let Err(error) = &result {
        eprintln!("[zTerm] SSH tunnel bridge connection failed: {error}");
    }
    result
}

fn handle_system_session_tunnel_connection(
    local: StdTcpStream,
    session: SavedSession,
    auth_secret: Option<String>,
    remote_host: String,
    remote_port: u16,
    cancelled: Arc<AtomicBool>,
    child_killer: Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
) -> AppResult<()> {
    tunnel_bridge_debug_log("accepted local tunnel connection");
    local
        .set_nonblocking(false)
        .map_err(|error| AppError::ssh(format!("SSH 隧道本地连接阻塞模式设置失败: {error}")))?;
    let args = build_ssh_arguments(&session)?;
    let mut command = CommandBuilder::new("ssh");
    for arg in &args {
        command.arg(arg.as_str());
    }
    let PtySpawn {
        master,
        mut child,
        reader,
        mut writer,
    } = spawn_pty_command(command, 120, 32).map_err(|error| AppError::ssh(error.to_string()))?;

    if let Ok(mut registered_killer) = child_killer.lock() {
        *registered_killer = Some(child.clone_killer());
    }
    if cancelled.load(Ordering::Acquire) {
        let _ = child.kill();
        clear_tunnel_child_killer(&child_killer);
        return Err(AppError::ssh("SSH 隧道已取消"));
    }

    let output = spawn_tunnel_pty_output_reader(reader);

    if let Err(error) = prepare_system_tunnel_bridge(
        &output,
        writer.as_mut(),
        auth_secret.as_deref(),
        &remote_host,
        remote_port,
        TUNNEL_BRIDGE_AUTH_TIMEOUT,
    ) {
        let _ = child.kill();
        clear_tunnel_child_killer(&child_killer);
        drop(master);
        return Err(error);
    }
    tunnel_bridge_debug_log("system bridge prepared; starting bidirectional copy");

    let mut local_reader = local
        .try_clone()
        .map_err(|error| AppError::ssh(format!("SSH 隧道本地连接复制失败: {error}")))?;
    let mut local_writer = local;
    let upstream = thread::spawn(move || {
        let _ = std::io::copy(&mut local_reader, &mut writer);
    });
    let mut downstream_reader = TunnelPtyReader::new(output);
    let downstream = thread::spawn(move || {
        let _ = std::io::copy(&mut downstream_reader, &mut local_writer);
        let _ = local_writer.shutdown(Shutdown::Both);
    });
    let _ = upstream.join();
    let _ = downstream.join();
    let _ = child.kill();
    clear_tunnel_child_killer(&child_killer);
    drop(master);
    tunnel_bridge_debug_log("system bridge connection closed");
    Ok(())
}

fn prepare_system_tunnel_bridge(
    output_receiver: &std_mpsc::Receiver<std::io::Result<Vec<u8>>>,
    writer: &mut dyn Write,
    auth_secret: Option<&str>,
    remote_host: &str,
    remote_port: u16,
    timeout: Duration,
) -> AppResult<()> {
    let start_command = system_tunnel_bridge_start_command(remote_host, remote_port);
    let mut output_buffer = Vec::new();
    let mut wrote_secret = false;
    let mut wrote_start_command = false;
    let started = Instant::now();

    loop {
        let remaining = timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            return Err(AppError::ssh("SSH 隧道桥接等待远端 shell 超时"));
        }
        let chunk = match output_receiver.recv_timeout(remaining) {
            Ok(Ok(chunk)) => chunk,
            Ok(Err(error)) => {
                return Err(AppError::ssh(format!(
                    "SSH 隧道桥接读取远端输出失败: {error}"
                )))
            }
            Err(std_mpsc::RecvTimeoutError::Timeout) => {
                return Err(AppError::ssh("SSH 隧道桥接等待远端 shell 超时"))
            }
            Err(std_mpsc::RecvTimeoutError::Disconnected) => {
                return Err(AppError::ssh("SSH 隧道桥接远端连接已关闭"))
            }
        };
        output_buffer.extend_from_slice(&chunk);
        let text = String::from_utf8_lossy(&output_buffer).to_string();
        if !wrote_secret && system_bridge_should_answer_auth_prompt(&text) {
            if let Some(secret) = auth_secret {
                tunnel_bridge_debug_log("answering SSH bridge auth prompt");
                writer
                    .write_all(format!("{secret}\r").as_bytes())
                    .map_err(|error| AppError::ssh(format!("SSH 隧道桥接写入认证失败: {error}")))?;
                writer
                    .flush()
                    .map_err(|error| AppError::ssh(format!("SSH 隧道桥接刷新认证失败: {error}")))?;
                wrote_secret = true;
            }
        }
        if !wrote_start_command && system_bridge_shell_prompt_seen(&text) {
            tunnel_bridge_debug_log("shell prompt seen; writing tunnel bridge start command");
            writer
                .write_all(format!("{start_command}\r").as_bytes())
                .map_err(|error| AppError::ssh(format!("SSH 隧道桥接写入启动命令失败: {error}")))?;
            writer
                .flush()
                .map_err(|error| AppError::ssh(format!("SSH 隧道桥接刷新启动命令失败: {error}")))?;
            wrote_start_command = true;
        }
        if wrote_start_command && text.contains(TUNNEL_BRIDGE_READY_MARKER) {
            tunnel_bridge_debug_log("tunnel bridge ready marker seen");
            return Ok(());
        }
        if output_buffer.len() > 64 * 1024 {
            let keep_from = output_buffer.len().saturating_sub(16 * 1024);
            output_buffer = output_buffer.split_off(keep_from);
        }
    }
}

fn spawn_tunnel_pty_output_reader(
    mut reader: Box<dyn Read + Send>,
) -> std_mpsc::Receiver<std::io::Result<Vec<u8>>> {
    let (sender, receiver) = std_mpsc::channel();
    thread::spawn(move || loop {
        let mut buffer = vec![0_u8; 4096];
        match reader.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => {
                buffer.truncate(read);
                if sender.send(Ok(buffer)).is_err() {
                    break;
                }
            }
            Err(error) => {
                let _ = sender.send(Err(error));
                break;
            }
        }
    });
    receiver
}

struct TunnelPtyReader {
    receiver: std_mpsc::Receiver<std::io::Result<Vec<u8>>>,
    pending: Cursor<Vec<u8>>,
}

impl TunnelPtyReader {
    fn new(receiver: std_mpsc::Receiver<std::io::Result<Vec<u8>>>) -> Self {
        Self {
            receiver,
            pending: Cursor::new(Vec::new()),
        }
    }
}

impl Read for TunnelPtyReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        loop {
            let read = Read::read(&mut self.pending, buffer)?;
            if read > 0 {
                return Ok(read);
            }
            match self.receiver.recv() {
                Ok(Ok(data)) => self.pending = Cursor::new(data),
                Ok(Err(error)) => return Err(error),
                Err(_) => return Ok(0),
            }
        }
    }
}

fn clear_tunnel_child_killer(
    child_killer: &Arc<Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>>,
) {
    if let Ok(mut registered_killer) = child_killer.lock() {
        registered_killer.take();
    }
}

fn send_tunnel_status(status: Option<&std_mpsc::Sender<Vec<u8>>>, message: impl AsRef<str>) {
    if let Some(status) = status {
        let _ = status.send(message.as_ref().as_bytes().to_vec());
    }
}

fn tunnel_bridge_debug_log(message: &str) {
    let Ok(path) = std::env::var("ZTERM_TUNNEL_BRIDGE_LOG") else {
        return;
    };
    if path.trim().is_empty() {
        return;
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{message}");
    }
}

fn remote_tcp_bridge_command(remote_host: &str, remote_port: u16) -> String {
    let host = shell_quote(remote_host);
    let port = remote_port.to_string();
    let bash_bridge = shell_quote("exec 3<>/dev/tcp/\"$1\"/\"$2\"; cat <&3 & cat >&3; wait");
    format!(
        "host={host}; port={}; if command -v nc >/dev/null 2>&1; then exec nc \"$host\" \"$port\"; fi; if command -v ncat >/dev/null 2>&1; then exec ncat \"$host\" \"$port\"; fi; if command -v socat >/dev/null 2>&1; then exec socat - TCP:\"$host\":\"$port\"; fi; if command -v bash >/dev/null 2>&1; then exec bash -lc {bash_bridge} zterm-tunnel \"$host\" \"$port\"; fi; echo 'zTerm tunnel bridge requires nc, ncat, socat, or bash /dev/tcp on the remote host' >&2; exit 127",
        shell_quote(&port),
    )
}

fn system_tunnel_bridge_start_command(remote_host: &str, remote_port: u16) -> String {
    format!(
        "m1='__ZTERM_TUNNEL_'; m2='BRIDGE_READY__'; stty raw -echo; printf '\\n%s%s\\n' \"$m1\" \"$m2\"; {}",
        remote_tcp_bridge_command(remote_host, remote_port)
    )
}

fn system_bridge_should_answer_auth_prompt(data: &str) -> bool {
    let normalized = data.to_ascii_lowercase();
    normalized.contains("password:") || normalized.contains("passphrase for key")
}

fn system_bridge_shell_prompt_seen(data: &str) -> bool {
    let normalized = data.replace('\r', "\n");
    let tail = normalized
        .lines()
        .rev()
        .take(6)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join("\n");
    tail.contains("]# ")
        || tail.contains("]$ ")
        || tail.ends_with("# ")
        || tail.ends_with("$ ")
        || tail.contains("\n# ")
        || tail.contains("\n$ ")
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

fn shell_quote(value: &str) -> String {
    if value
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | '/' | ':'))
    {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\"'\"'"))
}

fn container_command(
    container: &crate::models::session::SshContainerOptions,
    container_id: &str,
) -> AppResult<String> {
    build_container_exec_command(container, container_id)
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

#[cfg(test)]
mod tests {
    use std::{
        io::Cursor,
        sync::mpsc,
        time::{Duration, Instant},
    };

    use super::{
        build_ssh_arguments, prepare_system_tunnel_bridge, remote_tcp_bridge_command,
        spawn_ssh_terminal_with_resolver, ssh_container_terminal_transport,
        ssh_terminal_launch_mode, system_bridge_shell_prompt_seen,
        system_tunnel_bridge_start_command, SshContainerTerminalTransport, SshTerminalLaunchMode,
        SshTerminalRuntime, SystemSshSecretResolver, TUNNEL_BRIDGE_READY_MARKER,
    };
    use crate::models::session::{
        AuthMode, SavedSession, SessionType, SshContainerOptions, SshOptions, SshTunnel,
        SshTunnelKind,
    };

    #[test]
    fn container_terminal_uses_native_transport_without_system_ssh_features() {
        let session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: Vec::new(),
            container: Some(container_options()),
        });

        assert_eq!(
            ssh_container_terminal_transport(&session),
            SshContainerTerminalTransport::Native
        );
    }

    #[test]
    fn container_terminal_keeps_system_transport_when_tunnels_are_active() {
        let session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: vec![SshTunnel {
                mode: Some("host_service".to_string()),
                name: Some("Web".to_string()),
                kind: SshTunnelKind::Local,
                auto_open: true,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(18080),
                remote_host: Some("10.11.0.71".to_string()),
                remote_port: Some(8080),
            }],
            container: Some(container_options()),
        });

        assert_eq!(
            ssh_container_terminal_transport(&session),
            SshContainerTerminalTransport::System
        );
    }

    #[test]
    fn container_terminal_keeps_system_transport_for_bhost_gateway_identity() {
        let mut session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: Vec::new(),
            container: Some(container_options()),
        });
        session.host = "172.21.195.223".to_string();
        session.port = 222;
        session.username =
            "b64>>d2VuOjE4NTU1MDQ2ODQzMTJAcm9vdEAxMC4xMS4wLjcxOjIyOlNTSDI=".to_string();

        assert_eq!(
            ssh_container_terminal_transport(&session),
            SshContainerTerminalTransport::System
        );
    }

    #[test]
    fn bhost_gateway_identity_excludes_open_ssh_tunnel_args_for_bridge_listener() {
        let mut session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: vec![SshTunnel {
                mode: Some("host_service".to_string()),
                name: Some("Web".to_string()),
                kind: SshTunnelKind::Local,
                auto_open: true,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(18040),
                remote_host: Some("127.0.0.1".to_string()),
                remote_port: Some(8040),
            }],
            container: Some(container_options()),
        });
        session.host = "172.21.195.223".to_string();
        session.port = 222;
        session.username =
            "b64>>d2VuOjE4NTU1MDQ2ODQzMTJAcm9vdEAxMC4xMS4wLjcxOjIyOlNTSDI=".to_string();

        let args = build_ssh_arguments(&session).expect("arguments should build");

        assert!(!args.iter().any(|arg| arg == "-L"));
        assert!(args.iter().any(|arg| arg
            == "b64>>d2VuOjE4NTU1MDQ2ODQzMTJAcm9vdEAxMC4xMS4wLjcxOjIyOlNTSDI=@172.21.195.223"));
    }

    #[test]
    fn single_channel_temporary_ssh_with_an_open_tunnel_uses_exclusive_tunnel_mode() {
        let session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: vec![SshTunnel {
                mode: Some("host_service".to_string()),
                name: Some("PostgreSQL".to_string()),
                kind: SshTunnelKind::Local,
                auto_open: true,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(15432),
                remote_host: Some("127.0.0.1".to_string()),
                remote_port: Some(35432),
            }],
            container: Some(container_options()),
        });

        assert_eq!(
            ssh_terminal_launch_mode(&session, true),
            SshTerminalLaunchMode::ExclusiveTunnel
        );
    }

    #[test]
    fn single_channel_temporary_ssh_without_an_open_tunnel_keeps_interactive_mode() {
        let session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: Vec::new(),
            container: Some(container_options()),
        });

        assert_eq!(
            ssh_terminal_launch_mode(&session, true),
            SshTerminalLaunchMode::Interactive
        );
    }

    #[test]
    fn non_single_channel_ssh_with_an_open_tunnel_keeps_interactive_mode() {
        let session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: vec![SshTunnel {
                mode: Some("host_service".to_string()),
                name: Some("PostgreSQL".to_string()),
                kind: SshTunnelKind::Local,
                auto_open: true,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(15432),
                remote_host: Some("127.0.0.1".to_string()),
                remote_port: Some(35432),
            }],
            container: Some(container_options()),
        });

        assert_eq!(
            ssh_terminal_launch_mode(&session, false),
            SshTerminalLaunchMode::Interactive
        );
    }

    #[test]
    fn exclusive_tunnel_mode_does_not_spawn_an_interactive_ssh_runtime() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("port should bind");
        let local_port = listener.local_addr().expect("address should exist").port();
        drop(listener);
        let mut session = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: vec![SshTunnel {
                mode: Some("host_service".to_string()),
                name: Some("PostgreSQL".to_string()),
                kind: SshTunnelKind::Local,
                auto_open: true,
                bind_address: Some("127.0.0.1".to_string()),
                local_port: Some(local_port),
                remote_host: Some("127.0.0.1".to_string()),
                remote_port: Some(35432),
            }],
            container: Some(container_options()),
        });
        session.auth_mode = AuthMode::None;
        session.credential_ref = None;

        let spawn =
            spawn_ssh_terminal_with_resolver(&session, 120, 32, &SystemSshSecretResolver, true)
                .expect("exclusive tunnel runtime should open");

        assert!(matches!(spawn.runtime, SshTerminalRuntime::TunnelOnly(_)));
        assert!(spawn.auth_secret.is_none());
        assert_eq!(spawn.tunnel_bridges.len(), 1);
    }

    #[test]
    fn remote_tcp_bridge_command_uses_remote_tcp_tools() {
        let command = remote_tcp_bridge_command("127.0.0.1", 8040);

        assert!(command.contains("exec nc"));
        assert!(command.contains("exec ncat"));
        assert!(command.contains("exec socat"));
        assert!(command.contains("/dev/tcp"));
        assert!(command.contains("8040"));
    }

    #[test]
    fn system_tunnel_bridge_start_command_enters_raw_mode_after_marker() {
        let command = system_tunnel_bridge_start_command("127.0.0.1", 8040);

        assert!(!command.contains(TUNNEL_BRIDGE_READY_MARKER));
        assert!(command.contains("__ZTERM_TUNNEL_"));
        assert!(command.contains("BRIDGE_READY__"));
        assert!(command.contains("stty raw -echo"));
        assert!(command.contains("/dev/tcp"));
        assert!(command.contains("8040"));
    }

    #[test]
    fn system_tunnel_bridge_auth_wait_has_a_real_timeout_without_pty_output() {
        let (_sender, receiver) = mpsc::channel();
        let mut writer = Cursor::new(Vec::new());
        let started = Instant::now();

        let error = prepare_system_tunnel_bridge(
            &receiver,
            &mut writer,
            None,
            "127.0.0.1",
            35432,
            Duration::from_millis(10),
        )
        .expect_err("silent SSH startup should time out");

        assert!(error.to_string().contains("等待远端 shell 超时"));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn system_tunnel_bridge_detects_bhost_shell_prompt() {
        let output = "Welcome to Alibaba Cloud Elastic Compute Service !\r\n[root@iZhl001dzgpupo8m7stjllZ ~]# ";

        assert!(system_bridge_shell_prompt_seen(output));
    }

    fn ssh_session_with_options(ssh_options: SshOptions) -> SavedSession {
        SavedSession {
            id: "external:launch-1".to_string(),
            name: "root@10.11.0.71".to_string(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: "10.11.0.71".to_string(),
            port: 22,
            username: "root".to_string(),
            auth_mode: AuthMode::Password,
            credential_ref: Some("external-secret:launch-1:password".to_string()),
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
            last_used_at_ms: None,
            ssh_options: Some(ssh_options),
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        }
    }

    fn container_options() -> SshContainerOptions {
        SshContainerOptions {
            enabled: true,
            runtime: "docker".to_string(),
            container: String::new(),
            shell: Some("/bin/sh".to_string()),
            user: None,
            workdir: None,
        }
    }
}
