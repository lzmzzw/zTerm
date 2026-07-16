// Author: Liz
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};

use crate::{
    error::{AppError, AppResult},
    models::history::{CommandHistoryDraft, HistoryScopeKind},
    storage::{history::insert_command_history, sqlite::SqliteStore},
};

const MAX_COMMAND_LENGTH: usize = 4096;
const SHELL_HISTORY_MARKER_PREFIX: &str = "\u{1b}]633;ZTermCommand;";
const SHELL_HISTORY_MARKER_TERMINATOR: char = '\u{7}';
const MAX_SHELL_HISTORY_MARKER_LENGTH: usize = MAX_COMMAND_LENGTH * 6;

#[derive(Default)]
struct RuntimeInputState {
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<String>,
    buffer: String,
    pending_cr: bool,
    control_skip: Option<ControlSkipState>,
    shell_integration_enabled: bool,
    shell_output_buffer: String,
}

#[derive(Clone, Copy)]
enum ControlSkipState {
    Escape,
    Csi,
    Osc,
    OscEscape,
    String,
    StringEscape,
    Ss3,
}

pub struct CommandHistoryService {
    store: Arc<SqliteStore>,
    runtimes: Mutex<HashMap<String, RuntimeInputState>>,
}

impl CommandHistoryService {
    pub fn new(store: Arc<SqliteStore>) -> Self {
        Self {
            store,
            runtimes: Mutex::new(HashMap::new()),
        }
    }

    pub fn register_runtime(
        &self,
        runtime_session_id: &str,
        _saved_session_id: Option<String>,
        scope_kind: Option<HistoryScopeKind>,
        scope_id: Option<String>,
    ) {
        if runtime_session_id.trim().is_empty() {
            return;
        }
        if let Ok(mut runtimes) = self.runtimes.lock() {
            runtimes.insert(
                runtime_session_id.to_string(),
                RuntimeInputState {
                    scope_kind,
                    scope_id,
                    buffer: String::new(),
                    pending_cr: false,
                    control_skip: None,
                    shell_integration_enabled: false,
                    shell_output_buffer: String::new(),
                },
            );
        }
    }

    pub fn enable_shell_integration(&self, runtime_session_id: &str) {
        if let Ok(mut runtimes) = self.runtimes.lock() {
            if let Some(state) = runtimes.get_mut(runtime_session_id) {
                state.shell_integration_enabled = true;
                state.buffer.clear();
            }
        }
    }

    pub fn unregister_runtime(&self, runtime_session_id: &str) {
        if let Ok(mut runtimes) = self.runtimes.lock() {
            runtimes.remove(runtime_session_id);
        }
    }

    pub fn capture_input(&self, runtime_session_id: &str, data: &str) -> AppResult<()> {
        let mut completed = Vec::new();
        {
            let mut runtimes = self
                .runtimes
                .lock()
                .map_err(|_| AppError::terminal("command history lock was poisoned"))?;
            let Some(state) = runtimes.get_mut(runtime_session_id) else {
                return Ok(());
            };
            if state.shell_integration_enabled {
                return Ok(());
            }

            for ch in data.chars() {
                if let Some(skip) = state.control_skip {
                    state.control_skip = consume_control_skip(skip, ch);
                    continue;
                }

                match ch {
                    '\u{1b}' => {
                        state.pending_cr = false;
                        state.control_skip = Some(ControlSkipState::Escape);
                    }
                    '\u{9b}' => {
                        state.pending_cr = false;
                        state.control_skip = Some(ControlSkipState::Csi);
                    }
                    '\r' => {
                        push_completed_command(state, &mut completed);
                        state.pending_cr = true;
                    }
                    '\n' => {
                        if state.pending_cr {
                            state.pending_cr = false;
                            continue;
                        }
                        push_completed_command(state, &mut completed);
                    }
                    '\u{8}' | '\u{7f}' => {
                        state.pending_cr = false;
                        state.buffer.pop();
                    }
                    '\u{3}' => {
                        state.pending_cr = false;
                        state.buffer.clear();
                    }
                    _ => {
                        state.pending_cr = false;
                        if !ch.is_control() || ch == '\t' {
                            state.buffer.push(ch);
                        }
                    }
                }
            }
        }

        for mut command in completed {
            let Some(scope_kind) = command.scope_kind else {
                continue;
            };
            let Some(scope_id) = command.scope_id.take() else {
                continue;
            };
            insert_command_history(
                self.store.as_ref(),
                CommandHistoryDraft {
                    scope_kind: Some(scope_kind),
                    scope_id: Some(scope_id),
                    runtime_session_id: runtime_session_id.to_string(),
                    command: command.command,
                    cwd: None,
                    exit_code: None,
                    started_at_ms: now_ms()?,
                    finished_at_ms: None,
                },
            )?;
        }

        Ok(())
    }

    pub fn consume_output(
        &self,
        runtime_session_id: &str,
        data: &str,
    ) -> AppResult<(String, bool)> {
        let mut completed = Vec::new();
        let visible = {
            let mut runtimes = self
                .runtimes
                .lock()
                .map_err(|_| AppError::terminal("command history lock was poisoned"))?;
            let Some(state) = runtimes.get_mut(runtime_session_id) else {
                return Ok((data.to_string(), false));
            };
            if !state.shell_integration_enabled {
                return Ok((data.to_string(), false));
            }
            state.shell_output_buffer.push_str(data);
            consume_shell_history_output(state, &mut completed)
        };

        let history_changed = !completed.is_empty();
        for command in completed {
            persist_completed_command(self.store.as_ref(), runtime_session_id, command)?;
        }
        Ok((visible, history_changed))
    }
}

fn consume_shell_history_output(
    state: &mut RuntimeInputState,
    completed: &mut Vec<CompletedCommand>,
) -> String {
    let mut visible = String::new();
    loop {
        let Some(marker_start) = state.shell_output_buffer.find(SHELL_HISTORY_MARKER_PREFIX) else {
            let retained = partial_marker_prefix_len(&state.shell_output_buffer);
            let emit_until = state.shell_output_buffer.len().saturating_sub(retained);
            visible.push_str(&state.shell_output_buffer[..emit_until]);
            state.shell_output_buffer.drain(..emit_until);
            break;
        };

        visible.push_str(&state.shell_output_buffer[..marker_start]);
        state
            .shell_output_buffer
            .drain(..marker_start + SHELL_HISTORY_MARKER_PREFIX.len());
        let Some(marker_end) = state
            .shell_output_buffer
            .find(SHELL_HISTORY_MARKER_TERMINATOR)
        else {
            if state.shell_output_buffer.len() > MAX_SHELL_HISTORY_MARKER_LENGTH {
                state.shell_output_buffer.clear();
            } else {
                state
                    .shell_output_buffer
                    .insert_str(0, SHELL_HISTORY_MARKER_PREFIX);
            }
            break;
        };

        let payload = state.shell_output_buffer[..marker_end].to_string();
        state.shell_output_buffer.drain(..=marker_end);
        if let Some(command) = decode_shell_history_command(&payload) {
            completed.push(CompletedCommand {
                scope_kind: state.scope_kind,
                scope_id: state.scope_id.clone(),
                command,
            });
        }
    }
    visible
}

fn partial_marker_prefix_len(value: &str) -> usize {
    let max_len = value
        .len()
        .min(SHELL_HISTORY_MARKER_PREFIX.len().saturating_sub(1));
    (1..=max_len)
        .rev()
        .find(|length| value.ends_with(&SHELL_HISTORY_MARKER_PREFIX[..*length]))
        .unwrap_or(0)
}

fn decode_shell_history_command(payload: &str) -> Option<String> {
    let bytes = BASE64_STANDARD.decode(payload).ok()?;
    let command = String::from_utf8(bytes).ok()?;
    let command = command.trim().to_string();
    (!command.is_empty() && command.chars().count() <= MAX_COMMAND_LENGTH).then_some(command)
}

fn consume_control_skip(skip: ControlSkipState, ch: char) -> Option<ControlSkipState> {
    match skip {
        ControlSkipState::Escape => match ch {
            '[' => Some(ControlSkipState::Csi),
            ']' => Some(ControlSkipState::Osc),
            'P' | '_' | '^' | 'X' => Some(ControlSkipState::String),
            'O' => Some(ControlSkipState::Ss3),
            _ => None,
        },
        ControlSkipState::Csi => {
            if is_ansi_final_byte(ch) {
                None
            } else {
                Some(ControlSkipState::Csi)
            }
        }
        ControlSkipState::Osc => match ch {
            '\u{7}' => None,
            '\u{1b}' => Some(ControlSkipState::OscEscape),
            _ => Some(ControlSkipState::Osc),
        },
        ControlSkipState::OscEscape => {
            if ch == '\\' {
                None
            } else {
                Some(ControlSkipState::Osc)
            }
        }
        ControlSkipState::String => {
            if ch == '\u{1b}' {
                Some(ControlSkipState::StringEscape)
            } else {
                Some(ControlSkipState::String)
            }
        }
        ControlSkipState::StringEscape => {
            if ch == '\\' {
                None
            } else {
                Some(ControlSkipState::String)
            }
        }
        ControlSkipState::Ss3 => None,
    }
}

fn is_ansi_final_byte(ch: char) -> bool {
    ('@'..='~').contains(&ch)
}

struct CompletedCommand {
    scope_kind: Option<HistoryScopeKind>,
    scope_id: Option<String>,
    command: String,
}

fn push_completed_command(state: &mut RuntimeInputState, completed: &mut Vec<CompletedCommand>) {
    let command = state.buffer.trim().to_string();
    state.buffer.clear();
    if command.is_empty() || command.chars().count() > MAX_COMMAND_LENGTH {
        return;
    }
    completed.push(CompletedCommand {
        scope_kind: state.scope_kind,
        scope_id: state.scope_id.clone(),
        command,
    });
}

fn persist_completed_command(
    store: &SqliteStore,
    runtime_session_id: &str,
    mut command: CompletedCommand,
) -> AppResult<()> {
    let Some(scope_kind) = command.scope_kind else {
        return Ok(());
    };
    let Some(scope_id) = command.scope_id.take() else {
        return Ok(());
    };
    insert_command_history(
        store,
        CommandHistoryDraft {
            scope_kind: Some(scope_kind),
            scope_id: Some(scope_id),
            runtime_session_id: runtime_session_id.to_string(),
            command: command.command,
            cwd: None,
            exit_code: None,
            started_at_ms: now_ms()?,
            finished_at_ms: None,
        },
    )?;
    Ok(())
}

fn now_ms() -> AppResult<i64> {
    let duration = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AppError::storage(error.to_string()))?;
    Ok(duration.as_millis() as i64)
}
