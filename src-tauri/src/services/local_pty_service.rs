// Author: Liz
use std::io::{Read, Write};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::error::{AppError, AppResult};

pub struct PtySpawn {
    pub master: Box<dyn MasterPty + Send>,
    pub child: Box<dyn Child + Send + Sync>,
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
}

pub fn spawn_pty_command(command: CommandBuilder, cols: u16, rows: u16) -> AppResult<PtySpawn> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| AppError::terminal(error.to_string()))?;
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| AppError::terminal(error.to_string()))?;
    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| AppError::terminal(error.to_string()))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| AppError::terminal(error.to_string()))?;

    Ok(PtySpawn {
        master: pair.master,
        child,
        reader,
        writer,
    })
}
