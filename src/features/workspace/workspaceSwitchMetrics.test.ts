// Author: Liz
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  markWorkspaceSwitchMetric,
  startWorkspaceSwitchMetrics,
  type WorkspaceSwitchMetricState,
} from "./workspaceSwitchMetrics";

type TestWorkspaceSwitchMetricMap = Record<string, WorkspaceSwitchMetricState>;

describe("workspaceSwitchMetrics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a metric state in the supplied map", () => {
    let now = 10;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const metrics: TestWorkspaceSwitchMetricMap = {};

    const state = startWorkspaceSwitchMetrics(metrics, "workspace-1");

    expect(state).toEqual({ startedAt: 10, marks: {} });
    expect(metrics["workspace-1"]).toBe(state);

    now = 20;
    const nextState = startWorkspaceSwitchMetrics(metrics, "workspace-1");

    expect(nextState.startedAt).toBe(20);
    expect(metrics["workspace-1"]).toBe(nextState);
  });

  it("records a mark only once", () => {
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const metrics: TestWorkspaceSwitchMetricMap = {};
    startWorkspaceSwitchMetrics(metrics, "workspace-1");

    now = 130;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "layout_visible");
    now = 250;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "layout_visible");

    expect(metrics["workspace-1"]?.marks.layout_visible).toBe(130);
  });

  it("logs a summary and removes metrics when all scheduled work is done", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const metrics: TestWorkspaceSwitchMetricMap = {};

    startWorkspaceSwitchMetrics(metrics, "workspace-1");
    now = 130;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "snapshot_visible");
    now = 150;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "store_committed");
    now = 170;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "active_xterm_live");
    now = 180;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "restore_queue_started");
    now = 190;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "first_visible_connected");
    now = 195;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "all_visible_connected");
    now = 200;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "all_scheduled_done");

    expect(infoSpy).toHaveBeenCalledWith("[workspace-switch]", {
      workspaceId: "workspace-1",
      click_to_snapshot_visible: 30,
      click_to_layout_visible: 30,
      snapshot_to_store_committed: 20,
      snapshot_to_active_xterm_live: 40,
      snapshot_to_restore_queue_started: 50,
      layout_to_first_visible_connected: 60,
      layout_to_all_visible_connected: 65,
      layout_to_all_scheduled_done: 70,
      switch_epoch_cancelled: null,
    });
    expect(metrics["workspace-1"]).toBeUndefined();
  });

  it("does not log a summary when the visible layout mark is missing", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const metrics: TestWorkspaceSwitchMetricMap = {};

    startWorkspaceSwitchMetrics(metrics, "workspace-1");
    now = 120;
    markWorkspaceSwitchMetric(metrics, "workspace-1", "all_scheduled_done");

    expect(infoSpy).not.toHaveBeenCalled();
    expect(metrics["workspace-1"]).toBeUndefined();
  });
});
