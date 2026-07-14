// Author: Liz
import type { IBufferLine, IDecoration, IMarker, Terminal } from "@xterm/xterm";

export type TerminalSemanticRole =
  | "permissionType"
  | "permissionRead"
  | "permissionWrite"
  | "permissionExecute"
  | "permissionNone"
  | "attributeInfo"
  | "attributeWarning"
  | "attributeError"
  | "path"
  | "prompt"
  | "command"
  | "option"
  | "number"
  | "date"
  | "ip"
  | "url"
  | "success"
  | "info"
  | "warning"
  | "error";

export interface TerminalSemanticHighlight {
  end: number;
  role: TerminalSemanticRole;
  start: number;
}

export type TerminalSemanticPalette = Record<TerminalSemanticRole, string>;

export const DIGE_BLACK_SEMANTIC_PALETTE: TerminalSemanticPalette = {
  permissionType: "#b267e6",
  permissionRead: "#6796e6",
  permissionWrite: "#cd9731",
  permissionExecute: "#f44747",
  permissionNone: "#A6E22E",
  attributeInfo: "#6796e6",
  attributeWarning: "#cd9731",
  attributeError: "#f44747",
  path: "#E6DB74",
  prompt: "#F92672",
  command: "#66D9EF",
  option: "#FD971F",
  number: "#AE81FF",
  date: "#A6E22E",
  ip: "#A6E22E",
  url: "#66D9EF",
  success: "#32CD32",
  info: "#6796e6",
  warning: "#cd9731",
  error: "#f44747",
};

export const DIGE_WHITE_SEMANTIC_PALETTE: TerminalSemanticPalette = {
  permissionType: "#b267e6",
  permissionRead: "#6796e6",
  permissionWrite: "#cd9731",
  permissionExecute: "#f44747",
  permissionNone: "#3CB371",
  attributeInfo: "#6796e6",
  attributeWarning: "#cd9731",
  attributeError: "#f44747",
  path: "#FF8C00",
  prompt: "#4B69C6",
  command: "#1E90FF",
  option: "#FD971F",
  number: "#DDA0DD",
  date: "#20B2AA",
  ip: "#20B2AA",
  url: "#1E90FF",
  success: "#32CD32",
  info: "#6796e6",
  warning: "#cd9731",
  error: "#f44747",
};

export interface TerminalSemanticHighlighter {
  clear: () => void;
  dispose: () => void;
  refresh: () => void;
}

export function createTerminalSemanticHighlighter(
  terminal: Terminal,
  palette: TerminalSemanticPalette,
): TerminalSemanticHighlighter {
  const highlightedLines: HighlightedTerminalLine[] = [];
  const writeDisposable = terminal.onWriteParsed(() => refresh());
  const scrollDisposable = terminal.onScroll(() => refresh());

  function refresh() {
    const buffer = terminal.buffer.active;
    pruneDisposedLines(highlightedLines);
    if (buffer.type !== "normal") {
      clear();
      return;
    }

    const firstLine = Math.max(0, buffer.viewportY);
    const lastLine = Math.min(buffer.length, firstLine + terminal.rows);
    const cursorLine = buffer.baseY + buffer.cursorY;
    for (let lineIndex = firstLine; lineIndex < lastLine; lineIndex += 1) {
      const bufferLine = buffer.getLine(lineIndex);
      if (!bufferLine) continue;
      const line = readTerminalLine(bufferLine, terminal.cols);
      const existing = highlightedLines.find((entry) => entry.marker.line === lineIndex);
      if (existing?.signature === line.signature) continue;
      if (existing) disposeHighlightedLine(highlightedLines, existing);

      const highlights = findTerminalSemanticHighlights(line.text);
      if (highlights.length === 0) continue;
      const marker = terminal.registerMarker(lineIndex - cursorLine);
      if (!marker) continue;
      const decorations: IDecoration[] = [];
      const decorationRanges: Array<{ color: string; width: number; x: number }> = [];
      for (const highlight of highlights) {
        for (const range of defaultForegroundRanges(line.cells, highlight.start, highlight.end)) {
          decorationRanges.push({ ...range, color: palette[highlight.role] });
        }
      }
      for (const range of mergeDecorationRanges(decorationRanges)) {
        const decoration = terminal.registerDecoration({
          marker,
          x: range.x,
          width: range.width,
          foregroundColor: range.color,
          layer: "bottom",
        });
        if (decoration) decorations.push(decoration);
      }
      if (decorations.length === 0) {
        marker.dispose();
        continue;
      }
      highlightedLines.push({ decorations, marker, signature: line.signature });
    }
  }

  function clear() {
    for (const line of highlightedLines.splice(0)) {
      line.decorations.forEach((decoration) => decoration.dispose());
      line.marker.dispose();
    }
  }

  return {
    clear,
    dispose: () => {
      writeDisposable.dispose();
      scrollDisposable.dispose();
      clear();
    },
    refresh,
  };
}

interface HighlightedTerminalLine {
  decorations: IDecoration[];
  marker: IMarker;
  signature: string;
}

interface TerminalLineCell {
  column: number;
  defaultForeground: boolean;
  textEnd: number;
  textStart: number;
  width: number;
}

function readTerminalLine(bufferLine: IBufferLine, columns: number) {
  const cells: TerminalLineCell[] = [];
  let text = "";
  const lastColumn = Math.min(bufferLine.length, columns);
  for (let column = 0; column < lastColumn; column += 1) {
    const cell = bufferLine.getCell(column);
    if (!cell || cell.getWidth() === 0) continue;
    const characters = cell.getChars() || " ";
    const textStart = text.length;
    text += characters;
    cells.push({
      column,
      defaultForeground: cell.isFgDefault(),
      textEnd: text.length,
      textStart,
      width: cell.getWidth(),
    });
  }
  const trimmedText = text.trimEnd();
  const visibleCells = cells.filter((cell) => cell.textStart < trimmedText.length);
  return {
    cells: visibleCells,
    signature: `${trimmedText}\u0000${visibleCells.map((cell) => (cell.defaultForeground ? "1" : "0")).join("")}`,
    text: trimmedText,
  };
}

function defaultForegroundRanges(cells: TerminalLineCell[], start: number, end: number) {
  const ranges: Array<{ width: number; x: number }> = [];
  for (const cell of cells) {
    if (cell.textStart >= end || cell.textEnd <= start || !cell.defaultForeground) continue;
    const previous = ranges[ranges.length - 1];
    if (previous && previous.x + previous.width === cell.column) {
      previous.width += cell.width;
    } else {
      ranges.push({ x: cell.column, width: cell.width });
    }
  }
  return ranges;
}

function mergeDecorationRanges(ranges: Array<{ color: string; width: number; x: number }>) {
  const merged: Array<{ color: string; width: number; x: number }> = [];
  for (const range of ranges.sort((left, right) => left.x - right.x)) {
    const previous = merged[merged.length - 1];
    if (previous && previous.color === range.color && previous.x + previous.width === range.x) {
      previous.width += range.width;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function pruneDisposedLines(lines: HighlightedTerminalLine[]) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].marker.isDisposed) lines.splice(index, 1);
  }
}

function disposeHighlightedLine(lines: HighlightedTerminalLine[], line: HighlightedTerminalLine) {
  line.decorations.forEach((decoration) => decoration.dispose());
  line.marker.dispose();
  const index = lines.indexOf(line);
  if (index >= 0) lines.splice(index, 1);
}

const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)";

export function findTerminalSemanticHighlights(line: string): TerminalSemanticHighlight[] {
  const highlights: TerminalSemanticHighlight[] = [];

  addUnixPermissions(line, highlights);
  addPowerShellAttributes(line, highlights);
  addShellPrompt(line, highlights);
  addMatches(
    line,
    /\b(?:https?|ftps?|file|scp|sftp):\/\/[^\s<>'"]+[^\s<>'".,;:!?)]/gi,
    "url",
    highlights,
  );
  addMatches(
    line,
    /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
    "ip",
    highlights,
  );
  addMatches(
    line,
    new RegExp(`\\b${MONTH}\\s+\\d{1,2}\\s+(?:\\d{1,2}:\\d{2}(?::\\d{2})?|\\d{4})\\b`, "gi"),
    "date",
    highlights,
  );
  addMatches(line, /\b\d{4}[/-]\d{1,2}[/-]\d{1,2}\b/g, "date", highlights);
  addMatches(line, /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, "date", highlights);
  addMatches(line, /\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s+(?:AM|PM|GMT))?\b/gi, "date", highlights);
  addMatches(line, /<DIR>/gi, "info", highlights);
  addMatches(
    line,
    /\b(?:success(?:ful(?:ly)?)?|passed|pass|supported|valid|yes|ok)\b/gi,
    "success",
    highlights,
  );
  addMatches(
    line,
    /\b(?:warning|warn|closed|exited|debug|disconnected|skipped|stopped|terminated)\b/gi,
    "warning",
    highlights,
  );
  addMatches(
    line,
    /\b(?:bad|cannot|denied|deprecated|disabled|errors?|failed|fail|failure|incorrect|invalid|refused|unknown|unsupported|wrong)\b/gi,
    "error",
    highlights,
  );
  addMatches(
    line,
    /\b(?:access|authentication|connection|disconnection|info|login|operation|password|permission)\b/gi,
    "info",
    highlights,
  );
  addMatches(line, /\b[A-Za-z]:[\\/][^\s<>"|?*]+/g, "path", highlights);
  addCapturedMatches(line, /(?:^|\s)([-/]{1,2}[A-Za-z][\w-]*)\b/g, 1, "option", highlights);
  addMatches(line, /(?<![\w.-])\d+(?:\.\d+)*%?(?![\w-])/g, "number", highlights);

  return highlights.sort((left, right) => left.start - right.start || left.end - right.end);
}

function addUnixPermissions(line: string, highlights: TerminalSemanticHighlight[]) {
  const match =
    /(?:^|\s)([bcdlps?-][r-][w-][xsStT-][r-][w-][xsStT-][r-][w-][xsStT-][.+]?)(?=\s)/.exec(line);
  if (!match) return;
  const start = match.index + match[0].indexOf(match[1]);
  Array.from(match[1]).forEach((character, index) => {
    const role =
      index === 0 && character !== "-"
        ? "permissionType"
        : character === "r"
          ? "permissionRead"
          : character === "w"
            ? "permissionWrite"
            : /[xsStT]/.test(character)
              ? "permissionExecute"
              : "permissionNone";
    addHighlight(highlights, { start: start + index, end: start + index + 1, role });
  });
}

function addPowerShellAttributes(line: string, highlights: TerminalSemanticHighlight[]) {
  const match = /^([d-][darhsl-]{5,6})(?=\s)/i.exec(line);
  if (!match) return;
  Array.from(match[1]).forEach((character, index) => {
    const normalized = character.toLowerCase();
    const role =
      normalized === "d" || normalized === "l"
        ? "attributeWarning"
        : normalized === "a" || normalized === "s"
          ? "attributeInfo"
          : normalized === "h" || normalized === "r"
            ? "attributeError"
            : "permissionNone";
    addHighlight(highlights, { start: index, end: index + 1, role });
  });
}

function addShellPrompt(line: string, highlights: TerminalSemanticHighlight[]) {
  const windowsPrompt = /^(?:PS\s+)?([A-Za-z]:[\\/][^>\r\n]*)(>)[ \t]*([A-Za-z][\w.-]*)?/.exec(line);
  if (windowsPrompt) {
    addCapture(line, windowsPrompt, 1, "path", highlights);
    addCapture(line, windowsPrompt, 2, "prompt", highlights);
    addCapture(line, windowsPrompt, 3, "command", highlights);
    return;
  }

  const posixPrompt = /^(?:\[[^\]]+\]\s*)?[^\r\n]*?([#$%])[ \t]+([A-Za-z_][\w.-]*)/.exec(line);
  if (!posixPrompt) return;
  addCapture(line, posixPrompt, 1, "prompt", highlights);
  addCapture(line, posixPrompt, 2, "command", highlights);
}

function addMatches(
  line: string,
  pattern: RegExp,
  role: TerminalSemanticRole,
  highlights: TerminalSemanticHighlight[],
) {
  for (const match of line.matchAll(pattern)) {
    if (match.index === undefined || !match[0]) continue;
    addHighlight(highlights, { start: match.index, end: match.index + match[0].length, role });
  }
}

function addCapturedMatches(
  line: string,
  pattern: RegExp,
  captureIndex: number,
  role: TerminalSemanticRole,
  highlights: TerminalSemanticHighlight[],
) {
  for (const match of line.matchAll(pattern)) {
    addCapture(line, match, captureIndex, role, highlights);
  }
}

function addCapture(
  _line: string,
  match: RegExpMatchArray | RegExpExecArray,
  captureIndex: number,
  role: TerminalSemanticRole,
  highlights: TerminalSemanticHighlight[],
) {
  const value = match[captureIndex];
  if (!value || match.index === undefined) return;
  let captureStart = 0;
  for (let index = 1; index < captureIndex; index += 1) {
    const precedingCapture = match[index];
    if (!precedingCapture) continue;
    const nextStart = match[0].indexOf(precedingCapture, captureStart);
    if (nextStart >= 0) captureStart = nextStart + precedingCapture.length;
  }
  const relativeStart = match[0].indexOf(value, captureStart);
  if (relativeStart < 0) return;
  addHighlight(highlights, {
    start: match.index + relativeStart,
    end: match.index + relativeStart + value.length,
    role,
  });
}

function addHighlight(highlights: TerminalSemanticHighlight[], candidate: TerminalSemanticHighlight) {
  const overlaps = highlights.some(
    (highlight) => candidate.start < highlight.end && candidate.end > highlight.start,
  );
  if (!overlaps) highlights.push(candidate);
}
