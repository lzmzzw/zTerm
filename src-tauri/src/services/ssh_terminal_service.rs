// Author: Liz
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc as std_mpsc, Arc, Mutex,
    },
    thread,
    time::Duration,
};

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
        local_pty_service::PtySpawn,
        ssh_command_service::SshCommandSecretResolver,
        ssh_container_service::{build_container_exec_command, enabled_container_options},
        ssh_native_tunnels::{ForwardedTcpip, NativeTunnels},
    },
    validation::required_text,
};

const DEFAULT_KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const DEFAULT_KEEPALIVE_MAX: usize = 3;
const NATIVE_SSH_OUTPUT_CHUNK_BYTES: usize = 8 * 1024;
const NATIVE_SSH_OUTPUT_QUEUE_CAPACITY: usize = 128;

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
    spawn_ssh_terminal_with_resolver(session, cols, rows, &SystemSshSecretResolver)
}

pub fn spawn_ssh_terminal_with_resolver(
    session: &SavedSession,
    cols: u16,
    rows: u16,
    secrets: &dyn SshCommandSecretResolver,
) -> AppResult<SshTerminalSpawn> {
    if session.session_type != SessionType::Ssh {
        return Err(AppError::unsupported(
            "only SSH sessions can open an SSH terminal",
        ));
    }

    spawn_native_ssh_terminal(session, cols, rows, secrets)
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
    let container = enabled_container_options(session)?;
    let command = container_command(container, container_id)?;
    spawn_native_ssh_exec_terminal(session, command, cols, rows, secrets)
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
    let mut target = NativeSshTarget::from_session(session, secrets)?;
    if target
        .proxy_command
        .as_deref()
        .is_none_or(|command| command.trim().is_empty())
    {
        target.resolved_jumps = target
            .jump_hosts
            .iter()
            .filter(|hop| !hop.trim().is_empty())
            .map(|hop| {
                if let Some(saved) = super::ssh_command_service::matching_jump_session(
                    hop,
                    secrets.saved_ssh_sessions(),
                    &session.id,
                ) {
                    NativeSshTarget::from_session(saved, secrets)
                        .map(|target| NativeSshHop::Saved(Box::new(target)))
                } else {
                    Ok(NativeSshHop::OpenSsh(hop.clone()))
                }
            })
            .collect::<AppResult<_>>()?;
    }
    let (command_sender, command_receiver) = tokio_mpsc::unbounded_channel();
    let (output_sender, output_receiver) = tokio_mpsc::channel(NATIVE_SSH_OUTPUT_QUEUE_CAPACITY);
    let (output_receiver, _output_bridge) = spawn_native_ssh_output_bridge(output_receiver);
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
            // The terminal may already be closed while an error is being reported.
            // Do not block this worker thread behind a slow or detached reader.
            let _ = error_sender.try_send(format!("\r\n[SSH] {error}\r\n").into_bytes());
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

#[derive(Debug, Clone, PartialEq, Eq)]
enum NativeSshStartup {
    Shell,
    Exec(String),
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
    let keepalive_interval = effective_keepalive_interval(session);
    args.push("-o".to_string());
    args.push(format!(
        "ServerAliveInterval={}",
        keepalive_interval
            .map(|interval| interval.as_millis().div_ceil(1_000).max(1))
            .unwrap_or(0)
    ));
    if keepalive_interval.is_some() {
        args.push("-o".to_string());
        args.push(format!("ServerAliveCountMax={DEFAULT_KEEPALIVE_MAX}"));
    }
    args.push("-p".to_string());
    args.push(session.port.to_string());
    args.push(ssh_target(session));
    Ok(args)
}

fn effective_keepalive_interval(session: &SavedSession) -> Option<Duration> {
    match session
        .ssh_options
        .as_ref()
        .and_then(|options| options.keepalive_interval_ms)
    {
        Some(0) => None,
        Some(interval_ms) => Some(Duration::from_millis(interval_ms)),
        None => Some(DEFAULT_KEEPALIVE_INTERVAL),
    }
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
    output_sender: tokio_mpsc::Sender<Vec<u8>>,
    exit_status: Arc<Mutex<Option<i32>>>,
) -> AppResult<()> {
    let (forward_sender, forward_receiver) = tokio_mpsc::channel(256);
    let (auth_sender, auth_receiver) = tokio_mpsc::unbounded_channel();
    let auth_pending = Arc::new(AtomicBool::new(false));
    let mut interaction = NativeAuthInteraction {
        input: auth_receiver,
        output: output_sender.clone(),
        pending: Arc::clone(&auth_pending),
    };
    let setup = async {
        let (mut handle, jumps) =
            connect_native_ssh(&target, forward_sender, &mut interaction).await?;
        tokio::time::timeout(
            Duration::from_secs(60),
            authenticate_native_ssh(&mut handle, &target, &mut interaction),
        )
        .await
        .map_err(|_| AppError::ssh("SSH 认证超时"))??;
        let handle = Arc::new(handle);
        let tunnels =
            NativeTunnels::start(Arc::clone(&handle), &target.tunnels, forward_receiver).await?;
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
        Ok::<_, AppError>((handle, tunnels, jumps, channel))
    };
    // Closing a tab also cancels a proxy handshake, authentication or tunnel setup.
    let mut queued_commands = Vec::new();
    let (handle, mut tunnels, jumps, channel) = tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(120), setup) => result.map_err(|_| AppError::ssh("SSH 建立终端超时"))??,
        _ = wait_for_native_close(&mut command_receiver, &mut queued_commands, &auth_pending, &auth_sender) => return Ok(()),
    };
    let (mut reader, writer) = channel.split();
    for command in queued_commands {
        if !apply_native_ssh_command(Some(command), &writer).await? {
            return Ok(());
        }
    }
    let mut pending_output: Option<NativeSshPendingOutput> = None;

    loop {
        if let Some(pending) = pending_output.as_mut() {
            if pending.is_complete() {
                pending_output = None;
                continue;
            }
            match wait_for_native_ssh_output_slot_or_command(
                output_sender.clone(),
                &mut command_receiver,
            )
            .await
            {
                NativeSshOutputWait::Command(command) => {
                    if !apply_native_ssh_command(command, &writer).await? {
                        break;
                    }
                }
                NativeSshOutputWait::Ready(permit) => {
                    // Chunks cap the total queued output by bytes, while retaining every
                    // byte and its original order across slow reader periods.
                    permit.send(pending.next_chunk().to_vec());
                    pending.advance();
                }
                NativeSshOutputWait::OutputClosed => {
                    let _ = writer.close().await;
                    break;
                }
            }
            continue;
        }

        tokio::select! {
            command = command_receiver.recv() => {
                if !apply_native_ssh_command(command, &writer).await? {
                    break;
                }
            }
            message = reader.wait() => {
                let Some(message) = message else {
                    break;
                };
                match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => {
                        pending_output = Some(NativeSshPendingOutput::new(data.to_vec()));
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
                        pending_output = Some(NativeSshPendingOutput::new(message.into_bytes()));
                    }
                    ChannelMsg::Close => break,
                    _ => {}
                }
            }
        }
    }

    tunnels.shutdown().await;
    let _ = handle
        .disconnect(russh::Disconnect::ByApplication, "terminal closed", "")
        .await;
    for hop in jumps.into_iter().rev() {
        let _ = hop
            .disconnect(russh::Disconnect::ByApplication, "terminal closed", "")
            .await;
    }
    Ok(())
}

async fn apply_native_ssh_command(
    command: Option<NativeSshCommand>,
    writer: &russh::ChannelWriteHalf<client::Msg>,
) -> AppResult<bool> {
    match command {
        Some(NativeSshCommand::Input(data)) => {
            writer.data_bytes(data).await.map_err(russh_error)?;
            Ok(true)
        }
        Some(NativeSshCommand::Resize { cols, rows }) => {
            writer
                .window_change(u32::from(cols), u32::from(rows), 0, 0)
                .await
                .map_err(russh_error)?;
            Ok(true)
        }
        Some(NativeSshCommand::Close) | None => {
            let _ = writer.close().await;
            Ok(false)
        }
    }
}

async fn wait_for_native_close(
    receiver: &mut tokio_mpsc::UnboundedReceiver<NativeSshCommand>,
    queued: &mut Vec<NativeSshCommand>,
    auth_pending: &AtomicBool,
    auth_sender: &tokio_mpsc::UnboundedSender<Vec<u8>>,
) {
    while let Some(command) = receiver.recv().await {
        if matches!(command, NativeSshCommand::Close) {
            return;
        }
        if auth_pending.load(Ordering::SeqCst) {
            if let NativeSshCommand::Input(data) = command {
                let _ = auth_sender.send(data);
                continue;
            }
        }
        queued.push(command);
    }
}

enum NativeSshOutputWait {
    Command(Option<NativeSshCommand>),
    Ready(tokio_mpsc::OwnedPermit<Vec<u8>>),
    OutputClosed,
}

async fn wait_for_native_ssh_output_slot_or_command(
    output_sender: tokio_mpsc::Sender<Vec<u8>>,
    command_receiver: &mut tokio_mpsc::UnboundedReceiver<NativeSshCommand>,
) -> NativeSshOutputWait {
    tokio::select! {
        biased;
        command = command_receiver.recv() => NativeSshOutputWait::Command(command),
        permit = output_sender.reserve_owned() => match permit {
            Ok(permit) => NativeSshOutputWait::Ready(permit),
            Err(_) => NativeSshOutputWait::OutputClosed,
        },
    }
}

struct NativeSshPendingOutput {
    data: Vec<u8>,
    offset: usize,
}

impl NativeSshPendingOutput {
    fn new(data: Vec<u8>) -> Self {
        Self { data, offset: 0 }
    }

    fn is_complete(&self) -> bool {
        self.offset >= self.data.len()
    }

    fn next_chunk(&self) -> &[u8] {
        let end = (self.offset + NATIVE_SSH_OUTPUT_CHUNK_BYTES).min(self.data.len());
        &self.data[self.offset..end]
    }

    fn advance(&mut self) {
        self.offset += self.next_chunk().len();
    }
}

fn spawn_native_ssh_output_bridge(
    mut output_receiver: tokio_mpsc::Receiver<Vec<u8>>,
) -> (std_mpsc::Receiver<Vec<u8>>, thread::JoinHandle<()>) {
    // A single-slot bridge prevents the legacy blocking Read consumer from
    // accumulating an unbounded second queue behind the bounded async queue.
    let (reader_sender, reader_receiver) = std_mpsc::sync_channel(1);
    let bridge = thread::spawn(move || {
        while let Some(data) = output_receiver.blocking_recv() {
            if reader_sender.send(data).is_err() {
                break;
            }
        }
    });
    (reader_receiver, bridge)
}

#[derive(Clone)]
struct NativeSshTarget {
    auth: NativeSshAuth,
    connect_timeout: Option<Duration>,
    host: String,
    keepalive_interval: Option<Duration>,
    port: u16,
    username: String,
    tunnels: Vec<SshTunnel>,
    proxy_command: Option<String>,
    jump_hosts: Vec<String>,
    resolved_jumps: Vec<NativeSshHop>,
}

#[derive(Clone)]
enum NativeSshHop {
    Saved(Box<NativeSshTarget>),
    OpenSsh(String),
}

#[derive(Clone)]
enum NativeSshAuth {
    Agent,
    OpenSsh {
        paths: Vec<PathBuf>,
        use_agent: bool,
        identities_only: bool,
    },
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
        let host = required_text("主机", &session.host)?;
        let username = required_text("用户名", &session.username)?;
        if session.port == 0 {
            return Err(AppError::validation("端口必须大于 0"));
        }
        let auth = match session.auth_mode {
            AuthMode::Password => {
                let credential_ref = required_credential_ref(session, "密码认证需要凭据引用")?;
                NativeSshAuth::Password(secrets.secret_for(credential_ref)?)
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
                    .map(|credential_ref| secrets.secret_for(credential_ref))
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
            keepalive_interval: effective_keepalive_interval(session),
            port: session.port,
            username,
            tunnels: session
                .ssh_options
                .as_ref()
                .map(|o| o.tunnels.clone())
                .unwrap_or_default(),
            proxy_command: session
                .ssh_options
                .as_ref()
                .and_then(|o| o.proxy_command.clone()),
            jump_hosts: session
                .ssh_options
                .as_ref()
                .map(|o| o.jump_hosts.clone())
                .unwrap_or_default(),
            resolved_jumps: Vec::new(),
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
struct NativeSshHandler {
    forwarded: tokio_mpsc::Sender<ForwardedTcpip>,
    host: String,
    port: u16,
}

impl client::Handler for NativeSshHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        verify_native_server_key(&self.host, self.port, server_public_key).map_err(|error| {
            russh::Error::IO(std::io::Error::other(format!(
                "SSH 主机密钥校验失败: {error}"
            )))
        })?;
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Never wait for channel IO inside the SSH driver callback.
        if let Err(rejected) = self.forwarded.try_send(ForwardedTcpip {
            channel,
            connected_address: connected_address.to_owned(),
            connected_port,
        }) {
            let incoming = rejected.into_inner();
            session.close(incoming.channel.id())?;
        }
        Ok(())
    }
}

fn verify_native_server_key(host: &str, port: u16, key: &PublicKey) -> Result<(), keys::Error> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _guard = LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    #[cfg(not(test))]
    let path = dirs::home_dir()
        .ok_or(keys::Error::NoHomeDir)?
        .join(".ssh")
        .join("known_hosts");
    #[cfg(test)]
    let path = {
        static PATH: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
        PATH.get_or_init(|| {
            std::env::temp_dir().join(format!("zterm-test-known-hosts-{}", uuid::Uuid::new_v4()))
        })
        .clone()
    };
    // Do not silently bypass OpenSSH trust markers which this parser does not support.
    match std::fs::read_to_string(&path) {
        Ok(content)
            if content
                .lines()
                .any(|line| line.trim_start().starts_with('@')) =>
        {
            return Err(
                std::io::Error::other("known_hosts 包含当前原生 SSH 不支持的信任标记").into(),
            );
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    let recorded = keys::known_hosts::known_host_keys_path(host, port, &path)?;
    if recorded.is_empty() {
        keys::known_hosts::learn_known_hosts_path(host, port, key, &path)?;
    } else if !recorded
        .iter()
        .any(|(_, known)| known.key_data() == key.key_data())
    {
        // A changed algorithm is still a changed host identity.
        return Err(keys::Error::KeyChanged {
            line: recorded[0].0,
        });
    }
    Ok(())
}

async fn connect_native_ssh(
    target: &NativeSshTarget,
    forwarded: tokio_mpsc::Sender<ForwardedTcpip>,
    interaction: &mut NativeAuthInteraction,
) -> AppResult<(
    client::Handle<NativeSshHandler>,
    Vec<client::Handle<NativeSshHandler>>,
)> {
    let config = client::Config {
        inactivity_timeout: None,
        keepalive_interval: target.keepalive_interval,
        keepalive_max: DEFAULT_KEEPALIVE_MAX,
        ..Default::default()
    };
    let connect = async {
        let handler = NativeSshHandler {
            forwarded,
            host: target.host.clone(),
            port: target.port,
        };
        let config = Arc::new(config);
        if !target.resolved_jumps.is_empty() {
            let mut jumps: Vec<client::Handle<NativeSshHandler>> = Vec::new();
            for hop in &target.resolved_jumps {
                let hop = match hop {
                    NativeSshHop::Saved(hop) => *hop.clone(),
                    NativeSshHop::OpenSsh(value) => {
                        let config = super::ssh_openssh_config::resolve_jump(value).await?;
                        NativeSshTarget {
                            auth: NativeSshAuth::OpenSsh {
                                paths: config.identity_files,
                                use_agent: config.use_agent,
                                identities_only: config.identities_only,
                            },
                            connect_timeout: target.connect_timeout,
                            host: config.host,
                            port: config.port,
                            username: config.username,
                            keepalive_interval: target.keepalive_interval,
                            proxy_command: config.proxy_command,
                            jump_hosts: Vec::new(),
                            resolved_jumps: Vec::new(),
                            tunnels: Vec::new(),
                        }
                    }
                };
                let (forwarded, _unused) = tokio_mpsc::channel(1);
                let handler = NativeSshHandler {
                    forwarded,
                    host: hop.host.clone(),
                    port: hop.port,
                };
                let mut handle = if let Some(upstream) = jumps.last() {
                    let channel = upstream
                        .channel_open_direct_tcpip(&hop.host, u32::from(hop.port), "127.0.0.1", 0)
                        .await
                        .map_err(russh_error)?;
                    client::connect_stream(Arc::clone(&config), channel.into_stream(), handler)
                        .await
                        .map_err(russh_error)?
                } else if let Some(stream) = super::ssh_native_proxy::spawn_target_stream(
                    &hop.host,
                    hop.port,
                    &hop.username,
                    hop.proxy_command.as_deref(),
                    &[],
                )? {
                    client::connect_stream(Arc::clone(&config), stream, handler)
                        .await
                        .map_err(russh_error)?
                } else {
                    client::connect(Arc::clone(&config), (hop.host.as_str(), hop.port), handler)
                        .await
                        .map_err(russh_error)?
                };
                authenticate_native_ssh(&mut handle, &hop, interaction).await?;
                jumps.push(handle);
            }
            let upstream = jumps.last().expect("resolved jump chain is nonempty");
            let channel = upstream
                .channel_open_direct_tcpip(&target.host, u32::from(target.port), "127.0.0.1", 0)
                .await
                .map_err(russh_error)?;
            let handle = client::connect_stream(config, channel.into_stream(), handler)
                .await
                .map_err(russh_error)?;
            return Ok((handle, jumps));
        }
        let stream = super::ssh_native_proxy::spawn_target_stream(
            &target.host,
            target.port,
            &target.username,
            target.proxy_command.as_deref(),
            &target.jump_hosts,
        )?;
        if let Some(stream) = stream {
            client::connect_stream(config, stream, handler)
                .await
                .map_err(russh_error)
                .map(|handle| (handle, Vec::new()))
        } else {
            client::connect(config, (target.host.as_str(), target.port), handler)
                .await
                .map_err(russh_error)
                .map(|handle| (handle, Vec::new()))
        }
    };
    if let Some(timeout) = target.connect_timeout {
        tokio::time::timeout(timeout, connect)
            .await
            .map_err(|_| AppError::ssh(format!("SSH 连接超时（{} 秒）", timeout.as_secs())))?
    } else {
        connect.await
    }
}

async fn authenticate_native_ssh(
    handle: &mut client::Handle<NativeSshHandler>,
    target: &NativeSshTarget,
    interaction: &mut NativeAuthInteraction,
) -> AppResult<()> {
    let username = target.username.clone();
    let authenticated = match &target.auth {
        NativeSshAuth::Password(password) => {
            if handle
                .authenticate_password(username.clone(), password.clone())
                .await
                .map_err(russh_error)?
                .success()
            {
                true
            } else {
                authenticate_keyboard_password(handle, username, Some(password), interaction)
                    .await?
            }
        }
        NativeSshAuth::PrivateKey {
            identity_file,
            passphrase,
        } => {
            let key = load_secret_key(identity_file, passphrase.as_deref()).map_err(key_error)?;
            authenticate_private_key(handle, username, key).await?
        }
        NativeSshAuth::Agent => authenticate_agent(handle, username).await.unwrap_or(false),
        NativeSshAuth::OpenSsh {
            paths,
            use_agent,
            identities_only,
        } => {
            let none = handle
                .authenticate_none(username.clone())
                .await
                .map_err(russh_error)?;
            let password_allowed = matches!(&none, client::AuthResult::Failure { remaining_methods, .. } if remaining_methods.contains(&russh::MethodKind::Password));
            let mut authenticated = none.success();
            if !authenticated && *use_agent && !*identities_only {
                authenticated = authenticate_agent(handle, username.clone())
                    .await
                    .unwrap_or(false);
            }
            if !authenticated && *use_agent && *identities_only {
                let allowed = paths
                    .iter()
                    .filter_map(|path| {
                        let encoded = std::fs::read(path).ok()?;
                        PrivateKey::from_openssh(encoded)
                            .ok()
                            .map(|key| key.public_key().clone())
                    })
                    .collect::<Vec<_>>();
                if !allowed.is_empty() {
                    authenticated =
                        authenticate_agent_matching(handle, username.clone(), Some(&allowed))
                            .await
                            .unwrap_or(false);
                }
            }
            for path in paths {
                if authenticated {
                    break;
                }
                let key = match load_secret_key(path, None) {
                    Ok(key) => Some(key),
                    Err(keys::Error::KeyIsEncrypted) => {
                        let passphrase = interaction
                            .answer("密钥口令", "", "Passphrase:", false)
                            .await?;
                        Some(load_secret_key(path, Some(&passphrase)).map_err(key_error)?)
                    }
                    Err(_) => None,
                };
                if let Some(key) = key {
                    authenticated = authenticate_private_key(handle, username.clone(), key).await?;
                }
            }
            if !authenticated && password_allowed {
                let password = interaction
                    .answer("跳板登录", "", "Password:", false)
                    .await?;
                authenticated = handle
                    .authenticate_password(username.clone(), password.clone())
                    .await
                    .map_err(russh_error)?
                    .success();
                if !authenticated {
                    authenticated = authenticate_keyboard_password(
                        handle,
                        username.clone(),
                        Some(&password),
                        interaction,
                    )
                    .await?;
                }
            }
            if !authenticated {
                authenticated =
                    authenticate_keyboard_password(handle, username, None, interaction).await?;
            }
            authenticated
        }
        NativeSshAuth::None => handle
            .authenticate_none(username)
            .await
            .map_err(russh_error)?
            .success(),
    };
    let authenticated = if !authenticated
        && matches!(
            target.auth,
            NativeSshAuth::PrivateKey { .. } | NativeSshAuth::Agent
        ) {
        authenticate_keyboard_password(handle, target.username.clone(), None, interaction).await?
    } else {
        authenticated
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

struct NativeAuthInteraction {
    input: tokio_mpsc::UnboundedReceiver<Vec<u8>>,
    output: tokio_mpsc::Sender<Vec<u8>>,
    pending: Arc<AtomicBool>,
}

impl NativeAuthInteraction {
    async fn answer(
        &mut self,
        name: &str,
        instructions: &str,
        prompt: &str,
        echo: bool,
    ) -> AppResult<String> {
        fn clean(value: &str) -> String {
            value
                .chars()
                .filter(|ch| !ch.is_control() || *ch == '\n')
                .take(2048)
                .collect()
        }
        while self.input.try_recv().is_ok() {}
        self.pending.store(true, Ordering::SeqCst);
        struct Reset(Arc<AtomicBool>);
        impl Drop for Reset {
            fn drop(&mut self) {
                self.0.store(false, Ordering::SeqCst);
            }
        }
        let _reset = Reset(Arc::clone(&self.pending));
        self.output
            .send(
                format!(
                    "\r\n[SSH 认证] {} {}\r\n{}",
                    clean(name),
                    clean(instructions),
                    clean(prompt)
                )
                .into_bytes(),
            )
            .await
            .map_err(|_| AppError::ssh("SSH 终端已关闭"))?;
        let mut answer = Vec::new();
        while let Some(input) = self.input.recv().await {
            for byte in input {
                match byte {
                    b'\r' | b'\n' => {
                        self.output
                            .send(b"\r\n".to_vec())
                            .await
                            .map_err(|_| AppError::ssh("SSH 终端已关闭"))?;
                        return String::from_utf8(answer)
                            .map_err(|_| AppError::credential("SSH 认证响应必须是 UTF-8 文本"));
                    }
                    3 => return Err(AppError::credential("SSH 认证已取消")),
                    8 | 127 => {
                        answer.pop();
                    }
                    byte if !byte.is_ascii_control() => {
                        if answer.len() >= 4096 {
                            return Err(AppError::credential("SSH 认证响应过长"));
                        }
                        answer.push(byte);
                        if echo {
                            let _ = self.output.send(vec![byte]).await;
                        }
                    }
                    _ => {}
                }
            }
        }
        Err(AppError::ssh("SSH 终端已关闭"))
    }
}

async fn authenticate_keyboard_password(
    handle: &mut client::Handle<NativeSshHandler>,
    username: String,
    password: Option<&str>,
    interaction: &mut NativeAuthInteraction,
) -> AppResult<bool> {
    use client::KeyboardInteractiveAuthResponse as Response;
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await
        .map_err(russh_error)?;
    for _ in 0..8 {
        match response {
            Response::Success => return Ok(true),
            Response::Failure { .. } => return Ok(false),
            Response::InfoRequest {
                name,
                instructions,
                prompts,
            } => {
                let mut answers = Vec::with_capacity(prompts.len());
                for prompt in prompts {
                    if let Some(password) =
                        password.filter(|_| is_password_prompt(&prompt.prompt, prompt.echo))
                    {
                        answers.push(password.to_owned());
                    } else {
                        answers.push(
                            interaction
                                .answer(&name, &instructions, &prompt.prompt, prompt.echo)
                                .await?,
                        );
                    }
                }
                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await
                    .map_err(russh_error)?;
            }
        }
    }
    Err(AppError::credential("SSH 交互认证轮次过多"))
}

fn is_password_prompt(prompt: &str, echo: bool) -> bool {
    let prompt = prompt.trim().to_lowercase();
    !echo
        && matches!(
            prompt.as_str(),
            "password:" | "password" | "密码:" | "密码："
        )
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
    authenticate_agent_matching(handle, username, None).await
}

async fn authenticate_agent_matching(
    handle: &mut client::Handle<NativeSshHandler>,
    username: String,
    allowed: Option<&[PublicKey]>,
) -> AppResult<bool> {
    let mut agent = connect_agent().await?;
    let identities = agent.request_identities().await.map_err(agent_error)?;
    for identity in identities {
        let key = match &identity {
            AgentIdentity::PublicKey { key, .. } => key.clone(),
            AgentIdentity::Certificate { .. } => identity.public_key().into_owned(),
        };
        if allowed.is_some_and(|allowed| {
            !allowed
                .iter()
                .any(|selected| selected.key_data() == key.key_data())
        }) {
            continue;
        }
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
#[path = "ssh_terminal_integration_tests.rs"]
mod integration_tests;

#[cfg(test)]
mod tests {
    use std::{io::Read, sync::mpsc};

    use std::time::Duration;

    use super::{
        build_ssh_arguments, effective_keepalive_interval, spawn_native_ssh_output_bridge,
        wait_for_native_ssh_output_slot_or_command, NativeSshCommand, NativeSshOutputWait,
        NativeSshPendingOutput, NativeSshReader, NATIVE_SSH_OUTPUT_CHUNK_BYTES,
        NATIVE_SSH_OUTPUT_QUEUE_CAPACITY,
    };
    use crate::models::session::{AuthMode, SavedSession, SessionType, SshOptions};

    #[test]
    fn ssh_keepalive_uses_the_safe_default_when_options_are_missing() {
        let missing = ssh_session_with_options(SshOptions {
            connect_timeout_ms: None,
            keepalive_interval_ms: None,
            proxy_command: None,
            identity_file: None,
            jump_hosts: Vec::new(),
            tunnels: Vec::new(),
            container: None,
        });
        assert_eq!(
            effective_keepalive_interval(&missing),
            Some(Duration::from_secs(30))
        );

        let zero = ssh_session_with_options(SshOptions {
            keepalive_interval_ms: Some(0),
            ..missing.ssh_options.expect("options should exist")
        });
        assert_eq!(effective_keepalive_interval(&zero), None);
        let zero_args = build_ssh_arguments(&zero).expect("zero keepalive should build");
        assert!(ssh_option_is_set(&zero_args, "ServerAliveInterval=0"));
        assert!(!ssh_option_is_set(&zero_args, "ServerAliveCountMax=3"));

        let configured = ssh_session_with_options(SshOptions {
            keepalive_interval_ms: Some(1_500),
            ..zero.ssh_options.expect("options should exist")
        });
        let configured_args = build_ssh_arguments(&configured).expect("configured keepalive");
        assert!(ssh_option_is_set(&configured_args, "ServerAliveInterval=2"));
        assert!(ssh_option_is_set(&configured_args, "ServerAliveCountMax=3"));
    }

    #[test]
    fn native_ssh_output_is_chunked_without_losing_or_reordering_bytes() {
        let source = (0..NATIVE_SSH_OUTPUT_CHUNK_BYTES * 2 + 37)
            .map(|index| (index % 251) as u8)
            .collect::<Vec<_>>();
        let mut pending = NativeSshPendingOutput::new(source.clone());
        let mut actual = Vec::new();

        while !pending.is_complete() {
            let chunk = pending.next_chunk();
            assert!(chunk.len() <= NATIVE_SSH_OUTPUT_CHUNK_BYTES);
            actual.extend_from_slice(chunk);
            pending.advance();
        }

        assert_eq!(actual, source);
    }

    #[tokio::test]
    async fn native_ssh_output_backpressure_keeps_resize_and_close_available() {
        let (output_sender, _output_receiver) =
            tokio::sync::mpsc::channel(NATIVE_SSH_OUTPUT_QUEUE_CAPACITY);
        for _ in 0..NATIVE_SSH_OUTPUT_QUEUE_CAPACITY {
            output_sender
                .send(vec![0_u8])
                .await
                .expect("bounded queue should accept its configured capacity");
        }
        assert!(output_sender.try_send(vec![1_u8]).is_err());

        let (command_sender, mut command_receiver) = tokio::sync::mpsc::unbounded_channel();
        command_sender
            .send(NativeSshCommand::Resize {
                cols: 120,
                rows: 40,
            })
            .expect("resize command should queue independently of output pressure");
        match wait_for_native_ssh_output_slot_or_command(
            output_sender.clone(),
            &mut command_receiver,
        )
        .await
        {
            NativeSshOutputWait::Command(Some(NativeSshCommand::Resize { cols, rows })) => {
                assert_eq!((cols, rows), (120, 40));
            }
            _ => panic!("resize must win while the output queue is full"),
        }

        command_sender
            .send(NativeSshCommand::Close)
            .expect("close command should queue independently of output pressure");
        assert!(matches!(
            wait_for_native_ssh_output_slot_or_command(output_sender, &mut command_receiver).await,
            NativeSshOutputWait::Command(Some(NativeSshCommand::Close))
        ));
    }

    #[test]
    fn native_ssh_output_bridge_stops_after_reader_is_closed() {
        let (output_sender, output_receiver) = tokio::sync::mpsc::channel(1);
        let (reader, bridge) = spawn_native_ssh_output_bridge(output_receiver);
        drop(reader);

        output_sender
            .blocking_send(vec![1, 2, 3])
            .expect("bridge should receive the queued output before it observes closure");
        bridge
            .join()
            .expect("bridge should exit after reader closure");
        assert!(output_sender.is_closed());
    }

    #[test]
    fn native_ssh_reader_preserves_partial_reads_and_releases_closed_senders() {
        let (sender, receiver) = mpsc::sync_channel(1);
        let mut reader = NativeSshReader::new(receiver);
        sender
            .send(vec![1, 2, 3])
            .expect("initial output should queue");
        let mut first = [0_u8; 2];
        assert_eq!(reader.read(&mut first).expect("first read"), 2);
        assert_eq!(first, [1, 2]);
        let mut last = [0_u8; 2];
        assert_eq!(reader.read(&mut last).expect("second read"), 1);
        assert_eq!(last[0], 3);

        drop(reader);
        assert!(sender.send(vec![4]).is_err());
    }

    fn ssh_option_is_set(args: &[String], expected: &str) -> bool {
        args.windows(2)
            .any(|pair| pair[0] == "-o" && pair[1] == expected)
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
}
