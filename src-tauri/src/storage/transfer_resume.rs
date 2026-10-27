use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    storage::sqlite::SqliteStore,
};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct TransferResumeManifest {
    pub version: u32,
    pub binding: String,
    pub partial_path: String,
    pub total_bytes: u64,
    pub source_sha256: String,
    pub confirmed_offset: u64,
    pub prefix_sha256: String,
}

pub fn phase(store: &SqliteStore, task_id: &str) -> AppResult<Option<String>> {
    store.with_connection(|connection| {
        connection
            .query_row(
                "select phase from transfer_resume where task_id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(Into::into)
    })
}

pub fn load(store: &SqliteStore, task_id: &str) -> AppResult<Option<TransferResumeManifest>> {
    store.with_connection(|connection| {
        let json: Option<String> = connection
            .query_row(
                "select manifest_json from transfer_resume where task_id = ?1",
                [task_id],
                |row| row.get(0),
            )
            .optional()?;
        json.map(|json| {
            serde_json::from_str(&json).map_err(|_| AppError::storage("传输续传记录损坏"))
        })
        .transpose()
    })
}

pub fn save(
    store: &SqliteStore,
    task_id: &str,
    manifest: &TransferResumeManifest,
) -> AppResult<()> {
    let json = serde_json::to_string(manifest).map_err(|e| AppError::storage(e.to_string()))?;
    store.write_transaction(|tx| {
        let changed = tx.execute(
            "insert into transfer_resume(task_id, phase, manifest_json) values (?1, 'copying', ?2)
             on conflict(task_id) do update set manifest_json = excluded.manifest_json
             where transfer_resume.phase = 'copying'",
            params![task_id, json],
        )?;
        if changed != 1 {
            return Err(AppError::storage("传输已进入发布阶段，不能重写续传记录"));
        }
        Ok(())
    })
}

pub fn mark_publishing(store: &SqliteStore, task_id: &str) -> AppResult<()> {
    store.write_transaction(|tx| {
        if tx.execute("update transfer_resume set phase = 'publishing' where task_id = ?1 and phase = 'copying'", [task_id])? != 1 {
            return Err(AppError::storage("传输续传记录不存在或已进入发布阶段"));
        }
        Ok(())
    })
}

pub fn clear(store: &SqliteStore, task_id: &str) -> AppResult<()> {
    store.write_transaction(|tx| {
        tx.execute("delete from transfer_resume where task_id = ?1", [task_id])?;
        Ok(())
    })
}

#[cfg(test)]
pub(crate) fn test_context() -> (
    std::sync::Arc<SqliteStore>,
    crate::services::transfer_resume::TransferResumeContext,
) {
    let store = std::sync::Arc::new(SqliteStore::open_in_memory().unwrap());
    store.with_connection(|connection| {
        connection.execute_batch("insert into saved_sessions(id,name,type,host,port,username,auth_mode,created_at_ms,updated_at_ms) values ('resume-session','test','ssh','example.test',22,'test','none',1,1);
            insert into transfer_tasks(id,saved_session_id,direction,local_path,remote_path,status,created_at_ms,updated_at_ms) values ('resume-task','resume-session','upload','local','remote','failed',1,1);")?;
        Ok(())
    }).unwrap();
    let context = crate::services::transfer_resume::TransferResumeContext::new(
        std::sync::Arc::clone(&store),
        "resume-task",
    );
    (store, context)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persistent_publishing_blocks_restart_and_task_delete_cascades() {
        let (store, context) = test_context();
        let manifest = TransferResumeManifest {
            version: 1,
            binding: "route-digest".into(),
            partial_path: "/.zterm-test.partial".into(),
            total_bytes: 3,
            source_sha256: "hash".into(),
            confirmed_offset: 0,
            prefix_sha256: "empty".into(),
        };
        save(&store, "resume-task", &manifest).unwrap();
        assert_eq!(load(&store, "resume-task").unwrap(), Some(manifest.clone()));
        mark_publishing(&store, "resume-task").unwrap();
        let restarted = crate::services::transfer_resume::TransferResumeContext::new(
            std::sync::Arc::clone(&store),
            "resume-task",
        );
        assert!(restarted
            .ensure_retryable()
            .unwrap_err()
            .to_string()
            .contains("SFTP_PUBLISH_OUTCOME_UNKNOWN"));
        assert!(save(&store, "resume-task", &manifest).is_err());
        store
            .with_connection(|connection| {
                connection.execute("delete from transfer_tasks where id='resume-task'", [])?;
                Ok(())
            })
            .unwrap();
        assert!(phase(&store, "resume-task").unwrap().is_none());
        assert!(context.ensure_retryable().is_ok());
    }
}
