// Author: Liz
import { Activity, Box, Cable, Clock3, Folder, LogIn, MessageSquareMore, RefreshCw, type LucideIcon } from "lucide-react";

import { AiPanel } from "../features/ai/AiPanel";
import type {
  AiApprovalMode,
  AiConversationMessage,
  AiConversationSummary,
  AiTerminalContextSnapshot,
  AiToolPendingInvocation,
} from "../features/ai/aiStore";
import { FileExplorerPanel } from "../features/files/FileExplorerPanel";
import { TransferPanel } from "../features/files/TransferPanel";
import type { FileEntry, TransferTask } from "../features/files/fileStore";
import type { FileSelectionEvent } from "../features/files/fileSelectionModel";
import { CommandHistoryPanel } from "../features/history/CommandHistoryPanel";
import type {
  CommandHistoryEntry,
  HistoryScopeKind,
  SessionCommandGroup,
  SessionCommandGroupDraft,
} from "../features/history/historyStore";
import type { CommandHistoryView } from "../features/history/CommandHistoryPanel";
import { ServerMonitorPanel, type ServerMonitorTarget } from "../features/monitor/ServerMonitorPanel";
import { useServerInfoSnapshot } from "../features/monitor/useServerInfoSnapshot";
import { sshTunnelMode } from "../features/sessions/sshSessionModel";
import { tunnelModes } from "../features/sessions/SshTunnelCard";
import type { SshTunnel } from "../features/sessions/types";
import type { AppLanguage } from "../features/settings/settingsStore";
import type { SshContainerInfo } from "../features/terminal/sshContainerApi";
import { t } from "../features/settings/i18n";
import { PanelHeader, ToolButton } from "./ShellControls";
import { rightToolLabelKey, rightToolRailOrder, type RightTool } from "./rightTools";

const rightToolRailIcons: Record<RightTool, LucideIcon> = {
  agent: MessageSquareMore,
  containers: Box,
  files: Folder,
  history: Clock3,
  monitor: Activity,
  tunnels: Cable,
};

interface RightToolsPanelProps {
  activeTool: RightTool | null;
  agent: {
    activeRuntimeSessionId: string | null;
    activePaneId: string | null;
    activePaneTitle: string | null;
    activeSavedSessionId: string | null;
    approvalMode: AiApprovalMode;
    error: string | null;
    loading: boolean;
    providersAvailable: boolean;
    recentTerminalOutput: string;
    conversations: AiConversationSummary[];
    activeConversationId: string | null;
    messages: AiConversationMessage[];
    contextSnapshot: AiTerminalContextSnapshot | null;
    pendingInvocations: AiToolPendingInvocation[];
    language?: AppLanguage;
    onApprovalModeChange: (mode: AiApprovalMode) => Promise<unknown> | unknown;
    onConfirmTool: (invocationId: string, approved: boolean) => Promise<unknown> | unknown;
    onDeleteConversation: (conversationId: string) => Promise<unknown> | unknown;
    onNewConversation: () => Promise<unknown> | unknown;
    onSelectConversation: (conversationId: string) => Promise<unknown> | unknown;
    onSendChat: (message: string) => Promise<unknown> | unknown;
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
    sessionName: string | null;
    target: string | null;
    items: SshContainerInfo[];
    loading: boolean;
    error: string | null;
    onEnter: (container: SshContainerInfo) => Promise<void> | void;
    onRefresh: () => Promise<void> | void;
  };
  tunnels: {
    sessionName: string | null;
    target: string | null;
    items: SshTunnel[];
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
  onActiveToolChange: (tool: RightTool) => void;
}

export function RightToolsPanel({
  activeTool,
  agent,
  files,
  history,
  monitor,
  containers,
  tunnels,
  transfers,
  language = "zhCN",
  onActiveToolChange,
}: RightToolsPanelProps) {
  const monitorSnapshot = useServerInfoSnapshot(monitor.target?.id ?? null, activeTool === "monitor");
  const visibleTools = rightToolRailOrder.filter(
    (tool) =>
      (tool !== "tunnels" || tunnels.items.length > 0) &&
      (tool !== "containers" || containers.enabled),
  );

  return (
    <aside
      className={
        activeTool
          ? "zt-sidebar zt-sidebar-right zt-right-tools"
          : "zt-sidebar zt-sidebar-right zt-right-tools zt-right-tools-collapsed"
      }
      aria-label="右侧工具栏"
    >
      {activeTool ? (
        <section className="zt-tool-panel" aria-label={t(language, rightToolLabelKey(activeTool))}>
          {activeTool === "agent" ? (
            <>
              <PanelHeader title={t(language, "agent")} />
              <AiPanel
                activeRuntimeSessionId={agent.activeRuntimeSessionId}
                activePaneId={agent.activePaneId}
                activePaneTitle={agent.activePaneTitle}
                activeSavedSessionId={agent.activeSavedSessionId}
                providersAvailable={agent.providersAvailable}
                recentOutput={agent.recentTerminalOutput}
                conversations={agent.conversations}
                activeConversationId={agent.activeConversationId}
                approvalMode={agent.approvalMode}
                messages={agent.messages}
                contextSnapshot={agent.contextSnapshot}
                pendingInvocations={agent.pendingInvocations}
                language={agent.language}
                loading={agent.loading}
                error={agent.error}
                onApprovalModeChange={agent.onApprovalModeChange}
                onSendChat={agent.onSendChat}
                onSelectConversation={agent.onSelectConversation}
                onNewConversation={agent.onNewConversation}
                onDeleteConversation={agent.onDeleteConversation}
                onConfirmTool={agent.onConfirmTool}
              />
            </>
          ) : null}

          {activeTool === "files" ? (
            <>
              <PanelHeader title="SFTP" />
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
              <PanelHeader title={t(language, "history")} />
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
                onSaveCommandGroup={history.onSaveCommandGroup}
                onDeleteCommandGroup={history.onDeleteCommandGroup}
              />
            </>
          ) : null}

          {activeTool === "monitor" ? (
            <>
              <PanelHeader title={t(language, "resourceMonitor")} />
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
              <PanelHeader title={t(language, "sshContainers")} />
              <SshContainerListPanel
                sessionName={containers.sessionName}
                target={containers.target}
                containers={containers.items}
                loading={containers.loading}
                error={containers.error}
                onEnter={containers.onEnter}
                onRefresh={containers.onRefresh}
              />
            </>
          ) : null}

          {activeTool === "tunnels" ? (
            <>
              <PanelHeader title={t(language, "sshTunnels")} />
              <SshTunnelListPanel sessionName={tunnels.sessionName} target={tunnels.target} tunnels={tunnels.items} />
            </>
          ) : null}
        </section>
      ) : null}

      <nav className="zt-tool-rail" aria-label="工具切换">
        {visibleTools.map((tool) => {
          const Icon = rightToolRailIcons[tool];
          return (
            <ToolButton
              key={tool}
              label={t(language, rightToolLabelKey(tool))}
              active={activeTool === tool}
              className={tool === "agent" ? "zt-tool-rail-agent" : undefined}
              icon={<Icon size={16} aria-hidden="true" />}
              onClick={() => onActiveToolChange(tool)}
            />
          );
        })}
      </nav>
    </aside>
  );
}

function SshContainerListPanel({
  sessionName,
  target,
  containers,
  loading,
  error,
  onEnter,
  onRefresh,
}: {
  sessionName: string | null;
  target: string | null;
  containers: SshContainerInfo[];
  loading: boolean;
  error: string | null;
  onEnter: (container: SshContainerInfo) => Promise<void> | void;
  onRefresh: () => Promise<void> | void;
}) {
  return (
    <div className="zt-tunnel-panel">
      <div className="zt-tunnel-target">
        <div className="zt-tunnel-target-content">
          <strong>{sessionName ?? "当前 SSH 连接"}</strong>
          {target ? <span>{target}</span> : null}
        </div>
        <button
          type="button"
          className="zt-icon-button zt-container-refresh-button"
          aria-label="刷新容器"
          title="刷新"
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
      {loading ? <div className="zt-empty-line">正在加载容器...</div> : null}
      {error ? <div className="zt-error-line">{error}</div> : null}
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
                  <code>{container.running ? "running" : "stopped"}</code>
                  <button
                    type="button"
                    className="zt-icon-button zt-container-enter-button"
                    aria-label={`进入容器 ${title}`}
                    title="进入容器"
                    disabled={!container.running}
                    onPointerDown={(event) => {
                      if (event.button !== 0 || !container.running) return;
                      event.preventDefault();
                      const button = event.currentTarget;
                      button.dataset.pointerActivated = "true";
                      window.setTimeout(() => {
                        delete button.dataset.pointerActivated;
                      }, 350);
                      void onEnter(container);
                    }}
                    onClick={(event) => {
                      if (event.currentTarget.dataset.pointerActivated === "true") {
                        delete event.currentTarget.dataset.pointerActivated;
                        event.preventDefault();
                        return;
                      }
                      void onEnter(container);
                    }}
                  >
                    <LogIn size={15} aria-hidden="true" />
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
}: {
  sessionName: string | null;
  target: string | null;
  tunnels: SshTunnel[];
}) {
  if (tunnels.length === 0) {
    return <div className="zt-empty-line">当前 SSH 连接没有配置隧道</div>;
  }

  return (
    <div className="zt-tunnel-panel">
      <div className="zt-tunnel-target">
        <strong>{sessionName ?? "当前 SSH 连接"}</strong>
        {target ? <span>{target}</span> : null}
      </div>
      <div className="zt-tunnel-list" role="list" aria-label="SSH 隧道列表">
        {tunnels.map((tunnel, index) => {
          const mode = sshTunnelMode(tunnel);
          const modeInfo = tunnelModes.find((item) => item.value === mode);
          const title = tunnel.name?.trim() || `${modeInfo?.title ?? "SSH 隧道"} ${index + 1}`;
          return (
            <section className="zt-tunnel-list-item" role="listitem" aria-label={title} key={`${title}-${index}`}>
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
