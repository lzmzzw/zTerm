// Author: Liz
use std::sync::Arc;

use zterm_lib::{
    error::AppError,
    models::{
        session::{AuthMode, SavedSessionDraft, SessionType},
        sftp::{TransferDirection, TransferStatus},
    },
    services::transfer_queue::TransferQueue,
    storage::{sessions::save_session, sqlite::SqliteStore, transfers},
};

fn ssh_draft() -> SavedSessionDraft {
    SavedSessionDraft {
        id: None,
        name: "SFTP Test".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "example.test".to_string(),
        port: 22,
        username: "ops".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("cred-sftp".to_string()),
        description: None,
        tags: vec![],
        sort_order: 0,
        ssh_options: None,
        rdp_options: None,
        local_options: None,
    }
}

#[test]
fn transfer_queue_records_progress_failure_and_retry() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let session = save_session(store.as_ref(), ssh_draft()).expect("session should save");
    let queue = TransferQueue::from_storage(Arc::clone(&store));

    let task = queue
        .enqueue(
            &session.id,
            TransferDirection::Upload,
            "C:/tmp/local.txt",
            "/tmp/remote.txt",
            12,
        )
        .expect("transfer should enqueue");
    assert_eq!(task.status, TransferStatus::Queued);

    let running = queue
        .mark_running(&task.id)
        .expect("transfer should mark running");
    assert_eq!(running.status, TransferStatus::Running);

    let progressed = queue
        .mark_progress(&task.id, 7)
        .expect("transfer should update progress");
    assert_eq!(progressed.transferred_bytes, 7);

    let failed = queue
        .mark_failed(&task.id, "remote write failed")
        .expect("transfer should record failure");
    assert_eq!(failed.status, TransferStatus::Failed);
    assert_eq!(failed.error_message.as_deref(), Some("remote write failed"));

    let retry = queue
        .retry_failed(&task.id)
        .expect("failed transfer should retry");
    assert_eq!(retry.status, TransferStatus::Queued);
    assert_eq!(retry.transferred_bytes, 0);
    assert_eq!(retry.error_message, None);

    let list = transfers::list_transfer_tasks(store.as_ref(), Some(&session.id), 20)
        .expect("transfers should list");
    assert_eq!(list, vec![retry]);
}

#[test]
fn recursive_directory_delete_requires_explicit_confirmation() {
    let error =
        zterm_lib::services::sftp_service::validate_delete_request("/var/log/app", true, false)
            .expect_err("recursive directory delete should require confirmation");

    assert!(matches!(error, AppError::Validation(message) if message.contains("recursive=true")));
}
