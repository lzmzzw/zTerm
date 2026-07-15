// Author: Liz
import {
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Eye,
  EyeOff,
  Folder,
  FolderKey,
  FolderSync,
  FolderUp,
  HardDrive,
  RefreshCw,
  Server,
} from "lucide-react";
import { type CSSProperties, type MouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";

import { ZtSelect } from "../../components/ZtSelect";
import { ZtConfirmDialog, ZtContextMenu, ZtInlineError, ZtPromptDialog } from "../../components/ZtUi";
import { formatBytes } from "../../lib/byteFormatters";
import type { AppLanguage } from "../settings/settingsStore";
import { useSessionStore } from "../sessions/sessionStore";
import {
  buildSessionTreeListItems,
  type SessionTreeListItem,
  visibleSessionTreeListItems,
} from "../sessions/sessionTreeModel";
import { TransferPanel } from "./TransferPanel";
import type { FileEntry, TransferEndpoint, TransferKind } from "./fileStore";
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

type PointerDragState = {
  sourceSide: FileTransferSide;
  entry: FileEntry;
  startX: number;
  startY: number;
  active: boolean;
};

type DragPreviewState = {
  entry: FileEntry;
  count: number;
  clientX: number;
  clientY: number;
};

type TransferPlan = {
  source: TransferEndpoint;
  destination: TransferEndpoint;
  kind: TransferKind;
};

type FileContextMenuState = {
  side: FileTransferSide;
  entries: FileEntry[];
  x: number;
  y: number;
};

type FileSortKey = "name" | "size" | "modified";
type FileSortState = { key: FileSortKey; direction: "ascending" | "descending" } | null;
type FileColumnRatios = { name: number; size: number; modified: number };
type FileColumnBoundary = "name-size" | "size-modified";

const DEFAULT_FILE_COLUMN_RATIOS: FileColumnRatios = { name: 70, size: 15, modified: 15 };
const MIN_FILE_COLUMN_RATIOS: FileColumnRatios = { name: 25, size: 10, modified: 10 };

const MIN_FILE_TRANSFER_PANES_HEIGHT = 200;
const MIN_TRANSFER_DOCK_HEIGHT = 120;
const POINTER_DRAG_THRESHOLD = 6;

export function FileTransferPanel({ language: _language = "zhCN" }: FileTransferPanelProps) {
  const { groups, sessions, loadSessions } = useSessionStore(
    useShallow((state) => ({
      groups: state.groups,
      sessions: state.sessions,
      loadSessions: state.loadSessions,
    })),
  );
  const remoteSessionTreeItems = useMemo(
    () =>
      buildSessionTreeListItems({
        groups,
        sessions: sessions.filter((session) => session.type === "ssh" || session.type === "sftp" || session.type === "ftp"),
        hideEmptyGroups: true,
      }),
    [groups, sessions],
  );
  const orderedRemoteSessions = useMemo(
    () => remoteSessionTreeItems.flatMap((item) => (item.kind === "session" ? [item.session] : [])),
    [remoteSessionTreeItems],
  );
  const {
    left,
    right,
    transfers,
    transferLoading,
    transferError,
    conflictPolicy,
    defaultLocalPath,
    loadDefaultLocalPath,
    localRoots,
    loadLocalRoots,
    setEndpoint,
    setPath,
    selectPath,
    selectPaths,
    loadEndpoint,
    renameEndpoint,
    deleteEndpoint,
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
      localRoots: state.localRoots,
      loadLocalRoots: state.loadLocalRoots,
      setEndpoint: state.setEndpoint,
      setPath: state.setPath,
      selectPath: state.selectPath,
      selectPaths: state.selectPaths,
      loadEndpoint: state.loadEndpoint,
      renameEndpoint: state.renameEndpoint,
      deleteEndpoint: state.deleteEndpoint,
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
  const [dragPreview, setDragPreview] = useState<DragPreviewState | null>(null);
  const [pendingOverwrite, setPendingOverwrite] = useState<{ count: number; plans: TransferPlan[] } | null>(null);
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [renameEntry, setRenameEntry] = useState<{ side: FileTransferSide; entry: FileEntry } | null>(null);
  const [deleteEntries, setDeleteEntries] = useState<{ side: FileTransferSide; entries: FileEntry[] } | null>(null);
  const [transferDockCollapsed, setTransferDockCollapsed] = useState(false);
  const [transferDockHeight, setTransferDockHeight] = useState<number | null>(null);
  const [collapsedEndpointGroupKeys, setCollapsedEndpointGroupKeys] = useState<Set<string>>(() => new Set());
  const dragStateRef = useRef<DragState | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);

  useEffect(() => {
    void loadSessions();
  }, [loadSessions]);

  useEffect(() => {
    void loadLocalRoots();
  }, [loadLocalRoots]);

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
    if (right.endpoint.kind !== "saved_session" || right.endpoint.saved_session_id || orderedRemoteSessions.length === 0) return;
    setEndpoint("right", { kind: "saved_session", saved_session_id: orderedRemoteSessions[0].id, path: "/" });
    void Promise.resolve().then(() => loadEndpoint("right"));
  }, [loadEndpoint, orderedRemoteSessions, right.endpoint.kind, right.endpoint.saved_session_id, setEndpoint]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextMenu]);

  function openEntryContextMenu(side: FileTransferSide, entry: FileEntry, event: MouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const pane = side === "left" ? left : right;
    if (pane.loading) return;
    const entries = pane.selectedPaths.includes(entry.path)
      ? pane.entries.filter((item) => pane.selectedPaths.includes(item.path))
      : [entry];
    if (!pane.selectedPaths.includes(entry.path)) selectPath(side, entry.path);
    setContextMenu({ side, entries, x: event.clientX, y: event.clientY });
  }

  async function transferSelected(sourceSide: FileTransferSide) {
    const sourcePane = sourceSide === "left" ? left : right;
    await transferPaths(sourceSide, sourcePane.selectedPaths);
  }

  async function enqueuePlans(plans: TransferPlan[]) {
    for (const plan of plans) {
      await enqueueTransfer(plan.source, plan.destination, { kind: plan.kind, conflictPolicy });
    }
    await loadTransfers();
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
    if (conflicts.length > 0 && conflictPolicy === "overwrite") {
      setPendingOverwrite({ count: conflicts.length, plans });
      return;
    }
    await enqueuePlans(plans);
  }

  function beginDrag(sourceSide: FileTransferSide, path: string) {
    const sourcePane = sourceSide === "left" ? left : right;
    const paths = sourcePane.selectedPaths.includes(path) ? sourcePane.selectedPaths : [path];
    const nextDragState = { sourceSide, paths };
    dragStateRef.current = nextDragState;
    setDragState(nextDragState);
    return nextDragState;
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
    setDragPreview(null);
  }

  function preparePointerDrag(sourceSide: FileTransferSide, entry: FileEntry, clientX: number, clientY: number) {
    pointerDragRef.current = { sourceSide, entry, startX: clientX, startY: clientY, active: false };
  }

  function movePointerDrag(clientX: number, clientY: number) {
    const pointerDrag = pointerDragRef.current;
    if (!pointerDrag) return false;
    if (!pointerDrag.active) {
      const distance = Math.hypot(clientX - pointerDrag.startX, clientY - pointerDrag.startY);
      if (distance < POINTER_DRAG_THRESHOLD) return false;
      pointerDrag.active = true;
      const nextDragState = beginDrag(pointerDrag.sourceSide, pointerDrag.entry.path);
      setDragPreview({ entry: pointerDrag.entry, count: nextDragState.paths.length, clientX, clientY });
    } else {
      setDragPreview((current) => (current ? { ...current, clientX, clientY } : current));
    }
    return true;
  }

  function cancelPointerDrag() {
    pointerDragRef.current = null;
    clearDrag();
  }

  function finishPointerDrag(clientX: number, clientY: number) {
    const pointerDrag = pointerDragRef.current;
    pointerDragRef.current = null;
    if (!pointerDrag?.active) {
      clearDrag();
      return;
    }
    const targetSide = fileTransferSideAtPoint(clientX, clientY);
    if (!targetSide || targetSide === pointerDrag.sourceSide) {
      clearDrag();
      return;
    }
    void dropOn(targetSide);
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

  function resizeTransferDock(requestedHeight: number) {
    const maxHeight = Math.max(MIN_TRANSFER_DOCK_HEIGHT, window.innerHeight - MIN_FILE_TRANSFER_PANES_HEIGHT);
    setTransferDockHeight(Math.min(maxHeight, Math.max(MIN_TRANSFER_DOCK_HEIGHT, Math.round(requestedHeight))));
  }

  function toggleEndpointGroup(key: string) {
    setCollapsedEndpointGroupKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  const panelClassName = transferDockCollapsed
    ? "zt-file-transfer-panel zt-file-transfer-panel-transfer-collapsed"
    : "zt-file-transfer-panel";
  const panelStyle = transferDockCollapsed || transferDockHeight === null
    ? undefined
    : ({ "--zt-transfer-dock-height": `${transferDockHeight}px` } as CSSProperties);

  return (
    <div className={panelClassName} style={panelStyle} aria-label="文件传输面板">
      <div className="zt-file-transfer-panes">
        <EndpointPane
          side="left"
          title="左侧"
          pane={left}
          sessionTreeItems={remoteSessionTreeItems}
          collapsedGroupKeys={collapsedEndpointGroupKeys}
          onToggleGroup={toggleEndpointGroup}
          defaultLocalPath={defaultLocalPath}
          localRoots={localRoots}
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
          onSelectAll={(paths) => selectPaths("left", paths)}
          onOpenDirectory={(path) => {
            setPath("left", path);
            void Promise.resolve().then(() => loadEndpoint("left"));
          }}
          onPointerDragStart={(entry, clientX, clientY) => preparePointerDrag("left", entry, clientX, clientY)}
          onPointerDragMove={movePointerDrag}
          onPointerDragEnd={finishPointerDrag}
          onPointerDragCancel={cancelPointerDrag}
          onContextMenu={openEntryContextMenu}
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
          sessionTreeItems={remoteSessionTreeItems}
          collapsedGroupKeys={collapsedEndpointGroupKeys}
          onToggleGroup={toggleEndpointGroup}
          defaultLocalPath={defaultLocalPath}
          localRoots={localRoots}
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
          onSelectAll={(paths) => selectPaths("right", paths)}
          onOpenDirectory={(path) => {
            setPath("right", path);
            void Promise.resolve().then(() => loadEndpoint("right"));
          }}
          onPointerDragStart={(entry, clientX, clientY) => preparePointerDrag("right", entry, clientX, clientY)}
          onPointerDragMove={movePointerDrag}
          onPointerDragEnd={finishPointerDrag}
          onPointerDragCancel={cancelPointerDrag}
          onContextMenu={openEntryContextMenu}
          dropActive={Boolean(dragState) && canDropOn("right")}
        />
      </div>
      <div className="zt-file-transfer-operation-status">
        {transferError ? (
          <ZtInlineError className="zt-file-transfer-error">{transferError}</ZtInlineError>
        ) : null}
        {transferLoading ? <div className="zt-empty-line">传输任务加载中</div> : null}
      </div>
      <TransferPanel
        collapsible
        defaultCollapsed
        tasks={transfers}
        onCancel={cancelTransfer}
        onDelete={deleteTransfer}
        onPause={pauseTransfer}
        onRetry={retryTransfer}
        onResume={resumeTransfer}
        onPauseAll={pauseTransfers}
        onResumeAll={resumeTransfers}
        onClearAll={clearTransfers}
        onCollapsedChange={setTransferDockCollapsed}
        onResize={resizeTransferDock}
      />
      {dragPreview
        ? createPortal(
            <div
              className="zt-file-transfer-drag-preview"
              style={{ left: dragPreview.clientX + 14, top: dragPreview.clientY + 14 }}
              aria-hidden="true"
            >
              <span className="zt-file-transfer-drag-preview-icon">{resolveFileIcon(dragPreview.entry)}</span>
              <strong>{dragPreview.entry.name}</strong>
              {dragPreview.count > 1 ? <span className="zt-file-transfer-drag-preview-count">{dragPreview.count}</span> : null}
            </div>,
            document.body,
          )
        : null}
      {pendingOverwrite ? (
        <ZtConfirmDialog
          title="覆盖传输目标"
          message={`检测到 ${pendingOverwrite.count} 个目标已存在，确认覆盖？`}
          confirmLabel="确认覆盖"
          danger
          onCancel={() => setPendingOverwrite(null)}
          onConfirm={() => {
            const plans = pendingOverwrite.plans;
            setPendingOverwrite(null);
            void enqueuePlans(plans);
          }}
        />
      ) : null}
      {contextMenu
        ? createPortal(
            <ZtContextMenu className="zt-context-menu" role="menu" x={contextMenu.x} y={contextMenu.y}>
              <button
                type="button"
                role="menuitem"
                disabled={contextMenu.entries.length !== 1}
                onClick={() => setRenameEntry({ side: contextMenu.side, entry: contextMenu.entries[0] })}
              >
                重命名
              </button>
              <button
                type="button"
                role="menuitem"
                className="zt-delete-button"
                onClick={() => setDeleteEntries({ side: contextMenu.side, entries: contextMenu.entries })}
              >
                删除
              </button>
            </ZtContextMenu>,
            document.body,
          )
        : null}
      {renameEntry ? (
        <ZtPromptDialog
          title="重命名"
          label="重命名为"
          initialValue={renameEntry.entry.name}
          requiredMessage="请填写新名称"
          confirmLabel="确认重命名"
          onCancel={() => setRenameEntry(null)}
          onSubmit={(name) => {
            const pending = renameEntry;
            setRenameEntry(null);
            const to = renamedSiblingPath(pending.entry.path, name);
            if (to !== pending.entry.path) void renameEndpoint(pending.side, pending.entry.path, to);
          }}
        />
      ) : null}
      {deleteEntries ? (
        <ZtConfirmDialog
          title="删除文件"
          message={`确认删除选中的 ${deleteEntries.entries.length} 个项目？`}
          confirmLabel="确认删除"
          danger
          onCancel={() => setDeleteEntries(null)}
          onConfirm={() => {
            const pending = deleteEntries;
            setDeleteEntries(null);
            void deleteEndpoint(
              pending.side,
              pending.entries.map((entry) => entry.path),
              pending.entries.some((entry) => entry.kind === "directory"),
            );
          }}
        />
      ) : null}
    </div>
  );
}

function EndpointPane({
  side,
  title,
  pane,
  sessionTreeItems,
  collapsedGroupKeys,
  onToggleGroup,
  defaultLocalPath,
  localRoots,
  showHidden,
  onShowHiddenChange,
  onEndpointChange,
  onPathChange,
  onRefresh,
  onParent,
  onSelect,
  onSelectAll,
  onOpenDirectory,
  onPointerDragStart,
  onPointerDragMove,
  onPointerDragEnd,
  onPointerDragCancel,
  onContextMenu,
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
  sessionTreeItems: SessionTreeListItem[];
  collapsedGroupKeys: ReadonlySet<string>;
  onToggleGroup: (key: string) => void;
  defaultLocalPath: string;
  localRoots: string[];
  showHidden: boolean;
  onShowHiddenChange: (value: boolean) => void;
  onEndpointChange: (endpoint: TransferEndpoint) => void;
  onPathChange: (path: string) => void;
  onRefresh: () => Promise<void> | void;
  onParent: () => Promise<void> | void;
  onSelect: (path: string | null, event?: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => void;
  onSelectAll: (paths: string[]) => void;
  onOpenDirectory: (path: string) => Promise<void> | void;
  onPointerDragStart: (entry: FileEntry, clientX: number, clientY: number) => void;
  onPointerDragMove: (clientX: number, clientY: number) => boolean;
  onPointerDragEnd: (clientX: number, clientY: number) => void;
  onPointerDragCancel: () => void;
  onContextMenu: (side: FileTransferSide, entry: FileEntry, event: MouseEvent<HTMLButtonElement>) => void;
  dropActive: boolean;
}) {
  const [sort, setSort] = useState<FileSortState>(null);
  const [columnRatios, setColumnRatios] = useState<FileColumnRatios>(DEFAULT_FILE_COLUMN_RATIOS);
  const listHeaderRef = useRef<HTMLDivElement>(null);
  const columnResizeRef = useRef<{
    boundary: FileColumnBoundary;
    startX: number;
    width: number;
    ratios: FileColumnRatios;
  } | null>(null);
  const endpointValue = pane.endpoint.kind === "local" ? "local" : `session:${pane.endpoint.saved_session_id ?? ""}`;
  const selectedSessionItem = sessionTreeItems.find(
    (item) => item.kind === "session" && item.session.id === pane.endpoint.saved_session_id,
  );
  const endpointSelectedLabel =
    pane.endpoint.kind === "local"
      ? "本机"
      : selectedSessionItem?.kind === "session"
        ? selectedSessionItem.session.name
        : undefined;
  const visibleTreeItems = visibleSessionTreeListItems(sessionTreeItems, collapsedGroupKeys);
  const endpointOptions = [
    { value: "local", label: "本机", depth: 0, icon: <HardDrive size={14} aria-hidden="true" /> },
    ...visibleTreeItems.map((item) =>
      item.kind === "group"
        ? (() => {
            const collapsed = collapsedGroupKeys.has(item.key);
            return {
              value: item.key,
              label: item.name,
              kind: "group" as const,
              collapsed,
              depth: item.depth,
              icon: <Folder size={14} aria-hidden="true" />,
              trailing: collapsed ? (
                <ChevronRight size={14} aria-hidden="true" />
              ) : (
                <ChevronDown size={14} aria-hidden="true" />
              ),
              onToggle: () => onToggleGroup(item.key),
            };
          })()
        : {
            value: `session:${item.session.id}`,
            label: item.session.name,
            depth: item.depth,
            icon: item.session.type === "ftp"
              ? <FolderSync size={14} aria-hidden="true" />
              : item.session.type === "sftp"
                ? <FolderKey size={14} aria-hidden="true" />
                : <Server size={14} aria-hidden="true" />,
          },
    ),
  ];
  const visibleEntries = showHidden ? pane.entries : pane.entries.filter((entry) => !entry.name.startsWith("."));
  const sortedEntries = useMemo(() => sortFileEntries(visibleEntries, sort), [sort, visibleEntries]);
  const endpointReady = pane.endpoint.kind === "local" || Boolean(pane.endpoint.saved_session_id);
  const localRoot = rootPathFor(pane.endpoint.path);
  const rootOptions = Array.from(new Set([...localRoots, ...(localRoot ? [localRoot] : [])])).map((root) => ({
    value: root,
    label: root,
  }));

  function toggleSort(key: FileSortKey) {
    setSort((current) => ({
      key,
      direction: current?.key === key && current.direction === "ascending" ? "descending" : "ascending",
    }));
  }

  function beginColumnResize(boundary: FileColumnBoundary, clientX: number) {
    columnResizeRef.current = {
      boundary,
      startX: clientX,
      width: Math.max(1, listHeaderRef.current?.clientWidth ?? 1),
      ratios: columnRatios,
    };
  }

  function resizeColumns(clientX: number) {
    const resize = columnResizeRef.current;
    if (!resize) return;
    const delta = ((clientX - resize.startX) / resize.width) * 100;
    setColumnRatios(resizeFileColumnRatios(resize.ratios, resize.boundary, delta));
  }

  const columnStyle = {
    "--zt-file-name-fr": `${columnRatios.name}fr`,
    "--zt-file-size-fr": `${columnRatios.size}fr`,
    "--zt-file-modified-fr": `${columnRatios.modified}fr`,
  } as CSSProperties;
  return (
    <section
      className={dropActive ? "zt-file-transfer-pane zt-file-transfer-pane-drop" : "zt-file-transfer-pane"}
      aria-label={`${title}文件端点`}
      data-side={side}
      data-file-transfer-side={side}
      data-local={pane.endpoint.kind === "local" ? "true" : "false"}
      style={columnStyle}
    >
      <div className="zt-file-transfer-pane-header">
        <ZtSelect
          ariaLabel={`${title}端点`}
          value={endpointValue}
          options={endpointOptions}
          tree
          selectedLabel={endpointSelectedLabel}
          onChange={(value) => {
            if (value === "local") {
              onEndpointChange({ kind: "local", saved_session_id: null, path: defaultLocalPath });
              return;
            }
            const savedSessionId = value.replace(/^session:/, "");
            onEndpointChange({ kind: "saved_session", saved_session_id: savedSessionId || null, path: "/" });
          }}
        />
      </div>
      <div className="zt-file-transfer-path">
        {pane.endpoint.kind === "local" && rootOptions.length > 0 ? (
          <ZtSelect
            ariaLabel={`${title}本地磁盘`}
            className="zt-file-transfer-root-select"
            value={localRoot}
            options={rootOptions}
            onChange={(path) => {
              onPathChange(path);
              void Promise.resolve().then(() => onRefresh());
            }}
          />
        ) : null}
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
      <div className="zt-file-transfer-pane-status">
        {!endpointReady ? <div className="zt-empty-line">请选择远程连接或本机端点</div> : null}
        {pane.error ? <ZtInlineError className="zt-file-transfer-pane-error">{pane.error}</ZtInlineError> : null}
        {pane.loading ? <div className="zt-empty-line">加载中</div> : null}
        {endpointReady && !pane.loading && visibleEntries.length === 0 ? <div className="zt-empty-line">暂无文件</div> : null}
      </div>
      <div ref={listHeaderRef} className="zt-file-transfer-list-header" role="row" aria-label={`${title}文件列表表头`}>
        <span aria-hidden="true" />
        <FileColumnHeader
          label="文件名"
          sortKey="name"
          sort={sort}
          onSort={toggleSort}
          resizeLabel="调整文件名和文件大小列宽"
          onResizeStart={(clientX) => beginColumnResize("name-size", clientX)}
          onResize={resizeColumns}
          onResizeEnd={() => { columnResizeRef.current = null; }}
        />
        <FileColumnHeader
          label="文件大小"
          sortKey="size"
          sort={sort}
          numeric
          onSort={toggleSort}
          resizeLabel="调整文件大小和最近修改列宽"
          onResizeStart={(clientX) => beginColumnResize("size-modified", clientX)}
          onResize={resizeColumns}
          onResizeEnd={() => { columnResizeRef.current = null; }}
        />
        <FileColumnHeader label="最近修改" sortKey="modified" sort={sort} numeric onSort={toggleSort} />
      </div>
      <div
        className="zt-file-transfer-list"
        role="list"
        aria-label={`${title}文件列表`}
        onKeyDown={(event) => {
          if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== "a") return;
          event.preventDefault();
          onSelectAll(sortedEntries.map((entry) => entry.path));
        }}
      >
        {sortedEntries.map((entry) => (
          <button
            key={entry.path}
            type="button"
            role="listitem"
            data-transfer-draggable={transferKindFromFileKind(entry.kind) !== null ? "true" : "false"}
            aria-selected={pane.selectedPaths.includes(entry.path)}
            className={pane.selectedPaths.includes(entry.path) ? "active" : ""}
            onPointerDown={(event) => {
              if (event.button !== 0 || !transferKindFromFileKind(entry.kind)) return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              onPointerDragStart(entry, event.clientX, event.clientY);
            }}
            onPointerMove={(event) => {
              if (event.buttons !== 1) return;
              if (onPointerDragMove(event.clientX, event.clientY)) event.preventDefault();
            }}
            onPointerUp={(event) => {
              if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
                event.currentTarget.releasePointerCapture(event.pointerId);
              }
              onPointerDragEnd(event.clientX, event.clientY);
            }}
            onPointerCancel={onPointerDragCancel}
            onClick={(event) =>
              onSelect(entry.path, { ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey })
            }
            onDoubleClick={() => {
              if (entry.kind === "directory") void onOpenDirectory(entry.path);
            }}
            onContextMenu={(event) => onContextMenu(side, entry, event)}
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

function FileColumnHeader({
  label,
  sortKey,
  sort,
  numeric = false,
  onSort,
  resizeLabel,
  onResizeStart,
  onResize,
  onResizeEnd,
}: {
  label: string;
  sortKey: FileSortKey;
  sort: FileSortState;
  numeric?: boolean;
  onSort: (key: FileSortKey) => void;
  resizeLabel?: string;
  onResizeStart?: (clientX: number) => void;
  onResize?: (clientX: number) => void;
  onResizeEnd?: () => void;
}) {
  const activeDirection = sort?.key === sortKey ? sort.direction : null;
  const nextDirection = activeDirection === "ascending" ? "降序" : "升序";
  return (
    <div
      className={numeric ? "zt-file-transfer-column-header is-numeric" : "zt-file-transfer-column-header"}
      role="columnheader"
      aria-sort={activeDirection ?? "none"}
    >
      <button
        type="button"
        className="zt-file-transfer-sort-button"
        aria-label={`按${label}${nextDirection}排列`}
        title={`按${label}${nextDirection}排列`}
        onClick={() => onSort(sortKey)}
      >
        <span>{label}</span>
        {activeDirection === "ascending" ? <ChevronUp size={12} aria-hidden="true" /> : null}
        {activeDirection === "descending" ? <ChevronDown size={12} aria-hidden="true" /> : null}
      </button>
      {resizeLabel ? (
        <button
          type="button"
          className="zt-file-transfer-column-resizer"
          aria-label={resizeLabel}
          title={resizeLabel}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture?.(event.pointerId);
            onResizeStart?.(event.clientX);
          }}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            onResize?.(event.clientX);
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId);
            }
            onResizeEnd?.();
          }}
          onPointerCancel={onResizeEnd}
        />
      ) : null}
    </div>
  );
}

function sortFileEntries(entries: FileEntry[], sort: FileSortState) {
  if (!sort) return entries;
  const direction = sort.direction === "ascending" ? 1 : -1;
  return entries
    .map((entry, index) => ({ entry, index }))
    .sort((left, right) => {
      const comparison = compareFileEntries(left.entry, right.entry, sort.key);
      return comparison === 0 ? left.index - right.index : comparison * direction;
    })
    .map(({ entry }) => entry);
}

function compareFileEntries(left: FileEntry, right: FileEntry, key: FileSortKey) {
  if (key === "name") {
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
  }
  if (key === "size") return left.size - right.size;
  if (left.modified_at_ms === null && right.modified_at_ms === null) return 0;
  if (left.modified_at_ms === null) return 1;
  if (right.modified_at_ms === null) return -1;
  return left.modified_at_ms - right.modified_at_ms;
}

function resizeFileColumnRatios(
  ratios: FileColumnRatios,
  boundary: FileColumnBoundary,
  delta: number,
): FileColumnRatios {
  if (boundary === "name-size") {
    const total = ratios.name + ratios.size;
    const name = clamp(ratios.name + delta, MIN_FILE_COLUMN_RATIOS.name, total - MIN_FILE_COLUMN_RATIOS.size);
    return { ...ratios, name: roundColumnRatio(name), size: roundColumnRatio(total - name) };
  }
  const total = ratios.size + ratios.modified;
  const size = clamp(ratios.size + delta, MIN_FILE_COLUMN_RATIOS.size, total - MIN_FILE_COLUMN_RATIOS.modified);
  return { ...ratios, size: roundColumnRatio(size), modified: roundColumnRatio(total - size) };
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundColumnRatio(value: number) {
  return Math.round(value * 10) / 10;
}

function renamedSiblingPath(path: string, name: string) {
  const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return separatorIndex < 0 ? name : `${path.slice(0, separatorIndex + 1)}${name}`;
}

function rootPathFor(path: string) {
  const match = path.trim().match(/^[a-z]:[\\/]/i);
  return match ? `${match[0][0].toUpperCase()}:\\` : path.trim() === "/" ? "/" : "";
}

function fileTransferSideAtPoint(clientX: number, clientY: number): FileTransferSide | null {
  const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-file-transfer-side]");
  const side = target?.dataset.fileTransferSide;
  return side === "left" || side === "right" ? side : null;
}

function canTransfer(
  source: { endpoint: TransferEndpoint; selectedPaths: string[] },
  destination: { endpoint: TransferEndpoint },
) {
  if (source.selectedPaths.length === 0) return false;
  if (source.endpoint.kind === "saved_session" && !source.endpoint.saved_session_id) return false;
  if (destination.endpoint.kind === "saved_session" && !destination.endpoint.saved_session_id) return false;
  if (source.endpoint.kind === "local" && destination.endpoint.kind === "local") return false;
  return Boolean(destination.endpoint.path.trim());
}
