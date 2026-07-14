// Author: Liz
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ZtContextMenu } from "../../components/ZtUi";
import { scheduleNextTask } from "../../lib/renderScheduling";
import {
  createTerminalSemanticHighlighter,
  DIGE_BLACK_SEMANTIC_PALETTE,
  DIGE_WHITE_SEMANTIC_PALETTE,
  type TerminalSemanticHighlighter,
} from "./terminalSemanticHighlight";
import type { CommandCompletionCandidate } from "./terminalStore";

interface XtermPaneProps {
  data?: string;
  liveData?: string | null;
  liveSerial?: number | null;
  replayKey?: number | string | null;
  streamId?: string | null;
  contextMenuEnabled?: boolean;
  onCompletionRequest?: (input: string, cursor: number) => Promise<CommandCompletionCandidate[]>;
  onDisconnect?: () => void;
  onInput?: (data: string) => void;
  onReconnect?: () => void;
  onResize?: (cols: number, rows: number) => void;
}

// Keep xterm's palette aligned with the shell surface; CSS controls the surrounding chrome.
// ANSI text colors reference WindTerm's dige-black and dige-white themes.
const DIGE_BLACK_TERMINAL_THEME = {
  background: "#1f1f21",
  foreground: "#F8F8F2",
  cursor: "rgba(245, 245, 247, 0.9)",
  black: "#333333",
  red: "#C4265E",
  green: "#86B42B",
  yellow: "#D0A500",
  blue: "#3465A4",
  magenta: "#8C6BC8",
  cyan: "#56ADBC",
  white: "#e3e3dd",
  brightBlack: "#666666",
  brightRed: "#f92672",
  brightGreen: "#A6E22E",
  brightYellow: "#9e862f",
  brightBlue: "#819aff",
  brightMagenta: "#AE81FF",
  brightCyan: "#66D9EF",
  brightWhite: "#f8f8f2",
};

const DIGE_WHITE_TERMINAL_THEME = {
  background: "#f7f7fa",
  foreground: "#333333",
  cursor: "#1d1d1f",
  black: "#272822",
  red: "#dc322f",
  green: "#32CD32",
  yellow: "#FFD700",
  blue: "#3465A4",
  magenta: "#d33682",
  cyan: "#3A96DD",
  white: "#D3D3D3",
  brightBlack: "#333333",
  brightRed: "#ff7882",
  brightGreen: "#3CB371",
  brightYellow: "#D2691E",
  brightBlue: "#80baff",
  brightMagenta: "#d778ff",
  brightCyan: "#78ffff",
  brightWhite: "#708090",
};
const MAX_REPLAY_OUTPUT_CHARS = 16_000;
const MAX_TERMINAL_WRITE_CHUNK_CHARS = 4_096;
const TERMINAL_STATUS_QUERY_PATTERN = /\x1b\[[0-9?;]*n/g;
const ANSI_CONTROL_SEQUENCE_PATTERN = /\x1b\](?:[^\x07\x1b]|\x1b(?!\\))*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

interface QueuedTerminalWrite {
  data: string;
  suppressGeneratedInput: boolean;
}

export function XtermPane({
  data = "",
  liveData = null,
  liveSerial,
  replayKey = null,
  streamId = null,
  contextMenuEnabled = true,
  onCompletionRequest,
  onDisconnect,
  onInput,
  onReconnect,
  onResize,
}: XtermPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const semanticHighlighterRef = useRef<TerminalSemanticHighlighter | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const writtenLengthRef = useRef(0);
  const streamIdRef = useRef<string | null>(streamId);
  const replayKeyRef = useRef<number | string | null>(null);
  const liveSerialRef = useRef<number | null>(null);
  const completionRequestIdRef = useRef(0);
  const ghostCandidateRef = useRef<CommandCompletionCandidate | null>(null);
  const lastResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const replayingOutputRef = useRef(false);
  const outputWriteQueueRef = useRef<QueuedTerminalWrite[]>([]);
  const outputWriteInProgressRef = useRef(false);
  const outputWriteGenerationRef = useRef(0);
  const outputWriteTimerRef = useRef<number | null>(null);
  const lineInputRef = useRef("");
  const onInputRef = useRef(onInput);
  const onResizeRef = useRef(onResize);
  const [ghostCandidate, setGhostCandidate] = useState<CommandCompletionCandidate | null>(null);
  const [ghostPosition, setGhostPosition] = useState<CSSProperties>({ bottom: 8, left: 10 });
  const [lineInput, setLineInput] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const clearOutputWriteTimer = useCallback(() => {
    if (outputWriteTimerRef.current !== null) {
      window.clearTimeout(outputWriteTimerRef.current);
      outputWriteTimerRef.current = null;
    }
  }, []);

  const cancelQueuedOutputWrites = useCallback(() => {
    outputWriteGenerationRef.current += 1;
    outputWriteQueueRef.current = [];
    outputWriteInProgressRef.current = false;
    replayingOutputRef.current = false;
    clearOutputWriteTimer();
  }, [clearOutputWriteTimer]);

  const drainQueuedOutputWrites = useCallback(() => {
    const terminal = terminalRef.current;
    if (!terminal || outputWriteInProgressRef.current) return;
    const item = outputWriteQueueRef.current.shift();
    if (!item) return;

    const generation = outputWriteGenerationRef.current;
    outputWriteInProgressRef.current = true;
    replayingOutputRef.current = item.suppressGeneratedInput;
    let offset = 0;

    const finishItem = () => {
      if (item.suppressGeneratedInput) {
        replayingOutputRef.current = false;
      }
      outputWriteInProgressRef.current = false;
      drainQueuedOutputWrites();
    };

    const writeNextChunk = () => {
      if (generation !== outputWriteGenerationRef.current || terminalRef.current !== terminal) {
        outputWriteInProgressRef.current = false;
        replayingOutputRef.current = false;
        return;
      }
      const chunk = item.data.slice(offset, offset + MAX_TERMINAL_WRITE_CHUNK_CHARS);
      offset += chunk.length;
      terminal.write(chunk, () => {
        if (generation !== outputWriteGenerationRef.current || terminalRef.current !== terminal) {
          outputWriteInProgressRef.current = false;
          replayingOutputRef.current = false;
          return;
        }
        if (offset < item.data.length) {
          outputWriteTimerRef.current = window.setTimeout(writeNextChunk, 0);
          return;
        }
        finishItem();
      });
    };

    writeNextChunk();
  }, []);

  const enqueueTerminalOutput = useCallback(
    (data: string, suppressGeneratedInput: boolean) => {
      const output = suppressGeneratedInput ? prepareReplayOutput(data) : data;
      if (!output) {
        replayingOutputRef.current = false;
        return;
      }
      outputWriteQueueRef.current.push({
        data: output,
        suppressGeneratedInput,
      });
      drainQueuedOutputWrites();
    },
    [drainQueuedOutputWrites],
  );

  useEffect(() => {
    onInputRef.current = onInput;
    onResizeRef.current = onResize;
  }, [onInput, onResize]);

  useEffect(() => {
    ghostCandidateRef.current = ghostCandidate;
  }, [ghostCandidate]);

  useEffect(() => {
    lineInputRef.current = lineInput;
  }, [lineInput]);

  useEffect(() => {
    if (!onCompletionRequest || !lineInput.trim()) {
      setGhostCandidate(null);
      return;
    }

    const requestId = (completionRequestIdRef.current += 1);
    void onCompletionRequest(lineInput, countChars(lineInput))
      .then((candidates) => {
        if (completionRequestIdRef.current !== requestId) return;
        const candidate = normalizedCandidateForInput(candidates, lineInput);
        setGhostPosition(resolveGhostPosition(terminalRef.current, containerRef.current));
        setGhostCandidate(candidate);
      })
      .catch(() => {
        if (completionRequestIdRef.current === requestId) {
          setGhostCandidate(null);
        }
      });
  }, [lineInput, onCompletionRequest]);

  const handleTerminalInput = useCallback(
    (value: string) => {
      if (replayingOutputRef.current) {
        return;
      }

      const candidate = ghostCandidateRef.current;
      if (value === "\t" && candidate) {
        onInputRef.current?.(candidate.suffix);
        lineInputRef.current = candidate.replacement_text;
        ghostCandidateRef.current = null;
        setLineInput(candidate.replacement_text);
        setGhostCandidate(null);
        return;
      }
      if (value === "\x1b" && candidate) {
        ghostCandidateRef.current = null;
        setGhostCandidate(null);
        return;
      }

      onInputRef.current?.(value);
      const currentInput = lineInputRef.current;
      const nextInput = applyTerminalInput(currentInput, value);
      if (nextInput !== currentInput) {
        setLineInput(nextInput);
      } else if (value !== "\t") {
        setGhostCandidate(null);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    return () => {
      containerRef.current?.replaceChildren();
    };
  }, []);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    const terminal = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        'ui-monospace, "SFMono-Regular", "Cascadia Mono", "Microsoft YaHei Mono", Consolas, "Liberation Mono", monospace',
      fontSize: resolveConfiguredTerminalFontSize(),
      fontWeight: 200,
      theme: resolveTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(containerRef.current);
    const semanticHighlighter = createTerminalSemanticHighlighter(terminal, resolveTerminalSemanticPalette());
    terminalRef.current = terminal;
    semanticHighlighterRef.current = semanticHighlighter;
    searchAddonRef.current = searchAddon;

    const inputDisposable = terminal.onData(handleTerminalInput);
    const reportTerminalSize = (size: { cols: number; rows: number }) => {
      const previousSize = lastResizeRef.current;
      if (previousSize?.cols === size.cols && previousSize.rows === size.rows) {
        return;
      }
      lastResizeRef.current = { cols: size.cols, rows: size.rows };
      onResizeRef.current?.(size.cols, size.rows);
    };
    const resizeDisposable = terminal.onResize(reportTerminalSize);
    fitAddon.fit();
    reportTerminalSize({ cols: terminal.cols, rows: terminal.rows });
    const fit = () => fitAddon.fit();
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resizeObserver?.observe(containerRef.current);
    window.addEventListener("resize", fit);

    return () => {
      cancelQueuedOutputWrites();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fit);
      inputDisposable.dispose();
      resizeDisposable.dispose();
      semanticHighlighter.dispose();
      terminalRef.current = null;
      semanticHighlighterRef.current = null;
      searchAddonRef.current = null;
      writtenLengthRef.current = 0;
      streamIdRef.current = null;
      replayKeyRef.current = null;
      liveSerialRef.current = null;
      replayingOutputRef.current = false;
      lastResizeRef.current = null;
      scheduleNextTask(() => terminal.dispose());
    };
  }, [cancelQueuedOutputWrites, handleTerminalInput]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;

    if (liveSerial !== undefined) {
      const streamChanged = streamIdRef.current !== streamId;
      const replayChanged = replayKeyRef.current !== replayKey;
      if (!streamChanged && !replayChanged) return;
      streamIdRef.current = streamId;
      replayKeyRef.current = replayKey;
      const replayCoversLiveData = isLiveDataCoveredByReplay(data, liveData, liveSerial);
      if (
        !streamChanged &&
        replayChanged &&
        replayCoversLiveData &&
        liveSerialRef.current === liveSerial &&
        writtenLengthRef.current === data.length
      ) {
        return;
      }
      liveSerialRef.current = replayCoversLiveData ? (liveSerial ?? null) : null;
      writtenLengthRef.current = data.length;
      cancelQueuedOutputWrites();
      semanticHighlighterRef.current?.clear();
      terminal.clear();
      if (data) {
        enqueueTerminalOutput(data, !isOnlyTerminalStatusQuery(data));
      }
      return;
    }

    const streamChanged = streamIdRef.current !== streamId;
    if (streamChanged) {
      streamIdRef.current = streamId;
      writtenLengthRef.current = 0;
      cancelQueuedOutputWrites();
      semanticHighlighterRef.current?.clear();
      terminal.clear();
      if (data) {
        enqueueTerminalOutput(data, !isOnlyTerminalStatusQuery(data));
      }
      writtenLengthRef.current = data.length;
      return;
    }

    if (!data) return;
    const previousLength = writtenLengthRef.current;
    if (data.length >= previousLength) {
      const nextChunk = data.slice(previousLength);
      if (nextChunk) {
        const suppressGeneratedInput = previousLength === 0 && !isOnlyTerminalStatusQuery(nextChunk);
        enqueueTerminalOutput(nextChunk, suppressGeneratedInput);
      }
    } else {
      cancelQueuedOutputWrites();
      semanticHighlighterRef.current?.clear();
      terminal.clear();
      enqueueTerminalOutput(data, !isOnlyTerminalStatusQuery(data));
    }
    writtenLengthRef.current = data.length;
  }, [cancelQueuedOutputWrites, data, enqueueTerminalOutput, liveData, liveSerial, replayKey, streamId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || liveSerial === undefined || liveSerial === null || !liveData) return;
    if (liveSerialRef.current === liveSerial) return;
    enqueueTerminalOutput(liveData, false);
    liveSerialRef.current = liveSerial;
    writtenLengthRef.current += liveData.length;
  }, [enqueueTerminalOutput, liveData, liveSerial]);

  return (
    <div
      className="zt-xterm-pane"
      onContextMenu={(event) => {
        event.preventDefault();
        if (!contextMenuEnabled) return;
        setContextMenu({ x: event.clientX, y: event.clientY });
      }}
    >
      <TerminalContextMenu
        menu={contextMenu}
        onClear={() => {
          semanticHighlighterRef.current?.clear();
          terminalRef.current?.clear();
        }}
        onCopy={() => {
          const selection = terminalRef.current?.getSelection();
          if (selection) void navigator.clipboard?.writeText(selection);
        }}
        onDisconnect={onDisconnect}
        onPaste={() => {
          void navigator.clipboard?.readText().then((text) => {
            if (text) onInputRef.current?.(text);
          });
        }}
        onReconnect={onReconnect}
        onSearch={() => {
          const term = window.prompt("搜索");
          if (term) searchAddonRef.current?.findNext(term);
        }}
        onClose={() => setContextMenu(null)}
      />
      <div className="zt-xterm-host" ref={containerRef} />
      {ghostCandidate ? (
        <div className="zt-command-ghost" aria-hidden="true" style={ghostPosition}>
          {ghostCandidate.suffix}
        </div>
      ) : null}
    </div>
  );
}

function TerminalContextMenu({
  menu,
  onClear,
  onCopy,
  onDisconnect,
  onClose,
  onPaste,
  onReconnect,
  onSearch,
}: {
  menu: { x: number; y: number } | null;
  onClear: () => void;
  onCopy: () => void;
  onDisconnect?: () => void;
  onClose: () => void;
  onPaste: () => void;
  onReconnect?: () => void;
  onSearch: () => void;
}) {
  useEffect(() => {
    if (!menu) return undefined;
    window.addEventListener("click", onClose);
    return () => window.removeEventListener("click", onClose);
  }, [menu, onClose]);

  if (!menu) return null;
  const hasConnectionActions = Boolean(onReconnect || onDisconnect);

  return (
    <ZtContextMenu className="zt-context-menu" role="menu" x={menu.x} y={menu.y}>
      <button type="button" role="menuitem" onClick={onCopy}>
        复制
      </button>
      <button type="button" role="menuitem" onClick={onPaste}>
        粘贴
      </button>
      <button type="button" role="menuitem" onClick={onClear}>
        清屏
      </button>
      <button type="button" role="menuitem" onClick={onSearch}>
        搜索
      </button>
      {hasConnectionActions ? (
        <>
          <div className="zt-context-menu-separator" role="separator" />
          {onReconnect ? (
            <button type="button" role="menuitem" onClick={onReconnect}>
              重新连接
            </button>
          ) : null}
          {onDisconnect ? (
            <button type="button" role="menuitem" onClick={onDisconnect}>
              断开连接
            </button>
          ) : null}
        </>
      ) : null}
    </ZtContextMenu>
  );
}

function resolveConfiguredTerminalFontSize() {
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue("--zt-terminal-font-size")
    .trim();
  const size = Number.parseInt(value, 10);
  return Number.isFinite(size) ? size : 13;
}

function resolveTerminalTheme() {
  return document.documentElement.dataset.ztTheme === "light"
    ? DIGE_WHITE_TERMINAL_THEME
    : DIGE_BLACK_TERMINAL_THEME;
}

function resolveTerminalSemanticPalette() {
  return document.documentElement.dataset.ztTheme === "light"
    ? DIGE_WHITE_SEMANTIC_PALETTE
    : DIGE_BLACK_SEMANTIC_PALETTE;
}

function applyTerminalInput(current: string, value: string) {
  if (value.startsWith("\x1b")) {
    return current;
  }
  let next = current;
  for (const character of value) {
    if (character === "\r" || character === "\n" || character === "\x03") {
      next = "";
    } else if (character === "\b" || character === "\x7f") {
      next = Array.from(next).slice(0, -1).join("");
    } else if (character === "\t") {
      continue;
    } else if (!isControlCharacter(character)) {
      next += character;
    }
  }
  return next;
}

function prepareReplayOutput(data: string) {
  const tail = data.length > MAX_REPLAY_OUTPUT_CHARS ? data.slice(-MAX_REPLAY_OUTPUT_CHARS) : data;
  return tail.replace(TERMINAL_STATUS_QUERY_PATTERN, "");
}

function isOnlyTerminalStatusQuery(data: string) {
  const withoutQueries = data.replace(TERMINAL_STATUS_QUERY_PATTERN, "");
  if (withoutQueries === data) {
    return false;
  }
  return data.replace(ANSI_CONTROL_SEQUENCE_PATTERN, "").trim().length === 0;
}

function isLiveDataCoveredByReplay(data: string, liveData: string | null, liveSerial: number | null | undefined) {
  if (liveSerial === undefined || liveSerial === null) {
    return false;
  }
  if (!liveData) {
    return true;
  }
  return data.endsWith(liveData);
}

function isControlCharacter(character: string) {
  return character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127;
}

function countChars(value: string) {
  return Array.from(value).length;
}

function resolveGhostPosition(terminal: Terminal | null, container: HTMLElement | null): CSSProperties {
  if (!terminal || !container) {
    return { bottom: 8, left: 10 };
  }
  const rows = container.querySelector<HTMLElement>(".xterm-rows");
  const firstRow = rows?.querySelector<HTMLElement>("div");
  const rowsRect = rows?.getBoundingClientRect();
  const rowRect = firstRow?.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  const fontSize = Number(terminal.options.fontSize) || resolveConfiguredTerminalFontSize();
  const cellWidth = Math.max(6, estimateCellWidth(firstRow, fontSize));
  const rowHeight = Math.max(fontSize * 1.2, rowRect?.height || fontSize * 1.35);
  const cursorX = Math.max(0, terminal.buffer.active.cursorX);
  const cursorY = Math.max(0, terminal.buffer.active.cursorY);
  if (!rowsRect || rowsRect.height === 0) {
    return { bottom: 8, left: 10 + cursorX * cellWidth };
  }
  return {
    left: Math.min(containerRect.width - 20, 4 + cursorX * cellWidth),
    top: Math.max(0, rowsRect.top - containerRect.top + cursorY * rowHeight),
    bottom: "auto",
  };
}

function estimateCellWidth(row: HTMLElement | null | undefined, fontSize: number) {
  if (!row) return fontSize * 0.62;
  const textLength = row.textContent ? Array.from(row.textContent).length : 0;
  const width = row.getBoundingClientRect().width;
  if (textLength > 0 && width > 0) {
    return width / textLength;
  }
  return fontSize * 0.62;
}

function normalizedCandidateForInput(candidates: CommandCompletionCandidate[], input: string) {
  const candidate = candidates.find(
    (item) => item.replacement_text !== input && item.replacement_text.startsWith(input),
  );
  if (!candidate) return null;
  return {
    ...candidate,
    suffix: candidate.replacement_text.slice(input.length),
  };
}
