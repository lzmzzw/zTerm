// Author: Liz
use zterm_lib::{
    error::AppError,
    models::sftp::{FileTransferViewState, TransferEndpoint, TransferEndpointKind},
    storage::{
        file_transfer_view_state::{get_file_transfer_view_state, save_file_transfer_view_state},
        sqlite::SqliteStore,
    },
};

fn view_state() -> FileTransferViewState {
    FileTransferViewState {
        left: TransferEndpoint {
            kind: TransferEndpointKind::Local,
            saved_session_id: None,
            path: "F:/Workspace".to_string(),
        },
        right: TransferEndpoint {
            kind: TransferEndpointKind::SavedSession,
            saved_session_id: Some("ssh-prod".to_string()),
            path: "/srv/releases".to_string(),
        },
    }
}

#[test]
fn file_transfer_view_state_round_trips_both_endpoints() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    assert_eq!(
        get_file_transfer_view_state(&store).expect("empty state should load"),
        None
    );

    let state = view_state();
    save_file_transfer_view_state(&store, state.clone()).expect("state should save");

    assert_eq!(
        get_file_transfer_view_state(&store).expect("saved state should load"),
        Some(state)
    );
}

#[test]
fn file_transfer_view_state_rejects_incomplete_endpoints() {
    let store = SqliteStore::open_in_memory().expect("store should open");
    let mut state = view_state();
    state.right.saved_session_id = None;

    let error = save_file_transfer_view_state(&store, state)
        .expect_err("remote endpoint without a session must fail");

    assert!(matches!(error, AppError::Validation(_)));
}
