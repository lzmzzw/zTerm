// Author: Liz
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize};
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
    services::ssh_terminal_service::{spawn_ssh_terminal, NativeSshControl, SshTerminalRuntime},
};

#[derive(Default)]
pub struct TerminalManager {
    sessions: Mutex<HashMap<String, RuntimeSession>>,
    infos: Mutex<HashMap<String, RuntimeSessionInfo>>,
    output_buffers: Mutex<HashMap<String, OutputBuffer>>,
}

pub struct OpenedPtySession {
    pub info: RuntimeSessionInfo,
    pub reader: Box<dyn Read + Send>,
    pub auth_secret: Option<String>,
}

enum RuntimeSession {
    Placeholder,
    Pty(PtyRuntime),
    NativeSsh(NativeSshRuntimeState),
}

struct PtyRuntime {
    master: Mutex<Box<dyn MasterPty + Send>>,
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
    data: String,
    updated_at_ms: i64,
}

impl TerminalManager {
    pub fn open_rdp_placeholder(
        &self,
        saved_session_id: String,
        pane_id: String,
        title: String,
    ) -> AppResult<RuntimeSessionInfo> {
        let info = RuntimeSessionInfo {
            runtime_session_id: Uuid::new_v4().to_string(),
            saved_session_id: Some(saved_session_id),
            history_scope_kind: None,
            history_scope_id: None,
            pane_id,
            title,
            kind: RuntimeSessionKind::RdpPlaceholder,
            cols: 0,
            rows: 0,
        };

        self.sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?
            .insert(info.runtime_session_id.clone(), RuntimeSession::Placeholder);
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
        let spawn = spawn_ssh_terminal(session, cols, rows)?;
        let info = RuntimeSessionInfo {
            runtime_session_id: Uuid::new_v4().to_string(),
            saved_session_id: Some(session.id.clone()),
            history_scope_kind: Some(HistoryScopeKind::SavedSession),
            history_scope_id: Some(session.id.clone()),
            pane_id,
            title: session.name.clone(),
            kind: RuntimeSessionKind::Ssh,
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
            .insert(info.runtime_session_id.clone(), runtime);
        self.record_runtime_info(&info)?;
        self.ensure_output_buffer(&info.runtime_session_id)?;

        Ok(OpenedPtySession {
            info,
            reader,
            auth_secret: spawn.auth_secret,
        })
    }

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
        let mut command = CommandBuilder::new(profile.path.as_str());
        for arg in &profile.args {
            command.arg(arg.as_str());
        }
        if let Some(working_directory) = local_options
            .and_then(|options| options.working_directory.as_deref())
            .filter(|value| !value.trim().is_empty())
        {
            command.cwd(working_directory);
        }
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
            saved_session_id,
            history_scope_kind: Some(HistoryScopeKind::LocalProfile),
            history_scope_id: Some(profile.id.clone()),
            pane_id,
            title,
            kind: RuntimeSessionKind::Local,
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
                RuntimeSession::Pty(runtime),
            );
        self.record_runtime_info(&info)?;
        self.ensure_output_buffer(&info.runtime_session_id)?;

        Ok(OpenedPtySession {
            info,
            reader: pty.reader,
            auth_secret: None,
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
        let mut sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?;
        let runtime = sessions.get_mut(runtime_session_id).ok_or_else(|| {
            AppError::not_found(format!("runtime session not found: {runtime_session_id}"))
        })?;

        match runtime {
            RuntimeSession::Placeholder => Err(AppError::unsupported(
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
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?;
        let runtime = sessions.get(runtime_session_id).ok_or_else(|| {
            AppError::not_found(format!("runtime session not found: {runtime_session_id}"))
        })?;

        match runtime {
            RuntimeSession::Placeholder => Ok(TerminalResized { resized: false }),
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
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::terminal("terminal session lock was poisoned"))?;
        let runtime = sessions.get(runtime_session_id).ok_or_else(|| {
            AppError::not_found(format!("runtime session not found: {runtime_session_id}"))
        })?;

        match runtime {
            RuntimeSession::Placeholder => Ok(None),
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

        match runtime {
            RuntimeSession::Pty(pty) => {
                let _ = pty
                    .child
                    .lock()
                    .map_err(|_| AppError::terminal("terminal child lock was poisoned"))?
                    .kill();
            }
            RuntimeSession::NativeSsh(native) => {
                native.control.close();
            }
            RuntimeSession::Placeholder => {}
        }
        if let Ok(mut buffers) = self.output_buffers.lock() {
            buffers.remove(runtime_session_id);
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

    pub fn runtime_count(&self) -> usize {
        self.sessions
            .lock()
            .map(|sessions| sessions.len())
            .unwrap_or(0)
    }

    pub fn record_output(&self, runtime_session_id: &str, data: &str) -> AppResult<()> {
        let mut buffers = self
            .output_buffers
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
        let buffer = buffers.entry(runtime_session_id.to_string()).or_default();
        buffer.data.push_str(data);
        buffer.data = tail_chars(&buffer.data, 24_000);
        buffer.updated_at_ms = now_ms();
        Ok(())
    }

    pub fn output_cursor(&self, runtime_session_id: &str) -> AppResult<usize> {
        let buffers = self
            .output_buffers
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
        Ok(buffers
            .get(runtime_session_id)
            .map(|buffer| buffer.data.len())
            .unwrap_or_default())
    }

    pub fn output_tail(
        &self,
        runtime_session_id: &str,
        max_chars: usize,
    ) -> AppResult<Option<String>> {
        let buffers = self
            .output_buffers
            .lock()
            .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
        Ok(buffers
            .get(runtime_session_id)
            .map(|buffer| tail_chars(&buffer.data, max_chars)))
    }

    pub fn wait_for_output_after(
        &self,
        runtime_session_id: &str,
        cursor: usize,
        timeout_ms: u64,
        quiet_ms: u64,
        max_chars: usize,
    ) -> AppResult<Option<String>> {
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let quiet = Duration::from_millis(quiet_ms);
        let mut observed_at: Option<Instant> = None;
        let mut last_len = cursor;

        loop {
            let current = {
                let buffers = self
                    .output_buffers
                    .lock()
                    .map_err(|_| AppError::terminal("terminal output lock was poisoned"))?;
                buffers
                    .get(runtime_session_id)
                    .map(|buffer| buffer.data.clone())
                    .unwrap_or_default()
            };
            let current_len = current.len();
            if current_len > cursor {
                if current_len != last_len {
                    last_len = current_len;
                    observed_at = Some(Instant::now());
                } else if observed_at
                    .map(|instant| instant.elapsed() >= quiet)
                    .unwrap_or(false)
                {
                    return Ok(Some(tail_chars(byte_suffix(&current, cursor), max_chars)));
                } else if observed_at.is_none() {
                    observed_at = Some(Instant::now());
                }
            }

            if Instant::now() >= deadline {
                if current_len > cursor {
                    return Ok(Some(tail_chars(byte_suffix(&current, cursor), max_chars)));
                }
                return Ok(None);
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

    fn record_runtime_info(&self, info: &RuntimeSessionInfo) -> AppResult<()> {
        self.infos
            .lock()
            .map_err(|_| AppError::terminal("terminal info lock was poisoned"))?
            .insert(info.runtime_session_id.clone(), info.clone());
        Ok(())
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

fn tail_chars(value: &str, max_chars: usize) -> String {
    let chars = value.chars().collect::<Vec<_>>();
    let start = chars.len().saturating_sub(max_chars);
    chars[start..].iter().collect()
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or_default()
}
