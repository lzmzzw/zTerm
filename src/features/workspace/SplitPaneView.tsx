// Author: Liz
import { CircleAlert, Clock3, LoaderCircle, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

import { TerminalPlaceholder } from "../terminal/TerminalPlaceholder";
import { TerminalSnapshotPane } from "../terminal/TerminalSnapshotPane";
import { useTerminalStore } from "../terminal/terminalStore";
import { TerminalToolbar } from "../terminal/TerminalToolbar";
import { XtermPane } from "../terminal/XtermPane";
import { scheduleAfterPaintDelay } from "../../lib/renderScheduling";
import { getActiveTerminalTab, getLeafTerminalTabs } from "./workspaceLayout";
import type { PaneNode, PaneSplitDirection } from "./types";

const ACTIVE_XTERM_MOUNT_DELAY_MS = 48;
const INACTIVE_XTERM_MOUNT_DELAY_MS = 96;

interface SplitPaneViewProps {
  root: PaneNode;
  activePaneId: string;
  onActivatePane: (paneId: string) => void;
  onAddPaneTab: (paneId: string) => void;
  onSelectPaneTab: (paneId: string, paneTabId: string) => void;
  onClosePaneTab: (paneId: string, paneTabId: string) => void;
  onSplitPane: (direction: PaneSplitDirection) => void;
  onResizeSplit?: (splitId: string, ratio: number) => void;
  onClosePane: () => void;
  onDisconnectTerminal?: (paneId: string, paneTabId: string, runtimeSessionId: string) => void;
  onReconnectTerminal?: (paneId: string, paneTabId: string, savedSessionId: string, runtimeSessionId: string) => void;
  workspaceActive?: boolean;
  visualMode?: "normal" | "placeholder" | "snapshot";
}

export function SplitPaneView({
  root,
  activePaneId,
  onActivatePane,
  onAddPaneTab,
  onSelectPaneTab,
  onClosePaneTab,
  onSplitPane,
  onResizeSplit,
  onClosePane,
  onDisconnectTerminal,
  onReconnectTerminal,
  workspaceActive = true,
  visualMode = "normal",
}: SplitPaneViewProps) {
  const handleSplitDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, split: Extract<PaneNode, { kind: "split" }>) => {
      if (!onResizeSplit) return;

      event.preventDefault();
      event.stopPropagation();

      const container = event.currentTarget.parentElement;
      if (!container) return;

      event.currentTarget.setPointerCapture?.(event.pointerId);

      const updateRatio = (clientX: number, clientY: number) => {
        const rect = container.getBoundingClientRect();
        const length = split.direction === "horizontal" ? rect.width : rect.height;
        if (length <= 0) return;

        const offset = split.direction === "horizontal" ? clientX - rect.left : clientY - rect.top;
        onResizeSplit(split.id, offset / length);
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        updateRatio(moveEvent.clientX, moveEvent.clientY);
      };

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
    },
    [onResizeSplit],
  );

  if (root.kind === "split") {
    return (
      <div
        className={`zt-split-pane zt-split-pane-${root.direction}`}
        style={
          {
            "--zt-split-ratio": `${root.ratio * 100}%`,
          } as CSSProperties
        }
      >
        <SplitPaneView
          root={root.first}
          activePaneId={activePaneId}
          onActivatePane={onActivatePane}
          onAddPaneTab={onAddPaneTab}
          onSelectPaneTab={onSelectPaneTab}
          onClosePaneTab={onClosePaneTab}
          onSplitPane={onSplitPane}
          onResizeSplit={onResizeSplit}
          onClosePane={onClosePane}
          onDisconnectTerminal={onDisconnectTerminal}
          onReconnectTerminal={onReconnectTerminal}
          workspaceActive={workspaceActive}
          visualMode={visualMode}
        />
        <div
          className="zt-split-divider"
          role="separator"
          aria-orientation={root.direction === "horizontal" ? "vertical" : "horizontal"}
          onPointerDown={(event) => handleSplitDividerPointerDown(event, root)}
        />
        <SplitPaneView
          root={root.second}
          activePaneId={activePaneId}
          onActivatePane={onActivatePane}
          onAddPaneTab={onAddPaneTab}
          onSelectPaneTab={onSelectPaneTab}
          onClosePaneTab={onClosePaneTab}
          onSplitPane={onSplitPane}
          onResizeSplit={onResizeSplit}
          onClosePane={onClosePane}
          onDisconnectTerminal={onDisconnectTerminal}
          onReconnectTerminal={onReconnectTerminal}
          workspaceActive={workspaceActive}
          visualMode={visualMode}
        />
      </div>
    );
  }

  return (
    <LeafPane
      root={root}
      active={root.id === activePaneId}
      onActivatePane={onActivatePane}
      onAddPaneTab={onAddPaneTab}
      onSelectPaneTab={onSelectPaneTab}
      onClosePaneTab={onClosePaneTab}
      onSplitPane={onSplitPane}
      onClosePane={onClosePane}
      onDisconnectTerminal={onDisconnectTerminal}
      onReconnectTerminal={onReconnectTerminal}
      workspaceActive={workspaceActive}
      visualMode={visualMode}
    />
  );
}

function LeafPane({
  root,
  active,
  onActivatePane,
  onAddPaneTab,
  onSelectPaneTab,
  onClosePaneTab,
  onSplitPane,
  onClosePane,
  onDisconnectTerminal,
  onReconnectTerminal,
  workspaceActive,
  visualMode,
}: {
  root: Extract<PaneNode, { kind: "leaf" }>;
  active: boolean;
  onActivatePane: (paneId: string) => void;
  onAddPaneTab: (paneId: string) => void;
  onSelectPaneTab: (paneId: string, paneTabId: string) => void;
  onClosePaneTab: (paneId: string, paneTabId: string) => void;
  onSplitPane: (direction: PaneSplitDirection) => void;
  onClosePane: () => void;
  onDisconnectTerminal?: (paneId: string, paneTabId: string, runtimeSessionId: string) => void;
  onReconnectTerminal?: (paneId: string, paneTabId: string, savedSessionId: string, runtimeSessionId: string) => void;
  workspaceActive: boolean;
  visualMode: "normal" | "placeholder" | "snapshot";
}) {
  const terminalTabs = getLeafTerminalTabs(root);
  const activeTerminalTab = getActiveTerminalTab(root);
  const activeRuntimeSessionId = activeTerminalTab.runtime_session_id ?? null;
  const [xtermRuntimeSessionId, setXtermRuntimeSessionId] = useState<string | null>(null);
  const [xtermReplay, setXtermReplay] = useState<{ data: string; key: number; runtimeSessionId: string | null }>({
    data: "",
    key: 0,
    runtimeSessionId: null,
  });
  const scheduledRuntimeSessionIdRef = useRef<string | null>(null);
  const allowXterm = visualMode === "normal" && workspaceActive;
  const runtime = useTerminalStore((state) =>
    activeRuntimeSessionId ? state.runtimes[activeRuntimeSessionId] : null,
  );
  const xtermMounted = Boolean(
      runtime &&
      activeRuntimeSessionId &&
      xtermRuntimeSessionId === activeRuntimeSessionId &&
      (runtime.kind === "ssh" || runtime.kind === "local"),
  );
  const xtermLive = Boolean(workspaceActive && xtermMounted);
  const outputChunk = useTerminalStore((state) =>
    xtermLive && activeRuntimeSessionId ? (state.outputChunks[activeRuntimeSessionId] ?? null) : null,
  );
  const visualOutputTail = useTerminalStore((state) =>
    workspaceActive && !xtermMounted && activeRuntimeSessionId ? (state.visualOutputTail[activeRuntimeSessionId] ?? "") : "",
  );
  const snapshotText = activeTerminalTab.visual_snapshot?.text ?? visualOutputTail;
  const hasSnapshotText = snapshotText.length > 0;
  const writeTerminal = useTerminalStore((state) => state.writeTerminal);
  const suggestCompletion = useTerminalStore((state) => state.suggestCompletion);
  const resizeTerminal = useTerminalStore((state) => state.resizeTerminal);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);

  const activatePane = useCallback(() => onActivatePane(root.id), [onActivatePane, root.id]);
  const visibleTerminalTabs = terminalTabs.filter((terminalTab) => !isEmptyPaneTerminalTab(terminalTab));

  useLayoutEffect(() => {
    scheduledRuntimeSessionIdRef.current = null;
    if (!allowXterm) {
      setXtermRuntimeSessionId(null);
      return;
    }
    setXtermRuntimeSessionId((current) => (current === activeRuntimeSessionId ? current : null));
  }, [activeRuntimeSessionId, allowXterm]);

  useEffect(() => {
    if (!allowXterm || !activeRuntimeSessionId) {
      return undefined;
    }
    if (xtermRuntimeSessionId === activeRuntimeSessionId) {
      return undefined;
    }

    scheduledRuntimeSessionIdRef.current = activeRuntimeSessionId;
    const delayMs = active ? ACTIVE_XTERM_MOUNT_DELAY_MS : INACTIVE_XTERM_MOUNT_DELAY_MS;
    return scheduleAfterPaintDelay(() => {
      if (scheduledRuntimeSessionIdRef.current === activeRuntimeSessionId) {
        const replayData = useTerminalStore.getState().output[activeRuntimeSessionId] ?? "";
        setXtermReplay((current) => ({
          data: replayData,
          key: current.runtimeSessionId === activeRuntimeSessionId ? current.key + 1 : 1,
          runtimeSessionId: activeRuntimeSessionId,
        }));
        setXtermRuntimeSessionId(activeRuntimeSessionId);
      }
    }, delayMs);
  }, [active, activeRuntimeSessionId, allowXterm, xtermRuntimeSessionId]);

  useEffect(() => {
    if (!xtermLive || !activeRuntimeSessionId) return;
    if (xtermReplay.runtimeSessionId === activeRuntimeSessionId) return;
    const replayData = useTerminalStore.getState().output[activeRuntimeSessionId] ?? "";
    setXtermReplay((current) => ({
      data: replayData,
      key: current.runtimeSessionId === activeRuntimeSessionId ? current.key + 1 : 1,
      runtimeSessionId: activeRuntimeSessionId,
    }));
  }, [activeRuntimeSessionId, xtermLive, xtermReplay.runtimeSessionId]);

  const handleInput = useCallback(
    (data: string) => {
      if (runtime?.kind === "ssh" || runtime?.kind === "local") {
        void writeTerminal(runtime.runtime_session_id, data);
      }
    },
    [runtime, writeTerminal],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (runtime?.kind === "ssh" || runtime?.kind === "local") {
        void resizeTerminal(runtime.runtime_session_id, cols, rows);
      }
    },
    [runtime, resizeTerminal],
  );

  const handleCompletionRequest = useCallback(
    (input: string, cursor: number) => {
      if (runtime?.kind === "ssh" || runtime?.kind === "local") {
        return suggestCompletion(runtime.runtime_session_id, input, cursor);
      }
      return Promise.resolve([]);
    },
    [runtime, suggestCompletion],
  );

  const handleClosePane = useCallback(() => {
    if (activeTerminalTab.runtime_session_id) {
      void closeTerminal(activeTerminalTab.runtime_session_id)
        .catch(() => undefined)
        .finally(onClosePane);
      return;
    }
    onClosePane();
  }, [activeTerminalTab.runtime_session_id, closeTerminal, onClosePane]);

  const handleSplitPane = useCallback(
    (direction: PaneSplitDirection) => {
      onActivatePane(root.id);
      onSplitPane(direction);
    },
    [onActivatePane, onSplitPane, root.id],
  );

  const handleClosePaneTab = useCallback(
    (terminalTabId: string, runtimeSessionId: string | null) => {
      onActivatePane(root.id);
      if (runtimeSessionId) {
        void closeTerminal(runtimeSessionId)
          .catch(() => undefined)
          .finally(() => onClosePaneTab(root.id, terminalTabId));
        return;
      }
      onClosePaneTab(root.id, terminalTabId);
    },
    [closeTerminal, onActivatePane, onClosePaneTab, root.id],
  );

  return (
    <section
      className={`zt-terminal-frame ${active ? "active" : ""}`}
      aria-label={`终端区域 ${activeTerminalTab.title}`}
      onClick={activatePane}
    >
      <div className="zt-pane-tabs">
        <div className="zt-pane-tablist" role="tablist" aria-label={`${activeTerminalTab.title} 标签`}>
          {visibleTerminalTabs.map((terminalTab) => {
            const isActivePaneTerminalTab = active && terminalTab.id === activeTerminalTab.id;
            const connecting = terminalTab.restore_status === "pending";
            const queued = terminalTab.restore_status === "queued";
            const failed = terminalTab.restore_status === "failed";

            return (
              <div
                key={terminalTab.id}
                className={[
                  "zt-pane-tab",
                  isActivePaneTerminalTab ? "active" : "",
                  connecting ? "connecting" : "",
                  queued || failed ? "statused" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
              >
                <button
                  type="button"
                  className="zt-pane-tab-main"
                  role="tab"
                  aria-selected={isActivePaneTerminalTab}
                  onClick={(event) => {
                    event.stopPropagation();
                    onActivatePane(root.id);
                    onSelectPaneTab(root.id, terminalTab.id);
                  }}
                >
                  {terminalTab.title}
                </button>
                {connecting ? (
                  <span
                    className="zt-pane-tab-spinner"
                    aria-label={`正在连接 ${terminalTab.title}`}
                    title="连接中"
                  >
                    <LoaderCircle size={13} aria-hidden="true" />
                  </span>
                ) : null}
                {queued ? (
                  <span
                    className="zt-pane-tab-status zt-pane-tab-queued"
                    aria-label={`等待连接 ${terminalTab.title}`}
                    title="等待连接"
                  >
                    <Clock3 size={13} aria-hidden="true" />
                  </span>
                ) : null}
                {failed ? (
                  <span
                    className="zt-pane-tab-status zt-pane-tab-failed"
                    aria-label={`连接失败 ${terminalTab.title}`}
                    title={terminalTab.restore_error ?? "连接失败"}
                  >
                    <CircleAlert size={13} aria-hidden="true" />
                  </span>
                ) : null}
                <button
                  type="button"
                  className="zt-pane-tab-close"
                  aria-label={`关闭标签 ${terminalTab.title}`}
                  title="关闭标签"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleClosePaneTab(terminalTab.id, terminalTab.runtime_session_id);
                  }}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="zt-pane-tab-icon"
            aria-label="创建连接"
            title="创建连接"
            onClick={(event) => {
              event.stopPropagation();
              onActivatePane(root.id);
              onAddPaneTab(root.id);
            }}
          >
            <Plus size={14} aria-hidden="true" />
          </button>
        </div>
        <TerminalToolbar onSplitPane={handleSplitPane} onClosePane={handleClosePane} />
      </div>
      {xtermMounted && visualMode === "normal" && workspaceActive && (runtime?.kind === "ssh" || runtime?.kind === "local") ? (
        <XtermPane
          contextMenuEnabled={workspaceActive && (runtime.kind === "ssh" || runtime.kind === "local")}
          data={xtermReplay.data}
          liveData={outputChunk?.data ?? null}
          liveSerial={outputChunk?.serial ?? null}
          replayKey={xtermReplay.key}
          streamId={runtime.runtime_session_id}
          onCompletionRequest={handleCompletionRequest}
          onDisconnect={
            runtime.kind === "ssh" && activeTerminalTab.runtime_session_id
              ? () => onDisconnectTerminal?.(root.id, activeTerminalTab.id, activeTerminalTab.runtime_session_id!)
              : undefined
          }
          onInput={handleInput}
          onReconnect={
            runtime.kind === "ssh" && activeTerminalTab.runtime_session_id && activeTerminalTab.saved_session_id
              ? () =>
                  onReconnectTerminal?.(
                    root.id,
                    activeTerminalTab.id,
                    activeTerminalTab.saved_session_id!,
                    activeTerminalTab.runtime_session_id!,
                  )
              : undefined
          }
          onResize={handleResize}
        />
      ) : visualMode === "snapshot" || (visualMode === "normal" && activeRuntimeSessionId && !xtermMounted && hasSnapshotText) ? (
        <TerminalSnapshotPane
          title={activeTerminalTab.title}
          text={snapshotText}
          restoreStatus={activeTerminalTab.restore_status}
          restoreError={activeTerminalTab.restore_error}
          mode={runtime?.kind === "rdp_placeholder" ? "rdp" : "terminal"}
        />
      ) : (
        <TerminalPlaceholder
          mode={runtime?.kind === "rdp_placeholder" ? "rdp" : "terminal"}
          message={
            runtime?.kind === "rdp_placeholder"
              ? activeTerminalTab.title
              : runtime?.kind === "ssh" || runtime?.kind === "local"
                ? `正在准备 ${activeTerminalTab.title}`
              : activeTerminalTab.restore_status === "pending"
                ? `正在连接 ${activeTerminalTab.title}`
                : activeTerminalTab.restore_status === "queued"
                  ? `等待连接 ${activeTerminalTab.title}`
                  : activeTerminalTab.restore_status === "failed"
                    ? (activeTerminalTab.restore_error ?? "连接失败")
                : undefined
          }
        />
      )}
    </section>
  );
}

function isEmptyPaneTerminalTab(terminalTab: ReturnType<typeof getLeafTerminalTabs>[number]) {
  return (
    terminalTab.title === "新建终端" &&
    !terminalTab.runtime_session_id &&
    !terminalTab.saved_session_id &&
    !terminalTab.restore_status &&
    terminalTab.connection_source !== "missing"
  );
}
