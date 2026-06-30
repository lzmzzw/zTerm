// Author: Liz
use zterm_lib::{
    models::{
        session::{AuthMode, SavedSessionDraft, SessionType},
        workspace::{
            PaneNode, WorkspaceDefinitionDraft, WorkspaceStatus, WorkspaceTabDraft,
            WorkspaceTerminalTab,
        },
    },
    storage::{
        sessions::{delete_session, save_session},
        sqlite::SqliteStore,
        workspace::{
            close_workspace, get_workspace, list_workspaces, remove_workspace, save_workspace,
        },
    },
};

fn saved_ssh_session() -> SavedSessionDraft {
    SavedSessionDraft {
        id: None,
        name: "生产机".to_string(),
        session_type: SessionType::Ssh,
        group_id: None,
        host: "10.0.0.10".to_string(),
        port: 22,
        username: "ops".to_string(),
        auth_mode: AuthMode::Password,
        credential_ref: Some("cred-ref".to_string()),
        description: None,
        tags: Vec::new(),
        sort_order: 0,
        ssh_options: None,
        rdp_options: None,
        local_options: None,
    }
}

fn leaf_with_runtime(saved_session_id: Option<String>) -> PaneNode {
    PaneNode::Leaf {
        id: "pane-1".to_string(),
        runtime_session_id: Some("runtime-should-not-persist".to_string()),
        saved_session_id: saved_session_id.clone(),
        title: "生产机".to_string(),
        active_terminal_tab_id: Some("pane-1-tab-1".to_string()),
        terminal_tabs: vec![WorkspaceTerminalTab {
            id: "pane-1-tab-1".to_string(),
            title: "生产机".to_string(),
            runtime_session_id: Some("runtime-should-not-persist".to_string()),
            saved_session_id,
            connection_source: None,
            path: Some("/srv/app".to_string()),
            startup_command: Some("source ./env.sh".to_string()),
            restore_status: Some("connected".to_string()),
            restore_error: Some("transient error should not persist".to_string()),
        }],
    }
}

fn workspace_draft(saved_session_id: Option<String>) -> WorkspaceDefinitionDraft {
    WorkspaceDefinitionDraft {
        id: None,
        name: "运维巡检".to_string(),
        status: WorkspaceStatus::Running,
        active_tab_id: "tab-1".to_string(),
        sort_order: 0,
        tabs: vec![WorkspaceTabDraft {
            id: "tab-1".to_string(),
            title: "主工作台".to_string(),
            active_pane_id: "pane-1".to_string(),
            root: leaf_with_runtime(saved_session_id),
            sort_order: 0,
        }],
    }
}

#[test]
fn workspace_save_and_get_strips_runtime_state_from_snapshot() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let session = save_session(&store, saved_ssh_session()).expect("session should save");

    let workspace = save_workspace(&store, workspace_draft(Some(session.id.clone())))
        .expect("workspace should save");
    let loaded = get_workspace(&store, &workspace.id).expect("workspace should load");

    assert_eq!(loaded.name, "运维巡检");
    assert_eq!(loaded.status, WorkspaceStatus::Closed);
    assert_eq!(loaded.tabs.len(), 1);
    let PaneNode::Leaf {
        runtime_session_id,
        terminal_tabs,
        ..
    } = &loaded.tabs[0].root
    else {
        panic!("workspace root should be a leaf");
    };
    assert_eq!(runtime_session_id, &None);
    assert_eq!(terminal_tabs[0].runtime_session_id, None);
    assert_eq!(
        terminal_tabs[0].saved_session_id.as_deref(),
        Some(session.id.as_str())
    );
    assert_eq!(terminal_tabs[0].path.as_deref(), Some("/srv/app"));
    assert_eq!(
        terminal_tabs[0].startup_command.as_deref(),
        Some("source ./env.sh")
    );
    assert_eq!(terminal_tabs[0].restore_error, None);
}

#[test]
fn workspace_list_summarizes_saved_definitions() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let workspace = save_workspace(&store, workspace_draft(None)).expect("workspace should save");

    let summaries = list_workspaces(&store).expect("workspaces should list");

    assert!(summaries.iter().any(|summary| {
        summary.id == workspace.id
            && summary.name == "运维巡检"
            && summary.status == WorkspaceStatus::Closed
            && summary.tab_count == 1
    }));
}

#[test]
fn multiple_workspaces_can_save_the_same_tab_id() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");

    let first = save_workspace(&store, workspace_draft(None)).expect("first workspace should save");
    let second =
        save_workspace(&store, workspace_draft(None)).expect("second workspace should save");

    assert_ne!(first.id, second.id);
    assert_eq!(
        get_workspace(&store, &first.id)
            .expect("first should load")
            .tabs[0]
            .id,
        "tab-1"
    );
    assert_eq!(
        get_workspace(&store, &second.id)
            .expect("second should load")
            .tabs[0]
            .id,
        "tab-1"
    );
}

#[test]
fn closing_workspace_keeps_definition_for_later_restore() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let workspace = save_workspace(&store, workspace_draft(None)).expect("workspace should save");

    close_workspace(&store, &workspace.id).expect("workspace should close");
    let loaded = get_workspace(&store, &workspace.id).expect("closed workspace should remain");

    assert_eq!(loaded.status, WorkspaceStatus::Closed);
    assert_eq!(loaded.tabs.len(), 1);
}

#[test]
fn removing_workspace_deletes_definition_and_tabs() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let workspace = save_workspace(&store, workspace_draft(None)).expect("workspace should save");

    remove_workspace(&store, &workspace.id).expect("workspace should remove");

    assert!(get_workspace(&store, &workspace.id).is_err());
    assert!(!list_workspaces(&store)
        .expect("workspaces should list")
        .iter()
        .any(|summary| summary.id == workspace.id));
}

#[test]
fn default_workspace_cannot_be_removed() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");

    let result = remove_workspace(&store, "default-workspace");

    assert!(result.is_err());
    let loaded = get_workspace(&store, "default-workspace")
        .expect("default workspace should remain after rejected remove");
    assert_eq!(loaded.id, "default-workspace");
}

#[test]
fn default_workspace_cannot_be_saved_with_layout_snapshot() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let mut draft = workspace_draft(None);
    draft.id = Some("default-workspace".to_string());

    let result = save_workspace(&store, draft);

    assert!(result.is_err());
    let loaded = get_workspace(&store, "default-workspace")
        .expect("default workspace should remain after rejected save");
    assert_eq!(loaded.id, "default-workspace");
    assert!(loaded.tabs.is_empty());
}

#[test]
fn deleted_saved_session_is_removed_from_workspace_snapshot_on_read() {
    let store = SqliteStore::open_in_memory().expect("sqlite store should open");
    let session = save_session(&store, saved_ssh_session()).expect("session should save");
    let workspace = save_workspace(&store, workspace_draft(Some(session.id.clone())))
        .expect("workspace should save");

    delete_session(&store, &session.id).expect("session should delete");
    let loaded = get_workspace(&store, &workspace.id).expect("workspace should still load");

    let PaneNode::Leaf { terminal_tabs, .. } = &loaded.tabs[0].root else {
        panic!("workspace root should be a leaf");
    };
    assert_eq!(terminal_tabs[0].saved_session_id, None);
    assert_eq!(
        terminal_tabs[0].connection_source.as_deref(),
        Some("missing")
    );
}
