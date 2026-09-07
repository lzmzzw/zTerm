// Author: Liz
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  type ClipboardEvent as ReactClipboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ZtContextMenu } from "../../components/ZtUi";
import { scheduleNextTask } from "../../lib/renderScheduling";
import { readClipboardTextWithRetry, sanitizeTerminalPaste } from "./terminalClipboard";
import { parseOsc7Cwd, parseSimpleCdTarget } from "./terminalCwd";
import {
  createTerminalSemanticHighlighter,
  DIGE_BLACK_SEMANTIC_PALETTE,
  DIGE_BLACK_LINE_HIGHLIGHT_PALETTE,
  DIGE_WHITE_LINE_HIGHLIGHT_PALETTE,
  DIGE_WHITE_SEMANTIC_PALETTE,
  type TerminalSemanticHighlighter,
} from "./terminalSemanticHighlight";
import type { CommandCompletionCandidate } from "./terminalStore";
import type { TerminalReplayKind } from "./terminalReplay";
import type { TerminalInputSource } from "./syncInputStore";

interface XtermPaneProps {
  autoFocus?: boolean;
  data?: string;
  initialCwd?: string | null;
  liveData?: string | null;
  liveSerial?: number | null;
  replayKey?: number | string | null;
  replayKind?: TerminalReplayKind;
  streamId?: string | null;
  contextMenuEnabled?: boolean;
  contextMenuClearEnabled?: boolean;
  contextMenuSearchEnabled?: boolean;
  onCompletionRequest?: (
    input: string,
    cursor: number,
    cwd: string | null,
  ) => Promise<CommandCompletionCandidate[]>;
  onCwdResolve?: (currentCwd: string | null, target: string | null) => Promise<string | null>;
  onCwdChange?: (cwd: string) => void;
  onDisconnect?: () => void;
  onInput?: (data: string, metadata?: { source: TerminalInputSource }) => void;
  onCloseTerminal?: () => void;
  onReconnect?: () => void;
  onRestart?: () => void;
  onResize?: (cols: number, rows: number) => void;
}

// Keep xterm's palette aligned with the shell surface; CSS controls the surrounding chrome.
// ANSI text colors reference WindTerm's dige-black and dige-white themes.
const DIGE_BLACK_TERMINAL_THEME = {
  background: "#1f1f21",
  foreground: "#F8F8F2",
  cursor: "#ff9d00",
  cursorAccent: "#1f1f21",
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
  cursor: "#ff9d00",
  cursorAccent: "#f7f7fa",
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
  autoFocus = true,
  data = "",
  initialCwd = null,
  liveData = null,
  liveSerial,
  replayKey = null,
  replayKind = "raw",
  streamId = null,
  contextMenuEnabled = true,
  contextMenuClearEnabled = true,
  contextMenuSearchEnabled = true,
  onCompletionRequest,
  onCwdResolve,
  onCwdChange,
  onDisconnect,
  onInput,
  onCloseTerminal,
  onReconnect,
  onRestart,
  onResize,
}: XtermPaneProps) {
  const paneRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const ghostElementRef = useRef<HTMLDivElement | null>(null);
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
  const parsingOutputRef = useRef(false);
  const outputWriteQueueRef = useRef<QueuedTerminalWrite[]>([]);
  const outputWriteInProgressRef = useRef(false);
  const outputWriteGenerationRef = useRef(0);
  const outputWriteTimerRef = useRef<number | null>(null);
  const lineInputRef = useRef("");
  const cwdRef = useRef<string | null>(initialCwd);
  const cwdResolveGenerationRef = useRef(0);
  const pasteInFlightRef = useRef<Promise<void> | null>(null);
  const onInputRef = useRef(onInput);
  const onCwdResolveRef = useRef(onCwdResolve);
  const onCwdChangeRef = useRef(onCwdChange);
  const onResizeRef = useRef(onResize);
  const [ghostCandidate, setGhostCandidate] = useState<CommandCompletionCandidate | null>(null);
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

  const syncGhostPosition = useCallback(() => {
    const element = ghostElementRef.current;
    if (!element) return;
    const position = resolveGhostPosition(
      terminalRef.current,
      containerRef.current,
      paneRef.current,
    );
    element.style.left = `${position.left}px`;
    element.style.top = `${position.top}px`;
    element.style.maxWidth = `${position.maxWidth}px`;
  }, []);

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
      parsingOutputRef.current = true;
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
        semanticHighlighterRef.current?.refresh();
        finishItem();
      });
      parsingOutputRef.current = false;
    };

    writeNextChunk();
  }, []);

  const enqueueTerminalOutput = useCallback(
    (data: string, suppressGeneratedInput: boolean) => {
      const output = suppressGeneratedInput ? prepareReplayOutput(data, replayKind) : data;
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
    [drainQueuedOutputWrites, replayKind],
  );

  useEffect(() => {
    onInputRef.current = onInput;
    onCwdResolveRef.current = onCwdResolve;
    onCwdChangeRef.current = onCwdChange;
    onResizeRef.current = onResize;
  }, [onCwdChange, onCwdResolve, onInput, onResize]);

  useEffect(() => {
    ghostCandidateRef.current = ghostCandidate;
  }, [ghostCandidate]);

  useEffect(() => {
    lineInputRef.current = lineInput;
  }, [lineInput]);

  useEffect(() => {
    cwdResolveGenerationRef.current += 1;
    cwdRef.current = initialCwd;
  }, [initialCwd, streamId]);

  useEffect(() => {
    if (!onCompletionRequest || !lineInput.trim()) {
      setGhostCandidate(null);
      return;
    }

    const requestId = (completionRequestIdRef.current += 1);
    void onCompletionRequest(lineInput, countChars(lineInput), cwdRef.current)
      .then((candidates) => {
        if (completionRequestIdRef.current !== requestId) return;
        const candidate = normalizedCandidateForInput(candidates, lineInput);
        setGhostCandidate(candidate);
      })
      .catch(() => {
        if (completionRequestIdRef.current === requestId) {
          setGhostCandidate(null);
        }
      });
  }, [lineInput, onCompletionRequest]);

  useLayoutEffect(() => {
    if (ghostCandidate) syncGhostPosition();
  }, [ghostCandidate, syncGhostPosition]);

  const handleTerminalInput = useCallback(
    (value: string) => {
      if (replayingOutputRef.current) {
        return;
      }

      if (!parsingOutputRef.current) {
        cwdResolveGenerationRef.current += 1;
      }

      const candidate = ghostCandidateRef.current;
      if (value === "\t" && candidate) {
        onInputRef.current?.(completionInputForCandidate(candidate, lineInputRef.current));
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

      if (parsingOutputRef.current) {
        onInputRef.current?.(value, { source: "terminal_response" });
        return;
      }

      onInputRef.current?.(value);
      const currentInput = lineInputRef.current;
      const submittedParts = value.split(/[\r\n]/);
      const submittedPrefix = submittedParts[0];
      const hasAdditionalCommand = submittedParts.slice(1).some((part) => part.trim().length > 0);
      if (value.includes("\r") || value.includes("\n")) {
        const parsedCd = hasAdditionalCommand
          ? null
          : parseSimpleCdTarget(currentInput + submittedPrefix);
        const resolveCwd = onCwdResolveRef.current;
        if (parsedCd && resolveCwd) {
          const generation = cwdResolveGenerationRef.current;
          void resolveCwd(cwdRef.current, parsedCd.target)
            .then((resolvedCwd) => {
              if (resolvedCwd && cwdResolveGenerationRef.current === generation) {
                cwdRef.current = resolvedCwd;
              }
            })
            .catch(() => undefined);
        }
      }
      const nextInput = applyTerminalInput(currentInput, value);
      if (nextInput !== currentInput) {
        setLineInput(nextInput);
      } else if (value !== "\t") {
        setGhostCandidate(null);
      }
    },
    [],
  );

  const pastePlainText = useCallback((text: string) => {
    const plainText = sanitizeTerminalPaste(text);
    if (plainText) {
      terminalRef.current?.paste(plainText);
    }
  }, []);

  const pasteClipboardText = useCallback(() => {
    if (pasteInFlightRef.current) {
      return pasteInFlightRef.current;
    }

    const pasteTask = readClipboardTextWithRetry(navigator.clipboard)
      .then(pastePlainText)
      .catch(() => undefined)
      .finally(() => {
        if (pasteInFlightRef.current === pasteTask) {
          pasteInFlightRef.current = null;
        }
      });
    pasteInFlightRef.current = pasteTask;
    return pasteTask;
  }, [pastePlainText]);

  const handlePasteCapture = useCallback(
    (event: ReactClipboardEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (pasteInFlightRef.current) {
        return;
      }
      pastePlainText(event.clipboardData.getData("text/plain"));
    },
    [pastePlainText],
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
      minimumContrastRatio: 4.5,
      cursorInactiveStyle: "outline",
      cursorStyle: "block",
      fontFamily:
        'ui-monospace, "SFMono-Regular", "Cascadia Mono", "Microsoft YaHei Mono", Consolas, "Liberation Mono", monospace',
      fontSize: resolveConfiguredTerminalFontSize(),
      fontWeight: 350,
      theme: resolveTerminalTheme(),
    });
    terminal.attachCustomKeyEventHandler((event) => {
      const hasPrimaryModifier = (event.ctrlKey || event.metaKey) && !event.altKey;
      const key = event.key.toLowerCase();
      if (hasPrimaryModifier && key === "v") {
        event.preventDefault();
        event.stopPropagation();
        if (event.type === "keydown" && !event.repeat) {
          void pasteClipboardText();
        }
        return false;
      }
      if (hasPrimaryModifier && key === "a") {
        terminal.selectAll();
        return false;
      }
      return true;
    });
    const fitAddon = new FitAddon();
    const searchAddon = new SearchAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(searchAddon);
    terminal.loadAddon(new WebLinksAddon());
    terminal.open(containerRef.current);
    const cwdDisposable = terminal.parser.registerOscHandler(7, (payload) => {
      const cwd = parseOsc7Cwd(payload);
      if (cwd) {
        cwdResolveGenerationRef.current += 1;
        cwdRef.current = cwd;
        onCwdChangeRef.current?.(cwd);
      }
      return true;
    });
    const semanticHighlighter = createTerminalSemanticHighlighter(
      terminal,
      resolveTerminalSemanticPalette(),
      resolveTerminalLineHighlightPalette(),
    );
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
    const cursorDisposable = terminal.onCursorMove(syncGhostPosition);
    const scrollDisposable = terminal.onScroll(syncGhostPosition);
    const resizeDisposable = terminal.onResize((size) => {
      reportTerminalSize(size);
      syncGhostPosition();
    });
    fitAddon.fit();
    reportTerminalSize({ cols: terminal.cols, rows: terminal.rows });
    const fit = () => {
      fitAddon.fit();
      syncGhostPosition();
    };
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fit);
    resizeObserver?.observe(containerRef.current);
    window.addEventListener("resize", fit);

    return () => {
      cancelQueuedOutputWrites();
      resizeObserver?.disconnect();
      window.removeEventListener("resize", fit);
      inputDisposable.dispose();
      cursorDisposable.dispose();
      scrollDisposable.dispose();
      resizeDisposable.dispose();
      cwdDisposable.dispose();
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
  }, [cancelQueuedOutputWrites, handleTerminalInput, pasteClipboardText, syncGhostPosition]);

  useEffect(() => {
    if (autoFocus) terminalRef.current?.focus();
  }, [autoFocus]);

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
      ref={paneRef}
      onPasteCapture={handlePasteCapture}
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
        onCloseTerminal={onCloseTerminal}
        onPaste={() => void pasteClipboardText()}
        onReconnect={onReconnect}
        onRestart={onRestart}
        onSearch={() => {
          const term = window.prompt("搜索");
          if (term) searchAddonRef.current?.findNext(term);
        }}
        showClear={contextMenuClearEnabled}
        showSearch={contextMenuSearchEnabled}
        onClose={() => setContextMenu(null)}
      />
      <div className="zt-xterm-host" ref={containerRef} />
      {ghostCandidate ? (
        <div className="zt-command-ghost" aria-hidden="true" ref={ghostElementRef}>
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
  onCloseTerminal,
  onPaste,
  onReconnect,
  onRestart,
  onSearch,
  showClear,
  showSearch,
}: {
  menu: { x: number; y: number } | null;
  onClear: () => void;
  onCopy: () => void;
  onDisconnect?: () => void;
  onClose: () => void;
  onCloseTerminal?: () => void;
  onPaste: () => void;
  onReconnect?: () => void;
  onRestart?: () => void;
  onSearch: () => void;
  showClear: boolean;
  showSearch: boolean;
}) {
  useEffect(() => {
    if (!menu) return undefined;
    window.addEventListener("click", onClose);
    return () => window.removeEventListener("click", onClose);
  }, [menu, onClose]);

  if (!menu) return null;
  const hasLifecycleActions = Boolean(onRestart || onCloseTerminal);
  const hasConnectionActions = Boolean(onReconnect || onDisconnect);

  return (
    <ZtContextMenu className="zt-context-menu" role="menu" x={menu.x} y={menu.y}>
      <button type="button" role="menuitem" onClick={onCopy}>
        复制
      </button>
      <button type="button" role="menuitem" onClick={onPaste}>
        粘贴
      </button>
      {showClear ? (
        <button type="button" role="menuitem" onClick={onClear}>
          清屏
        </button>
      ) : null}
      {showSearch ? (
        <button type="button" role="menuitem" onClick={onSearch}>
          搜索
        </button>
      ) : null}
      {hasLifecycleActions ? (
        <>
          <div className="zt-context-menu-separator" role="separator" />
          {onRestart ? (
            <button type="button" role="menuitem" onClick={onRestart}>
              重启 Codex CLI
            </button>
          ) : null}
          {onCloseTerminal ? (
            <button type="button" className="zt-delete-button" role="menuitem" onClick={onCloseTerminal}>
              关闭 Codex CLI
            </button>
          ) : null}
        </>
      ) : null}
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

function resolveTerminalLineHighlightPalette() {
  return document.documentElement.dataset.ztTheme === "light"
    ? DIGE_WHITE_LINE_HIGHLIGHT_PALETTE
    : DIGE_BLACK_LINE_HIGHLIGHT_PALETTE;
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

function prepareReplayOutput(data: string, replayKind: TerminalReplayKind) {
  const tail = replayKind === "screen" || data.length <= MAX_REPLAY_OUTPUT_CHARS
    ? data
    : data.slice(-MAX_REPLAY_OUTPUT_CHARS);
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

function resolveGhostPosition(
  terminal: Terminal | null,
  container: HTMLElement | null,
  pane: HTMLElement | null,
) {
  if (!terminal || !container || !pane) {
    return { left: 10, maxWidth: 1, top: 8 };
  }
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  const firstRow = container.querySelector<HTMLElement>(".xterm-rows > div");
  const screenRect = screen?.getBoundingClientRect();
  const rowRect = firstRow?.getBoundingClientRect();
  const paneRect = pane.getBoundingClientRect();
  const fontSize = Number(terminal.options.fontSize) || resolveConfiguredTerminalFontSize();
  const columns = Math.max(1, terminal.cols);
  const rows = Math.max(1, terminal.rows);
  const cellWidth = screenRect && screenRect.width > 0
    ? screenRect.width / columns
    : Math.max(6, fontSize * 0.62);
  const rowHeight = screenRect && screenRect.height > 0
    ? screenRect.height / rows
    : Math.max(fontSize * 1.2, rowRect?.height || fontSize * 1.35);
  const rawCursorX = Math.max(0, terminal.buffer.active.cursorX);
  const cursorRowOffset = Math.floor(rawCursorX / columns);
  const cursorX = rawCursorX % columns;
  const cursorY = Math.max(0, terminal.buffer.active.cursorY + cursorRowOffset);
  const originLeft = (screenRect?.left ?? paneRect.left + 4) - paneRect.left;
  const originTop = (screenRect?.top ?? paneRect.top) - paneRect.top;
  const left = Math.max(originLeft, originLeft + cursorX * cellWidth);
  return {
    left,
    maxWidth: Math.max(
      cellWidth,
      (screenRect?.right ?? paneRect.right - 4) - paneRect.left - left,
    ),
    top: Math.max(originTop, originTop + Math.min(rows - 1, cursorY) * rowHeight),
  };
}

function normalizedCandidateForInput(candidates: CommandCompletionCandidate[], input: string) {
  const candidate = candidates.find(
    (item) =>
      item.replacement_text !== input &&
      item.replacement_range.start >= 0 &&
      item.replacement_range.start <= item.replacement_range.end &&
      item.replacement_range.end <= countChars(input) &&
      Array.from(item.replacement_text).slice(0, item.replacement_range.start).join("") ===
        Array.from(input).slice(0, item.replacement_range.start).join(""),
  );
  if (!candidate) return null;
  return {
    ...candidate,
    suffix: candidate.suffix,
  };
}

function completionInputForCandidate(candidate: CommandCompletionCandidate, input: string) {
  if (candidate.replacement_text.startsWith(input)) {
    return candidate.replacement_text.slice(input.length);
  }
  const eraseCount = Math.max(0, countChars(input) - candidate.replacement_range.start);
  const replacement = Array.from(candidate.replacement_text)
    .slice(candidate.replacement_range.start)
    .join("");
  return `${"\x7f".repeat(eraseCount)}${replacement}`;
}
