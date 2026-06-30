// Author: Liz
import { X } from "lucide-react";
import { useMemo, useState } from "react";

import { ZtSelect } from "../../components/ZtSelect";
import type { SavedSession } from "../sessions/types";
import {
  findLeafPane,
  firstLeafPaneId,
  getActiveTerminalTab,
  getLeafTerminalTabs,
  updateTerminalTabInRoot,
} from "./workspaceLayout";
import { WorkspaceLayoutPreview } from "./WorkspaceLayoutPreview";
import type {
  PaneNode,
  PaneTerminalTab,
  WorkspaceDefinition,
  WorkspaceDefinitionDraft,
} from "./types";

interface WorkspacePreviewDialogProps {
  workspace: WorkspaceDefinition;
  mode?: "create" | "edit";
  sessions: SavedSession[];
  onCancel: () => void;
  onSave: (draft: WorkspaceDefinitionDraft) => void;
}

export function WorkspacePreviewDialog({
  workspace,
  mode = "edit",
  sessions,
  onCancel,
  onSave,
}: WorkspacePreviewDialogProps) {
  const [draft, setDraft] = useState<WorkspaceDefinitionDraft>(() => definitionToDraft(workspace, mode));
  const initialTabId = draft.tabs.some((tab) => tab.id === draft.active_tab_id) ? draft.active_tab_id : draft.tabs[0]?.id;
  const [activeWorkspaceTabId, setActiveWorkspaceTabId] = useState(initialTabId ?? "");
  const initialWorkspaceTab = draft.tabs.find((tab) => tab.id === initialTabId) ?? draft.tabs[0] ?? null;
  const [selectedPaneId, setSelectedPaneId] = useState(
    initialWorkspaceTab ? initialWorkspaceTab.active_pane_id || firstLeafPaneId(initialWorkspaceTab.root) || "" : "",
  );
  const [selectedTerminalTabId, setSelectedTerminalTabId] = useState(() => {
    if (!initialWorkspaceTab) return "";
    const selectedPane = findLeafPane(initialWorkspaceTab.root, initialWorkspaceTab.active_pane_id);
    return selectedPane ? getActiveTerminalTab(selectedPane).id : "";
  });
  const sessionOptions = useMemo(
    () => sessions.filter((session) => session.type === "ssh" || session.type === "local" || session.type === "rdp"),
    [sessions],
  );
  const activeWorkspaceTab = draft.tabs.find((tab) => tab.id === activeWorkspaceTabId) ?? draft.tabs[0] ?? null;
  const selectedPane =
    activeWorkspaceTab && selectedPaneId
      ? findLeafPane(activeWorkspaceTab.root, selectedPaneId) ?? findLeafPane(activeWorkspaceTab.root, activeWorkspaceTab.active_pane_id)
      : null;
  const terminalTabs = selectedPane ? getLeafTerminalTabs(selectedPane) : [];
  const selectedTerminalTab =
    terminalTabs.find((terminalTab) => terminalTab.id === selectedTerminalTabId) ??
    (selectedPane ? getActiveTerminalTab(selectedPane) : null);
  const visibleTabs = draft.tabs.filter((tab) => !isEmptyWorkspaceTab(tab));
  const dialogLabel = mode === "create" ? "新建工作区" : `编辑工作区 ${workspace.name}`;

  function selectWorkspaceTab(tabId: string) {
    const nextTab = draft.tabs.find((tab) => tab.id === tabId);
    if (!nextTab) return;
    const paneId = nextTab.active_pane_id || firstLeafPaneId(nextTab.root) || "";
    const pane = paneId ? findLeafPane(nextTab.root, paneId) : null;
    setActiveWorkspaceTabId(tabId);
    setSelectedPaneId(paneId);
    setSelectedTerminalTabId(pane ? getActiveTerminalTab(pane).id : "");
  }

  function selectPane(paneId: string) {
    if (!activeWorkspaceTab) return;
    const pane = findLeafPane(activeWorkspaceTab.root, paneId);
    setSelectedPaneId(paneId);
    setSelectedTerminalTabId(pane ? getActiveTerminalTab(pane).id : "");
  }

  function updateTerminalTab(
    paneId: string,
    terminalTabId: string,
    updater: (terminalTab: PaneTerminalTab) => PaneTerminalTab,
  ) {
    setDraft((current) => ({
      ...current,
      tabs: current.tabs.map((tab) =>
        tab.id === activeWorkspaceTabId
          ? {
              ...tab,
              root: updateTerminalTabInRoot(tab.root, paneId, terminalTabId, updater),
            }
          : tab,
      ),
    }));
  }

  return (
    <div className="zt-session-modal-backdrop">
      <section
        className="zt-session-dialog zt-workspace-preview-dialog"
        role="dialog"
        aria-label={dialogLabel}
      >
        <header>
          <span />
          <strong>{mode === "create" ? "新建工作区" : "编辑工作区"}</strong>
          <button type="button" aria-label="关闭工作区编辑" onClick={onCancel}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className={visibleTabs.length > 1 ? "zt-workspace-preview-body has-workspace-tabs" : "zt-workspace-preview-body"}>
          <div className="zt-workspace-editor-fields">
            <input
              aria-label="编辑工作区名称"
              value={draft.name}
              onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
            />
          </div>

          {visibleTabs.length > 1 ? (
            <div className="zt-workspace-preview-workspace-tabs" role="tablist" aria-label="工作区标签">
              {visibleTabs.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-label={`切换工作区标签 ${tab.title}`}
                  aria-selected={tab.id === activeWorkspaceTabId}
                  onClick={() => selectWorkspaceTab(tab.id)}
                >
                  {tab.title}
                </button>
              ))}
            </div>
          ) : null}

          <div className="zt-workspace-preview-layout-editor">
            <div className="zt-workspace-preview-canvas">
              {activeWorkspaceTab ? (
                <WorkspaceLayoutPreview
                  root={activeWorkspaceTab.root}
                  sessions={sessionOptions}
                  selectedPaneId={selectedPane?.id ?? selectedPaneId}
                  onSelectPane={selectPane}
                />
              ) : (
                <div className="zt-empty-line">暂无工作区标签</div>
              )}
            </div>

            <aside className="zt-workspace-preview-inspector" aria-label="工作区标签属性">
              {selectedPane && selectedTerminalTab ? (
                <TerminalTabInspector
                  paneId={selectedPane.id}
                  terminalTabs={terminalTabs}
                  selectedTerminalTab={selectedTerminalTab}
                  sessions={sessionOptions}
                  onSelectTerminalTab={setSelectedTerminalTabId}
                  onUpdate={updateTerminalTab}
                />
              ) : (
                <div className="zt-empty-line">选择一个分栏以编辑连接和路径</div>
              )}
            </aside>
          </div>
        </div>

        <footer>
          <button type="button" onClick={onCancel}>
            取消
          </button>
          <button type="button" aria-label="保存工作区" onClick={() => onSave(normalizeDraft(draft))}>
            保存
          </button>
        </footer>
      </section>
    </div>
  );
}

function TerminalTabInspector({
  paneId,
  terminalTabs,
  selectedTerminalTab,
  sessions,
  onSelectTerminalTab,
  onUpdate,
}: {
  paneId: string;
  terminalTabs: PaneTerminalTab[];
  selectedTerminalTab: PaneTerminalTab;
  sessions: SavedSession[];
  onSelectTerminalTab: (terminalTabId: string) => void;
  onUpdate: (
    paneId: string,
    terminalTabId: string,
    updater: (terminalTab: PaneTerminalTab) => PaneTerminalTab,
  ) => void;
}) {
  const connectionValue =
    selectedTerminalTab.connection_source === "missing"
      ? "__missing__"
      : selectedTerminalTab.saved_session_id ?? "__default_local__";
  const visibleTerminalTabs = terminalTabs.filter((terminalTab) => !isEmptyTerminalTab(terminalTab));

  return (
    <>
      <div className="zt-workspace-preview-pane-tab-list horizontal" role="tablist" aria-label={`${paneId} 终端标签`}>
        {visibleTerminalTabs.map((terminalTab) => (
          <button
            key={terminalTab.id}
            type="button"
            role="tab"
            aria-label={`终端标签 ${terminalTab.id}`}
            aria-selected={terminalTab.id === selectedTerminalTab.id}
            onClick={() => onSelectTerminalTab(terminalTab.id)}
          >
            {terminalTab.title}
          </button>
        ))}
      </div>
      <div className="zt-workspace-preview-inspector-fields">
        <label>
          连接
          <ZtSelect
            ariaLabel="编辑标签连接"
            value={connectionValue}
            options={[
              { value: "__default_local__", label: "默认本地终端" },
              ...(connectionValue === "__missing__" ? [{ value: "__missing__", label: "缺失连接" }] : []),
              ...sessions.map((session) => ({ value: session.id, label: session.name })),
            ]}
            searchable
            onChange={(nextValue) =>
              onUpdate(paneId, selectedTerminalTab.id, (current) => {
                if (nextValue === "__default_local__") {
                  return {
                    ...current,
                    saved_session_id: null,
                    connection_source: "default_local",
                  };
                }
                const session = sessions.find((candidate) => candidate.id === nextValue);
                return {
                  ...current,
                  title: current.title.trim() ? current.title : (session?.name ?? current.title),
                  saved_session_id: nextValue,
                  connection_source: "saved_session",
                };
              })
            }
          />
        </label>
        <label>
          路径
          <input
            aria-label="编辑标签路径"
            value={selectedTerminalTab.path ?? ""}
            onChange={(event) =>
              onUpdate(paneId, selectedTerminalTab.id, (current) => ({ ...current, path: event.target.value }))
            }
          />
        </label>
        <label>
          连接后指令
          <textarea
            aria-label="编辑连接后指令"
            value={selectedTerminalTab.startup_command ?? ""}
            rows={3}
            onChange={(event) =>
              onUpdate(paneId, selectedTerminalTab.id, (current) => ({
                ...current,
                startup_command: event.target.value,
              }))
            }
          />
        </label>
        {selectedTerminalTab.restore_status === "failed" ? (
          <p className="zt-workspace-preview-error">{selectedTerminalTab.restore_error ?? "恢复失败"}</p>
        ) : null}
      </div>
    </>
  );
}

function isEmptyWorkspaceTab(tab: WorkspaceDefinitionDraft["tabs"][number]) {
  if (tab.title !== "新建终端" || tab.root.kind !== "leaf") return false;
  if (tab.root.runtime_session_id || tab.root.saved_session_id) return false;

  const terminalTabs = tab.root.terminal_tabs ?? [];
  return terminalTabs.length === 0 || terminalTabs.every(isEmptyTerminalTab);
}

function isEmptyTerminalTab(terminalTab: PaneTerminalTab) {
  return (
    terminalTab.title === "新建终端" &&
    !terminalTab.runtime_session_id &&
    !terminalTab.saved_session_id &&
    terminalTab.connection_source !== "missing" &&
    !terminalTab.path &&
    !terminalTab.startup_command
  );
}

function definitionToDraft(workspace: WorkspaceDefinition, mode: "create" | "edit"): WorkspaceDefinitionDraft {
  return {
    id: mode === "create" ? null : workspace.id,
    name: workspace.name,
    status: "closed",
    active_tab_id: workspace.active_tab_id,
    sort_order: workspace.sort_order,
    tabs: workspace.tabs.map((tab) => ({
      id: tab.id,
      title: tab.title,
      active_pane_id: tab.active_pane_id,
      root: tab.root,
      sort_order: tab.sort_order,
    })),
  };
}

function normalizeDraft(draft: WorkspaceDefinitionDraft): WorkspaceDefinitionDraft {
  return {
    ...draft,
    name: draft.name.trim(),
    tabs: draft.tabs.map((tab) => ({
      ...tab,
      root: normalizePane(tab.root),
    })),
  };
}

function normalizePane(root: PaneNode): PaneNode {
  if (root.kind === "split") {
    return {
      ...root,
      first: normalizePane(root.first),
      second: normalizePane(root.second),
    };
  }

  return {
    ...root,
    terminal_tabs: getLeafTerminalTabs(root).map((terminalTab) => {
      const startupCommand = terminalTab.startup_command?.trimEnd();
      return {
        ...terminalTab,
        startup_command: startupCommand && startupCommand.trim() ? startupCommand : null,
      };
    }),
  };
}
