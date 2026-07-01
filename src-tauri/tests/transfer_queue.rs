// Author: Liz
use std::sync::Arc;

use zterm_lib::{
    error::AppError,
    models::{
        session::{AuthMode, SavedSessionDraft, SessionType},
        sftp::{
            TransferConflictPolicy, TransferDirection, TransferEndpoint, TransferEndpointKind,
            TransferKind, TransferStatus, TransferTaskOrigin,
        },
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
fn transfer_queue_records_file_transfer_endpoints_without_polluting_sftp_panel_lists() {
    let store = Arc::new(SqliteStore::open_in_memory().expect("sqlite store should open"));
    let source_session =
        save_session(store.as_ref(), ssh_draft()).expect("source session should save");
    let destination_session = save_session(
        store.as_ref(),
        SavedSessionDraft {
            id: None,
            name: "SFTP Destination".to_string(),
            host: "destination.example.test".to_string(),
            ..ssh_draft()
        },
    )
    .expect("destination session should save");
    let queue = TransferQueue::from_storage(Arc::clone(&store));

    let sftp_panel_task = queue
        .enqueue(
            &source_session.id,
            TransferDirection::Upload,
            "C:/tmp/local.txt",
            "/tmp/remote.txt",
            Some(TransferKind::File),
            TransferConflictPolicy::Overwrite,
            10,
        )
        .expect("legacy SFTP panel task should enqueue");
    let source_endpoint = TransferEndpoint {
        kind: TransferEndpointKind::Ssh,
        saved_session_id: Some(source_session.id.clone()),
        path: "/var/app.log".to_string(),
    };
    let destination_endpoint = TransferEndpoint {
        kind: TransferEndpointKind::Ssh,
        saved_session_id: Some(destination_session.id.clone()),
        path: "/backup/app.log".to_string(),
    };

    let file_transfer_task = queue
        .enqueue_with_endpoints(
            &source_session.id,
            TransferDirection::Upload,
            "/var/app.log",
            "/backup/app.log",
            Some(TransferKind::File),
            TransferConflictPolicy::Rename,
            0,
            TransferTaskOrigin::FileTransfer,
            &source_endpoint,
            &destination_endpoint,
        )
        .expect("file transfer task should enqueue");

    assert_eq!(
        file_transfer_task.task_origin,
        TransferTaskOrigin::FileTransfer
    );
    assert_eq!(file_transfer_task.source_endpoint, source_endpoint);
    assert_eq!(
        file_transfer_task.destination_endpoint,
        destination_endpoint
    );
    assert_eq!(
        file_transfer_task.conflict_policy,
        TransferConflictPolicy::Rename
    );

    let source_sftp_panel_tasks =
        transfers::list_transfer_tasks(store.as_ref(), Some(&source_session.id), 20)
            .expect("source SFTP panel tasks should list");
    assert_eq!(source_sftp_panel_tasks, vec![sftp_panel_task]);

    let destination_sftp_panel_tasks =
        transfers::list_transfer_tasks(store.as_ref(), Some(&destination_session.id), 20)
            .expect("destination SFTP panel tasks should list");
    assert!(destination_sftp_panel_tasks.is_empty());

    let global_tasks = transfers::list_transfer_tasks(store.as_ref(), None, 20)
        .expect("global transfer tasks should list");
    assert!(global_tasks
        .iter()
        .any(|task| task.id == file_transfer_task.id));
    assert!(global_tasks
        .iter()
        .any(|task| task.id == source_sftp_panel_tasks[0].id));
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

#[test]
fn transfer_queue_pauses_resumes_cancels_and_deletes_tasks() {
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
            TransferConflictPolicy::Overwrite,
            10,
        )
        .expect("transfer should enqueue");

    queue
        .register_control(&task.id)
        .expect("current runtime control should register");
    let paused_queued = queue
        .pause(&task.id)
        .expect("queued transfer with current control should pause");
    assert_eq!(paused_queued.status, TransferStatus::Paused);
    let resumed_queued = queue
        .resume(&task.id)
        .expect("paused queued transfer should resume");
    assert_eq!(resumed_queued.status, TransferStatus::Running);

    queue
        .mark_running(&task.id)
        .expect("transfer should mark running");
    let paused = queue
        .pause(&task.id)
        .expect("running transfer should pause");
    assert_eq!(paused.status, TransferStatus::Paused);

    let still_paused = queue
        .mark_progress_with_total(&task.id, 4, Some(10))
        .expect("paused transfer should keep progress without resuming");
    assert_eq!(still_paused.transferred_bytes, 4);
    assert_eq!(still_paused.status, TransferStatus::Paused);

    let resumed = queue
        .resume(&task.id)
        .expect("paused transfer should resume");
    assert_eq!(resumed.status, TransferStatus::Running);

    let cancelled = queue
        .cancel(&task.id)
        .expect("running transfer should cancel");
    assert_eq!(cancelled.status, TransferStatus::Cancelled);

    let still_cancelled = queue
        .mark_progress(&task.id, 8)
        .expect("cancelled transfer should not return to running");
    assert_eq!(still_cancelled.status, TransferStatus::Cancelled);

    queue
        .delete(&task.id)
        .expect("cancelled transfer should delete");
    let list = transfers::list_transfer_tasks(store.as_ref(), Some(&session.id), 20)
        .expect("transfers should list after delete");
    assert!(list.is_empty());
}

#[test]
fn transfer_queue_rejects_invalid_control_transitions() {
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
            10,
        )
        .expect("transfer should enqueue");

    let resume_error = queue
        .resume(&task.id)
        .expect_err("queued transfer should not resume");
    assert!(matches!(resume_error, AppError::Validation(message) if message.contains("暂停")));

    let pause_error = queue
        .pause(&task.id)
        .expect_err("queued transfer without current control should not pause");
    assert!(matches!(pause_error, AppError::Validation(message) if message.contains("当前运行期")));

    let failed = queue
        .mark_failed(&task.id, "network error")
        .expect("transfer should fail");
    assert_eq!(failed.status, TransferStatus::Failed);

    let cancel_error = queue
        .cancel(&task.id)
        .expect_err("failed transfer should not cancel");
    assert!(matches!(cancel_error, AppError::Validation(message) if message.contains("运行中")));
}
