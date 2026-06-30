// Author: Liz

type WorkspaceSwitchMetricMark =
  | "snapshot_visible"
  | "layout_visible"
  | "store_committed"
  | "active_xterm_live"
  | "restore_queue_started"
  | "switch_epoch_cancelled"
  | "first_visible_connected"
  | "all_visible_connected"
  | "all_scheduled_done";

export interface WorkspaceSwitchMetricState {
  startedAt: number;
  marks: Partial<Record<WorkspaceSwitchMetricMark, number>>;
}

type WorkspaceSwitchMetricMap = Record<string, WorkspaceSwitchMetricState>;

export function startWorkspaceSwitchMetrics(
  metrics: WorkspaceSwitchMetricMap,
  workspaceId: string,
): WorkspaceSwitchMetricState {
  const state = {
    startedAt: performanceNow(),
    marks: {},
  };
  metrics[workspaceId] = state;
  return state;
}

export function markWorkspaceSwitchMetric(
  metrics: WorkspaceSwitchMetricMap,
  workspaceId: string,
  mark: WorkspaceSwitchMetricMark,
) {
  const state = metrics[workspaceId];
  if (!state || state.marks[mark] !== undefined) return;
  state.marks[mark] = performanceNow();
  if (mark === "all_scheduled_done") {
    logWorkspaceSwitchMetrics(workspaceId, state);
    delete metrics[workspaceId];
  }
}

export function performanceNow() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

function logWorkspaceSwitchMetrics(workspaceId: string, state: WorkspaceSwitchMetricState) {
  if (!import.meta.env.DEV) return;
  const snapshotVisibleAt = state.marks.snapshot_visible ?? state.marks.layout_visible;
  if (snapshotVisibleAt === undefined) return;
  const summary = {
    workspaceId,
    click_to_snapshot_visible: Math.round(snapshotVisibleAt - state.startedAt),
    click_to_layout_visible: Math.round(snapshotVisibleAt - state.startedAt),
    snapshot_to_store_committed:
      state.marks.store_committed === undefined ? null : Math.round(state.marks.store_committed - snapshotVisibleAt),
    snapshot_to_active_xterm_live:
      state.marks.active_xterm_live === undefined ? null : Math.round(state.marks.active_xterm_live - snapshotVisibleAt),
    snapshot_to_restore_queue_started:
      state.marks.restore_queue_started === undefined
        ? null
        : Math.round(state.marks.restore_queue_started - snapshotVisibleAt),
    layout_to_first_visible_connected:
      state.marks.first_visible_connected === undefined
        ? null
        : Math.round(state.marks.first_visible_connected - snapshotVisibleAt),
    layout_to_all_visible_connected:
      state.marks.all_visible_connected === undefined
        ? null
        : Math.round(state.marks.all_visible_connected - snapshotVisibleAt),
    layout_to_all_scheduled_done:
      state.marks.all_scheduled_done === undefined
        ? null
        : Math.round(state.marks.all_scheduled_done - snapshotVisibleAt),
    switch_epoch_cancelled:
      state.marks.switch_epoch_cancelled === undefined
        ? null
        : Math.round(state.marks.switch_epoch_cancelled - state.startedAt),
  };
  console.info("[workspace-switch]", summary);
}
