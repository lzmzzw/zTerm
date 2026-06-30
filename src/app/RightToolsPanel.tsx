// Author: Liz
import { Activity, Clock3, Folder, MessageSquareMore, Send, type LucideIcon } from "lucide-react";

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
import type { AppLanguage } from "../features/settings/settingsStore";
import { t } from "../features/settings/i18n";
import { PanelHeader, ToolButton } from "./ShellControls";
import { rightToolLabelKey, rightToolRailOrder, type RightTool } from "./rightTools";

const rightToolRailIcons: Record<RightTool, LucideIcon> = {
  agent: MessageSquareMore,
  files: Folder,
  history: Clock3,
  monitor: Activity,
  transfer: Send,
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
    onQueryChange: (query: string) => void;
    onSaveCommandGroup: (draft: SessionCommandGroupDraft) => Promise<unknown> | unknown;
    onSearch: (options?: { deduplicate?: boolean }) => void;
    onSend: (command: string) => void;
    onViewChange: (view: CommandHistoryView) => void;
  };
  monitor: {
    target: ServerMonitorTarget | null;
  };
  transfers: {
    tasks: TransferTask[];
    onRetry: (taskId: string) => Promise<void> | void;
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
  transfers,
  language = "zhCN",
  onActiveToolChange,
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
            </>
          ) : null}

          {activeTool === "history" ? (
            <>
              <PanelHeader title={t(language, "history")} />
              <CommandHistoryPanel
                activeView={history.activeView}
                commandGroups={history.commandGroups}
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

          {activeTool === "transfer" ? (
            <>
              <PanelHeader title={t(language, "transferTasks")} />
              <TransferPanel tasks={transfers.tasks} onRetry={transfers.onRetry} />
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
        </section>
      ) : null}

      <nav className="zt-tool-rail" aria-label="工具切换">
        {rightToolRailOrder.map((tool) => {
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
