// Author: Liz
use tauri::State;

use crate::{
    error::AppResult,
    models::terminal::{TerminalAccepted, TerminalOutputFlowLease},
    state::AppState,
    validation::required_text,
};

#[tauri::command]
pub fn terminal_output_flow_open(
    state: State<'_, AppState>,
    runtime_session_id: String,
) -> AppResult<TerminalOutputFlowLease> {
    let runtime_session_id = required_text("终端运行时", &runtime_session_id)?;
    state.terminal_manager().runtime_info(&runtime_session_id)?;
    let lease = state
        .terminal_output_dispatcher()
        .open_runtime(&runtime_session_id);
    Ok(TerminalOutputFlowLease {
        generation: lease.generation,
    })
}

#[tauri::command]
pub fn terminal_output_flow_ack(
    state: State<'_, AppState>,
    runtime_session_id: String,
    generation: u64,
    sequence: u64,
) -> AppResult<TerminalAccepted> {
    let runtime_session_id = required_text("终端运行时", &runtime_session_id)?;
    let accepted = state.terminal_output_dispatcher().acknowledge_runtime(
        &runtime_session_id,
        generation,
        sequence,
    );
    Ok(TerminalAccepted { accepted })
}

#[tauri::command]
pub fn terminal_output_flow_close(
    state: State<'_, AppState>,
    runtime_session_id: String,
    generation: Option<u64>,
) -> AppResult<()> {
    let runtime_session_id = required_text("终端运行时", &runtime_session_id)?;
    state
        .terminal_output_dispatcher()
        .close_runtime(&runtime_session_id, generation);
    Ok(())
}
