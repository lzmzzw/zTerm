// Author: Liz
use std::{path::Path, sync::Mutex};

use rusqlite::{Connection, Transaction};

use crate::{
    error::{AppError, AppResult},
    storage::migrations::run_migrations,
};

pub struct SqliteStore {
    connection: Mutex<Connection>,
}

impl SqliteStore {
    pub fn open(db_path: impl AsRef<Path>) -> AppResult<Self> {
        let db_path = db_path.as_ref();
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let mut connection = Connection::open(db_path)?;
        configure_connection(&connection)?;
        run_migrations(&mut connection)?;

        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn open_in_memory() -> AppResult<Self> {
        let mut connection = Connection::open_in_memory()?;
        configure_connection(&connection)?;
        run_migrations(&mut connection)?;

        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn with_connection<T>(
        &self,
        operation: impl FnOnce(&Connection) -> AppResult<T>,
    ) -> AppResult<T> {
        let guard = self
            .connection
            .lock()
            .map_err(|_| AppError::storage("sqlite connection lock was poisoned"))?;
        operation(&guard)
    }

    pub fn write_transaction<T>(
        &self,
        operation: impl FnOnce(&Transaction<'_>) -> AppResult<T>,
    ) -> AppResult<T> {
        let mut guard = self
            .connection
            .lock()
            .map_err(|_| AppError::storage("sqlite connection lock was poisoned"))?;
        let transaction = guard.transaction()?;
        let result = operation(&transaction)?;
        transaction.commit()?;
        Ok(result)
    }
}

fn configure_connection(connection: &Connection) -> AppResult<()> {
    connection.execute_batch(
        "
        pragma foreign_keys = on;
        pragma busy_timeout = 5000;
        ",
    )?;
    Ok(())
}
