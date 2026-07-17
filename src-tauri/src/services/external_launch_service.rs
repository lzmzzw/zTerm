// Author: Liz
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::Path,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::session::{AuthMode, SavedSession, SessionType, SshContainerOptions, SshOptions},
    services::{
        credential_service::CredentialService, ssh_command_service::SshCommandSecretResolver,
    },
};

const EXTERNAL_SESSION_PREFIX: &str = "external:";
const EXTERNAL_CREDENTIAL_PREFIX: &str = "external-secret:";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExternalSshLaunchRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub identity_file: Option<String>,
    pub auto_open_sftp: bool,
    pub remote_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ExternalSshChannelPolicy {
    Unknown,
    MultiChannel,
    SingleChannel,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalSshLaunchEvent {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auto_open_sftp: bool,
    pub remote_path: String,
    pub channel_policy: ExternalSshChannelPolicy,
}

#[derive(Clone, Default)]
pub struct ExternalLaunchService {
    inner: Arc<ExternalLaunchInner>,
}

#[derive(Default)]
struct ExternalLaunchInner {
    sessions: Mutex<HashMap<String, TransientSshSession>>,
    pending_launches: Mutex<VecDeque<ExternalSshLaunchEvent>>,
}

#[derive(Debug, Clone)]
struct TransientSshSession {
    session: SavedSession,
    secrets: HashMap<String, String>,
    launch: ExternalSshLaunchEvent,
}

#[derive(Clone)]
pub struct CompositeSshSecretResolver {
    external: ExternalLaunchService,
    credentials: CredentialService,
}

impl ExternalLaunchService {
    pub fn register_request(
        &self,
        request: ExternalSshLaunchRequest,
    ) -> AppResult<ExternalSshLaunchEvent> {
        let host = required_text("主机", &request.host)?;
        let username = required_text("用户名", &request.username)?;
        if request.port == 0 {
            return Err(AppError::validation("端口必须大于 0"));
        }
        let remote_path =
            required_text("远程路径", &request.remote_path).unwrap_or_else(|_| "/".to_string());
        let id = format!("{EXTERNAL_SESSION_PREFIX}{}", Uuid::new_v4());
        let credential_ref = request
            .password
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(|_| format!("{EXTERNAL_CREDENTIAL_PREFIX}{id}:password"));
        let auth_mode = if request
            .identity_file
            .as_deref()
            .is_some_and(|value| !value.trim().is_empty())
        {
            AuthMode::Key
        } else if credential_ref.is_some() {
            AuthMode::Password
        } else {
            AuthMode::None
        };
        let now = now_ms();
        let name = format!("{username}@{host}:{}", request.port);
        let session = SavedSession {
            id: id.clone(),
            name: name.clone(),
            session_type: SessionType::Ssh,
            group_id: None,
            host: host.clone(),
            port: request.port,
            username: username.clone(),
            auth_mode,
            credential_ref: credential_ref.clone(),
            description: None,
            tags: Vec::new(),
            sort_order: 0,
            created_at_ms: now,
            updated_at_ms: now,
            last_used_at_ms: None,
            ssh_options: Some(SshOptions {
                connect_timeout_ms: None,
                keepalive_interval_ms: None,
                proxy_command: None,
                identity_file: request
                    .identity_file
                    .map(|value| value.trim().to_string())
                    .filter(|value| !value.is_empty()),
                jump_hosts: Vec::new(),
                tunnels: Vec::new(),
                container: Some(default_external_container_options()),
            }),
            rdp_options: None,
            local_options: None,
            ftp_options: None,
        };
        let launch = ExternalSshLaunchEvent {
            id: id.clone(),
            name,
            host,
            port: request.port,
            channel_policy: external_ssh_channel_policy_for_username(&username),
            username,
            auto_open_sftp: request.auto_open_sftp,
            remote_path,
        };
        let mut secrets = HashMap::new();
        if let (Some(credential_ref), Some(password)) = (credential_ref, request.password) {
            secrets.insert(credential_ref, password);
        }

        self.inner
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("external session lock was poisoned"))?
            .insert(
                id,
                TransientSshSession {
                    session,
                    secrets,
                    launch: launch.clone(),
                },
            );
        self.inner
            .pending_launches
            .lock()
            .map_err(|_| AppError::terminal("external launch queue lock was poisoned"))?
            .push_back(launch.clone());
        Ok(launch)
    }

    pub fn register_from_args<I, S>(&self, args: I) -> AppResult<Option<ExternalSshLaunchEvent>>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        match parse_external_ssh_launch_args(args)? {
            Some(request) => self.register_request(request).map(Some),
            None => Ok(None),
        }
    }

    pub(crate) fn register_from_forwarded_args<I, S>(
        &self,
        args: I,
        parent_command_line: Option<String>,
    ) -> AppResult<Option<ExternalSshLaunchEvent>>
    where
        I: IntoIterator<Item = S>,
        S: Into<String>,
    {
        match parse_external_ssh_launch_args_inner(args, parent_command_line)? {
            Some(request) => self.register_request(request).map(Some),
            None => Ok(None),
        }
    }

    pub fn get_session(&self, id: &str) -> AppResult<Option<SavedSession>> {
        if !is_external_session_id(id) {
            return Ok(None);
        }
        Ok(self
            .inner
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("external session lock was poisoned"))?
            .get(id)
            .map(|entry| entry.session.clone()))
    }

    pub fn get_ssh_options(&self, id: &str) -> AppResult<SshOptions> {
        if !is_external_session_id(id) {
            return Err(AppError::validation("只能读取临时 SSH 连接配置"));
        }
        let sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("external session lock was poisoned"))?;
        let entry = sessions
            .get(id)
            .ok_or_else(|| AppError::validation("临时 SSH 连接不存在"))?;
        Ok(entry
            .session
            .ssh_options
            .clone()
            .unwrap_or_else(default_external_ssh_options))
    }

    pub fn update_ssh_options(&self, id: &str, next_options: SshOptions) -> AppResult<SshOptions> {
        if !is_external_session_id(id) {
            return Err(AppError::validation("只能更新临时 SSH 连接配置"));
        }
        let mut sessions = self
            .inner
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("external session lock was poisoned"))?;
        let entry = sessions
            .get_mut(id)
            .ok_or_else(|| AppError::validation("临时 SSH 连接不存在"))?;
        let mut options = entry
            .session
            .ssh_options
            .clone()
            .unwrap_or_else(default_external_ssh_options);
        if entry.launch.channel_policy == ExternalSshChannelPolicy::SingleChannel {
            validate_single_channel_ssh_options(&next_options)?;
        }
        options.tunnels = next_options.tunnels;
        options.container = next_options
            .container
            .or(Some(default_external_container_options()));
        entry.session.ssh_options = Some(options.clone());
        Ok(options)
    }

    pub fn remove_session(&self, id: &str) {
        if !is_external_session_id(id) {
            return;
        }
        if let Ok(mut sessions) = self.inner.sessions.lock() {
            sessions.remove(id);
        }
    }

    pub fn take_pending_launches(&self) -> AppResult<Vec<ExternalSshLaunchEvent>> {
        let mut pending = self
            .inner
            .pending_launches
            .lock()
            .map_err(|_| AppError::terminal("external launch queue lock was poisoned"))?;
        Ok(pending.drain(..).collect())
    }

    pub fn composite_secret_resolver(
        &self,
        credentials: CredentialService,
    ) -> CompositeSshSecretResolver {
        CompositeSshSecretResolver {
            external: self.clone(),
            credentials,
        }
    }

    fn secret_for_external_ref(&self, credential_ref: &str) -> Option<String> {
        self.inner.sessions.lock().ok().and_then(|sessions| {
            sessions
                .values()
                .find_map(|entry| entry.secrets.get(credential_ref).cloned())
        })
    }

    pub fn launch_metadata(&self, id: &str) -> AppResult<Option<ExternalSshLaunchEvent>> {
        if !is_external_session_id(id) {
            return Ok(None);
        }
        Ok(self
            .inner
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("external session lock was poisoned"))?
            .get(id)
            .map(|entry| entry.launch.clone()))
    }
}

impl SshCommandSecretResolver for CompositeSshSecretResolver {
    fn secret_for(&self, credential_ref: &str) -> AppResult<String> {
        self.external
            .secret_for_external_ref(credential_ref)
            .map(Ok)
            .unwrap_or_else(|| self.credentials.read_secret(credential_ref))
    }
}

pub fn is_external_session_id(value: &str) -> bool {
    value.starts_with(EXTERNAL_SESSION_PREFIX)
}

pub fn external_ssh_channel_policy_for_username(username: &str) -> ExternalSshChannelPolicy {
    if valid_b64_gateway_username(username) {
        ExternalSshChannelPolicy::SingleChannel
    } else {
        ExternalSshChannelPolicy::MultiChannel
    }
}

fn validate_single_channel_ssh_options(options: &SshOptions) -> AppResult<()> {
    if !options.tunnels.is_empty() {
        return Err(AppError::validation("单通道临时 SSH 不允许配置隧道"));
    }
    Ok(())
}

fn valid_b64_gateway_username(username: &str) -> bool {
    let Some(payload) = username.trim().trim_matches('"').strip_prefix("b64>>") else {
        return false;
    };
    let mut normalized_payload = payload.trim().replace('-', "+").replace('_', "/");
    let padding = (4 - (normalized_payload.len() % 4)) % 4;
    normalized_payload.extend(std::iter::repeat_n('=', padding));
    let Ok(decoded) = general_purpose::STANDARD.decode(normalized_payload) else {
        return false;
    };
    let Ok(decoded) = String::from_utf8(decoded) else {
        return false;
    };
    let normalized = decoded.trim().to_ascii_lowercase();
    normalized.contains('@') && (normalized.ends_with(":ssh2") || normalized.ends_with(":ssh"))
}

pub fn parse_external_ssh_launch_args<I, S>(args: I) -> AppResult<Option<ExternalSshLaunchRequest>>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    parse_external_ssh_launch_args_inner(args, None)
}

fn parse_external_ssh_launch_args_inner<I, S>(
    args: I,
    parent_command_line: Option<String>,
) -> AppResult<Option<ExternalSshLaunchRequest>>
where
    I: IntoIterator<Item = S>,
    S: Into<String>,
{
    let mut args = args.into_iter().map(Into::into).collect::<Vec<_>>();
    if args.is_empty() {
        return Ok(None);
    }
    args.remove(0);
    if args.is_empty() {
        return Ok(None);
    }

    let mut host: Option<String> = None;
    let mut port: Option<u16> = None;
    let mut username: Option<String> = None;
    let mut password: Option<String> = None;
    let mut identity_file: Option<String> = None;
    let mut auto_open_sftp = true;
    let mut remote_path = "/".to_string();
    let mut explicit_external = false;
    let mut saw_external_client_option = false;
    let mut saw_moba_file = false;
    let mut index = 0;

    while index < args.len() {
        let arg = args[index].trim().to_string();
        let lower_arg = arg.to_ascii_lowercase();
        match arg.as_str() {
            "--external-ssh" | "-ssh" => {
                explicit_external = true;
                saw_external_client_option |= arg == "-ssh";
                index += 1;
            }
            "--host" => {
                host = Some(take_value(&args, &mut index, "--host")?);
            }
            "--port" | "-P" => {
                let label = arg.clone();
                port = Some(parse_port(&take_value(&args, &mut index, &label)?)?);
                saw_external_client_option |= arg == "-P";
            }
            "--user" | "--username" | "-l" => {
                let label = arg.clone();
                username = Some(take_value(&args, &mut index, &label)?);
                saw_external_client_option |= arg == "-l";
            }
            "--password" | "-pw" => {
                let label = arg.clone();
                password = Some(take_value(&args, &mut index, &label)?);
                saw_external_client_option |= arg == "-pw";
            }
            "--identity-file" | "-i" => {
                let label = arg.clone();
                identity_file = Some(take_value(&args, &mut index, &label)?);
                saw_external_client_option |= arg == "-i";
            }
            "--sftp" => {
                let value = take_value(&args, &mut index, "--sftp")?;
                auto_open_sftp = !matches!(
                    value.trim().to_ascii_lowercase().as_str(),
                    "off" | "false" | "none"
                );
            }
            "--remote-path" => {
                remote_path = take_value(&args, &mut index, "--remote-path")?;
            }
            _ if lower_arg == "/ssh2" => {
                explicit_external = true;
                saw_external_client_option = true;
                index += 1;
            }
            _ if lower_arg == "/l" => {
                username = Some(take_value(&args, &mut index, &arg)?);
                saw_external_client_option = true;
            }
            _ if lower_arg == "/p" => {
                port = Some(parse_port(&take_value(&args, &mut index, &arg)?)?);
                saw_external_client_option = true;
            }
            _ if lower_arg == "/password" => {
                password = Some(take_value(&args, &mut index, &arg)?);
                saw_external_client_option = true;
            }
            _ if lower_arg == "/i" => {
                identity_file = Some(take_value(&args, &mut index, &arg)?);
                saw_external_client_option = true;
            }
            _ if lower_arg == "/n" || lower_arg == "/titlebar" => {
                skip_option_value(&args, &mut index);
            }
            _ if lower_arg == "/t" || lower_arg == "/accepthostkeys" => {
                index += 1;
            }
            _ if lower_arg == "-url" => {
                let value = take_value(&args, &mut index, &arg)?;
                apply_target(&value, &mut host, &mut port, &mut username, &mut password)?;
                saw_external_client_option = true;
            }
            _ if lower_arg == "-newwin" => {
                saw_external_client_option = true;
                if let Some(value) = args
                    .get(index + 1)
                    .filter(|value| !looks_like_option(value))
                {
                    apply_target(value, &mut host, &mut port, &mut username, &mut password)?;
                    index += 2;
                } else {
                    index += 1;
                }
            }
            _ if lower_arg == "-newtab" || lower_arg == "-exec" => {
                let value_index = index + 1;
                let Some(first_value) = args.get(value_index) else {
                    return Err(AppError::validation(format!("{arg} 缺少参数值")));
                };
                let (value, next_index) = if is_single_ssh_program_token(first_value) {
                    (args[value_index..].join(" "), args.len())
                } else {
                    (first_value.clone(), index + 2)
                };
                if apply_nested_ssh_command(
                    &value,
                    &mut host,
                    &mut port,
                    &mut username,
                    &mut password,
                    &mut identity_file,
                )? {
                    saw_external_client_option = true;
                }
                index = next_index;
            }
            value if value.starts_with('-') => {
                index += 1;
            }
            value if value.starts_with('/') => {
                index += 1;
            }
            value if value.to_ascii_lowercase().ends_with(".moba") => {
                apply_moba_file_target(
                    value,
                    &mut host,
                    &mut port,
                    &mut username,
                    &mut identity_file,
                )?;
                saw_external_client_option = true;
                saw_moba_file = true;
                index += 1;
            }
            value => {
                apply_target(value, &mut host, &mut port, &mut username, &mut password)?;
                index += 1;
            }
        }
    }

    if saw_moba_file && password.is_none() {
        let parent_command_line = parent_command_line.or_else(discover_parent_command_line);
        if let Some(parent_command_line) = parent_command_line {
            apply_bhost_multauth_command_line(
                &parent_command_line,
                &mut host,
                &mut port,
                &mut username,
                &mut password,
            )?;
        }
    }

    if !explicit_external && !saw_external_client_option {
        return Ok(None);
    }

    let host = required_text("主机", host.as_deref().unwrap_or_default())?;
    let username = required_text("用户名", username.as_deref().unwrap_or_default())?;
    Ok(Some(ExternalSshLaunchRequest {
        host,
        port: port.unwrap_or(22),
        username,
        password,
        identity_file,
        auto_open_sftp,
        remote_path,
    }))
}

fn take_value(args: &[String], index: &mut usize, label: &str) -> AppResult<String> {
    let value_index = *index + 1;
    let Some(value) = args.get(value_index) else {
        return Err(AppError::validation(format!("{label} 缺少参数值")));
    };
    *index += 2;
    Ok(value.clone())
}

#[cfg(all(windows, not(test)))]
fn discover_parent_command_line() -> Option<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let script = format!(
        "$p=Get-CimInstance Win32_Process -Filter 'ProcessId = {}'; \
         if ($p) {{ \
           $pp=Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $p.ParentProcessId); \
           if ($pp) {{ [Console]::Out.Write($pp.CommandLine) }} \
         }}",
        std::process::id()
    );
    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(any(not(windows), test))]
fn discover_parent_command_line() -> Option<String> {
    None
}

fn apply_moba_file_target(
    value: &str,
    host: &mut Option<String>,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    identity_file: &mut Option<String>,
) -> AppResult<()> {
    let path = Path::new(value);
    let text = fs::read_to_string(path)
        .map_err(|error| AppError::validation(format!("读取 MobaXterm 会话文件失败: {error}")))?;
    apply_moba_session_text(&text, host, port, username, identity_file)
}

fn apply_moba_session_text(
    text: &str,
    host: &mut Option<String>,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    identity_file: &mut Option<String>,
) -> AppResult<()> {
    for line in text.lines() {
        let Some((session_name, definition)) = line.split_once('=') else {
            continue;
        };
        let Some((_, after_marker)) = definition.split_once("#109#") else {
            continue;
        };
        let fields_text = after_marker.split('#').next().unwrap_or_default();
        let fields = fields_text.split('%').collect::<Vec<_>>();
        let Some(parsed_host) = fields
            .get(1)
            .copied()
            .filter(|value| !value.trim().is_empty())
        else {
            continue;
        };
        *host = Some(required_text("主机", parsed_host)?);
        if let Some(parsed_port) = fields.get(2).filter(|value| !value.trim().is_empty()) {
            *port = Some(parse_port(parsed_port)?);
        }
        if let Some(parsed_username) = fields
            .get(3)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && *value != "<none>")
        {
            *username = Some(parsed_username.to_string());
        } else if let Some(derived_username) = derive_moba_username(session_name) {
            *username = Some(derived_username);
        }
        if let Some(parsed_identity) = fields
            .get(15)
            .map(|value| value.trim())
            .filter(|value| !value.is_empty() && *value != "<none>")
        {
            *identity_file = Some(parsed_identity.to_string());
        }
        return Ok(());
    }
    Err(AppError::validation("MobaXterm 会话文件中未找到 SSH 会话"))
}

fn derive_moba_username(session_name: &str) -> Option<String> {
    let name = session_name.trim();
    let candidate = name
        .split_once('@')
        .map(|(left, _)| left)
        .or_else(|| name.split_once('_').map(|(left, _)| left))
        .unwrap_or(name)
        .trim();
    if candidate.is_empty() {
        None
    } else {
        Some(candidate.to_string())
    }
}

fn apply_bhost_multauth_command_line(
    value: &str,
    host: &mut Option<String>,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    password: &mut Option<String>,
) -> AppResult<bool> {
    let tokens = split_command_line(value);
    let Some(program) = tokens.first() else {
        return Ok(false);
    };
    if !program.to_ascii_lowercase().ends_with("bhmultauth.exe") {
        return Ok(false);
    }
    let Some(zterm_index) = tokens
        .iter()
        .position(|token| is_zterm_program_token(token))
    else {
        return Ok(false);
    };
    if tokens.len() <= zterm_index + 4 {
        return Ok(false);
    }

    *host = Some(required_text("主机", &tokens[zterm_index + 1])?);
    *port = Some(parse_port(&tokens[zterm_index + 2])?);
    *username = Some(clean_external_token(&tokens[zterm_index + 3]));
    *password = Some(clean_external_token(&tokens[zterm_index + 4]));
    Ok(true)
}

fn is_zterm_program_token(value: &str) -> bool {
    let program = value
        .trim_matches('"')
        .trim_matches('\'')
        .replace('/', "\\")
        .to_ascii_lowercase();
    program == "zterm.exe" || program.ends_with("\\zterm.exe")
}

fn skip_option_value(args: &[String], index: &mut usize) {
    if args
        .get(*index + 1)
        .is_some_and(|value| !looks_like_option(value))
    {
        *index += 2;
    } else {
        *index += 1;
    }
}

fn looks_like_option(value: &str) -> bool {
    let value = value.trim();
    value.starts_with('-') || (value.starts_with('/') && !value.contains("://"))
}

fn apply_nested_ssh_command(
    value: &str,
    host: &mut Option<String>,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    password: &mut Option<String>,
    identity_file: &mut Option<String>,
) -> AppResult<bool> {
    let tokens = split_command_line(value);
    let Some(program) = tokens.first() else {
        return Ok(false);
    };
    if !is_ssh_program_token(program) {
        return Ok(false);
    }

    let mut index = 1;
    while index < tokens.len() {
        let arg = tokens[index].trim();
        match arg {
            "-p" => {
                *port = Some(parse_port(&take_nested_value(&tokens, &mut index, "-p")?)?);
            }
            "-l" => {
                *username = Some(take_nested_value(&tokens, &mut index, "-l")?);
            }
            "-i" => {
                *identity_file = Some(take_nested_value(&tokens, &mut index, "-i")?);
            }
            value if value.starts_with("-p") && value.len() > 2 => {
                *port = Some(parse_port(value[2..].trim_start_matches('='))?);
                index += 1;
            }
            value if value.starts_with("-l") && value.len() > 2 => {
                *username = Some(value[2..].trim_start_matches('=').to_string());
                index += 1;
            }
            value if value.starts_with("-i") && value.len() > 2 => {
                *identity_file = Some(value[2..].trim_start_matches('=').to_string());
                index += 1;
            }
            "-b" | "-c" | "-D" | "-E" | "-e" | "-F" | "-I" | "-J" | "-L" | "-m" | "-O" | "-o"
            | "-Q" | "-R" | "-S" | "-W" | "-w" => {
                skip_nested_option_value(&tokens, &mut index);
            }
            value if value.starts_with('-') => {
                index += 1;
            }
            value => {
                apply_target(value, host, port, username, password)?;
                index += 1;
            }
        }
    }

    Ok(true)
}

fn take_nested_value(tokens: &[String], index: &mut usize, label: &str) -> AppResult<String> {
    let value_index = *index + 1;
    let Some(value) = tokens.get(value_index) else {
        return Err(AppError::validation(format!("{label} 缺少参数值")));
    };
    *index += 2;
    Ok(value.clone())
}

fn skip_nested_option_value(tokens: &[String], index: &mut usize) {
    if tokens
        .get(*index + 1)
        .is_some_and(|value| !value.trim().starts_with('-'))
    {
        *index += 2;
    } else {
        *index += 1;
    }
}

fn split_command_line(value: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;

    for character in value.chars() {
        match (quote, character) {
            (Some(active), next) if next == active => {
                quote = None;
            }
            (None, '"' | '\'') => {
                quote = Some(character);
            }
            (None, next) if next.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(character),
        }
    }

    if !current.is_empty() {
        tokens.push(current);
    }

    tokens
}

fn is_single_ssh_program_token(value: &str) -> bool {
    let tokens = split_command_line(value);
    tokens.len() == 1
        && tokens
            .first()
            .is_some_and(|item| is_ssh_program_token(item))
}

fn is_ssh_program_token(value: &str) -> bool {
    let program = value
        .trim_matches('"')
        .trim_matches('\'')
        .to_ascii_lowercase();
    matches!(program.as_str(), "ssh" | "ssh.exe")
        || program.ends_with("\\ssh.exe")
        || program.ends_with("/ssh")
        || program.ends_with("/ssh.exe")
}

fn apply_target(
    value: &str,
    host: &mut Option<String>,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    password: &mut Option<String>,
) -> AppResult<()> {
    if value.contains("://") {
        let url = reqwest::Url::parse(value)
            .map_err(|error| AppError::validation(format!("连接 URL 无效: {error}")))?;
        if url.scheme() != "ssh" {
            return Err(AppError::validation("外部启动只支持 ssh:// URL"));
        }
        let url_username = clean_external_token(url.username());
        let url_password = url.password().map(clean_external_token);
        if url_username.starts_with("b64>>")
            && url_password.as_deref().is_some_and(|item| !item.is_empty())
        {
            if let Some(parsed_host) = url.host_str() {
                *host = Some(parsed_host.to_string());
            }
            if let Some(parsed_port) = url.port() {
                *port = Some(parsed_port);
            }
            *username = Some(url_username);
            *password = url_password;
            return Ok(());
        }
        if apply_xshell_b64_username(&url_username, host, port, username, password)? {
            return Ok(());
        }
        if let Some(parsed_host) = url.host_str() {
            *host = Some(parsed_host.to_string());
        }
        if let Some(parsed_port) = url.port() {
            *port = Some(parsed_port);
        }
        if !url_username.trim().is_empty() {
            *username = Some(url_username);
        }
        if let Some(parsed_password) = url_password {
            *password = Some(parsed_password);
        }
        return Ok(());
    }

    let (maybe_user, maybe_host) = value
        .split_once('@')
        .map(|(left, right)| (Some(left), right))
        .unwrap_or((None, value));
    if let Some(user) = maybe_user.filter(|item| !item.trim().is_empty()) {
        *username = Some(user.trim().to_string());
    }
    let (target_host, target_port) = maybe_host
        .rsplit_once(':')
        .and_then(|(left, right)| parse_port(right).ok().map(|parsed| (left, parsed)))
        .map(|(left, parsed)| (left, Some(parsed)))
        .unwrap_or((maybe_host, None));
    if !target_host.trim().is_empty() {
        *host = Some(target_host.trim().to_string());
    }
    if let Some(parsed_port) = target_port {
        *port = Some(parsed_port);
    }
    Ok(())
}

fn apply_xshell_b64_username(
    raw_username: &str,
    host: &mut Option<String>,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    password: &mut Option<String>,
) -> AppResult<bool> {
    let Some(payload) = raw_username.strip_prefix("b64>>") else {
        return Ok(false);
    };
    let decoded_payload = general_purpose::STANDARD
        .decode(payload)
        .map_err(|_| AppError::validation("Xshell b64 URL 用户名无效"))?;
    let decoded_payload = String::from_utf8(decoded_payload)
        .map_err(|_| AppError::validation("Xshell b64 URL 用户名不是有效 UTF-8"))?;
    apply_xshell_b64_payload(&decoded_payload, host, port, username, password)?;
    Ok(true)
}

fn apply_xshell_b64_payload(
    value: &str,
    host: &mut Option<String>,
    port: &mut Option<u16>,
    username: &mut Option<String>,
    password: &mut Option<String>,
) -> AppResult<()> {
    let (before_protocol, protocol) = value
        .rsplit_once(':')
        .ok_or_else(|| AppError::validation("Xshell b64 URL 缺少协议"))?;
    if !protocol.eq_ignore_ascii_case("ssh2") && !protocol.eq_ignore_ascii_case("ssh") {
        return Err(AppError::validation("Xshell b64 URL 只支持 SSH 协议"));
    }
    let (before_port, parsed_port) = before_protocol
        .rsplit_once(':')
        .ok_or_else(|| AppError::validation("Xshell b64 URL 缺少端口"))?;
    let (before_host, parsed_host) = before_port
        .rsplit_once('@')
        .ok_or_else(|| AppError::validation("Xshell b64 URL 缺少主机"))?;
    let (credential_part, target_user) = before_host
        .rsplit_once('@')
        .ok_or_else(|| AppError::validation("Xshell b64 URL 缺少用户名"))?;

    let (_, parsed_password) = credential_part
        .split_once(':')
        .ok_or_else(|| AppError::validation("Xshell b64 URL 缺少密码"))?;
    *host = Some(required_text("主机", parsed_host)?);
    *port = Some(parse_port(parsed_port)?);
    *username = Some(required_text("用户名", target_user)?);
    if !parsed_password.is_empty() {
        *password = Some(parsed_password.to_string());
    }
    Ok(())
}

fn clean_external_token(value: &str) -> String {
    let mut value = percent_decode(value).trim().to_string();
    loop {
        let trimmed = value.trim();
        let quoted = (trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\''));
        if quoted && trimmed.len() >= 2 {
            value = trimmed[1..trimmed.len() - 1].trim().to_string();
        } else {
            return trimmed.to_string();
        }
    }
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Some(decoded) = hex_byte(bytes[index + 1], bytes[index + 2]) {
                output.push(decoded);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn hex_byte(high: u8, low: u8) -> Option<u8> {
    Some(hex_digit(high)? * 16 + hex_digit(low)?)
}

fn hex_digit(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn parse_port(value: &str) -> AppResult<u16> {
    let port = value
        .trim()
        .parse::<u16>()
        .map_err(|_| AppError::validation("端口必须是 1-65535 之间的数字"))?;
    if port == 0 {
        return Err(AppError::validation("端口必须大于 0"));
    }
    Ok(port)
}

fn required_text(label: &str, value: impl AsRef<str>) -> AppResult<String> {
    let value = value.as_ref().trim();
    if value.is_empty() {
        return Err(AppError::validation(format!("{label}不能为空")));
    }
    Ok(value.to_string())
}

fn default_external_ssh_options() -> SshOptions {
    SshOptions {
        connect_timeout_ms: None,
        keepalive_interval_ms: None,
        proxy_command: None,
        identity_file: None,
        jump_hosts: Vec::new(),
        tunnels: Vec::new(),
        container: Some(default_external_container_options()),
    }
}

fn default_external_container_options() -> SshContainerOptions {
    SshContainerOptions {
        enabled: true,
        runtime: "docker".to_string(),
        container: String::new(),
        shell: Some("/bin/sh".to_string()),
        user: None,
        workdir: None,
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        is_external_session_id, parse_external_ssh_launch_args, ExternalLaunchService,
        ExternalSshChannelPolicy,
    };
    use crate::models::session::{SshContainerOptions, SshOptions, SshTunnel, SshTunnelKind};

    #[test]
    fn parses_recommended_external_ssh_cli_without_leaking_password_to_event() {
        let request = parse_external_ssh_launch_args([
            "zTerm.exe",
            "--external-ssh",
            "--host",
            "cloud.example.test",
            "--port",
            "2200",
            "--user",
            "ops",
            "--password",
            "secret-value",
            "--sftp",
            "auto",
            "--remote-path",
            "/srv/app",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2200);
        assert_eq!(request.username, "ops");
        assert_eq!(request.password.as_deref(), Some("secret-value"));
        assert!(request.auto_open_sftp);
        assert_eq!(request.remote_path, "/srv/app");

        let launch = ExternalLaunchService::default()
            .register_request(request)
            .expect("transient launch should register");
        assert!(is_external_session_id(&launch.id));
        assert_eq!(launch.name, "ops@cloud.example.test:2200");
        assert!(!format!("{launch:?}").contains("secret-value"));
    }

    #[test]
    fn parses_putty_compatible_password_args() {
        let request = parse_external_ssh_launch_args([
            "putty.exe",
            "-ssh",
            "ops@cloud.example.test",
            "-P",
            "2222",
            "-pw",
            "secret-value",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2222);
        assert_eq!(request.username, "ops");
        assert_eq!(request.password.as_deref(), Some("secret-value"));
    }

    #[test]
    fn parses_securecrt_compatible_password_args() {
        let request = parse_external_ssh_launch_args([
            "SecureCRT.exe",
            "/SSH2",
            "/L",
            "ops",
            "/P",
            "2200",
            "/PASSWORD",
            "secret-value",
            "cloud.example.test",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2200);
        assert_eq!(request.username, "ops");
        assert_eq!(request.password.as_deref(), Some("secret-value"));
    }

    #[test]
    fn parses_xshell_url_args() {
        let request = parse_external_ssh_launch_args([
            "Xshell.exe",
            "-url",
            "ssh://ops:secret-value@cloud.example.test:2200",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2200);
        assert_eq!(request.username, "ops");
        assert_eq!(request.password.as_deref(), Some("secret-value"));
    }

    #[test]
    fn parses_xshell_b64_wrapped_url_args() {
        let request = parse_external_ssh_launch_args([
            "Xshell.exe",
            "-url",
            "ssh://b64%3E%3Eb3BzOnNlY3JldC12YWx1ZUByb290QDEwLjExLjAuNzU6MjI6U1NIMg%3D%3D@172.21.195.223:222",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "10.11.0.75");
        assert_eq!(request.port, 22);
        assert_eq!(request.username, "root");
        assert_eq!(request.password.as_deref(), Some("secret-value"));
    }

    #[test]
    fn parses_xshell_bhost_gateway_url_with_quoted_credentials() {
        let request = parse_external_ssh_launch_args([
            "Xshell.exe",
            "-url",
            "ssh://\"b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=\":\"en::6d49b3b3fb5721e430d82ae005431d2a\"@172.21.195.223:222",
            "-newtab",
            "root@10.11.0.75",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "172.21.195.223");
        assert_eq!(request.port, 222);
        assert_eq!(
            request.username,
            "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI="
        );
        assert_eq!(
            request.password.as_deref(),
            Some("en::6d49b3b3fb5721e430d82ae005431d2a")
        );
    }

    #[test]
    fn bhost_gateway_launch_is_marked_single_channel() {
        let service = ExternalLaunchService::default();
        let request = parse_external_ssh_launch_args([
            "Xshell.exe",
            "-url",
            "ssh://\"b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=\":\"en::6d49b3b3fb5721e430d82ae005431d2a\"@172.21.195.223:222",
        ])
        .expect("args should parse")
        .expect("request should exist");

        let launch = service
            .register_request(request)
            .expect("transient launch should register");

        assert_eq!(
            launch.channel_policy,
            ExternalSshChannelPolicy::SingleChannel
        );
    }

    #[test]
    fn regular_transient_ssh_launch_is_marked_multi_channel() {
        let service = ExternalLaunchService::default();
        let request = parse_external_ssh_launch_args([
            "zterm.exe",
            "--external-ssh",
            "--host",
            "cloud.example.test",
            "--port",
            "2200",
            "--user",
            "ops",
        ])
        .expect("args should parse")
        .expect("request should exist");

        let launch = service
            .register_request(request)
            .expect("transient launch should register");

        assert_eq!(
            launch.channel_policy,
            ExternalSshChannelPolicy::MultiChannel
        );
    }

    #[test]
    fn parses_xshell_newwin_url_and_identity_file_args() {
        let request = parse_external_ssh_launch_args([
            "Xshell.exe",
            "-newwin",
            "ssh://ops@cloud.example.test:2200",
            "-i",
            "C:\\Users\\ops\\.ssh\\id_ed25519",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2200);
        assert_eq!(request.username, "ops");
        assert_eq!(
            request.identity_file.as_deref(),
            Some("C:\\Users\\ops\\.ssh\\id_ed25519")
        );
    }

    #[test]
    fn parses_mobaxterm_nested_ssh_command_args() {
        let request = parse_external_ssh_launch_args([
            "MobaXterm.exe",
            "-newtab",
            "ssh -p 2200 ops@cloud.example.test",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2200);
        assert_eq!(request.username, "ops");
    }

    #[test]
    fn parses_mobaxterm_split_ssh_command_args() {
        let request = parse_external_ssh_launch_args([
            "MobaXterm.exe",
            "-newtab",
            "ssh",
            "-p",
            "2200",
            "ops@cloud.example.test",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2200);
        assert_eq!(request.username, "ops");
    }

    #[test]
    fn parses_mobaxterm_moba_session_file_arg() {
        let path = std::env::temp_dir().join(format!(
            "zterm-mobaxterm-{}-{}.moba",
            std::process::id(),
            super::now_ms()
        ));
        std::fs::write(
            &path,
            "root_10.11.0.75 =  #109#0%172.21.195.223%222%%%-1%-1%%%%%0%-1%0%%%0%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1#0# #-1",
        )
        .expect("temp moba file should be written");

        let request = parse_external_ssh_launch_args([
            "zterm.exe".to_string(),
            path.to_string_lossy().into_owned(),
        ])
        .expect("args should parse")
        .expect("request should exist");

        let _ = std::fs::remove_file(path);
        assert_eq!(request.host, "172.21.195.223");
        assert_eq!(request.port, 222);
        assert_eq!(request.username, "root");
        assert_eq!(request.password, None);
    }

    #[test]
    fn parses_mobaxterm_bhost_parent_credentials_for_moba_file_arg() {
        let path = std::env::temp_dir().join(format!(
            "zterm-bhost-mobaxterm-{}-{}.moba",
            std::process::id(),
            super::now_ms()
        ));
        std::fs::write(
            &path,
            "root_10.11.0.75 =  #109#0%172.21.195.223%222%%%-1%-1%%%%%0%-1%0%%%0%0%0%0%%1080%%0%0%1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1%-1%_Std_Colors_0_%80%24%0%1%-1%<none>%%0%0%-1#0# #-1",
        )
        .expect("temp moba file should be written");

        let parent_command_line = "\"C:\\Users\\Public\\Documents\\BHost\\bhmultauth.exe\" 33 \"C:/Users/PKUWHAI/AppData/Local/zTerm/zterm.exe\" \"172.21.195.223\" \"222\" \"b64>>d2VuOjMwMTI1OTY5NDQ4OTVAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=\" \"en::6d49b3b3fb5721e430d82ae005431d2a\" \"root_10.11.0.75\"";
        let service = ExternalLaunchService::default();
        let launch = service
            .register_from_forwarded_args(
                ["zterm.exe".to_string(), path.to_string_lossy().into_owned()],
                Some(parent_command_line.to_string()),
            )
            .expect("args should parse")
            .expect("request should exist");
        let session = service
            .get_session(&launch.id)
            .expect("session lookup should succeed")
            .expect("transient session should exist");

        let _ = std::fs::remove_file(path);
        assert_eq!(launch.host, "172.21.195.223");
        assert_eq!(launch.port, 222);
        assert_eq!(
            launch.username,
            "b64>>d2VuOjMwMTI1OTY5NDQ4OTVAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI="
        );
        assert_eq!(
            session
                .credential_ref
                .as_deref()
                .and_then(|credential_ref| service.secret_for_external_ref(credential_ref))
                .as_deref(),
            Some("en::6d49b3b3fb5721e430d82ae005431d2a")
        );
    }

    #[test]
    fn parses_ssh_url_target_and_rejects_invalid_port() {
        let request = parse_external_ssh_launch_args([
            "zTerm.exe",
            "--external-ssh",
            "ssh://ops:secret-value@cloud.example.test:2022",
        ])
        .expect("args should parse")
        .expect("request should exist");

        assert_eq!(request.host, "cloud.example.test");
        assert_eq!(request.port, 2022);
        assert_eq!(request.username, "ops");
        assert_eq!(request.password.as_deref(), Some("secret-value"));

        let error = parse_external_ssh_launch_args([
            "zTerm.exe",
            "--external-ssh",
            "--host",
            "h",
            "--user",
            "u",
            "--port",
            "0",
        ])
        .expect_err("invalid port should fail");
        assert!(error.to_string().contains("端口"));
    }

    #[test]
    fn ignores_normal_app_start_without_external_flags() {
        assert!(parse_external_ssh_launch_args(["zTerm.exe"])
            .expect("parse should succeed")
            .is_none());
        assert!(
            parse_external_ssh_launch_args(["zTerm.exe", "--some-tauri-flag"])
                .expect("parse should succeed")
                .is_none()
        );
    }

    #[test]
    fn transient_session_keeps_secret_in_memory_and_removes_on_close() {
        let service = ExternalLaunchService::default();
        let request = parse_external_ssh_launch_args([
            "zTerm.exe",
            "--external-ssh",
            "--host",
            "cloud.example.test",
            "--user",
            "ops",
            "--password",
            "secret-value",
        ])
        .expect("args should parse")
        .expect("request should exist");
        let launch = service
            .register_request(request)
            .expect("transient launch should register");
        let session = service
            .get_session(&launch.id)
            .expect("lookup should succeed")
            .expect("session should exist");
        let expected_ref = format!("external-secret:{}:password", launch.id);

        assert_eq!(session.id, launch.id);
        assert_eq!(
            session.credential_ref.as_deref(),
            Some(expected_ref.as_str())
        );
        assert!(service
            .take_pending_launches()
            .expect("pending should drain")
            .contains(&launch));
        assert!(service
            .take_pending_launches()
            .expect("pending should be empty")
            .is_empty());

        service.remove_session(&launch.id);
        assert!(service
            .get_session(&launch.id)
            .expect("lookup should succeed")
            .is_none());
    }

    #[test]
    fn transient_session_defaults_to_enabled_docker_container_options() {
        let service = ExternalLaunchService::default();
        let request = parse_external_ssh_launch_args([
            "zTerm.exe",
            "--external-ssh",
            "--host",
            "cloud.example.test",
            "--user",
            "ops",
            "--password",
            "secret-value",
        ])
        .expect("args should parse")
        .expect("request should exist");
        let launch = service
            .register_request(request)
            .expect("transient launch should register");

        let options = service
            .get_ssh_options(&launch.id)
            .expect("external ssh options should load");
        let container = options
            .container
            .expect("container should be enabled by default");

        assert!(container.enabled);
        assert_eq!(container.runtime, "docker");
        assert_eq!(container.shell.as_deref(), Some("/bin/sh"));
        assert!(options.tunnels.is_empty());
    }

    #[test]
    fn transient_ssh_options_update_only_mutable_runtime_fields() {
        let service = ExternalLaunchService::default();
        let request = parse_external_ssh_launch_args([
            "zTerm.exe",
            "--external-ssh",
            "--host",
            "cloud.example.test",
            "--user",
            "ops",
            "--password",
            "secret-value",
            "--identity-file",
            "C:\\Users\\ops\\.ssh\\id_ed25519",
        ])
        .expect("args should parse")
        .expect("request should exist");
        let launch = service
            .register_request(request)
            .expect("transient launch should register");

        let updated = service
            .update_ssh_options(
                &launch.id,
                SshOptions {
                    connect_timeout_ms: Some(1),
                    keepalive_interval_ms: Some(2),
                    proxy_command: Some("ignored".to_string()),
                    identity_file: None,
                    jump_hosts: vec!["ignored".to_string()],
                    tunnels: vec![SshTunnel {
                        mode: Some("host_service".to_string()),
                        name: Some("管理后台".to_string()),
                        kind: SshTunnelKind::Local,
                        auto_open: true,
                        bind_address: Some("127.0.0.1".to_string()),
                        local_port: Some(18080),
                        remote_host: Some("127.0.0.1".to_string()),
                        remote_port: Some(8080),
                    }],
                    container: Some(SshContainerOptions {
                        enabled: true,
                        runtime: "podman".to_string(),
                        container: String::new(),
                        shell: Some("/bin/sh".to_string()),
                        user: None,
                        workdir: None,
                    }),
                },
            )
            .expect("external options should update");
        let session = service
            .get_session(&launch.id)
            .expect("lookup should succeed")
            .expect("session should remain");
        let session_options = session.ssh_options.expect("ssh options should remain");

        assert_eq!(updated.tunnels.len(), 1);
        assert_eq!(
            updated
                .container
                .as_ref()
                .map(|container| container.runtime.as_str()),
            Some("podman")
        );
        assert_eq!(
            session_options.identity_file.as_deref(),
            Some("C:\\Users\\ops\\.ssh\\id_ed25519")
        );
        assert!(session_options.proxy_command.is_none());
        assert!(session_options.jump_hosts.is_empty());
    }

    #[test]
    fn single_channel_transient_ssh_options_reject_any_tunnel() {
        let service = ExternalLaunchService::default();
        let request = parse_external_ssh_launch_args([
            "Xshell.exe",
            "-url",
            "ssh://\"b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=\":\"en::6d49b3b3fb5721e430d82ae005431d2a\"@172.21.195.223:222",
        ])
        .expect("args should parse")
        .expect("request should exist");
        let launch = service
            .register_request(request)
            .expect("transient launch should register");

        let error = service
            .update_ssh_options(
                &launch.id,
                SshOptions {
                    connect_timeout_ms: None,
                    keepalive_interval_ms: None,
                    proxy_command: None,
                    identity_file: None,
                    jump_hosts: Vec::new(),
                    tunnels: vec![SshTunnel {
                        mode: Some("host_service".to_string()),
                        name: Some("管理后台".to_string()),
                        kind: SshTunnelKind::Local,
                        auto_open: true,
                        bind_address: Some("127.0.0.1".to_string()),
                        local_port: Some(18080),
                        remote_host: Some("127.0.0.1".to_string()),
                        remote_port: Some(8080),
                    }],
                    container: Some(SshContainerOptions {
                        enabled: true,
                        runtime: "docker".to_string(),
                        container: String::new(),
                        shell: Some("/bin/sh".to_string()),
                        user: None,
                        workdir: None,
                    }),
                },
            )
            .expect_err("single-channel launch should reject any tunnel");

        assert!(error.to_string().contains("不允许配置隧道"));
    }

    #[test]
    fn transient_ssh_options_reject_non_external_ids() {
        let service = ExternalLaunchService::default();

        let error = service
            .get_ssh_options("session-1")
            .expect_err("saved sessions are not external launch options");

        assert!(error.to_string().contains("临时 SSH"));
    }
}
