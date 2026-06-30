// Author: Liz
import { useEffect, useMemo, useState } from "react";

import { FileToolbar } from "./FileToolbar";
import type { FileEntry } from "./fileStore";
import { formatFileModifiedTime, resolveFileIcon } from "./fileExplorerPresentation";
import { formatBytes } from "../../lib/byteFormatters";

interface FileExplorerPanelProps {
  savedSessionId: string | null;
  path: string;
  entries: FileEntry[];
  selectedPath: string | null;
  loading: boolean;
  error: string | null;
  onPathChange: (path: string) => void;
  onSelect: (path: string | null) => void;
  onRefresh: () => Promise<void> | void;
  onParent: () => Promise<void> | void;
  onMkdir: () => Promise<void> | void;
  onUpload: () => Promise<void> | void;
  onDownload: (path: string) => Promise<void> | void;
  onRename: (path: string) => Promise<void> | void;
  onDelete: (path: string, recursive: boolean) => Promise<void> | void;
  onOpenDirectory?: (path: string) => Promise<void> | void;
}

export function FileExplorerPanel({
  savedSessionId,
  path,
  entries,
  selectedPath,
  loading,
  error,
  onPathChange,
  onSelect,
  onRefresh,
  onParent,
  onMkdir,
  onUpload,
  onDownload,
  onRename,
  onDelete,
  onOpenDirectory,
}: FileExplorerPanelProps) {
  const [confirmDeletePath, setConfirmDeletePath] = useState<string | null>(null);
  const [showHiddenFiles, setShowHiddenFiles] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const visibleEntries = useMemo(
    () => (showHiddenFiles ? entries : entries.filter((entry) => !entry.name.startsWith("."))),
    [entries, showHiddenFiles],
  );
  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.path === selectedPath) ?? null,
    [entries, selectedPath],
  );
  const disabled = !savedSessionId;

  function requestDelete() {
    if (!selectedEntry) return;
    if (selectedEntry.kind === "directory") {
      setConfirmDeletePath(selectedEntry.path);
      return;
    }
    void onDelete(selectedEntry.path, false);
  }

  useEffect(() => {
    if (!contextMenu) return undefined;
    const closeMenu = () => setContextMenu(null);
    window.addEventListener("click", closeMenu);
    return () => window.removeEventListener("click", closeMenu);
  }, [contextMenu]);

  return (
    <div
      className="zt-file-panel"
      onContextMenu={(event) => {
        event.preventDefault();
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <div className="zt-file-path">
        <span>{path}</span>
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
        hasSelection={Boolean(selectedEntry)}
        onRefresh={onRefresh}
        onParent={onParent}
        onMkdir={onMkdir}
        onUpload={onUpload}
        onDownload={() => {
          if (selectedEntry) return onDownload(selectedEntry.path);
        }}
        onRename={() => {
          if (selectedEntry) return onRename(selectedEntry.path);
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
            className={entry.path === selectedPath ? "active" : ""}
            onClick={() => onSelect(entry.path)}
            onDoubleClick={() => {
              if (entry.kind === "directory") {
                if (onOpenDirectory) {
                  void onOpenDirectory(entry.path);
                } else {
                  onPathChange(entry.path);
                }
              }
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
      {confirmDeletePath ? (
        <div className="zt-confirm-inline">
          <span>确认删除文件夹</span>
          <button
            type="button"
            onClick={() => {
              const pathToDelete = confirmDeletePath;
              setConfirmDeletePath(null);
              void onDelete(pathToDelete, true);
            }}
          >
            确认删除
          </button>
          <button type="button" onClick={() => setConfirmDeletePath(null)}>
            取消
          </button>
        </div>
      ) : null}
      {contextMenu ? (
        <div className="zt-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <button type="button" role="menuitem" disabled={disabled || loading} onClick={() => void onUpload()}>
            上传文件
          </button>
          <button type="button" role="menuitem" disabled={disabled || loading} onClick={() => void onUpload()}>
            上传文件夹
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
        </div>
      ) : null}
    </div>
  );
}
