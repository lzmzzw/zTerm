// Author: Liz
use std::{
    collections::{HashMap, VecDeque},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Child as ProcessChild,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use portable_pty::{Child, CommandBuilder, PtySize};
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::{
        history::HistoryScopeKind,
        session::{LocalOptions, SavedSession},
        terminal::{
            RuntimeSessionInfo, RuntimeSessionKind, TerminalAccepted, TerminalClosed,
            TerminalResized,
        },
        terminal_profile::TerminalProfile,
    },
    services::credential_service::read_system_secret,
    services::pty_process_guard::PtyMasterGuard,
    services::ssh_command_service::SshCommandSecretResolver,
    services::ssh_terminal_service::{
        spawn_ssh_container_terminal_with_resolver, spawn_ssh_terminal_with_resolver,
        NativeSshControl, SshTerminalRuntime,
    },
    time::now_ms,
};

const PTY_KILL_REAP_TIMEOUT: Duration = Duration::from_secs(1);
const OUTPUT_RETAINED_CHARS: usize = 24_000;
const OUTPUT_CHUNK_BYTES: usize = 4096;

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, Arc<RuntimeSession>>>,
    infos: Mutex<HashMap<String, RuntimeSessionInfo>>,
    output_buffers: Mutex<HashMap<String, Arc<Mutex<OutputBuffer>>>>,
    output_suppressions: Mutex<HashMap<String, OutputSuppression>>,
}

pub struct OpenedPtySession {
    pub info: RuntimeSessionInfo,
    pub reader: Box<dyn Read + Send>,
    pub auth_secret: Option<String>,
    pub shell_history_integration: bool,
}

pub struct AgentCodexPtyOptions {
    pub command_path: String,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    pub environment: Vec<(String, String)>,
    pub pane_id: String,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
}

enum RuntimeSession {
    Placeholder,
    Rdp(RdpRuntime),
    Pty(PtyRuntime),
    NativeSsh(NativeSshRuntimeState),
}

struct RdpRuntime {
    child: Mutex<ProcessChild>,
    file_path: Option<PathBuf>,
}

struct PtyRuntime {
    master: Mutex<PtyMasterGuard>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

struct NativeSshRuntimeState {
    writer: Mutex<Box<dyn Write + Send>>,
    control: NativeSshControl,
    exit_status: Arc<Mutex<Option<i32>>>,
}

#[derive(Default)]
struct OutputBuffer {
    chunks: VecDeque<OutputChunk>,
    retained_chars: usize,
    retained_bytes: usize,
    start_cursor: usize,
    end_cursor: usize,
    updated_at_ms: i64,
}

struct OutputChunk {
    data: String,
    // 淘汰首块的一部分时只移动 UTF-8 边界，不搬移仍保留的内容。
    start: usize,
    chars: usize,
}

impl OutputBuffer {
    fn append(&mut self, mut data: &str) {
        self.end_cursor = self.end_cursor.saturating_add(data.len());
        while !data.is_empty() {
            let capacity = self
                .chunks
                .back()
                .map_or(0, |chunk| OUTPUT_CHUNK_BYTES - chunk.data.len());
            let mut take = data.len().min(capacity);
            while !data.is_char_boundary(take) {
                take -= 1;
            }
            if take == 0 {
                self.chunks.push_back(OutputChunk {
                    data: String::with_capacity(OUTPUT_CHUNK_BYTES),
                    start: 0,
                    chars: 0,
                });
                continue;
            }
            let part = &data[..take];
            let chars = part.chars().count();
            let chunk = self.chunks.back_mut().expect("output chunk exists");
            chunk.data.push_str(part);
            chunk.chars += chars;
            self.retained_chars += chars;
            self.retained_bytes += take;
            data = &data[take..];
            self.trim();
        }
        self.start_cursor = self.end_cursor.saturating_sub(self.retained_bytes);
        self.updated_at_ms = now_ms();
    }

    fn trim(&mut self) {
        while self.retained_chars > OUTPUT_RETAINED_CHARS {
            let excess = self.retained_chars - OUTPUT_RETAINED_CHARS;
            let first = self.chunks.front_mut().expect("retained output exists");
            if first.chars <= excess {
                self.retained_chars -= first.chars;
                self.retained_bytes -= first.data.len() - first.start;
                self.chunks.pop_front();
            } else {
                let bytes = first.data[first.start..]
                    .char_indices()
                    .nth(excess)
                    .expect("partial chunk remains")
                    .0;
                first.start += bytes;
                first.chars -= excess;
                self.retained_chars -= excess;
                self.retained_bytes -= bytes;
            }
        }
    }

    fn read_after(&self, cursor: usize, max_chars: usize) -> OutputRead {
        let expired = cursor < self.start_cursor;
        if cursor >= self.end_cursor {
            return OutputRead {
                output: String::new(),
                cursor: self.end_cursor,
                truncated: expired,
            };
        }
        let mut skip_bytes = cursor.saturating_sub(self.start_cursor);
        let mut available_chars = 0;
        let mut parts = Vec::new();
        for chunk in &self.chunks {
            let data = &chunk.data[chunk.start..];
            if skip_bytes >= data.len() {
                skip_bytes -= data.len();
                continue;
            }
            let suffix = byte_suffix(data, skip_bytes);
            let chars = if skip_bytes == 0 {
                chunk.chars
            } else {
                suffix.chars().count()
            };
            skip_bytes = 0;
            available_chars += chars;
            parts.push((suffix, chars));
        }
        let mut skip_chars = available_chars.saturating_sub(max_chars);
        let mut output = String::new();
        for (part, chars) in parts {
            if skip_chars >= chars {
                skip_chars -= chars;
                continue;
            }
            let start = if skip_chars == 0 {
                0
            } else {
                part.char_indices()
                    .nth(skip_chars)
                    .expect("output suffix exists")
                    .0
            };
            output.push_str(&part[start..]);
            skip_chars = 0;
        }
        OutputRead {
            output,
            cursor: self.end_cursor,
            truncated: expired || available_chars > max_chars,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutputRead {
    pub output: String,
    pub cursor: usize,
    pub truncated: bool,
}

struct OutputSuppression {
    end_prefix: String,
    pending: Vec<u8>,
}

impl TerminalManager {
    pub fn open_agent_codex_session(
        &self,
        options: AgentCodexPtyOptions,
    ) -> AppResult<OpenedPtySession> {
        let mut command = CommandBuilder::new(&options.command_path);
        for arg in &options.args {
            command.arg(arg);
        }
        command.cwd(&options.cwd);
        for (name, value) in &options.environment {
            if !name.trim().is_empty() {
                command.env(name, value);
            }
        }
        let pty = crate::services::local_pty_service::spawn_pty_command(
            command,
            options.cols,
            options.rows,
        )?;
        let info = RuntimeSessionInfo {
            runtime_session_id: Uuid::new_v4().to_string(),
            saved_session_id: None,
            history_scope_kind: None,
            history_scope_id: None,
            pane_id: options.pane_id,
            title: options.title,
            kind: RuntimeSessionKind::Local,
            initial_cwd: canonical_local_cwd(Path::new(&options.cwd)),
            cols: options.cols,
            rows: options.rows,
        };
        let runtime = PtyRuntime {
            master: Mutex::new(pty.master),
            writer: Mutex::new(pty.writer),
            child: Mutex::new(pty.child),
        };
        self.sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .insert(
                info.runtime_session_id.clone(),
                Arc::new(RuntimeSession::Pty(runtime)),
            );
        self.record_runtime_info(&info)?;
        self.ensure_output_buffer(&info.runtime_session_id)?;
        Ok(OpenedPtySession {
            info,
            reader: pty.reader,
            auth_secret: None,
            shell_history_integration: false,
        })
    }

    pub fn open_rdp_session(
        &self,
        saved_session_id: String,
        pane_id: String,
        title: String,
        child: ProcessChild,
        file_path: Option<PathBuf>,
    ) -> AppResult<RuntimeSessionInfo> {
        self.open_rdp_runtime(
            saved_session_id,
            pane_id,
            title,
            RuntimeSession::Rdp(RdpRuntime {
                child: Mutex::new(child),
                file_path,
            }),
        )
    }

    pub fn open_rdp_placeholder(
        &self,
        saved_session_id: String,
        pane_id: String,
        title: String,
    ) -> AppResult<RuntimeSessionInfo> {
        self.open_rdp_runtime(
            saved_session_id,
            pane_id,
            title,
            RuntimeSession::Placeholder,
        )
    }

    fn open_rdp_runtime(
        &self,
        saved_session_id: String,
        pane_id: String,
        title: String,
        runtime: RuntimeSession,
    ) -> AppResult<RuntimeSessionInfo> {
        let info = RuntimeSessionInfo {
            runtime_session_id: Uuid::new_v4().to_string(),
            saved_session_id: Some(saved_session_id),
            history_scope_kind: None,
            history_scope_id: None,
            pane_id,
            title,
            kind: RuntimeSessionKind::RdpPlaceholder,
            initial_cwd: None,
            cols: 0,
            rows: 0,
        };

        self.sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .insert(info.runtime_session_id.clone(), Arc::new(runtime));
        self.record_runtime_info(&info)?;
        self.ensure_output_buffer(&info.runtime_session_id)?;

        Ok(info)
    }

    pub fn open_ssh_session(
        &self,
        session: &SavedSession,
        pane_id: String,
        cols: u16,
        rows: u16,
    ) -> AppResult<OpenedPtySession> {
        self.open_ssh_session_with_resolver(
            session,
            pane_id,
            cols,
            rows,
            &SystemSshSecretResolver,
            true,
        )
    }

    pub fn open_ssh_session_with_resolver(
        &self,
        session: &SavedSession,
        pane_id: String,
        cols: u16,
        rows: u16,
        secrets: &dyn SshCommandSecretResolver,
        history_enabled: bool,
    ) -> AppResult<OpenedPtySession> {
        let spawn = spawn_ssh_terminal_with_resolver(session, cols, rows, secrets)?;
        let history_scope_kind = history_enabled.then_some(HistoryScopeKind::SavedSession);
        let history_scope_id = history_enabled.then(|| session.id.clone());
        let info = RuntimeSessionInfo {
            runtime_session_id: Uuid::new_v4().to_string(),
            saved_session_id: Some(session.id.clone()),
            history_scope_kind,
            history_scope_id,
            pane_id,
            title: session.name.clone(),
            kind: RuntimeSessionKind::Ssh,
            initial_cwd: None,
            cols,
            rows,
        };

        let (runtime, reader) = match spawn.runtime {
            SshTerminalRuntime::Pty(pty) => (
                RuntimeSession::Pty(PtyRuntime {
                    master: Mutex::new(pty.master),
                    writer: Mutex::new(pty.writer),
                    child: Mutex::new(pty.child),
                }),
                pty.reader,
            ),
            SshTerminalRuntime::Native(native) => (
                RuntimeSession::NativeSsh(NativeSshRuntimeState {
                    writer: Mutex::new(native.writer),
                    control: native.control,
                    exit_status: native.exit_status,
                }),
                native.reader,
            ),
        };
        self.sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .insert(info.runtime_session_id.clone(), Arc::new(runtime));
        self.record_runtime_info(&info)?;
        self.ensure_output_buffer(&info.runtime_session_id)?;

        Ok(OpenedPtySession {
            info,
            reader,
            auth_secret: spawn.auth_secret,
            shell_history_integration: false,
        })
    }

    pub fn open_ssh_container_session(
        &self,
        session: &SavedSession,
        pane_id: String,
        container_id: String,
        container_name: Option<String>,
        cols: u16,
        rows: u16,
    ) -> AppResult<OpenedPtySession> {
        self.open_ssh_container_session_with_resolver(
            session,
            pane_id,
            container_id,
            container_name,
            cols,
            rows,
            &SystemSshSecretResolver,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_ssh_container_session_with_resolver(
        &self,
        session: &SavedSession,
        pane_id: String,
        container_id: String,
        container_name: Option<String>,
        cols: u16,
        rows: u16,
        secrets: &dyn SshCommandSecretResolver,
        history_enabled: bool,
    ) -> AppResult<OpenedPtySession> {
        let spawn = spawn_ssh_container_terminal_with_resolver(
            session,
            &container_id,
            cols,
            rows,
            secrets,
        )?;
        let title_target = container_name
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| short_container_id(&container_id));
        let info = RuntimeSessionInfo {
            runtime_session_id: Uuid::new_v4().to_string(),
            saved_session_id: Some(session.id.clone()),
            history_scope_kind: history_enabled.then_some(HistoryScopeKind::SavedSession),
            history_scope_id: history_enabled.then(|| session.id.clone()),
            pane_id,
            title: format!("容器: {title_target}"),
            kind: RuntimeSessionKind::SshContainer,
            initial_cwd: None,
            cols,
            rows,
        };

        let (runtime, reader) = match spawn.runtime {
            SshTerminalRuntime::Pty(pty) => (
                RuntimeSession::Pty(PtyRuntime {
                    master: Mutex::new(pty.master),
                    writer: Mutex::new(pty.writer),
                    child: Mutex::new(pty.child),
                }),
                pty.reader,
            ),
            SshTerminalRuntime::Native(native) => (
                RuntimeSession::NativeSsh(NativeSshRuntimeState {
                    writer: Mutex::new(native.writer),
                    control: native.control,
                    exit_status: native.exit_status,
                }),
                native.reader,
            ),
        };
        self.sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .insert(info.runtime_session_id.clone(), Arc::new(runtime));
        self.record_runtime_info(&info)?;
        self.ensure_output_buffer(&info.runtime_session_id)?;

        Ok(OpenedPtySession {
            info,
            reader,
            auth_secret: spawn.auth_secret,
            shell_history_integration: false,
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn open_local_session(
        &self,
        profile: &TerminalProfile,
        local_options: Option<&LocalOptions>,
        pane_id: String,
        saved_session_id: Option<String>,
        title: String,
        cols: u16,
        rows: u16,
    ) -> AppResult<OpenedPtySession> {
        let initial_cwd = initial_local_cwd(local_options)?;
        let mut command = CommandBuilder::new(profile.path.as_str());
        for arg in &profile.args {
            command.arg(arg.as_str());
        }
        let shell_history_integration = supports_powershell_history_integration(profile);
        if shell_history_integration {
            command.arg("-NoExit");
            command.arg("-Command");
            command.arg(powershell_history_integration_script());
        }
        command.cwd(&initial_cwd);
        if let Some(options) = local_options {
            for variable in &options.environment {
                let name = variable.name.trim();
                if !name.is_empty() {
                    command.env(name, variable.value.as_str());
                }
            }
        }
        let pty = crate::services::local_pty_service::spawn_pty_command(command, cols, rows)?;
        let info = RuntimeSessionInfo {
            runtime_session_id: Uuid::new_v4().to_string(),
            history_scope_kind: Some(if saved_session_id.is_some() {
                HistoryScopeKind::SavedSession
            } else {
                HistoryScopeKind::LocalProfile
            }),
            history_scope_id: Some(
                saved_session_id
                    .clone()
                    .unwrap_or_else(|| profile.id.clone()),
            ),
            saved_session_id,
            pane_id,
            title,
            kind: RuntimeSessionKind::Local,
            initial_cwd: Some(initial_cwd.to_string_lossy().to_string()),
            cols,
            rows,
        };

        let runtime = PtyRuntime {
            master: Mutex::new(pty.master),
            writer: Mutex::new(pty.writer),
            child: Mutex::new(pty.child),
        };
        self.sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .insert(
                info.runtime_session_id.clone(),
                Arc::new(RuntimeSession::Pty(runtime)),
            );
        self.record_runtime_info(&info)?;
        self.ensure_output_buffer(&info.runtime_session_id)?;

        Ok(OpenedPtySession {
            info,
            reader: pty.reader,
            auth_secret: None,
            shell_history_integration,
        })
    }

    pub fn write(&self, runtime_session_id: &str, data: &str) -> AppResult<TerminalAccepted> {
        self.write_bytes(runtime_session_id, data.as_bytes())
    }

    pub fn write_bytes(
        &self,
        runtime_session_id: &str,
        data: &[u8],
    ) -> AppResult<TerminalAccepted> {
        let runtime = self.runtime_session(runtime_session_id)?;

        match runtime.as_ref() {
            RuntimeSession::Placeholder | RuntimeSession::Rdp(_) => Err(AppError::unsupported(
                "RDP placeholder sessions do not accept terminal input",
            )),
            RuntimeSession::Pty(pty) => {
                let mut writer = pty
                    .writer
                    .lock()
                    .map_err(|_| AppError::terminal("terminal writer lock was poisoned"))?;
                writer
                    .write_all(data)
                    .map_err(|error| AppError::terminal(error.to_string()))?;
                writer
                    .flush()
                    .map_err(|error| AppError::terminal(error.to_string()))?;
                Ok(TerminalAccepted { accepted: true })
            }
            RuntimeSession::NativeSsh(native) => {
                let mut writer = native
                    .writer
                    .lock()
                    .map_err(|_| AppError::terminal("terminal writer lock was poisoned"))?;
                writer
                    .write_all(data)
                    .map_err(|error| AppError::terminal(error.to_string()))?;
                writer
                    .flush()
                    .map_err(|error| AppError::terminal(error.to_string()))?;
                Ok(TerminalAccepted { accepted: true })
            }
        }
    }

    pub fn resize(
        &self,
        runtime_session_id: &str,
        cols: u16,
        rows: u16,
    ) -> AppResult<TerminalResized> {
        let runtime = self.runtime_session(runtime_session_id)?;

        match runtime.as_ref() {
            RuntimeSession::Placeholder | RuntimeSession::Rdp(_) => {
                Ok(TerminalResized { resized: false })
            }
            RuntimeSession::NativeSsh(native) => {
                native.control.resize(cols, rows);
                Ok(TerminalResized { resized: true })
            }
            RuntimeSession::Pty(pty) => {
                pty.master
                    .lock()
                    .map_err(|_| AppError::terminal("terminal pty lock was poisoned"))?
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|error| AppError::terminal(error.to_string()))?;
                Ok(TerminalResized { resized: true })
            }
        }
    }

    pub fn try_wait_exit_code(&self, runtime_session_id: &str) -> AppResult<Option<i32>> {
        let runtime = self.runtime_session(runtime_session_id)?;

        match runtime.as_ref() {
            RuntimeSession::Placeholder => Ok(None),
            RuntimeSession::Rdp(rdp) => rdp
                .child
                .lock()
                .map_err(|_| AppError::terminal("RDP process lock was poisoned"))?
                .try_wait()
                .map(|status| status.map(|value| value.code().unwrap_or_default()))
                .map_err(|error| AppError::terminal(error.to_string())),
            RuntimeSession::NativeSsh(native) => {
                let status = native
                    .exit_status
                    .lock()
                    .map_err(|_| AppError::terminal("terminal child lock was poisoned"))?;
                Ok(*status)
            }
            RuntimeSession::Pty(pty) => {
                let mut child = pty
                    .child
                    .lock()
                    .map_err(|_| AppError::terminal("terminal child lock was poisoned"))?;
                child
                    .try_wait()
                    .map(|status| status.map(|value| value.exit_code() as i32))
                    .map_err(|error| AppError::terminal(error.to_string()))
            }
        }
    }

    pub fn close(&self, runtime_session_id: &str) -> AppResult<TerminalClosed> {
        let runtime = self
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .remove(runtime_session_id)
            .ok_or_else(|| {
                AppError::not_found(format!("runtime session not found: {runtime_session_id}"))
            })?;

        match runtime.as_ref() {
            RuntimeSession::Pty(pty) => {
                let mut child = pty
                    .child
                    .lock()
                    .map_err(|_| AppError::terminal("terminal child lock was poisoned"))?;
                let _ = child.kill();
                let deadline = Instant::now() + PTY_KILL_REAP_TIMEOUT;
                while Instant::now() < deadline {
                    match child.try_wait() {
                        Ok(Some(_)) | Err(_) => break,
                        Ok(None) => thread::sleep(Duration::from_millis(20)),
                    }
                }
            }
            RuntimeSession::NativeSsh(native) => {
                native.control.close();
            }
            RuntimeSession::Rdp(rdp) => {
                let mut child = rdp
                    .child
                    .lock()
                    .map_err(|_| AppError::terminal("RDP process lock was poisoned"))?;
                let _ = child.kill();
                let _ = child.wait();
                if let Some(file_path) = &rdp.file_path {
                    let _ = std::fs::remove_file(file_path);
                }
            }
            RuntimeSession::Placeholder => {}
        }
        if let Ok(mut buffers) = self.output_buffers.lock() {
            buffers.remove(runtime_session_id);
        }
        if let Ok(mut suppressions) = self.output_suppressions.lock() {
            suppressions.remove(runtime_session_id);
        }
        if let Ok(mut infos) = self.infos.lock() {
            infos.remove(runtime_session_id);
        }

        Ok(TerminalClosed { closed: true })
    }

    pub fn runtime_info(&self, runtime_session_id: &str) -> AppResult<RuntimeSessionInfo> {
        self.infos
            .lock()
            .map_err(|_| AppError::terminal("terminal info lock was poisoned"))?
            .get(runtime_session_id)
            .cloned()
            .ok_or_else(|| {
                AppError::not_found(format!("runtime session not found: {runtime_session_id}"))
            })
    }

    pub fn diagnostic_transport(&self, runtime_session_id: &str) -> &'static str {
        match self.runtime_session(runtime_session_id).as_deref() {
            Ok(RuntimeSession::NativeSsh(_)) => "native-ssh",
            Ok(RuntimeSession::Pty(_)) => "pty",
            _ => "other",
        }
    }

    pub fn runtime_count(&self) -> usize {
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    pub fn close_all(&self) -> AppResult<usize> {
        let runtime_session_ids = self
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut closed = 0;
        let mut first_error = None;
        for runtime_session_id in runtime_session_ids {
            match self.close(&runtime_session_id) {
                Ok(_) => closed += 1,
                Err(AppError::NotFound(_)) => {}
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(closed),
        }
    }

    pub fn runtime_infos(&self) -> AppResult<Vec<RuntimeSessionInfo>> {
        let mut infos = self
            .infos
            .lock()
            .map_err(|_| AppError::terminal("terminal info lock was poisoned"))?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        infos.sort_by(|left, right| left.title.cmp(&right.title));
        Ok(infos)
    }

    pub fn record_output(&self, runtime_session_id: &str, data: &str) -> AppResult<()> {
        // 全局锁只负责取得会话缓冲；追加、裁剪和读取都使用各自会话的锁。
        let buffer = self
            .output_buffers
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?
            .entry(runtime_session_id.to_string())
            .or_default()
            .clone();
        buffer
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?
            .append(data);
        Ok(())
    }

    pub fn begin_output_suppression(
        &self,
        runtime_session_id: &str,
        end_prefix: &str,
    ) -> AppResult<()> {
        self.output_suppressions
            .lock()
            .map_err(|_| AppError::terminal("terminal output suppression lock was poisoned"))?
            .insert(
                runtime_session_id.to_string(),
                OutputSuppression {
                    end_prefix: end_prefix.to_string(),
                    pending: Vec::new(),
                },
            );
        Ok(())
    }

    pub fn end_output_suppression(&self, runtime_session_id: &str) {
        if let Ok(mut suppressions) = self.output_suppressions.lock() {
            suppressions.remove(runtime_session_id);
        }
    }

    pub fn visible_output_after_suppression(
        &self,
        runtime_session_id: &str,
        data: &str,
    ) -> AppResult<String> {
        let visible =
            self.visible_output_bytes_after_suppression(runtime_session_id, data.as_bytes())?;
        Ok(String::from_utf8_lossy(&visible).into_owned())
    }

    pub(crate) fn visible_output_bytes_after_suppression(
        &self,
        runtime_session_id: &str,
        data: &[u8],
    ) -> AppResult<Vec<u8>> {
        let mut suppressions = self
            .output_suppressions
            .lock()
            .map_err(|_| AppError::terminal("terminal output suppression lock was poisoned"))?;
        let Some(suppression) = suppressions.get_mut(runtime_session_id) else {
            return Ok(data.to_vec());
        };

        suppression.pending.extend_from_slice(data);
        let Some(tail_start) =
            suppression_tail_start(&suppression.pending, suppression.end_prefix.as_bytes())
        else {
            // 原先的 24,000 字符最多占 96 KiB；按字节约束后不必解码或重编码探测输出。
            let remove = suppression.pending.len().saturating_sub(24_000 * 4);
            suppression.pending.drain(..remove);
            return Ok(Vec::new());
        };
        let visible = suppression.pending[tail_start..].to_vec();
        suppressions.remove(runtime_session_id);
        Ok(visible)
    }

    pub fn output_cursor(&self, runtime_session_id: &str) -> AppResult<usize> {
        let Some(buffer) = self.output_buffer(runtime_session_id)? else {
            return Ok(0);
        };
        let buffer = buffer
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
        Ok(buffer.end_cursor)
    }

    pub fn output_read_after_cursor(
        &self,
        runtime_session_id: &str,
        cursor: usize,
        max_chars: usize,
    ) -> AppResult<OutputRead> {
        let Some(buffer) = self.output_buffer(runtime_session_id)? else {
            return Ok(OutputRead {
                output: String::new(),
                cursor: 0,
                truncated: false,
            });
        };
        let buffer = buffer
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
        Ok(buffer.read_after(cursor, max_chars))
    }

    pub fn output_after_cursor(
        &self,
        runtime_session_id: &str,
        cursor: usize,
        max_chars: usize,
    ) -> AppResult<String> {
        Ok(self
            .output_read_after_cursor(runtime_session_id, cursor, max_chars)?
            .output)
    }

    pub fn output_tail(
        &self,
        runtime_session_id: &str,
        max_chars: usize,
    ) -> AppResult<Option<String>> {
        let Some(buffer) = self.output_buffer(runtime_session_id)? else {
            return Ok(None);
        };
        let buffer = buffer
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
        Ok(Some(
            buffer.read_after(buffer.start_cursor, max_chars).output,
        ))
    }

    pub fn wait_for_output_after(
        &self,
        runtime_session_id: &str,
        cursor: usize,
        timeout_ms: u64,
        quiet_ms: u64,
        max_chars: usize,
    ) -> AppResult<Option<String>> {
        Ok(self
            .wait_for_output_read_after(
                runtime_session_id,
                cursor,
                timeout_ms,
                quiet_ms,
                max_chars,
            )?
            .map(|read| read.output))
    }

    pub fn wait_for_output_read_after(
        &self,
        runtime_session_id: &str,
        cursor: usize,
        timeout_ms: u64,
        quiet_ms: u64,
        max_chars: usize,
    ) -> AppResult<Option<OutputRead>> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let quiet = Duration::from_millis(quiet_ms);
        let mut observed_at: Option<Instant> = None;
        let mut last_cursor = cursor;

        loop {
            let cursor_expired = self.output_cursor_is_expired(runtime_session_id, cursor)?;
            let read = self.output_read_after_cursor(runtime_session_id, cursor, max_chars)?;
            if cursor_expired {
                return Ok(Some(read));
            }
            if read.cursor > cursor {
                if read.cursor != last_cursor {
                    last_cursor = read.cursor;
                    observed_at = Some(Instant::now());
                } else if observed_at
                    .map(|instant| instant.elapsed() >= quiet)
                    .unwrap_or(false)
                {
                    return Ok(Some(read));
                } else if observed_at.is_none() {
                    observed_at = Some(Instant::now());
                }
            }

            if Instant::now() >= deadline {
                return Ok((read.cursor > cursor).then_some(read));
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn ensure_output_buffer(&self, runtime_session_id: &str) -> AppResult<()> {
        self.output_buffers
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?
            .entry(runtime_session_id.to_string())
            .or_default();
        Ok(())
    }

    fn output_cursor_is_expired(&self, runtime_session_id: &str, cursor: usize) -> AppResult<bool> {
        let Some(buffer) = self.output_buffer(runtime_session_id)? else {
            return Ok(false);
        };
        let buffer = buffer
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
        Ok(cursor < buffer.start_cursor)
    }

    fn output_buffer(
        &self,
        runtime_session_id: &str,
    ) -> AppResult<Option<Arc<Mutex<OutputBuffer>>>> {
        Ok(self
            .output_buffers
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?
            .get(runtime_session_id)
            .cloned())
    }

    fn runtime_session(&self, runtime_session_id: &str) -> AppResult<Arc<RuntimeSession>> {
        self.sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .get(runtime_session_id)
            .cloned()
            .ok_or_else(|| {
                AppError::not_found(format!("runtime session not found: {runtime_session_id}"))
            })
    }

    fn record_runtime_info(&self, info: &RuntimeSessionInfo) -> AppResult<()> {
        self.infos
            .lock()
            .map_err(|_| AppError::terminal("terminal info lock was poisoned"))?
            .insert(info.runtime_session_id.clone(), info.clone());
        Ok(())
    }
}

fn initial_local_cwd(local_options: Option<&LocalOptions>) -> AppResult<PathBuf> {
    let process_cwd = std::env::current_dir()
        .map_err(|error| AppError::terminal(format!("读取本机工作目录失败: {error}")))?;
    let configured = local_options
        .and_then(|options| options.working_directory.as_deref())
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let candidate = configured
        .map(PathBuf::from)
        .map(|path| {
            if path.is_absolute() {
                path
            } else {
                process_cwd.join(path)
            }
        })
        .unwrap_or(process_cwd);
    Ok(dunce::canonicalize(&candidate).unwrap_or(candidate))
}

fn canonical_local_cwd(path: &Path) -> Option<String> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().ok()?.join(path)
    };
    Some(
        dunce::canonicalize(&absolute)
            .unwrap_or(absolute)
            .to_string_lossy()
            .to_string(),
    )
}

struct SystemSshSecretResolver;

impl SshCommandSecretResolver for SystemSshSecretResolver {
    fn secret_for(&self, credential_ref: &str) -> AppResult<String> {
        read_system_secret(credential_ref)
    }
}

fn byte_suffix(value: &str, cursor: usize) -> &str {
    if cursor >= value.len() {
        return "";
    }
    if value.is_char_boundary(cursor) {
        &value[cursor..]
    } else {
        let start = value
            .char_indices()
            .map(|(index, _)| index)
            .find(|index| *index > cursor)
            .unwrap_or(value.len());
        &value[start..]
    }
}

#[cfg(test)]
fn tail_chars(value: &str, max_chars: usize) -> String {
    if max_chars == 0 {
        return String::new();
    }
    let total_chars = value.chars().count();
    if total_chars <= max_chars {
        return value.to_string();
    }
    let skip = total_chars - max_chars;
    let start = value
        .char_indices()
        .nth(skip)
        .map(|(index, _)| index)
        .unwrap_or(value.len());
    value[start..].to_string()
}

fn suppression_tail_start(value: &[u8], end_prefix: &[u8]) -> Option<usize> {
    let end_start = crate::services::terminal_utf8::find_bytes(value, end_prefix)?;
    let after_prefix = end_start + end_prefix.len();
    let after_line = value[after_prefix..]
        .iter()
        .position(|byte| *byte == b'\n')?;
    Some(after_prefix + after_line + 1)
}

fn short_container_id(container_id: &str) -> String {
    let value = container_id.trim();
    if value.chars().count() <= 12 {
        value.to_string()
    } else {
        value.chars().take(12).collect()
    }
}

fn supports_powershell_history_integration(profile: &TerminalProfile) -> bool {
    let is_powershell = Path::new(&profile.path)
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| {
            name.eq_ignore_ascii_case("pwsh.exe")
                || name.eq_ignore_ascii_case("powershell.exe")
                || name.eq_ignore_ascii_case("pwsh")
                || name.eq_ignore_ascii_case("powershell")
        })
        .unwrap_or(false);
    let has_conflicting_startup_arg = profile.args.iter().any(|arg| {
        matches!(
            arg.trim().to_ascii_lowercase().as_str(),
            "-command" | "-c" | "-encodedcommand" | "-e" | "-file" | "-f" | "-noninteractive"
        )
    });
    is_powershell && !has_conflicting_startup_arg
}

fn powershell_history_integration_script() -> &'static str {
    "$global:__ztermOriginalEnterHandler=Get-PSReadLineKeyHandler -Chord Enter;Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock { param($key,$arg) try { $line=$null;$cursor=0;[Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line,[ref]$cursor);$tokens=$null;$parseErrors=$null;[Management.Automation.Language.Parser]::ParseInput($line,[ref]$tokens,[ref]$parseErrors)>$null;if($parseErrors.IncompleteInput -notcontains $true){$payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($line));[Console]::Write(([char]27).ToString()+']633;ZTermCommand;'+$payload+[char]7)}} catch {} $handler=$global:__ztermOriginalEnterHandler;if ($handler.ScriptBlock) { & $handler.ScriptBlock $key $arg } elseif ($handler.Function -eq 'ValidateAndAcceptLine') { [Microsoft.PowerShell.PSConsoleReadLine]::ValidateAndAcceptLine() } else { [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine() } }"
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, Instant};

    use crate::models::{session::LocalOptions, terminal_profile::TerminalProfile};

    use super::{
        initial_local_cwd, powershell_history_integration_script,
        supports_powershell_history_integration, tail_chars, TerminalManager,
    };

    #[test]
    fn output_suppression_hides_probe_until_end_marker_and_returns_tail() {
        let manager = TerminalManager::default();

        manager
            .begin_output_suppression("runtime-1", "__ZTERM_CONTAINER_LIST_test:END:")
            .expect("suppression should start");

        assert_eq!(
            manager
                .visible_output_after_suppression(
                    "runtime-1",
                    "prompt# probe command\r\n__ZTERM_CONTAINER_LIST_test:BEGIN\r\nabc\tapi\tapp\tUp\r\n",
                )
                .expect("output should filter"),
            ""
        );
        assert_eq!(
            manager
                .visible_output_after_suppression(
                    "runtime-1",
                    "__ZTERM_CONTAINER_LIST_test:END:0\r\nprompt# ",
                )
                .expect("output should filter"),
            "prompt# "
        );
        assert_eq!(
            manager
                .visible_output_after_suppression("runtime-1", "next")
                .expect("suppression should be cleared"),
            "next"
        );
    }

    #[test]
    fn tail_chars_preserves_unicode_boundaries_without_allocating_full_char_vec() {
        assert_eq!(tail_chars("abc", 0), "");
        assert_eq!(tail_chars("abc", 5), "abc");
        assert_eq!(tail_chars("a中🚀b", 3), "中🚀b");
    }

    #[test]
    fn chunked_output_matches_string_reference_across_unicode_cursor_boundaries() {
        let mut buffer = super::OutputBuffer::default();
        let mut retained = String::new();
        let mut end_cursor = 0usize;
        for round in 0..64 {
            let input = "a中🚀\r\n".repeat((round * 97) % 1500);
            buffer.append(&input);
            end_cursor += input.len();
            retained.push_str(&input);
            retained = tail_chars(&retained, 24_000);
            let start_cursor = end_cursor - retained.len();
            assert_eq!(buffer.retained_chars, retained.chars().count());
            assert_eq!(buffer.retained_bytes, retained.len());
            assert!(buffer
                .chunks
                .iter()
                .all(|chunk| chunk.data.len() <= super::OUTPUT_CHUNK_BYTES));
            for cursor in [
                0,
                start_cursor,
                start_cursor + 1,
                end_cursor / 2,
                end_cursor.saturating_sub(1),
                end_cursor,
                end_cursor + 1,
            ] {
                let suffix = if cursor < start_cursor {
                    retained.as_str()
                } else {
                    super::byte_suffix(&retained, cursor - start_cursor)
                };
                for max_chars in [0, 1, 17, 24_000, 25_000] {
                    let read = buffer.read_after(cursor, max_chars);
                    assert_eq!(
                        read.output,
                        tail_chars(suffix, max_chars),
                        "round {round}, cursor {cursor}, max {max_chars}"
                    );
                    assert_eq!(read.cursor, end_cursor);
                    assert_eq!(
                        read.truncated,
                        cursor < start_cursor || suffix.chars().count() > max_chars
                    );
                }
            }
        }
    }

    #[test]
    fn tiny_output_appends_coalesce_and_keep_a_bounded_unicode_tail() {
        let mut buffer = super::OutputBuffer::default();
        for _ in 0..30_000 {
            buffer.append("中");
        }
        assert_eq!(buffer.retained_chars, 24_000);
        assert_eq!(buffer.retained_bytes, 72_000);
        assert!(
            buffer.chunks.len() < 20,
            "small reads must not allocate one chunk per character"
        );
        assert_eq!(buffer.read_after(0, 3).output, "中中中");
    }

    #[test]
    fn output_buffer_lock_does_not_block_another_session() {
        use std::sync::{mpsc, Arc};
        let manager = Arc::new(TerminalManager::default());
        manager.record_output("locked", "a").unwrap();
        let buffer = manager.output_buffer("locked").unwrap().unwrap();
        let locked = buffer.lock().unwrap();
        let writer = Arc::clone(&manager);
        let (sent, received) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            writer.record_output("independent", "中").unwrap();
            sent.send(writer.output_tail("independent", 10).unwrap())
                .unwrap();
        });
        let result = received.recv_timeout(Duration::from_secs(1));
        drop(locked);
        worker.join().unwrap();
        assert_eq!(result.unwrap().as_deref(), Some("中"));
    }

    #[test]
    fn output_cursor_stays_monotonic_after_the_retained_buffer_is_trimmed() {
        let manager = TerminalManager::default();
        let runtime_id = "output-cursor-trim";
        let first = "a".repeat(24_000);

        manager
            .record_output(runtime_id, &first)
            .expect("first output should be retained");
        let cursor_before_trim = manager
            .output_cursor(runtime_id)
            .expect("first cursor should be available");
        manager
            .record_output(runtime_id, "新")
            .expect("new output should be retained");

        let read = manager
            .output_read_after_cursor(runtime_id, cursor_before_trim, 24_000)
            .expect("incremental output should be readable");
        assert_eq!(read.output, "新");
        assert_eq!(read.cursor, cursor_before_trim + "新".len());
        assert!(!read.truncated);
    }

    #[test]
    fn expired_output_cursor_reports_truncation_and_keeps_unicode_boundaries() {
        let manager = TerminalManager::default();
        let runtime_id = "expired-output-cursor";
        manager
            .record_output(runtime_id, &"中".repeat(24_001))
            .expect("output should be retained");

        let read = manager
            .output_read_after_cursor(runtime_id, 0, 3)
            .expect("expired cursor should be readable");
        assert!(read.truncated);
        assert_eq!(read.output, "中中中");
        assert_eq!(read.cursor, "中".len() * 24_001);
    }

    #[test]
    fn waiting_with_an_expired_cursor_returns_the_available_tail_without_waiting_for_new_data() {
        let manager = TerminalManager::default();
        let runtime_id = "expired-output-wait";
        manager
            .record_output(runtime_id, &"x".repeat(24_001))
            .expect("output should be retained");

        let started = Instant::now();
        let read = manager
            .wait_for_output_read_after(runtime_id, 0, 1_000, 500, 10)
            .expect("expired cursor should be readable")
            .expect("expired cursor should return available output");

        assert!(read.truncated);
        assert_eq!(read.output, "xxxxxxxxxx");
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "an expired cursor should not wait for the quiet timeout"
        );
    }

    #[test]
    fn output_read_marks_a_result_truncated_when_max_chars_omits_available_output() {
        let manager = TerminalManager::default();
        let runtime_id = "max-chars-output-read";
        manager
            .record_output(runtime_id, "abcdef")
            .expect("output should be retained");

        let read = manager
            .output_read_after_cursor(runtime_id, 0, 3)
            .expect("output should be readable");

        assert_eq!(read.output, "def");
        assert_eq!(read.cursor, 6);
        assert!(read.truncated);
    }

    #[test]
    fn waiting_for_output_keeps_the_quiet_window_when_only_max_chars_truncates() {
        let manager = TerminalManager::default();
        let runtime_id = "max-chars-output-wait";
        manager
            .record_output(runtime_id, "abcdef")
            .expect("output should be retained");

        let started = Instant::now();
        let read = manager
            .wait_for_output_read_after(runtime_id, 0, 1_000, 100, 3)
            .expect("output should be readable")
            .expect("available output should be returned after quiet period");

        assert!(read.truncated);
        assert_eq!(read.output, "def");
        assert!(
            started.elapsed() >= Duration::from_millis(80),
            "max_chars truncation must not bypass the quiet window"
        );
    }

    #[test]
    fn powershell_profiles_install_the_shell_history_hook() {
        let profile = TerminalProfile {
            id: "pwsh".to_string(),
            name: "PowerShell 7".to_string(),
            path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe".to_string(),
            args: Vec::new(),
            detected: true,
            is_default: true,
            created_at_ms: 0,
            updated_at_ms: 0,
        };

        assert!(supports_powershell_history_integration(&profile));
        assert!(powershell_history_integration_script().contains("GetBufferState"));
        assert!(powershell_history_integration_script().contains("OriginalEnterHandler"));
        assert!(powershell_history_integration_script().contains("ZTermCommand"));
        assert!(powershell_history_integration_script().contains("IncompleteInput"));
        assert!(!supports_powershell_history_integration(&TerminalProfile {
            path: "C:\\Windows\\System32\\cmd.exe".to_string(),
            ..profile.clone()
        }));
        assert!(!supports_powershell_history_integration(&TerminalProfile {
            args: vec!["-File".to_string(), "startup.ps1".to_string()],
            ..profile
        }));
    }

    #[test]
    fn close_all_is_idempotent_for_multiple_runtime_sessions() {
        let manager = TerminalManager::default();
        manager
            .open_rdp_placeholder(
                "rdp-1".to_string(),
                "pane-1".to_string(),
                "RDP 1".to_string(),
            )
            .expect("first placeholder should open");
        manager
            .open_rdp_placeholder(
                "rdp-2".to_string(),
                "pane-2".to_string(),
                "RDP 2".to_string(),
            )
            .expect("second placeholder should open");

        assert_eq!(manager.close_all().expect("all runtimes should close"), 2);
        assert_eq!(manager.runtime_count(), 0);
        assert_eq!(manager.close_all().expect("repeat close should be safe"), 0);
    }

    #[cfg(windows)]
    #[test]
    fn configured_local_working_directory_is_reported_as_the_initial_cwd() {
        let options = LocalOptions {
            profile_id: None,
            working_directory: Some("C:\\work".to_string()),
            environment: Vec::new(),
        };

        assert_eq!(
            initial_local_cwd(Some(&options)).expect("initial cwd"),
            std::path::PathBuf::from("C:\\work")
        );
    }

    #[cfg(windows)]
    #[test]
    fn existing_local_working_directory_does_not_expose_the_verbatim_prefix() {
        let initial_cwd = initial_local_cwd(None).expect("initial cwd");

        assert!(initial_cwd.is_absolute());
        assert!(
            !initial_cwd.to_string_lossy().starts_with(r"\\?\"),
            "PowerShell would render a provider-qualified prompt for {initial_cwd:?}"
        );
    }
}
