// Author: Liz
import type { FileEntry } from "./fileStore";

export interface FileSelectionEvent {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

export function nextSelectedFilePaths(
  entries: FileEntry[],
  currentSelection: string[],
  anchorPath: string | null,
  clickedPath: string,
  event: FileSelectionEvent = {},
) {
  if (event.shiftKey && anchorPath) {
    return selectionRangePaths(entries, anchorPath, clickedPath);
  }

  if (event.ctrlKey || event.metaKey) {
    const next = new Set(currentSelection);
    if (next.has(clickedPath)) {
      next.delete(clickedPath);
    } else {
      next.add(clickedPath);
    }
    return orderPathsByEntries(entries, next);
  }

  return [clickedPath];
}

export function selectedFileEntries(entries: FileEntry[], selectedPaths: string[]) {
  const selected = new Set(selectedPaths);
  return entries.filter((entry) => selected.has(entry.path));
}

function selectionRangePaths(entries: FileEntry[], anchorPath: string, clickedPath: string) {
  const anchorIndex = entries.findIndex((entry) => entry.path === anchorPath);
  const clickedIndex = entries.findIndex((entry) => entry.path === clickedPath);
  if (anchorIndex < 0 || clickedIndex < 0) return [clickedPath];
  const start = Math.min(anchorIndex, clickedIndex);
  const end = Math.max(anchorIndex, clickedIndex);
  return entries.slice(start, end + 1).map((entry) => entry.path);
}

function orderPathsByEntries(entries: FileEntry[], paths: Set<string>) {
  const ordered = entries.filter((entry) => paths.has(entry.path)).map((entry) => entry.path);
  for (const path of paths) {
    if (!ordered.includes(path)) ordered.push(path);
  }
  return ordered;
}
