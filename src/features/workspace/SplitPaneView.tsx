// Author: Liz
import { CircleAlert, Clock3, LoaderCircle, Plus, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from "react";

import { TerminalPlaceholder } from "../terminal/TerminalPlaceholder";
import { TerminalSnapshotPane } from "../terminal/TerminalSnapshotPane";
import { useTerminalStore } from "../terminal/terminalStore";
import { TerminalToolbar } from "../terminal/TerminalToolbar";
import { XtermPane } from "../terminal/XtermPane";
import type { TerminalReplayKind, TerminalReplayOutput, TerminalReplayResult } from "../terminal/terminalReplay";
import { routeSyncTerminalInput, useSyncInputStore, type TerminalInputSource } from "../terminal/syncInputStore";
import { scheduleAfterPaintDelay } from "../../lib/renderScheduling";
import { DragOverlay, type DragOverlayHandle } from "../../components/drag/DragOverlay";
import { useFlipLayout } from "../../components/drag/useFlipLayout";
import {
  canSplitPane,
  getActiveTerminalTab,
  getLeafTerminalTabs,
  getPaneDisplayLabels,
  isVisibleTerminalTab,
} from "./workspaceLayout";
import type { PaneNode, PaneSplitDirection } from "./types";

const ACTIVE_XTERM_MOUNT_DELAY_MS = 48;
const INACTIVE_XTERM_MOUNT_DELAY_MS = 96;
const PANE_TAB_DRAG_THRESHOLD = 6;
type TerminalRuntimeKind = "local" | "ssh" | "ssh_container" | "rdp_placeholder";

function isInteractiveTerminalRuntime(kind: TerminalRuntimeKind) {
  return kind === "local" || kind === "ssh" || kind === "ssh_container";
}

function isSshLikeTerminalRuntime(kind: TerminalRuntimeKind) {
  return kind === "ssh" || kind === "ssh_container";
}

interface SplitPaneViewProps {
  root: PaneNode;
  activePaneId: string;
  onActivatePane: (paneId: string) => void;
  onAddPaneTab: (paneId: string) => void;
  onDuplicatePaneTab?: (paneId: string, paneTabId: string) => void;
  onSelectPaneTab: (paneId: string, paneTabId: string) => void;
  onClosePaneTab: (paneId: string, paneTabId: string) => void;
  onMovePaneTab?: (sourcePaneId: string, paneTabId: string, targetPaneId: string, beforePaneTabId: string | null) => void;
  onSplitPane: (direction: PaneSplitDirection) => void;
  onResizeSplit?: (splitId: string, ratio: number) => void;
  onClosePane: (paneId: string) => void;
  onDisconnectTerminal?: (paneId: string, paneTabId: string, runtimeSessionId: string) => void;
  onReconnectTerminal?: (paneId: string, paneTabId: string, savedSessionId: string, runtimeSessionId: string | null) => void;
  workspaceActive?: boolean;
  visualMode?: "normal" | "placeholder" | "snapshot";
  dragState?: PaneTabDragState | null;
  dragStateRef?: MutableRefObject<PaneTabDragState | null>;
  onDragStateChange?: (dragState: PaneTabDragState | null) => void;
  paneLabels?: Record<string, string>;
  splitAvailability?: PaneSplitAvailability;
}

interface PaneTabDragState {
  sourcePaneId: string;
  paneTabId: string;
  label: string;
  targetPaneId: string | null;
  beforePaneTabId: string | null;
  overlayX: number;
  overlayY: number;
  width: number;
  height: number;
}

interface PaneTabPointerDragState extends PaneTabDragState {
  startX: number;
  startY: number;
  pointerOffsetX: number;
  pointerOffsetY: number;
  sourceX: number;
  sourceY: number;
  active: boolean;
}

type PaneSplitAvailability = Record<string, Record<PaneSplitDirection, boolean>>;

export function SplitPaneView({
  root,
  activePaneId,
  onActivatePane,
  onAddPaneTab,
  onDuplicatePaneTab = () => undefined,
  onSelectPaneTab,
  onClosePaneTab,
  onMovePaneTab = () => undefined,
  onSplitPane,
  onResizeSplit,
  onClosePane,
  onDisconnectTerminal,
  onReconnectTerminal,
  workspaceActive = true,
  visualMode = "normal",
  dragState: inheritedDragState,
  dragStateRef: inheritedDragStateRef,
  onDragStateChange: inheritedDragStateChange,
  paneLabels: inheritedPaneLabels,
  splitAvailability: inheritedSplitAvailability,
}: SplitPaneViewProps) {
  const [localDragState, setLocalDragState] = useState<PaneTabDragState | null>(null);
  const localDragStateRef = useRef<PaneTabDragState | null>(null);
  const dragState = inheritedDragStateRef ? (inheritedDragState ?? null) : localDragState;
  const dragStateRef = inheritedDragStateRef ?? localDragStateRef;
  const onDragStateChange = inheritedDragStateChange ?? ((nextDragState: PaneTabDragState | null) => {
    localDragStateRef.current = nextDragState;
    setLocalDragState(nextDragState);
  });
  const paneLabels = inheritedPaneLabels ?? getPaneDisplayLabels(root);
  const splitAvailability = inheritedSplitAvailability ?? Object.fromEntries(
    Object.keys(paneLabels).map((paneId) => [
      paneId,
      {
        horizontal: canSplitPane(root, paneId, "horizontal"),
        vertical: canSplitPane(root, paneId, "vertical"),
      },
    ]),
  ) as PaneSplitAvailability;
  const handleSplitDividerPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, split: Extract<PaneNode, { kind: "split" }>) => {
      if (!onResizeSplit) return;

      event.preventDefault();
      event.stopPropagation();

      const container = event.currentTarget.parentElement;
      if (!container) return;

      event.currentTarget.setPointerCapture?.(event.pointerId);
      let resizeFrame: number | null = null;
      let pendingPosition: { clientX: number; clientY: number } | null = null;

      const updateRatio = (clientX: number, clientY: number) => {
        const rect = container.getBoundingClientRect();
        const length = split.direction === "horizontal" ? rect.width : rect.height;
        if (length <= 0) return;

        const offset = split.direction === "horizontal" ? clientX - rect.left : clientY - rect.top;
        onResizeSplit(split.id, offset / length);
      };

      const flushPendingResize = () => {
        resizeFrame = null;
        const position = pendingPosition;
        pendingPosition = null;
        if (position) {
          updateRatio(position.clientX, position.clientY);
        }
      };

      const scheduleResize = (clientX: number, clientY: number) => {
        pendingPosition = { clientX, clientY };
        if (resizeFrame !== null) return;
        if (typeof window.requestAnimationFrame === "function") {
          resizeFrame = window.requestAnimationFrame(flushPendingResize);
        } else {
          flushPendingResize();
        }
      };

      const handlePointerMove = (moveEvent: PointerEvent) => {
        moveEvent.preventDefault();
        scheduleResize(moveEvent.clientX, moveEvent.clientY);
      };

      const handlePointerUp = () => {
        if (resizeFrame !== null && typeof window.cancelAnimationFrame === "function") {
          window.cancelAnimationFrame(resizeFrame);
          resizeFrame = null;
        }
        flushPendingResize();
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
          onDuplicatePaneTab={onDuplicatePaneTab}
          onSelectPaneTab={onSelectPaneTab}
          onClosePaneTab={onClosePaneTab}
          onMovePaneTab={onMovePaneTab}
          onSplitPane={onSplitPane}
          onResizeSplit={onResizeSplit}
          onClosePane={onClosePane}
          onDisconnectTerminal={onDisconnectTerminal}
          onReconnectTerminal={onReconnectTerminal}
          workspaceActive={workspaceActive}
          visualMode={visualMode}
          dragState={dragState}
          dragStateRef={dragStateRef}
          onDragStateChange={onDragStateChange}
          paneLabels={paneLabels}
          splitAvailability={splitAvailability}
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
          onDuplicatePaneTab={onDuplicatePaneTab}
          onSelectPaneTab={onSelectPaneTab}
          onClosePaneTab={onClosePaneTab}
          onMovePaneTab={onMovePaneTab}
          onSplitPane={onSplitPane}
          onResizeSplit={onResizeSplit}
          onClosePane={onClosePane}
          onDisconnectTerminal={onDisconnectTerminal}
          onReconnectTerminal={onReconnectTerminal}
          workspaceActive={workspaceActive}
          visualMode={visualMode}
          dragState={dragState}
          dragStateRef={dragStateRef}
          onDragStateChange={onDragStateChange}
          paneLabels={paneLabels}
          splitAvailability={splitAvailability}
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
      onDuplicatePaneTab={onDuplicatePaneTab}
      onSelectPaneTab={onSelectPaneTab}
      onClosePaneTab={onClosePaneTab}
      onMovePaneTab={onMovePaneTab}
      onSplitPane={onSplitPane}
      onClosePane={onClosePane}
      onDisconnectTerminal={onDisconnectTerminal}
      onReconnectTerminal={onReconnectTerminal}
      workspaceActive={workspaceActive}
      visualMode={visualMode}
      dragState={dragState}
      dragStateRef={dragStateRef}
      onDragStateChange={onDragStateChange}
      paneLabel={paneLabels[root.id] ?? "A"}
      splitAvailability={splitAvailability[root.id] ?? { horizontal: false, vertical: false }}
    />
  );
}

function LeafPane({
  root,
  active,
  onActivatePane,
  onAddPaneTab,
  onDuplicatePaneTab,
  onSelectPaneTab,
  onClosePaneTab,
  onMovePaneTab,
  onSplitPane,
  onClosePane,
  onDisconnectTerminal,
  onReconnectTerminal,
  workspaceActive,
  visualMode,
  dragState,
  dragStateRef,
  onDragStateChange,
  paneLabel,
  splitAvailability,
}: {
  root: Extract<PaneNode, { kind: "leaf" }>;
  active: boolean;
  onActivatePane: (paneId: string) => void;
  onAddPaneTab: (paneId: string) => void;
  onDuplicatePaneTab: (paneId: string, paneTabId: string) => void;
  onSelectPaneTab: (paneId: string, paneTabId: string) => void;
  onClosePaneTab: (paneId: string, paneTabId: string) => void;
  onMovePaneTab: (sourcePaneId: string, paneTabId: string, targetPaneId: string, beforePaneTabId: string | null) => void;
  onSplitPane: (direction: PaneSplitDirection) => void;
  onClosePane: (paneId: string) => void;
  onDisconnectTerminal?: (paneId: string, paneTabId: string, runtimeSessionId: string) => void;
  onReconnectTerminal?: (paneId: string, paneTabId: string, savedSessionId: string, runtimeSessionId: string | null) => void;
  workspaceActive: boolean;
  visualMode: "normal" | "placeholder" | "snapshot";
  dragState: PaneTabDragState | null;
  dragStateRef: MutableRefObject<PaneTabDragState | null>;
  onDragStateChange: (dragState: PaneTabDragState | null) => void;
  paneLabel: string;
  splitAvailability: Record<PaneSplitDirection, boolean>;
}) {
  const terminalTabs = getLeafTerminalTabs(root);
  const activeTerminalTab = getActiveTerminalTab(root);
  const activeRuntimeSessionId = activeTerminalTab.runtime_session_id ?? null;
  const [xtermRuntimeSessionId, setXtermRuntimeSessionId] = useState<string | null>(null);
  const [xtermReplay, setXtermReplay] = useState<{
    data: string;
    key: number;
    kind: TerminalReplayKind;
    runtimeSessionId: string | null;
  }>({
    data: "",
    key: 0,
    kind: "raw",
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
      isInteractiveTerminalRuntime(runtime.kind),
  );
  const xtermLive = Boolean(workspaceActive && xtermMounted);
  const beginLiveOutput = useTerminalStore((state) => state.beginLiveOutput);
  const outputChunk = useTerminalStore((state) =>
    xtermLive && activeRuntimeSessionId ? (state.outputChunks[activeRuntimeSessionId] ?? null) : null,
  );
  const visualOutputTail =
    workspaceActive && !xtermMounted && activeRuntimeSessionId
      ? useTerminalStore.getState().getVisualOutputTail(activeRuntimeSessionId)
      : "";
  const snapshotText = activeTerminalTab.visual_snapshot?.text ?? visualOutputTail;
  const hasSnapshotText = snapshotText.length > 0;
  const writeTerminal = useTerminalStore((state) => state.writeTerminal);
  const suggestCompletion = useTerminalStore((state) => state.suggestCompletion);
  const resizeTerminal = useTerminalStore((state) => state.resizeTerminal);
  const closeTerminal = useTerminalStore((state) => state.closeTerminal);
  const syncChannel = useSyncInputStore((state) => state.channel);
  const leaveSyncChannel = useSyncInputStore((state) => state.leaveChannel);
  const closeSyncChannel = useSyncInputStore((state) => state.closeChannel);
  const activeSyncChannelMember = Boolean(
    syncChannel?.members.some((member) => member.id === activeTerminalTab.id),
  );

  const activatePane = useCallback(() => onActivatePane(root.id), [onActivatePane, root.id]);
  const visibleTerminalTabs = terminalTabs.filter(isVisibleTerminalTab);
  const terminalTabIdentifiers = new Map(
    visibleTerminalTabs.map((terminalTab, index) => [terminalTab.id, `${paneLabel}${index + 1}`]),
  );
  const activePaneIdentifier = terminalTabIdentifiers.get(activeTerminalTab.id) ?? paneLabel;
  const paneIdentifier = active ? activePaneIdentifier : paneLabel;

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
        const applyReplay = (replay: TerminalReplayOutput) => {
          if (scheduledRuntimeSessionIdRef.current !== activeRuntimeSessionId) return;
          setXtermReplay((current) => ({
            data: replay.data,
            key: current.runtimeSessionId === activeRuntimeSessionId ? current.key + 1 : 1,
            kind: replay.kind,
            runtimeSessionId: activeRuntimeSessionId,
          }));
          setXtermRuntimeSessionId(activeRuntimeSessionId);
        };
        applyTerminalReplay(useTerminalStore.getState().getReplayOutput(activeRuntimeSessionId), applyReplay);
      }
    }, delayMs);
  }, [active, activeRuntimeSessionId, allowXterm, xtermRuntimeSessionId]);

  useEffect(() => {
    if (!xtermLive || !activeRuntimeSessionId) return;
    if (xtermReplay.runtimeSessionId === activeRuntimeSessionId) return;
    let cancelled = false;
    const applyReplay = (replay: TerminalReplayOutput) => {
      if (cancelled) return;
      setXtermReplay((current) => ({
        data: replay.data,
        key: current.runtimeSessionId === activeRuntimeSessionId ? current.key + 1 : 1,
        kind: replay.kind,
        runtimeSessionId: activeRuntimeSessionId,
      }));
    };
    applyTerminalReplay(useTerminalStore.getState().getReplayOutput(activeRuntimeSessionId), applyReplay);
    return () => {
      cancelled = true;
    };
  }, [activeRuntimeSessionId, xtermLive, xtermReplay.runtimeSessionId]);

  useEffect(() => {
    if (!xtermLive || !activeRuntimeSessionId) return undefined;
    return beginLiveOutput(activeRuntimeSessionId);
  }, [activeRuntimeSessionId, beginLiveOutput, xtermLive]);

  const handleInput = useCallback(
    (data: string, metadata?: { source: TerminalInputSource }) => {
      if (runtime && isInteractiveTerminalRuntime(runtime.kind)) {
        void routeSyncTerminalInput(
          runtime.runtime_session_id,
          data,
          metadata?.source ?? "user",
          writeTerminal,
        );
      }
    },
    [runtime, writeTerminal],
  );

  const handleResize = useCallback(
    (cols: number, rows: number) => {
      if (runtime && isInteractiveTerminalRuntime(runtime.kind)) {
        void resizeTerminal(runtime.runtime_session_id, cols, rows);
      }
    },
    [runtime, resizeTerminal],
  );

  const handleCompletionRequest = useCallback(
    (input: string, cursor: number) => {
      if (runtime && isInteractiveTerminalRuntime(runtime.kind)) {
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
        .finally(() => onClosePane(root.id));
      return;
    }
    onClosePane(root.id);
  }, [activeTerminalTab.runtime_session_id, closeTerminal, onClosePane, root.id]);

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

  const clearPaneTabDrag = useCallback(() => onDragStateChange(null), [onDragStateChange]);
  const pointerDragRef = useRef<PaneTabPointerDragState | null>(null);
  const pointerDragCleanupRef = useRef<(() => void) | null>(null);
  const dragOverlayRef = useRef<DragOverlayHandle>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  useFlipLayout(tabListRef, `${dragState?.targetPaneId ?? ""}/${dragState?.beforePaneTabId ?? ""}/${dragState?.paneTabId ?? ""}`);

  useEffect(() => () => pointerDragCleanupRef.current?.(), []);

  const handlePaneTabPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>, paneTabId: string) => {
      if (event.button !== 0 || (event.target as Element).closest(".zt-pane-tab-close")) return;

      const paneTab = terminalTabs.find((item) => item.id === paneTabId);
      if (!paneTab) return;
      const sourceRect = event.currentTarget.getBoundingClientRect();
      const pointerDrag: PaneTabPointerDragState = {
        sourcePaneId: root.id,
        paneTabId,
        label: paneTab.title,
        targetPaneId: root.id,
        beforePaneTabId: paneTabId,
        overlayX: sourceRect.left,
        overlayY: sourceRect.top,
        width: sourceRect.width,
        height: sourceRect.height,
        startX: event.clientX,
        startY: event.clientY,
        pointerOffsetX: event.clientX - sourceRect.left,
        pointerOffsetY: event.clientY - sourceRect.top,
        sourceX: sourceRect.left,
        sourceY: sourceRect.top,
        active: false,
      };
      pointerDragRef.current = pointerDrag;

      const cleanup = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerCancel);
        pointerDragCleanupRef.current = null;
      };
      const targetAt = (clientX: number, clientY: number) => {
        const target = document.elementFromPoint(clientX, clientY)?.closest<HTMLElement>("[data-pane-id]");
        const targetPaneId = target?.dataset.paneId ?? null;
        if (!target || !targetPaneId) return { targetPaneId: null, beforePaneTabId: null };
        if (target.classList.contains("zt-pane-tab-placeholder")) {
          return { targetPaneId, beforePaneTabId: target.dataset.beforePaneTabId || null };
        }
        const targetPaneTabId = target.dataset.paneTabId ?? null;
        let beforePaneTabId = targetPaneTabId;
        if (targetPaneTabId) {
          const bounds = target.getBoundingClientRect();
          if (clientX >= bounds.left + bounds.width / 2) {
            let nextTab = target.nextElementSibling as HTMLElement | null;
            while (nextTab && !nextTab.dataset.paneTabId) nextTab = nextTab.nextElementSibling as HTMLElement | null;
            beforePaneTabId = nextTab?.dataset.paneTabId ?? null;
          }
        }
        return { targetPaneId, beforePaneTabId };
      };
      const finish = async (clientX: number, clientY: number) => {
        const completedDrag = pointerDragRef.current;
        pointerDragRef.current = null;
        cleanup();
        if (!completedDrag?.active) return;

        const { targetPaneId, beforePaneTabId } = targetAt(clientX, clientY);
        if (!targetPaneId) {
          await dragOverlayRef.current?.animateTo({
            left: completedDrag.sourceX,
            top: completedDrag.sourceY,
            width: completedDrag.width,
            height: completedDrag.height,
          });
          clearPaneTabDrag();
          return;
        }
        const placeholder = Array.from(document.querySelectorAll<HTMLElement>(".zt-pane-tab-placeholder[data-pane-id]"))
          .find((item) => item.dataset.paneId === targetPaneId);
        if (placeholder) await dragOverlayRef.current?.animateTo(placeholder.getBoundingClientRect());
        onMovePaneTab(completedDrag.sourcePaneId, completedDrag.paneTabId, targetPaneId, beforePaneTabId);
        clearPaneTabDrag();
      };
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const currentDrag = pointerDragRef.current;
        if (!currentDrag) return;
        if (!currentDrag.active) {
          const distance = Math.hypot(moveEvent.clientX - currentDrag.startX, moveEvent.clientY - currentDrag.startY);
          if (distance < PANE_TAB_DRAG_THRESHOLD) return;
          currentDrag.active = true;
        }
        const target = targetAt(moveEvent.clientX, moveEvent.clientY);
        currentDrag.targetPaneId = target.targetPaneId;
        currentDrag.beforePaneTabId = target.beforePaneTabId;
        currentDrag.overlayX = moveEvent.clientX - currentDrag.pointerOffsetX;
        currentDrag.overlayY = moveEvent.clientY - currentDrag.pointerOffsetY;
        dragOverlayRef.current?.moveTo(
          currentDrag.overlayX,
          currentDrag.overlayY,
        );
        const visibleDrag = dragStateRef.current;
        if (
          !visibleDrag ||
          visibleDrag.targetPaneId !== target.targetPaneId ||
          visibleDrag.beforePaneTabId !== target.beforePaneTabId
        ) {
          onDragStateChange({ ...currentDrag });
        }
        moveEvent.preventDefault();
      };
      const handlePointerUp = (upEvent: PointerEvent) => void finish(upEvent.clientX, upEvent.clientY);
      const handlePointerCancel = () => {
        pointerDragRef.current = null;
        cleanup();
        clearPaneTabDrag();
      };

      pointerDragCleanupRef.current?.();
      pointerDragCleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp, { once: true });
      window.addEventListener("pointercancel", handlePointerCancel, { once: true });
    },
    [clearPaneTabDrag, dragStateRef, onDragStateChange, onMovePaneTab, root.id, terminalTabs],
  );

  return (
    <section
      className={`zt-terminal-frame ${active ? "active" : ""}`}
      aria-label={`终端区域 ${activeTerminalTab.title}`}
      onClick={activatePane}
    >
      <div className="zt-pane-tabs">
        <div
          ref={tabListRef}
          className={`zt-pane-tablist ${dragState?.targetPaneId === root.id ? "drag-over" : ""}`}
          role="tablist"
          aria-label={`${activeTerminalTab.title} 标签`}
          data-pane-id={root.id}
        >
          {visibleTerminalTabs.flatMap((terminalTab) => {
            const items = [];
            if (dragState?.targetPaneId === root.id && dragState.beforePaneTabId === terminalTab.id) {
              items.push(
                <div
                  key="drag-placeholder"
                  className="zt-pane-tab-placeholder"
                  data-pane-id={root.id}
                  data-before-pane-tab-id={dragState.beforePaneTabId ?? ""}
                  style={{ width: dragState.width, height: dragState.height }}
                />,
              );
            }
            if (dragState?.sourcePaneId === root.id && dragState.paneTabId === terminalTab.id) return items;
            const isActivePaneTerminalTab = active && terminalTab.id === activeTerminalTab.id;
            const connecting = terminalTab.restore_status === "pending";
            const queued = terminalTab.restore_status === "queued";
            const failed = terminalTab.restore_status === "failed";

            items.push(
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
                data-pane-id={root.id}
                data-pane-tab-id={terminalTab.id}
                data-flip-id={terminalTab.id}
                onPointerDown={(event) => handlePaneTabPointerDown(event, terminalTab.id)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onActivatePane(root.id);
                  onDuplicatePaneTab(root.id, terminalTab.id);
                }}
                onAuxClick={(event) => {
                  if (event.button !== 1) return;
                  event.preventDefault();
                  event.stopPropagation();
                  handleClosePaneTab(terminalTab.id, terminalTab.runtime_session_id);
                }}
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
                    <LoaderCircle size={14} aria-hidden="true" />
                  </span>
                ) : null}
                {queued ? (
                  <span
                    className="zt-pane-tab-status zt-pane-tab-queued"
                    aria-label={`等待连接 ${terminalTab.title}`}
                    title="等待连接"
                  >
                    <Clock3 size={14} aria-hidden="true" />
                  </span>
                ) : null}
                {failed ? (
                  <span
                    className="zt-pane-tab-status zt-pane-tab-failed"
                    aria-label={`连接失败 ${terminalTab.title}`}
                    title={terminalTab.restore_error ?? "连接失败"}
                  >
                    <CircleAlert size={14} aria-hidden="true" />
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
            return items;
          })}
          {dragState?.targetPaneId === root.id && dragState.beforePaneTabId === null ? (
            <div
              className="zt-pane-tab-placeholder"
              data-pane-id={root.id}
              data-before-pane-tab-id=""
              style={{ width: dragState.width, height: dragState.height }}
            />
          ) : null}
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
        {active ? <span className="zt-pane-active-indicator" aria-hidden="true" /> : null}
        <span
          className={`zt-pane-identifier ${active ? "active" : ""}`}
          aria-label={`分栏标签 ${paneIdentifier}`}
          data-pane-identifier={paneIdentifier}
        >
          {paneIdentifier}
        </span>
        <TerminalToolbar
          onSplitPane={handleSplitPane}
          onClosePane={handleClosePane}
          canSplitHorizontal={splitAvailability.horizontal}
          canSplitVertical={splitAvailability.vertical}
          syncChannelMember={activeSyncChannelMember}
          onLeaveSyncChannel={() => leaveSyncChannel(activeTerminalTab.id)}
          onCloseSyncChannel={closeSyncChannel}
        />
      </div>
      {dragState?.sourcePaneId === root.id ? (
        <DragOverlay
          ref={dragOverlayRef}
          label={dragState.label}
          x={dragState.overlayX}
          y={dragState.overlayY}
          width={dragState.width}
          height={dragState.height}
          variant="tab"
        />
      ) : null}
      {xtermMounted && visualMode === "normal" && workspaceActive && runtime && isInteractiveTerminalRuntime(runtime.kind) ? (
        <XtermPane
          autoFocus={active}
          contextMenuEnabled={workspaceActive && isInteractiveTerminalRuntime(runtime.kind)}
          data={xtermReplay.data}
          liveData={outputChunk?.data ?? null}
          liveSerial={outputChunk?.serial ?? null}
          replayKey={xtermReplay.key}
          replayKind={xtermReplay.kind}
          streamId={runtime.runtime_session_id}
          onCompletionRequest={handleCompletionRequest}
          onDisconnect={
            isSshLikeTerminalRuntime(runtime.kind) && activeTerminalTab.runtime_session_id
              ? () => onDisconnectTerminal?.(root.id, activeTerminalTab.id, activeTerminalTab.runtime_session_id!)
              : undefined
          }
          onInput={handleInput}
          onReconnect={
            isSshLikeTerminalRuntime(runtime.kind) && activeTerminalTab.runtime_session_id && activeTerminalTab.saved_session_id
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
          title={activeTerminalTab.title}
          onDisconnect={
            runtime?.kind === "rdp_placeholder" && activeTerminalTab.runtime_session_id
              ? () => onDisconnectTerminal?.(root.id, activeTerminalTab.id, activeTerminalTab.runtime_session_id!)
              : undefined
          }
          onReconnect={
            activeTerminalTab.saved_session_id &&
            (runtime?.kind === "rdp_placeholder" ||
              (!activeTerminalTab.runtime_session_id && activeTerminalTab.restore_status === "failed"))
              ? () =>
                  onReconnectTerminal?.(
                    root.id,
                    activeTerminalTab.id,
                    activeTerminalTab.saved_session_id!,
                    activeTerminalTab.runtime_session_id ?? null,
                  )
              : undefined
          }
          message={
            runtime?.kind === "rdp_placeholder"
              ? activeTerminalTab.title
              : runtime && isInteractiveTerminalRuntime(runtime.kind)
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

function applyTerminalReplay(replay: TerminalReplayResult, apply: (output: TerminalReplayOutput) => void) {
  if (replay instanceof Promise) {
    void replay.then(apply);
  } else {
    apply(replay);
  }
}
