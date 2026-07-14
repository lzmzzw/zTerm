// Author: Liz
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { Edit3, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { FileToolbar } from "./FileToolbar";
import type { FileEntry } from "./fileStore";
import type { FileSelectionEvent } from "./fileSelectionModel";
import { resolveFileDragDropEvent } from "./fileDragDropModel";
import { formatFileModifiedTime, resolveFileIcon } from "./fileExplorerPresentation";
import { ZtContextMenu } from "../../components/ZtUi";
import { formatBytes } from "../../lib/byteFormatters";

interface FileExplorerPanelProps {
  savedSessionId: string | null;
  path: string;
  entries: FileEntry[];
  selectedPaths: string[];
  loading: boolean;
  error: string | null;
  onPathChange: (path: string) => void;
  onSelect: (path: string | null, event?: FileSelectionEvent, orderedEntries?: FileEntry[]) => void;
  onRefresh: () => Promise<void> | void;
  onParent: () => Promise<void> | void;
  onMkdir: () => Promise<void> | void;
  onUpload: () => Promise<void> | void;
  onUploadDropped: (paths: string[]) => Promise<void> | void;
  onDownload: (entries: FileEntry[]) => Promise<void> | void;
  onRename: (path: string) => Promise<void> | void;
  onDelete: (paths: string[], recursive: boolean) => Promise<void> | void;
  onOpenDirectory?: (path: string) => Promise<void> | void;
}

export function FileExplorerPanel({
  savedSessionId,
  path,
  entries,
  selectedPaths,
  loading,
  error,
  onPathChange,
  onSelect,
  onRefresh,
  onParent,
  onMkdir,
  onUpload,
  onUploadDropped,
  onDownload,
  onRename,
  onDelete,
  onOpenDirectory,
}: FileExplorerPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmDeletePaths, setConfirmDeletePaths] = useState<string[] | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entries: FileEntry[] } | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const visibleEntries = useMemo(
    () => (showHiddenFiles ? entries : entries.filter((entry) => !entry.name.startsWith("."))),
    [entries, showHiddenFiles],
  );
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedPaths.includes(entry.path)),
    [entries, selectedPaths],
  );
  const disabled = !savedSessionId;

  function requestDelete(entriesToDelete = selectedEntries) {
    if (entriesToDelete.length === 0) return;
    const paths = entriesToDelete.map((entry) => entry.path);
    if (entriesToDelete.some((entry) => entry.kind === "directory")) {
      setConfirmDeletePaths(paths);
      return;
    }
    void onDelete(paths, false);
  }

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextMenu]);

  useEffect(() => {
    let mounted = true;
    let cleanup: (() => void) | null = null;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (!mounted || disabled) return;
        const decision = resolveFileDragDropEvent(event.payload, panelRef.current);
        if (decision.kind === "hover") {
          setDragActive(decision.active);
        } else if (decision.kind === "clear") {
          setDragActive(false);
        } else if (decision.kind === "upload") {
          setDragActive(false);
          void onUploadDropped(decision.paths);
        }
      })
      .then((unlisten) => {
        if (mounted) {
          cleanup = unlisten;
        } else {
          unlisten();
        }
      })
      .catch(() => undefined);
    return () => {
      mounted = false;
      cleanup?.();
    };
  }, [disabled, onUploadDropped]);

  return (
    <div
      ref={panelRef}
      className={dragActive ? "zt-file-panel zt-file-panel-drag-active" : "zt-file-panel"}
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY, entries: [] });
      }}
    >
      <div className="zt-file-path">
        <input
          type="text"
          aria-label="远程路径"
          value={path}
          disabled={disabled}
          onChange={(event) => onPathChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void onRefresh();
          }}
        />
      </div>
      <FileToolbar
        disabled={disabled}
        loading={loading}
        hasSelection={selectedEntries.length > 0}
        canRename={selectedEntries.length === 1}
        onRefresh={onRefresh}
        onParent={onParent}
        onMkdir={onMkdir}
        onUpload={onUpload}
        onDownload={() => {
          if (selectedEntries.length > 0) return onDownload(selectedEntries);
        }}
        onRename={() => {
          if (selectedEntries.length === 1) return onRename(selectedEntries[0].path);
        }}
        onDelete={requestDelete}
      />
      {disabled ? <div className="zt-empty-line">打开 SSH 会话后显示远程文件</div> : null}
      {error ? <div className="zt-terminal-error">{error}</div> : null}
      {loading ? <div className="zt-empty-line">加载中</div> : null}
      {!disabled && !loading && visibleEntries.length === 0 ? <div className="zt-empty-line">暂无文件</div> : null}
      <div className="zt-file-list" role="list" aria-label="远程文件列表">
        {visibleEntries.map((entry) => (
          <button
            type="button"
            role="listitem"
            key={entry.path}
            aria-selected={selectedPaths.includes(entry.path)}
            className={selectedPaths.includes(entry.path) ? "active" : ""}
            onClick={(event) =>
              onSelect(
                entry.path,
                { ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey },
                visibleEntries,
              )
            }
            onDoubleClick={() => {
              if (entry.kind === "directory") {
                if (onOpenDirectory) {
                  void onOpenDirectory(entry.path);
                } else {
                  onPathChange(entry.path);
                }
              }
            }}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              const contextEntries = selectedPaths.includes(entry.path) ? selectedEntries : [entry];
              if (!selectedPaths.includes(entry.path)) onSelect(entry.path, undefined, visibleEntries);
              setContextMenu({ x: event.clientX, y: event.clientY, entries: contextEntries });
            }}
          >
            <span className="zt-file-kind-icon" aria-hidden="true">
              {resolveFileIcon(entry)}
            </span>
            <strong>{entry.name}</strong>
            <small>{entry.kind === "directory" ? "-" : formatBytes(entry.size, { maxUnit: "MB" })}</small>
            <small>{formatFileModifiedTime(entry.modified_at_ms)}</small>
            <small>{entry.permissions ?? "-"}</small>
          </button>
        ))}
      </div>
      {dragActive ? <div className="zt-file-drop-overlay">释放以上传到当前目录</div> : null}
      {confirmDeletePaths ? (
        <div className="zt-confirm-inline">
          <span>确认删除选中的 {confirmDeletePaths.length} 个项目</span>
          <button
            type="button"
            className="zt-delete-button"
            onClick={() => {
              const pathsToDelete = confirmDeletePaths;
              setConfirmDeletePaths(null);
              void onDelete(pathsToDelete, true);
            }}
          >
            确认删除
          </button>
          <button type="button" onClick={() => setConfirmDeletePaths(null)}>
            取消
          </button>
        </div>
      ) : null}
      {contextMenu ? (
        <ZtContextMenu className="zt-context-menu" role="menu" x={contextMenu.x} y={contextMenu.y}>
          <button type="button" role="menuitem" disabled={disabled || loading} onClick={() => void onUpload()}>
            上传
          </button>
          <button type="button" role="menuitem" disabled={disabled || loading} onClick={() => void onMkdir()}>
            新建目录
          </button>
          <button type="button" role="menuitem" disabled={disabled || loading} onClick={() => void onRefresh()}>
            刷新目录
          </button>
          <button type="button" role="menuitem" onClick={() => setShowHiddenFiles((current) => !current)}>
            {showHiddenFiles ? "不显示隐藏文件" : "显示隐藏文件"}
          </button>
          {contextMenu.entries.length > 0 ? <div className="zt-context-menu-separator" role="separator" /> : null}
          {contextMenu.entries.length > 0 ? (
            <button
              type="button"
              role="menuitem"
              disabled={loading || contextMenu.entries.length !== 1}
              onClick={() => void onRename(contextMenu.entries[0].path)}
            >
              <Edit3 size={14} aria-hidden="true" />
              重命名
            </button>
          ) : null}
          {contextMenu.entries.length > 0 ? (
            <button
              type="button"
              role="menuitem"
              className="zt-delete-button"
              disabled={loading}
              onClick={() => requestDelete(contextMenu.entries)}
            >
              <Trash2 size={14} aria-hidden="true" />
              删除
            </button>
          ) : null}
        </ZtContextMenu>
      ) : null}
    </div>
  );
}
