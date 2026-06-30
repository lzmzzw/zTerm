// Author: Liz
import {
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileSymlink,
  FileText,
  FileVideoCamera,
  FolderOpen,
} from "lucide-react";

import type { FileEntry } from "./fileStore";

export function formatFileModifiedTime(value: number | null) {
  if (!value) return "-";
  return new Date(value).toLocaleString();
}

export function resolveFileIcon(entry: Pick<FileEntry, "kind" | "name">) {
  if (entry.kind === "directory") return <FolderOpen size={16} />;
  if (entry.kind === "symlink") return <FileSymlink size={16} />;

  const lastDot = entry.name.lastIndexOf(".");
  const extension = lastDot > 0 ? entry.name.slice(lastDot + 1).toLowerCase() : "";

  switch (extension) {
    case "jpg":
    case "jpeg":
    case "png":
    case "gif":
    case "webp":
    case "bmp":
    case "svg":
      return <FileImage size={16} />;
    case "mp3":
    case "wav":
    case "ogg":
    case "flac":
    case "m4a":
      return <FileMusic size={16} />;
    case "mp4":
    case "mov":
    case "mkv":
    case "avi":
      return <FileVideoCamera size={16} />;
    case "xlsx":
    case "xls":
    case "csv":
      return <FileSpreadsheet size={16} />;
    case "zip":
    case "rar":
    case "tar":
    case "gz":
    case "7z":
    case "bz2":
      return <FileArchive size={16} />;
    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "java":
    case "rs":
    case "go":
    case "c":
    case "cpp":
    case "cs":
    case "php":
    case "rb":
    case "sh":
    case "bash":
    case "yaml":
    case "yml":
    case "json":
      return <FileCode size={16} />;
    case "md":
    case "txt":
    case "log":
      return <FileText size={16} />;
    default:
      return <File size={16} />;
  }
}
