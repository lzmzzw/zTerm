// Author: Liz
import { LogIn, Play, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AgentCodexPanel } from "../features/ai/AgentCodexPanel";
import type { AgentCodexSession } from "../features/ai/agentCodexApi";
import type { McpApprovalMode, McpToolPendingInvocation, McpToolSecretInputs } from "../features/ai/mcpStore";
import { FileExplorerPanel } from "../features/files/FileExplorerPanel";
import { TransferPanel } from "../features/files/TransferPanel";
import type { FileEntry, TransferTask } from "../features/files/fileTypes";
import type { FileSelectionEvent } from "../features/files/fileSelectionModel";
import { CommandHistoryPanel } from "../features/history/CommandHistoryPanel";
import type {
  CommandHistoryEntry,
  HistoryScopeKind,
  SessionCommandGroup,
  SessionCommandGroupDraft,
} from "../features/history/types";
import type { CommandHistoryView } from "../features/history/CommandHistoryPanel";
import { ServerMonitorPanel, type ServerMonitorTarget } from "../features/monitor/ServerMonitorPanel";
import { useServerInfoSnapshot } from "../features/monitor/useServerInfoSnapshot";
import { sshTunnelMode } from "../features/sessions/sshSessionModel";
import { tunnelModes } from "../features/sessions/SshTunnelCard";
import type { SshTunnel } from "../features/sessions/types";
import type { AppLanguage } from "../features/settings/settingsStore";
import type { SshContainerInfo } from "../features/terminal/sshContainerApi";
import { t } from "../features/settings/i18n";
import { ZtSelect } from "../components/ZtSelect";
import { ZtContextMenu, ZtInlineError } from "../components/ZtUi";
import { PanelHeader } from "./ShellControls";
import { rightToolLabelKey, type RightTool } from "./rightTools";

interface RightToolsPanelProps {
  activeTool: RightTool | null;
  onClose: () => void;
  agent: {
    session: AgentCodexSession | null;
    sessionsByConnectionKey: Record<string, AgentCodexSession>;
    activeConnectionKey: string | null;
    activeTargetLabel?: string | null;
    approvalMode: McpApprovalMode;
    error: string | null;
    loading: boolean;
    pendingInvocations: McpToolPendingInvocation[];
    onApprovalModeChange: (mode: McpApprovalMode) => Promise<unknown> | unknown;
    onClose: () => Promise<unknown> | unknown;
    onConfirmTool: (invocationId: string, approved: boolean, secretInputs?: McpToolSecretInputs) => Promise<unknown> | unknown;
    onRestart: () => Promise<unknown> | unknown;
  };
  files: {
    entries: FileEntry[];
    error: string | null;
    loading: boolean;
    path: string;
    savedSessionId: string | null;
    selectedPaths: string[];
    onDelete: (paths: string[], recursive: boolean) => Promise<void> | void;
    onDownload: (entries: FileEntry[]) => Promise<void> | void;
    onMkdir: () => Promise<void> | void;
    onOpenDirectory: (path: string) => Promise<void> | void;
    onParent: () => Promise<void> | void;
    onPathChange: (path: string) => void;
    onRefresh: () => Promise<void> | void;
    onRename: (path: string) => Promise<void> | void;
    onSelect: (path: string | null, event?: FileSelectionEvent, orderedEntries?: FileEntry[]) => void;
    onSelectAll: (paths: string[]) => void;
    onUpload: () => Promise<void> | void;
    onUploadDropped: (paths: string[]) => Promise<void> | void;
  };
  history: {
    activeView: CommandHistoryView;
    commandGroups: SessionCommandGroup[];
    deduplicateHistory: boolean;
    entries: CommandHistoryEntry[];
    error: string | null;
    groupError: string | null;
    groupLoading: boolean;
    language?: AppLanguage;
    loading: boolean;
    query: string;
    historyScopeKind: HistoryScopeKind | null;
    historyScopeId: string | null;
    onClear: () => void;
    onDeleteEntries: (entryIds: string[]) => Promise<void> | void;
    onCopy: (command: string) => void;
    onDeleteCommandGroup: (groupId: string) => Promise<unknown> | unknown;
    onDeduplicateHistoryChange: (enabled: boolean) => void;
    onQueryChange: (query: string) => void;
    onSaveCommandGroup: (draft: SessionCommandGroupDraft) => Promise<unknown> | unknown;
    onSearch: (options?: { deduplicate?: boolean }) => void;
    onSend: (command: string) => void;
    onViewChange: (view: CommandHistoryView) => void;
  };
  monitor: {
    target: ServerMonitorTarget | null;
  };
  containers: {
    enabled: boolean;
    editableRuntime: boolean;
    runtime: string | null;
    sessionName: string | null;
    target: string | null;
    items: SshContainerInfo[];
    loading: boolean;
    error: string | null;
    onEnter: (container: SshContainerInfo) => Promise<void> | void;
    onStart: (container: SshContainerInfo) => Promise<void> | void;
    onRefresh: () => Promise<void> | void;
    onRuntimeChange: (runtime: string) => Promise<void> | void;
  };
  tunnels: {
    canManage: boolean;
    canCreate: boolean;
    editable: boolean;
    needsReconnect: boolean;
    sessionName: string | null;
    target: string | null;
    items: SshTunnel[];
    onEdit: () => void;
    onCreate: () => void;
    onDeleteTunnel: (index: number) => void;
    onEditTunnel: (index: number) => void;
    onReconnect: () => void;
  };
  transfers: {
    tasks: TransferTask[];
    onCancel: (taskId: string) => Promise<void> | void;
    onDelete: (taskId: string) => Promise<void> | void;
    onPause: (taskId: string) => Promise<void> | void;
    onRetry: (taskId: string) => Promise<void> | void;
    onResume: (taskId: string) => Promise<void> | void;
  };
  language?: AppLanguage;
}

export function RightToolsPanel({
  activeTool,
  onClose,
  agent,
  files,
  history,
  monitor,
  containers,
  tunnels,
  transfers,
  language = "zhCN",
}: RightToolsPanelProps) {
  const monitorSnapshot = useServerInfoSnapshot(monitor.target?.id ?? null, activeTool === "monitor");

  return (
    <aside
      className={
        activeTool
          ? "zt-sidebar zt-sidebar-right zt-right-tools"
          : "zt-sidebar zt-sidebar-right zt-right-tools zt-right-tools-collapsed"
      }
      aria-label="右侧工具栏"
    >
      {activeTool && activeTool !== "agent" ? (
        <section className="zt-tool-panel" aria-label={t(language, rightToolLabelKey(activeTool))}>
          {activeTool === "files" ? (
            <>
              <PanelHeader onClose={onClose} title="SFTP" />
              <div className="zt-file-transfer-shell">
                <FileExplorerPanel
                  savedSessionId={files.savedSessionId}
                  path={files.path}
                  entries={files.entries}
                  selectedPaths={files.selectedPaths}
                  loading={files.loading}
                  error={files.error}
                  onPathChange={files.onPathChange}
                  onSelect={files.onSelect}
                  onSelectAll={files.onSelectAll}
                  onRefresh={files.onRefresh}
                  onParent={files.onParent}
                  onMkdir={files.onMkdir}
                  onUpload={files.onUpload}
                  onDownload={files.onDownload}
                  onRename={files.onRename}
                  onDelete={files.onDelete}
                  onOpenDirectory={files.onOpenDirectory}
                  onUploadDropped={files.onUploadDropped}
                />
                <TransferPanel
                  collapsible
                  defaultCollapsed
                  tasks={transfers.tasks}
                  onCancel={transfers.onCancel}
                  onDelete={transfers.onDelete}
                  onPause={transfers.onPause}
                  onRetry={transfers.onRetry}
                  onResume={transfers.onResume}
                />
              </div>
            </>
          ) : null}

          {activeTool === "history" ? (
            <>
              <PanelHeader onClose={onClose} title={t(language, "history")} />
              <CommandHistoryPanel
                activeView={history.activeView}
                commandGroups={history.commandGroups}
                deduplicateHistory={history.deduplicateHistory}
                entries={history.entries}
                query={history.query}
                loading={history.loading}
                error={history.error}
                groupLoading={history.groupLoading}
                groupError={history.groupError}
                language={history.language}
                historyScopeKind={history.historyScopeKind}
                historyScopeId={history.historyScopeId}
                onViewChange={history.onViewChange}
                onDeduplicateHistoryChange={history.onDeduplicateHistoryChange}
                onQueryChange={history.onQueryChange}
                onSearch={history.onSearch}
                onCopy={history.onCopy}
                onSend={history.onSend}
                onClear={history.onClear}
                onDeleteEntries={history.onDeleteEntries}
                onSaveCommandGroup={history.onSaveCommandGroup}
                onDeleteCommandGroup={history.onDeleteCommandGroup}
              />
            </>
          ) : null}

          {activeTool === "monitor" ? (
            <>
              <PanelHeader onClose={onClose} title={t(language, "resourceMonitor")} />
              <ServerMonitorPanel
                active={activeTool === "monitor"}
                target={monitor.target}
                error={monitorSnapshot.error}
                loading={monitorSnapshot.loading}
                networkTraffic={monitorSnapshot.networkTraffic}
                refreshIntervalMs={monitorSnapshot.refreshIntervalMs}
                snapshot={monitorSnapshot.snapshot}
                onRefresh={monitorSnapshot.refresh}
                onRefreshIntervalChange={monitorSnapshot.setRefreshIntervalMs}
              />
            </>
          ) : null}

          {activeTool === "containers" ? (
            <>
              <PanelHeader onClose={onClose} title={t(language, "sshContainers")} />
              <SshContainerListPanel
                sessionName={containers.sessionName}
                target={containers.target}
                containers={containers.items}
                editableRuntime={containers.editableRuntime}
                runtime={containers.runtime}
                loading={containers.loading}
                error={containers.error}
                onEnter={containers.onEnter}
                onStart={containers.onStart}
                onRefresh={containers.onRefresh}
                onRuntimeChange={containers.onRuntimeChange}
              />
            </>
          ) : null}

          {activeTool === "tunnels" ? (
            <>
              <PanelHeader
                onClose={onClose}
                title={t(language, "sshTunnels")}
                action={
                  tunnels.canManage ? (
                    <button
                      type="button"
                      className="zt-panel-action-button zt-panel-action-button-labeled"
                      aria-label="新增隧道"
                      title={tunnels.canCreate ? "新增隧道" : "当前 SSH 连接最多只能配置一条隧道"}
                      disabled={!tunnels.canCreate}
                      onClick={tunnels.onCreate}
                    >
                      <Plus size={14} aria-hidden="true" />
                      新增隧道
                    </button>
                  ) : undefined
                }
              />
              <SshTunnelListPanel
                sessionName={tunnels.sessionName}
                target={tunnels.target}
                tunnels={tunnels.items}
                editable={tunnels.editable}
                needsReconnect={tunnels.needsReconnect}
                onEdit={tunnels.onEdit}
                onDeleteTunnel={tunnels.onDeleteTunnel}
                onEditTunnel={tunnels.onEditTunnel}
                onReconnect={tunnels.onReconnect}
              />
            </>
          ) : null}
        </section>
      ) : null}

      {activeTool === "agent" || Object.keys(agent.sessionsByConnectionKey).length > 0 ? (
        <section
          className="zt-tool-panel"
          aria-label={t(language, "agent")}
          hidden={activeTool !== "agent"}
          style={activeTool === "agent" ? undefined : { display: "none" }}
        >
          <PanelHeader onClose={onClose} title={t(language, "agent")} />
          {Object.entries(agent.sessionsByConnectionKey).map(([connectionKey, session]) => {
            const active = connectionKey === agent.activeConnectionKey;
            return (
              <div
                key={connectionKey}
                hidden={!active}
                style={active ? { display: "flex", minHeight: 0, height: "100%", flexDirection: "column" } : { display: "none" }}
              >
                <AgentCodexPanel
                  session={session}
                  activeTargetLabel={active ? agent.activeTargetLabel : null}
                  active={active && activeTool === "agent"}
                  approvalMode={agent.approvalMode}
                  pendingInvocations={active ? agent.pendingInvocations : []}
                  loading={active && agent.loading}
                  error={active ? agent.error : null}
                  onApprovalModeChange={agent.onApprovalModeChange}
                  onClose={agent.onClose}
                  onConfirmTool={agent.onConfirmTool}
                  onRestart={agent.onRestart}
                />
              </div>
            );
          })}
          {!agent.session ? (
            <AgentCodexPanel
              session={null}
              activeTargetLabel={agent.activeTargetLabel}
              active={activeTool === "agent"}
              approvalMode={agent.approvalMode}
              pendingInvocations={agent.pendingInvocations}
              loading={agent.loading}
              error={agent.error}
              onApprovalModeChange={agent.onApprovalModeChange}
              onClose={agent.onClose}
              onConfirmTool={agent.onConfirmTool}
              onRestart={agent.onRestart}
            />
          ) : null}
        </section>
      ) : null}

    </aside>
  );
}

function SshContainerListPanel({
  sessionName,
  target,
  containers,
  editableRuntime,
  runtime,
  loading,
  error,
  onEnter,
  onStart,
  onRefresh,
  onRuntimeChange,
}: {
  sessionName: string | null;
  target: string | null;
  containers: SshContainerInfo[];
  editableRuntime: boolean;
  runtime: string | null;
  loading: boolean;
  error: string | null;
  onEnter: (container: SshContainerInfo) => Promise<void> | void;
  onStart: (container: SshContainerInfo) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
  onRuntimeChange: (runtime: string) => Promise<void> | void;
}) {
  const actionPending = useRef(false);
  const [busy, setBusy] = useState(false);
  async function activateContainer(container: SshContainerInfo) {
    if (actionPending.current || loading) return;
    actionPending.current = true;
    setBusy(true);
    try {
      await (container.running ? onEnter(container) : onStart(container));
    } finally {
      actionPending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="zt-tunnel-panel zt-container-panel">
      <div className="zt-tunnel-target zt-target-summary">
        <strong>{sessionName ?? "当前 SSH 连接"}</strong>
        {target ? <span>{target}</span> : null}
        <button
          type="button"
          className="zt-target-summary-action zt-container-refresh-button"
          aria-label="刷新容器"
          title="刷新"
          disabled={busy || loading}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            const button = event.currentTarget;
            button.dataset.pointerActivated = "true";
            window.setTimeout(() => {
              delete button.dataset.pointerActivated;
            }, 350);
            void onRefresh();
          }}
          onClick={(event) => {
            if (event.currentTarget.dataset.pointerActivated === "true") {
              delete event.currentTarget.dataset.pointerActivated;
              event.preventDefault();
              return;
            }
            void onRefresh();
          }}
        >
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      {editableRuntime ? (
        <label className="zt-session-form-wide">
          <span>容器类型</span>
          <ZtSelect
            ariaLabel="容器运行时"
            value={runtime ?? "docker"}
            options={containerRuntimeOptions}
            onChange={(nextRuntime) => void onRuntimeChange(nextRuntime)}
          />
        </label>
      ) : null}
      {loading ? <div className="zt-empty-line">正在加载容器...</div> : null}
      {error ? <ZtInlineError className="zt-error-line">{error}</ZtInlineError> : null}
      {!loading && !error && containers.length === 0 ? <div className="zt-empty-line">当前 SSH 连接没有容器</div> : null}
      {containers.length > 0 ? (
        <div className="zt-tunnel-list" role="list" aria-label="SSH 容器列表">
          {containers.map((container) => {
            const title = container.name?.trim() || container.id.slice(0, 12);
            return (
              <section className="zt-tunnel-list-item zt-container-list-item" role="listitem" aria-label={title} key={container.id}>
                <div className="zt-container-main">
                  <strong>{title}</strong>
                  <span>{container.image || "-"}</span>
                </div>
                <div className="zt-container-actions">
                  <span className={`zt-container-status${container.running ? " is-running" : " is-stopped"}`}>
                    {container.running ? "运行中" : "已停止"}
                  </span>
                  <button
                    type="button"
                    className="zt-icon-button zt-container-enter-button"
                    aria-label={`${container.running ? "进入" : "启动"}容器 ${title}`}
                    title={container.running ? "进入容器" : "启动容器"}
                    disabled={busy || loading}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || busy || loading) return;
                      event.preventDefault();
                      const button = event.currentTarget;
                      button.dataset.pointerActivated = "true";
                      window.setTimeout(() => {
                        delete button.dataset.pointerActivated;
                      }, 350);
                      void activateContainer(container);
                    }}
                    onClick={(event) => {
                      if (event.currentTarget.dataset.pointerActivated === "true") {
                        delete event.currentTarget.dataset.pointerActivated;
                        event.preventDefault();
                        return;
                      }
                      void activateContainer(container);
                    }}
                  >
                    {container.running ? <LogIn size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
                  </button>
                </div>
              </section>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function SshTunnelListPanel({
  sessionName,
  target,
  tunnels,
  editable,
  needsReconnect,
  onEdit,
  onDeleteTunnel,
  onEditTunnel,
  onReconnect,
}: {
  sessionName: string | null;
  target: string | null;
  tunnels: SshTunnel[];
  editable: boolean;
  needsReconnect: boolean;
  onEdit: () => void;
  onDeleteTunnel: (index: number) => void;
  onEditTunnel: (index: number) => void;
  onReconnect: () => void;
}) {
  const [contextMenu, setContextMenu] = useState<
    | { kind: "target"; x: number; y: number }
    | { kind: "tunnel"; index: number; x: number; y: number }
    | null
  >(null);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextMenu]);

  return (
    <div className={editable ? "zt-tunnel-panel zt-transient-tunnel-panel" : "zt-tunnel-panel"}>
      <div
        className="zt-tunnel-target zt-target-summary"
        onContextMenu={(event) => {
          event.preventDefault();
          setContextMenu({ kind: "target", x: event.clientX, y: event.clientY });
        }}
      >
        <strong>{sessionName ?? "当前 SSH 连接"}</strong>
        {target ? <span>{target}</span> : null}
      </div>
      {editable ? (
        <div className="zt-tunnel-target zt-transient-tunnel-actions">
          <div className="zt-tunnel-target-content">
            <strong>临时隧道</strong>
            <span>{needsReconnect ? "配置已更新，重连后生效" : "仅当前临时 SSH 连接有效"}</span>
          </div>
          <button type="button" className="zt-secondary-button" aria-label="添加临时 SSH 隧道" onClick={onEdit}>
            {tunnels.length === 0 ? "添加隧道" : "编辑隧道"}
          </button>
          {needsReconnect ? (
            <button type="button" className="zt-secondary-button" aria-label="重连临时 SSH" onClick={onReconnect}>
              重连
            </button>
          ) : null}
        </div>
      ) : null}
      {tunnels.length === 0 ? <div className="zt-empty-line">当前 SSH 连接没有配置隧道</div> : null}
      <div className="zt-tunnel-list" role="list" aria-label="SSH 隧道列表">
        {tunnels.map((tunnel, index) => {
          const mode = sshTunnelMode(tunnel);
          const modeInfo = tunnelModes.find((item) => item.value === mode);
          const title = tunnel.name?.trim() || `${modeInfo?.title ?? "SSH 隧道"} ${index + 1}`;
          return (
            <section
              className="zt-tunnel-list-item"
              role="listitem"
              aria-label={title}
              key={`${title}-${index}`}
              onContextMenu={(event) => {
                event.preventDefault();
                event.stopPropagation();
                setContextMenu({ kind: "tunnel", index, x: event.clientX, y: event.clientY });
              }}
            >
              <header>
                <strong>{title}</strong>
                <code>{modeInfo?.command ?? tunnel.kind}</code>
              </header>
              <div className="zt-tunnel-meta">
                <span>{modeInfo?.title ?? "SSH 隧道"}</span>
                <span>{tunnel.auto_open === false ? "手动打开" : "连接时自动打开"}</span>
              </div>
              <dl>
                {tunnel.bind_address ? (
                  <>
                    <dt>监听</dt>
                    <dd>{formatBindEndpoint(tunnel.bind_address, tunnel.local_port)}</dd>
                  </>
                ) : tunnel.local_port ? (
                  <>
                    <dt>监听端口</dt>
                    <dd>{tunnel.local_port}</dd>
                  </>
                ) : null}
                {tunnel.remote_host || tunnel.remote_port ? (
                  <>
                    <dt>目标</dt>
                    <dd>{formatRemoteEndpoint(tunnel.remote_host, tunnel.remote_port)}</dd>
                  </>
                ) : null}
              </dl>
            </section>
          );
        })}
      </div>
      {contextMenu ? (
        <ZtContextMenu className="zt-context-menu" role="menu" x={contextMenu.x} y={contextMenu.y}>
          {contextMenu.kind === "target" ? (
            <button type="button" role="menuitem" aria-label="重连" onClick={onReconnect}>
              重连
            </button>
          ) : (
            <>
              <button type="button" role="menuitem" aria-label="编辑" onClick={() => onEditTunnel(contextMenu.index)}>
                编辑
              </button>
              <button
                type="button"
                className="zt-delete-button"
                role="menuitem"
                aria-label="删除"
                onClick={() => onDeleteTunnel(contextMenu.index)}
              >
                删除
              </button>
            </>
          )}
        </ZtContextMenu>
      ) : null}
    </div>
  );
}

function formatBindEndpoint(bindAddress: string, port?: number | null) {
  return port ? `${bindAddress}:${port}` : bindAddress;
}

function formatRemoteEndpoint(host?: string | null, port?: number | null) {
  if (host && port) return `${host}:${port}`;
  return host || (port ? String(port) : "-");
}

const containerRuntimeOptions = [
  { value: "docker", label: "Docker" },
  { value: "podman", label: "Podman" },
  { value: "containerd", label: "containerd" },
];
