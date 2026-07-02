// Author: Liz
use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::session::{AuthMode, SavedSession, SessionType, SshOptions},
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
pub struct ExternalSshLaunchEvent {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auto_open_sftp: bool,
    pub remote_path: String,
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
                container: None,
            }),
            rdp_options: None,
            local_options: None,
        };
        let launch = ExternalSshLaunchEvent {
            id: id.clone(),
            name,
            host,
            port: request.port,
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

pub fn parse_external_ssh_launch_args<I, S>(args: I) -> AppResult<Option<ExternalSshLaunchRequest>>
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
    let mut saw_putty_option = false;
    let mut index = 0;

    while index < args.len() {
        let arg = args[index].trim().to_string();
        match arg.as_str() {
            "--external-ssh" | "-ssh" => {
                explicit_external = true;
                saw_putty_option |= arg == "-ssh";
                index += 1;
            }
            "--host" => {
                host = Some(take_value(&args, &mut index, "--host")?);
            }
            "--port" | "-P" => {
                let label = arg.clone();
                port = Some(parse_port(&take_value(&args, &mut index, &label)?)?);
                saw_putty_option |= arg == "-P";
            }
            "--user" | "--username" | "-l" => {
                let label = arg.clone();
                username = Some(take_value(&args, &mut index, &label)?);
                saw_putty_option |= arg == "-l";
            }
            "--password" | "-pw" => {
                let label = arg.clone();
                password = Some(take_value(&args, &mut index, &label)?);
                saw_putty_option |= arg == "-pw";
            }
            "--identity-file" | "-i" => {
                let label = arg.clone();
                identity_file = Some(take_value(&args, &mut index, &label)?);
                saw_putty_option |= arg == "-i";
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
            value if value.starts_with('-') => {
                index += 1;
            }
            value => {
                apply_target(value, &mut host, &mut port, &mut username, &mut password)?;
                index += 1;
            }
        }
    }

    if !explicit_external && !saw_putty_option {
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
        if let Some(parsed_host) = url.host_str() {
            *host = Some(parsed_host.to_string());
        }
        if let Some(parsed_port) = url.port() {
            *port = Some(parsed_port);
        }
        if !url.username().trim().is_empty() {
            *username = Some(url.username().trim().to_string());
        }
        if let Some(parsed_password) = url.password() {
            *password = Some(parsed_password.to_string());
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

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{is_external_session_id, parse_external_ssh_launch_args, ExternalLaunchService};

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
}
