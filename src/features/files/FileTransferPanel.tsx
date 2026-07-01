// Author: Liz
import { ArrowLeft, ArrowRight, Eye, EyeOff, FolderUp, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { formatBytes } from "../../lib/byteFormatters";
import type { AppLanguage } from "../settings/settingsStore";
import { useSessionStore } from "../sessions/sessionStore";
import type { SavedSession } from "../sessions/types";
import { TransferPanel } from "./TransferPanel";
import type { FileEntry, TransferConflictPolicy, TransferEndpoint } from "./fileStore";
import {
  endpointDisplayPath,
  endpointTargetPath,
  parentEndpointPath,
  transferKindFromFileKind,
} from "./fileTransferPaths";
import { useFileTransferStore, type FileTransferSide } from "./fileTransferStore";
import { formatFileModifiedTime, resolveFileIcon } from "./fileExplorerPresentation";

interface FileTransferPanelProps {
  language?: AppLanguage;
}

type DragState = {
  sourceSide: FileTransferSide;
  paths: string[];
};

export function FileTransferPanel({ language: _language = "zhCN" }: FileTransferPanelProps) {
  const { sessions, loadSessions } = useSessionStore(
    useShallow((state) => ({
      sessions: state.sessions,
      loadSessions: state.loadSessions,
    })),
  );
  const sshSessions = useMemo(() => sessions.filter((session) => session.type === "ssh"), [sessions]);
  const {
    left,
    right,
    transfers,
    transferLoading,
    transferError,
    conflictPolicy,
    defaultLocalPath,
    loadDefaultLocalPath,
    setConflictPolicy,
    setEndpoint,
    setPath,
    selectPath,
    loadEndpoint,
    checkConflicts,
    enqueueTransfer,
    loadTransfers,
    bindTransferEvents,
    retryTransfer,
    pauseTransfer,
    resumeTransfer,
    cancelTransfer,
    deleteTransfer,
    pauseTransfers,
    resumeTransfers,
    clearTransfers,
  } = useFileTransferStore(
    useShallow((state) => ({
      left: state.left,
      right: state.right,
      transfers: state.transfers,
      transferLoading: state.transferLoading,
      transferError: state.transferError,
      conflictPolicy: state.conflictPolicy,
      defaultLocalPath: state.defaultLocalPath,
      loadDefaultLocalPath: state.loadDefaultLocalPath,
      setConflictPolicy: state.setConflictPolicy,
      setEndpoint: state.setEndpoint,
      setPath: state.setPath,
      selectPath: state.selectPath,
      loadEndpoint: state.loadEndpoint,
      checkConflicts: state.checkConflicts,
      enqueueTransfer: state.enqueueTransfer,
      loadTransfers: state.loadTransfers,
      bindTransferEvents: state.bindTransferEvents,
      retryTransfer: state.retryTransfer,
      pauseTransfer: state.pauseTransfer,
      resumeTransfer: state.resumeTransfer,
      cancelTransfer: state.cancelTransfer,
      deleteTransfer: state.deleteTransfer,
      pauseTransfers: state.pauseTransfers,
      resumeTransfers: state.resumeTransfers,
      clearTransfers: state.clearTransfers,
    })),
  );
  const [showHidden, setShowHidden] = useState<Record<FileTransferSide, boolean>>({ left: false, right: false });
  const [dragState, setDragState] = useState<DragState | null>(null);
  const dragStateRef = useRef<DragState | null>(null);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | null = null;
    void bindTransferEvents().then((unlisten) => {
      if (mounted) {
        cleanup = unlisten;
      } else {
        unlisten();
      }
    });
    void loadTransfers();
    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [bindTransferEvents, loadTransfers]);

  useEffect(() => {
    if (!defaultLocalPath) {
      void loadDefaultLocalPath().then(() => loadEndpoint("left"));
    } else if (!left.endpoint.path) {
      void loadEndpoint("left");
    }
  }, [defaultLocalPath, left.endpoint.path, loadDefaultLocalPath, loadEndpoint]);

  useEffect(() => {
    if (right.endpoint.kind !== "ssh" || right.endpoint.saved_session_id || sshSessions.length === 0) return;
    setEndpoint("right", { kind: "ssh", saved_session_id: sshSessions[0].id, path: "/" });
    void Promise.resolve().then(() => loadEndpoint("right"));
  }, [loadEndpoint, right.endpoint.kind, right.endpoint.saved_session_id, setEndpoint, sshSessions]);

  async function transferSelected(sourceSide: FileTransferSide) {
    const sourcePane = sourceSide === "left" ? left : right;
    await transferPaths(sourceSide, sourcePane.selectedPaths);
  }

  async function transferPaths(sourceSide: FileTransferSide, paths: string[]) {
    const destinationSide = sourceSide === "left" ? "right" : "left";
    const sourcePane = sourceSide === "left" ? left : right;
    const destinationPane = destinationSide === "left" ? left : right;
    const entries = sourcePane.entries.filter((entry) => paths.includes(entry.path));
    const plans = entries.flatMap((entry) => {
      const kind = transferKindFromFileKind(entry.kind);
      if (!kind) return [];
      const source: TransferEndpoint = { ...sourcePane.endpoint, path: entry.path };
      const destination: TransferEndpoint = {
        ...destinationPane.endpoint,
        path: endpointTargetPath(destinationPane.endpoint, entry.path),
      };
      return [{ source, destination, kind }];
    });
    if (plans.length === 0) return;
    const conflicts = await checkConflicts(plans.map((plan) => ({ destination: plan.destination, kind: plan.kind })));
    if (
      conflicts.length > 0 &&
      conflictPolicy === "overwrite" &&
      !window.confirm(`检测到 ${conflicts.length} 个目标已存在，确认覆盖？`)
    ) {
      return;
    }
    for (const plan of plans) {
      await enqueueTransfer(plan.source, plan.destination, { kind: plan.kind, conflictPolicy });
    }
    await loadTransfers();
  }

  function beginDrag(sourceSide: FileTransferSide, path: string) {
    const sourcePane = sourceSide === "left" ? left : right;
    const paths = sourcePane.selectedPaths.includes(path) ? sourcePane.selectedPaths : [path];
    const nextDragState = { sourceSide, paths };
    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
  }

  function canDropOn(targetSide: FileTransferSide) {
    const currentDrag = dragStateRef.current;
    if (!currentDrag || currentDrag.sourceSide === targetSide) return false;
    const sourcePane = currentDrag.sourceSide === "left" ? left : right;
    const destinationPane = targetSide === "left" ? left : right;
    return canTransfer({ endpoint: sourcePane.endpoint, selectedPaths: currentDrag.paths }, destinationPane);
  }

  function clearDrag() {
    dragStateRef.current = null;
    setDragState(null);
  }

  async function dropOn(targetSide: FileTransferSide) {
    const currentDrag = dragStateRef.current;
    if (!currentDrag || !canDropOn(targetSide)) {
      clearDrag();
      return;
    }
    clearDrag();
    await transferPaths(currentDrag.sourceSide, currentDrag.paths);
  }

  return (
    <div className="zt-file-transfer-panel" aria-label="文件传输面板">
      <div className="zt-file-transfer-controls">
        <label>
          <span>冲突策略</span>
          <select
            aria-label="文件传输冲突策略"
            value={conflictPolicy}
            onChange={(event) => setConflictPolicy(event.currentTarget.value as TransferConflictPolicy)}
          >
            <option value="overwrite">覆盖</option>
            <option value="skip">跳过</option>
            <option value="rename">自动重命名</option>
          </select>
        </label>
        <button type="button" aria-label="刷新文件传输任务" title="刷新任务" onClick={() => void loadTransfers()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </div>
      <div className="zt-file-transfer-panes">
        <EndpointPane
          side="left"
          title="左侧"
          pane={left}
          sshSessions={sshSessions}
          defaultLocalPath={defaultLocalPath}
          showHidden={showHidden.left}
          onShowHiddenChange={(value) => setShowHidden((current) => ({ ...current, left: value }))}
          onEndpointChange={(endpoint) => {
            setEndpoint("left", endpoint);
            void Promise.resolve().then(() => loadEndpoint("left"));
          }}
          onPathChange={(path) => setPath("left", path)}
          onRefresh={() => loadEndpoint("left")}
          onParent={() => {
            setPath("left", parentEndpointPath(left.endpoint));
            void Promise.resolve().then(() => loadEndpoint("left"));
          }}
          onSelect={(path, event) => selectPath("left", path, event)}
          onOpenDirectory={(path) => {
            setPath("left", path);
            void Promise.resolve().then(() => loadEndpoint("left"));
          }}
          onDragStart={(path) => beginDrag("left", path)}
          onDragEnd={clearDrag}
          onDrop={() => dropOn("left")}
          canAcceptDrop={() => canDropOn("left")}
          dropActive={Boolean(dragState) && canDropOn("left")}
        />
        <div className="zt-file-transfer-arrows" aria-label="文件传输方向">
          <button
            type="button"
            aria-label="传输到右侧"
            title="传输到右侧"
            disabled={!canTransfer(left, right)}
            onClick={() => void transferSelected("left")}
          >
            <ArrowRight size={16} aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label="传输到左侧"
            title="传输到左侧"
            disabled={!canTransfer(right, left)}
            onClick={() => void transferSelected("right")}
          >
            <ArrowLeft size={16} aria-hidden="true" />
          </button>
        </div>
        <EndpointPane
          side="right"
          title="右侧"
          pane={right}
          sshSessions={sshSessions}
          defaultLocalPath={defaultLocalPath}
          showHidden={showHidden.right}
          onShowHiddenChange={(value) => setShowHidden((current) => ({ ...current, right: value }))}
          onEndpointChange={(endpoint) => {
            setEndpoint("right", endpoint);
            void Promise.resolve().then(() => loadEndpoint("right"));
          }}
          onPathChange={(path) => setPath("right", path)}
          onRefresh={() => loadEndpoint("right")}
          onParent={() => {
            setPath("right", parentEndpointPath(right.endpoint));
            void Promise.resolve().then(() => loadEndpoint("right"));
          }}
          onSelect={(path, event) => selectPath("right", path, event)}
          onOpenDirectory={(path) => {
            setPath("right", path);
            void Promise.resolve().then(() => loadEndpoint("right"));
          }}
          onDragStart={(path) => beginDrag("right", path)}
          onDragEnd={clearDrag}
          onDrop={() => dropOn("right")}
          canAcceptDrop={() => canDropOn("right")}
          dropActive={Boolean(dragState) && canDropOn("right")}
        />
      </div>
      {transferError ? <div className="zt-terminal-error">{transferError}</div> : null}
      {transferLoading ? <div className="zt-empty-line">传输任务加载中</div> : null}
      <TransferPanel
        collapsible
        tasks={transfers}
        onCancel={cancelTransfer}
        onDelete={deleteTransfer}
        onPause={pauseTransfer}
        onRetry={retryTransfer}
        onResume={resumeTransfer}
        onPauseAll={pauseTransfers}
        onResumeAll={resumeTransfers}
        onClearAll={clearTransfers}
      />
    </div>
  );
}

function EndpointPane({
  side,
  title,
  pane,
  sshSessions,
  defaultLocalPath,
  showHidden,
  onShowHiddenChange,
  onEndpointChange,
  onPathChange,
  onRefresh,
  onParent,
  onSelect,
  onOpenDirectory,
  onDragStart,
  onDragEnd,
  onDrop,
  canAcceptDrop,
  dropActive,
}: {
  side: FileTransferSide;
  title: string;
  pane: {
    endpoint: TransferEndpoint;
    entries: FileEntry[];
    selectedPaths: string[];
    loading: boolean;
    error: string | null;
  };
  sshSessions: SavedSession[];
  defaultLocalPath: string;
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  onEndpointChange: (endpoint: TransferEndpoint) => void;
  onPathChange: (path: string) => void;
  onRefresh: () => Promise<void> | void;
  onParent: () => Promise<void> | void;
  onSelect: (path: string | null, event?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onOpenDirectory: (path: string) => Promise<void> | void;
  onDragStart: (path: string) => void;
  onDragEnd: () => void;
  onDrop: () => Promise<void> | void;
  canAcceptDrop: () => boolean;
  dropActive: boolean;
}) {
  const endpointValue = pane.endpoint.kind === "local" ? "local" : `ssh:${pane.endpoint.saved_session_id ?? ""}`;
  const visibleEntries = showHidden ? pane.entries : pane.entries.filter((entry) => !entry.name.startsWith("."));
  const endpointReady = pane.endpoint.kind === "local" || Boolean(pane.endpoint.saved_session_id);
  return (
    <section
      className={dropActive ? "zt-file-transfer-pane zt-file-transfer-pane-drop" : "zt-file-transfer-pane"}
      aria-label={`${title}文件端点`}
      data-side={side}
      onDragOver={(event) => {
        if (!canAcceptDrop()) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        if (!canAcceptDrop()) return;
        event.preventDefault();
        void onDrop();
      }}
    >
      <div className="zt-file-transfer-pane-header">
        <strong>{title}</strong>
        <select
          aria-label={`${title}端点`}
          value={endpointValue}
          onChange={(event) => {
            const value = event.currentTarget.value;
            if (value === "local") {
              onEndpointChange({ kind: "local", saved_session_id: null, path: defaultLocalPath });
              return;
            }
            const savedSessionId = value.replace(/^ssh:/, "");
            onEndpointChange({ kind: "ssh", saved_session_id: savedSessionId || null, path: "/" });
          }}
        >
          <option value="local">本机</option>
          {sshSessions.map((session) => (
            <option key={session.id} value={`ssh:${session.id}`}>
              {session.name}
            </option>
          ))}
        </select>
      </div>
      <div className="zt-file-transfer-path">
        <input
          aria-label={`${title}路径`}
          value={endpointDisplayPath(pane.endpoint, defaultLocalPath)}
          disabled={!endpointReady}
          onChange={(event) => onPathChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void onRefresh();
          }}
        />
        <button type="button" aria-label={`${title}返回上级`} title="返回上级" disabled={!endpointReady} onClick={() => void onParent()}>
          <FolderUp size={14} aria-hidden="true" />
        </button>
        <button type="button" aria-label={`${title}刷新`} title="刷新" disabled={!endpointReady || pane.loading} onClick={() => void onRefresh()}>
          <RefreshCw size={14} aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`${title}${showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}`}
          title={showHidden ? "隐藏隐藏文件" : "显示隐藏文件"}
          onClick={() => onShowHiddenChange(!showHidden)}
        >
          {showHidden ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
        </button>
      </div>
      {!endpointReady ? <div className="zt-empty-line">请选择 SSH 主机或本机端点</div> : null}
      {pane.error ? <div className="zt-terminal-error">{pane.error}</div> : null}
      {pane.loading ? <div className="zt-empty-line">加载中</div> : null}
      {endpointReady && !pane.loading && visibleEntries.length === 0 ? <div className="zt-empty-line">暂无文件</div> : null}
      <div className="zt-file-transfer-list" role="list" aria-label={`${title}文件列表`}>
        {visibleEntries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            role="listitem"
            draggable={transferKindFromFileKind(entry.kind) !== null}
            aria-selected={pane.selectedPaths.includes(entry.path)}
            aria-grabbed={pane.selectedPaths.includes(entry.path) ? "true" : "false"}
            className={pane.selectedPaths.includes(entry.path) ? "active" : ""}
            onDragStart={(event) => {
              if (!transferKindFromFileKind(entry.kind)) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData("text/plain", entry.path);
              onDragStart(entry.path);
            }}
            onDragEnd={onDragEnd}
            onClick={(event) =>
              onSelect(entry.path, { ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey })
            }
            onDoubleClick={() => {
              if (entry.kind === "directory") void onOpenDirectory(entry.path);
            }}
          >
            <span className="zt-file-kind-icon" aria-hidden="true">
              {resolveFileIcon(entry)}
            </span>
            <strong>{entry.name}</strong>
            <small>{entry.kind === "directory" ? "-" : formatBytes(entry.size, { maxUnit: "MB" })}</small>
            <small>{formatFileModifiedTime(entry.modified_at_ms)}</small>
          </button>
        ))}
      </div>
    </section>
  );
}

function canTransfer(
  source: { endpoint: TransferEndpoint; selectedPaths: string[] },
  destination: { endpoint: TransferEndpoint },
) {
  if (source.selectedPaths.length === 0) return false;
  if (source.endpoint.kind === "ssh" && !source.endpoint.saved_session_id) return false;
  if (destination.endpoint.kind === "ssh" && !destination.endpoint.saved_session_id) return false;
  if (source.endpoint.kind === "local" && destination.endpoint.kind === "local") return false;
  return Boolean(destination.endpoint.path.trim());
}
