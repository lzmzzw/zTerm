// Author: Liz
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { useTerminalStore } from "../features/terminal/terminalStore";
import { materializePaneVisualSnapshots } from "../features/workspace/workspaceShellModel";
import {
  markWorkspaceSwitchMetric as markWorkspaceSwitchMetricState,
  performanceNow,
  startWorkspaceSwitchMetrics as startWorkspaceSwitchMetricState,
  type WorkspaceSwitchMetricState,
} from "../features/workspace/workspaceSwitchMetrics";
import type { PaneNode, WorkspaceDefinition, WorkspaceRuntime } from "../features/workspace/types";
import { scheduleAfterPaintDelay } from "../lib/renderScheduling";

const WORKSPACE_LAYOUT_METRIC_DELAY_MS = 0;
const WORKSPACE_SWITCH_SNAPSHOT_DWELL_MS = 320;

type WorkspaceSwitchMetricMark = Parameters<typeof markWorkspaceSwitchMetricState>[2];

interface WorkspaceSwitchOverlayState {
  id: number;
  targetWorkspaceId: string;
  root: PaneNode;
  activePaneId: string;
  phase: "snapshot" | "committed";
}

interface BeginWorkspaceVisualSwitchOptions {
  commit: () => void;
  onLive?: () => void;
  onCancel?: () => void;
  completeMetricsOnCommit?: boolean;
}

export function useWorkspaceVisualSwitch() {
  const workspaceSwitchOverlayIdRef = useRef(0);
  const workspaceSwitchCancelRef = useRef<(() => void) | null>(null);
  const workspaceSwitchTimersRef = useRef<Array<() => void>>([]);
  const workspaceSwitchMetricsRef = useRef<Record<string, WorkspaceSwitchMetricState>>({});
  const [workspaceSwitchOverlay, setWorkspaceSwitchOverlay] = useState<WorkspaceSwitchOverlayState | null>(null);

  function markWorkspaceSwitchMetric(workspaceId: string, mark: WorkspaceSwitchMetricMark) {
    markWorkspaceSwitchMetricState(workspaceSwitchMetricsRef.current, workspaceId, mark);
  }

  function startWorkspaceSwitchMetrics(workspaceId: string) {
    startWorkspaceSwitchMetricState(workspaceSwitchMetricsRef.current, workspaceId);
  }

  function isWorkspaceSwitchEpochCurrent(epoch: number) {
    return workspaceSwitchOverlayIdRef.current === epoch;
  }

  function cancelPendingWorkspaceVisualSwitch() {
    workspaceSwitchCancelRef.current?.();
    workspaceSwitchCancelRef.current = null;
    for (const cancel of workspaceSwitchTimersRef.current) {
      cancel();
    }
    workspaceSwitchTimersRef.current = [];
  }

  function beginWorkspaceVisualSwitch(
    workspace: WorkspaceRuntime | WorkspaceDefinition,
    options: BeginWorkspaceVisualSwitchOptions,
  ): number | null {
    const tab = workspace.tabs.find((candidate) => candidate.id === workspace.active_tab_id) ?? workspace.tabs[0];
    if (!tab) return null;
    cancelPendingWorkspaceVisualSwitch();
    const epoch = workspaceSwitchOverlayIdRef.current + 1;
    const capturedAt = performanceNow();
    const visualOutputTail = useTerminalStore.getState().visualOutputTail;
    const overlay: WorkspaceSwitchOverlayState = {
      id: epoch,
      targetWorkspaceId: workspace.id,
      root: materializePaneVisualSnapshots(tab.root, visualOutputTail, capturedAt),
      activePaneId: tab.active_pane_id,
      phase: "snapshot",
    };
    workspaceSwitchOverlayIdRef.current = epoch;
    workspaceSwitchCancelRef.current = () => {
      markWorkspaceSwitchMetric(workspace.id, "switch_epoch_cancelled");
      markWorkspaceSwitchMetric(workspace.id, "all_scheduled_done");
      options.onCancel?.();
    };
    flushSync(() => {
      setWorkspaceSwitchOverlay(overlay);
    });
    const cancelCommit = scheduleAfterPaintDelay(() => {
      if (!isWorkspaceSwitchEpochCurrent(epoch)) return;
      markWorkspaceSwitchMetric(workspace.id, "snapshot_visible");
      markWorkspaceSwitchMetric(workspace.id, "layout_visible");
      flushSync(() => {
        options.commit();
        setWorkspaceSwitchOverlay((current) => (current?.id === epoch ? { ...current, phase: "committed" } : current));
      });
      markWorkspaceSwitchMetric(workspace.id, "store_committed");
      if (options.completeMetricsOnCommit) {
        markWorkspaceSwitchMetric(workspace.id, "first_visible_connected");
        markWorkspaceSwitchMetric(workspace.id, "all_visible_connected");
      }
    }, WORKSPACE_LAYOUT_METRIC_DELAY_MS);
    const cancelLive = scheduleAfterPaintDelay(() => {
      if (!isWorkspaceSwitchEpochCurrent(epoch)) return;
      workspaceSwitchCancelRef.current = null;
      workspaceSwitchTimersRef.current = [];
      markWorkspaceSwitchMetric(workspace.id, "active_xterm_live");
      if (options.completeMetricsOnCommit) {
        markWorkspaceSwitchMetric(workspace.id, "all_scheduled_done");
      }
      setWorkspaceSwitchOverlay((current) => (current?.id === epoch ? null : current));
      options.onLive?.();
    }, WORKSPACE_SWITCH_SNAPSHOT_DWELL_MS);
    workspaceSwitchTimersRef.current = [cancelCommit, cancelLive];
    return epoch;
  }

  useEffect(() => () => cancelPendingWorkspaceVisualSwitch(), []);

  return {
    workspaceSwitchOverlay,
    workspaceVisualSwitchActive: workspaceSwitchOverlay !== null,
    beginWorkspaceVisualSwitch,
    isWorkspaceSwitchEpochCurrent,
    markWorkspaceSwitchMetric,
    startWorkspaceSwitchMetrics,
  };
}
