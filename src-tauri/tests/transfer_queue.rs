// Author: Liz
use std::sync::Arc;

use zterm_lib::{
    error::AppError,
    models::{
        session::{AuthMode, SavedSessionDraft, SessionType},
        sftp::{TransferConflictPolicy, TransferDirection, TransferKind, TransferStatus},
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
            Some(TransferKind::File),
            TransferConflictPolicy::Rename,
            12,
        )
        .expect("transfer should enqueue");
    assert_eq!(task.status, TransferStatus::Queued);
    assert_eq!(task.kind, Some(TransferKind::File));
    assert_eq!(task.conflict_policy, TransferConflictPolicy::Rename);

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
    assert_eq!(retry.kind, Some(TransferKind::File));
    assert_eq!(retry.conflict_policy, TransferConflictPolicy::Rename);

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

#[test]
fn root_destructive_operations_are_rejected() {
    let error = zterm_lib::services::sftp_service::validate_destructive_remote_path("/")
        .expect_err("root destructive operations should be rejected");

    assert!(matches!(error, AppError::Validation(message) if message.contains("根目录")));
}

#[test]
fn unknown_total_download_done_keeps_observed_progress() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let session = save_session(store.as_ref(), ssh_draft()).expect("session should save");
    let queue = TransferQueue::from_storage(Arc::clone(&store));
    let task = queue
        .enqueue(
            &session.id,
            TransferDirection::Download,
            "C:/tmp/local.txt",
            "/tmp/remote.txt",
            Some(TransferKind::File),
            TransferConflictPolicy::Overwrite,
            0,
        )
        .expect("download should enqueue with unknown total");

    queue
        .mark_progress(&task.id, 9)
        .expect("download should record progress");
    let done = queue.mark_done(&task.id).expect("download should complete");

    assert_eq!(done.total_bytes, 0);
    assert_eq!(done.transferred_bytes, 9);
    assert_eq!(done.status, TransferStatus::Done);
}

#[test]
fn progress_updates_can_set_download_total_when_discovered_later() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let session = save_session(store.as_ref(), ssh_draft()).expect("session should save");
    let queue = TransferQueue::from_storage(Arc::clone(&store));
    let task = queue
        .enqueue(
            &session.id,
            TransferDirection::Download,
            "C:/tmp/local.txt",
            "/tmp/remote.txt",
            Some(TransferKind::File),
            TransferConflictPolicy::Overwrite,
            0,
        )
        .expect("download should enqueue with unknown total");

    let progressed = queue
        .mark_progress_with_total(&task.id, 4, Some(10))
        .expect("download progress should set discovered total");

    assert_eq!(progressed.transferred_bytes, 4);
    assert_eq!(progressed.total_bytes, 10);
    assert_eq!(progressed.status, TransferStatus::Running);
}
