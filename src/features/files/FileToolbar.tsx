// Author: Liz
import { ArrowUp, Download, Edit3, FileUp, FolderPlus, FolderUp, RefreshCw, Trash2 } from "lucide-react";

interface FileToolbarProps {
  disabled: boolean;
  loading: boolean;
  hasSelection: boolean;
  canRename: boolean;
  onRefresh: () => Promise<void> | void;
  onParent: () => Promise<void> | void;
  onMkdir: () => Promise<void> | void;
  onUploadFiles: () => Promise<void> | void;
  onUploadDirectories: () => Promise<void> | void;
  onDownload: () => Promise<void> | void;
  onRename: () => Promise<void> | void;
  onDelete: () => Promise<void> | void;
}

export function FileToolbar({
  disabled,
  loading,
  hasSelection,
  canRename,
  onRefresh,
  onParent,
  onMkdir,
  onUploadFiles,
  onUploadDirectories,
  onDownload,
  onRename,
  onDelete,
}: FileToolbarProps) {
  return (
    <div className="zt-file-toolbar">
      <button type="button" aria-label="刷新文件列表" disabled={disabled || loading} onClick={() => void onRefresh()}>
        <RefreshCw size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="上级目录" disabled={disabled || loading} onClick={() => void onParent()}>
        <ArrowUp size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="新建文件夹" disabled={disabled || loading} onClick={() => void onMkdir()}>
        <FolderPlus size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="上传文件" title="上传文件" disabled={disabled || loading} onClick={() => void onUploadFiles()}>
        <FileUp size={14} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="上传文件夹"
        title="上传文件夹"
        disabled={disabled || loading}
        onClick={() => void onUploadDirectories()}
      >
        <FolderUp size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="下载" disabled={disabled || !hasSelection} onClick={() => void onDownload()}>
        <Download size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="重命名" disabled={disabled || !canRename} onClick={() => void onRename()}>
        <Edit3 size={14} aria-hidden="true" />
      </button>
      <button type="button" aria-label="删除" disabled={disabled || !hasSelection} onClick={() => void onDelete()}>
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </div>
  );
}
