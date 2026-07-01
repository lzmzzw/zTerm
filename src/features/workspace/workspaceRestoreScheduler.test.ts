// Author: Liz
import { describe, expect, it, vi } from "vitest";

import {
  collectWorkspaceRestoreTargets,
  runWorkspaceRestoreQueue,
  sortWorkspaceRestoreTargets,
} from "./workspaceRestoreScheduler";
import type { WorkspaceDefinition } from "./types";
import type { SavedSession } from "../sessions/types";
import type { RuntimeSessionInfo } from "../terminal/terminalStore";

function runtime(
  id: string,
  paneId: string,
  kind: "ssh" | "ssh_container" | "local",
  savedSessionId: string | null,
): RuntimeSessionInfo {
  return {
    runtime_session_id: id,
    saved_session_id: savedSessionId,
    history_scope_kind: savedSessionId ? "saved_session" : "local_profile",
    history_scope_id: savedSessionId ?? "pwsh",
    pane_id: paneId,
    title: id,
    kind,
    cols: 120,
    rows: 32,
  };
}

const sessions: SavedSession[] = [session("ssh-a", "SSH A", 0), session("ssh-b", "SSH B", 1)];

function session(id: string, name: string, sortOrder: number): SavedSession {
  return {
    id,
    name,
    host: sortOrder === 0 ? "10.0.0.1" : "10.0.0.2",
    port: 22,
    username: "ops",
    type: "ssh",
    auth_mode: "none",
    credential_ref: null,
    description: null,
    group_id: null,
    tags: [],
    sort_order: sortOrder,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
  };
}

function workspace(): WorkspaceDefinition {
  return {
    id: "workspace-1",
    name: "运维巡检",
    status: "running",
    active_tab_id: "tab-active",
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    tabs: [
      {
        id: "tab-active",
        title: "主工作台",
        active_pane_id: "pane-a",
        sort_order: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
        root: {
          kind: "split",
          id: "split-root",
          direction: "horizontal",
          ratio: 0.5,
          first: {
            kind: "leaf",
            id: "pane-a",
            title: "Active",
            runtime_session_id: null,
            saved_session_id: "ssh-a",
            active_terminal_tab_id: "pane-a-tab-2",
            terminal_tabs: [
              {
                id: "pane-a-tab-1",
                title: "Background same pane",
                runtime_session_id: null,
                saved_session_id: "ssh-b",
                connection_source: "saved_session",
              },
              {
                id: "pane-a-tab-2",
                title: "Active SSH",
                runtime_session_id: null,
                saved_session_id: "ssh-a",
                connection_source: "saved_session",
              },
            ],
          },
          second: {
            kind: "leaf",
            id: "pane-b",
            title: "Visible Local",
            runtime_session_id: null,
            saved_session_id: null,
            active_terminal_tab_id: "pane-b-tab-1",
            terminal_tabs: [
              {
                id: "pane-b-tab-1",
                title: "Visible Local",
                runtime_session_id: null,
                saved_session_id: null,
                connection_source: "default_local",
              },
            ],
          },
        },
      },
      {
        id: "tab-background",
        title: "后台标签",
        active_pane_id: "pane-c",
        sort_order: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
        root: {
          kind: "leaf",
          id: "pane-c",
          title: "Background workspace tab",
          runtime_session_id: null,
          saved_session_id: null,
          active_terminal_tab_id: "pane-c-tab-1",
          terminal_tabs: [
            {
              id: "pane-c-tab-1",
              title: "Background workspace tab",
              runtime_session_id: null,
              saved_session_id: null,
              connection_source: "default_local",
            },
          ],
        },
      },
    ],
  };
}

describe("workspaceRestoreScheduler", () => {
  it("prioritizes the active pane tab before visible leaves, same-pane background tabs, and inactive workspace tabs", () => {
    const targets = sortWorkspaceRestoreTargets(collectWorkspaceRestoreTargets(workspace()), workspace());

    expect(targets.map((target) => target.paneTabId)).toEqual([
      "pane-a-tab-2",
      "pane-b-tab-1",
      "pane-a-tab-1",
      "pane-c-tab-1",
    ]);
  });

  it("normalizes duplicate pane ids before collecting restore targets", () => {
    const duplicated = workspace();
    const activeRoot = duplicated.tabs[0].root;
    if (activeRoot.kind !== "split" || activeRoot.second.kind !== "leaf") {
      throw new Error("test workspace shape changed");
    }
    activeRoot.second.id = "pane-a";

    const targets = collectWorkspaceRestoreTargets(duplicated);
    const localTarget = targets.find((target) => target.terminalTab.title === "Visible Local");

    expect(targets.filter((target) => target.paneId === "pane-a")).toHaveLength(2);
    expect(localTarget?.paneId).not.toBe("pane-a");
    expect(localTarget?.paneId).toMatch(/^pane-/);
  });

  it("enforces total, SSH, local, and same-pane concurrency while continuing after failures", async () => {
    const inFlight = { total: 0, ssh: 0, local: 0, paneA: 0 };
    const max = { total: 0, ssh: 0, local: 0, paneA: 0 };
    const updates: Array<{ paneTabId: string; status: string | null | undefined }> = [];
    const pendingResolvers: Array<() => void> = [];

    const openTerminal = vi.fn(async (savedSessionId: string, paneId: string) => {
      inFlight.total += 1;
      inFlight.ssh += 1;
      if (paneId === "pane-a") inFlight.paneA += 1;
      max.total = Math.max(max.total, inFlight.total);
      max.ssh = Math.max(max.ssh, inFlight.ssh);
      max.paneA = Math.max(max.paneA, inFlight.paneA);
      await new Promise<void>((resolve) => pendingResolvers.push(resolve));
      inFlight.total -= 1;
      inFlight.ssh -= 1;
      if (paneId === "pane-a") inFlight.paneA -= 1;
      if (savedSessionId === "ssh-b") {
        throw new Error("ssh-b failed");
      }
      return runtime(`runtime-${savedSessionId}`, paneId, "ssh", savedSessionId);
    });
    const openDefaultLocalTerminal = vi.fn(async (paneId: string) => {
      inFlight.total += 1;
      inFlight.local += 1;
      max.total = Math.max(max.total, inFlight.total);
      max.local = Math.max(max.local, inFlight.local);
      await new Promise<void>((resolve) => pendingResolvers.push(resolve));
      inFlight.total -= 1;
      inFlight.local -= 1;
      return runtime(`runtime-${paneId}`, paneId, "local", null);
    });

    const run = runWorkspaceRestoreQueue({
      workspace: workspace(),
      sessions,
      strategy: "visible_first",
      openTerminal,
      openDefaultLocalTerminal,
      openSshContainerTerminal: vi.fn(),
      writeTerminal: vi.fn().mockResolvedValue(undefined),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      updatePaneTerminalTab: (_workspaceId, _workspaceTabId, _paneId, paneTabId, patch) => {
        updates.push({ paneTabId, status: patch.restore_status });
      },
    });

    await Promise.resolve();
    expect(openTerminal).toHaveBeenCalledTimes(1);
    expect(openDefaultLocalTerminal).toHaveBeenCalledTimes(2);
    for (let step = 0; step < 4; step += 1) {
      pendingResolvers.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
      await Promise.resolve();
    }
    await run;

    expect(max.total).toBeLessThanOrEqual(4);
    expect(max.ssh).toBeLessThanOrEqual(2);
    expect(max.local).toBeLessThanOrEqual(4);
    expect(max.paneA).toBe(1);
    expect(updates).toContainEqual({ paneTabId: "pane-a-tab-1", status: "failed" });
    expect(updates).toContainEqual({ paneTabId: "pane-c-tab-1", status: "connected" });
  });

  it("keeps updates bound to the captured workspace, workspace tab, pane, and pane tab ids", async () => {
    const updates: string[] = [];

    await runWorkspaceRestoreQueue({
      workspace: workspace(),
      sessions,
      strategy: "connect_all",
      openTerminal: vi.fn(async (savedSessionId: string, paneId: string) => runtime(`runtime-${savedSessionId}`, paneId, "ssh", savedSessionId)),
      openDefaultLocalTerminal: vi.fn(async (paneId: string) => runtime(`runtime-${paneId}`, paneId, "local", null)),
      openSshContainerTerminal: vi.fn(),
      writeTerminal: vi.fn().mockResolvedValue(undefined),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      updatePaneTerminalTab: (workspaceId, workspaceTabId, paneId, paneTabId, patch) => {
        updates.push(`${workspaceId}/${workspaceTabId}/${paneId}/${paneTabId}/${patch.restore_status}`);
      },
    });

    expect(updates).toContain("workspace-1/tab-active/pane-a/pane-a-tab-2/pending");
    expect(updates).toContain("workspace-1/tab-active/pane-b/pane-b-tab-1/connected");
    expect(updates).toContain("workspace-1/tab-background/pane-c/pane-c-tab-1/connected");
  });

  it("only writes an explicit startup command after opening a workspace terminal", async () => {
    const workspaceWithStartupCommand = workspace();
    const activeRoot = workspaceWithStartupCommand.tabs[0].root;
    if (activeRoot.kind !== "split" || activeRoot.first.kind !== "leaf") {
      throw new Error("test workspace shape changed");
    }
    const activeTab = (activeRoot.first.terminal_tabs ?? []).find((tab) => tab.id === "pane-a-tab-2");
    if (!activeTab) {
      throw new Error("active tab missing");
    }
    activeTab.path = "/srv/app";
    activeTab.startup_command = "source ./env.sh";

    const writeTerminal = vi.fn().mockResolvedValue(undefined);
    const openTerminal = vi.fn(async (savedSessionId: string, paneId: string, _workingDirectory?: string | null) =>
      runtime(`runtime-${savedSessionId}`, paneId, "ssh", savedSessionId),
    );

    await runWorkspaceRestoreQueue({
      workspace: workspaceWithStartupCommand,
      sessions,
      strategy: "layout_only",
      openTerminal,
      openDefaultLocalTerminal: vi.fn(),
      openSshContainerTerminal: vi.fn(),
      writeTerminal,
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      updatePaneTerminalTab: vi.fn(),
    });

    expect(writeTerminal).not.toHaveBeenCalled();

    await runWorkspaceRestoreQueue({
      workspace: workspaceWithStartupCommand,
      sessions,
      strategy: "visible_first",
      openTerminal,
      openDefaultLocalTerminal: vi.fn(async (paneId: string) => runtime(`runtime-${paneId}`, paneId, "local", null)),
      openSshContainerTerminal: vi.fn(),
      writeTerminal,
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      updatePaneTerminalTab: vi.fn(),
    });

    expect(openTerminal).toHaveBeenCalledWith("ssh-a", "pane-a", "/srv/app");
    expect(writeTerminal).toHaveBeenCalledWith("runtime-ssh-a", "source ./env.sh\r");
    expect(writeTerminal).not.toHaveBeenCalledWith("runtime-ssh-a", "cd -- '/srv/app'\r");
  });

  it("restores ssh_container tabs with the saved container target instead of host SSH", async () => {
    const workspaceWithContainer = workspace();
    const activeRoot = workspaceWithContainer.tabs[0].root;
    if (activeRoot.kind !== "split" || activeRoot.first.kind !== "leaf") {
      throw new Error("test workspace shape changed");
    }
    const activeTab = (activeRoot.first.terminal_tabs ?? []).find((tab) => tab.id === "pane-a-tab-2");
    if (!activeTab) {
      throw new Error("active tab missing");
    }
    activeTab.connection_source = "ssh_container";
    activeTab.container_target = { id: "abc123", name: "api" };

    const openTerminal = vi.fn(async (savedSessionId: string, paneId: string) =>
      runtime(`runtime-${savedSessionId}`, paneId, "ssh", savedSessionId),
    );
    const openSshContainerTerminal = vi.fn(async (savedSessionId: string, paneId: string) =>
      runtime(`runtime-container-${savedSessionId}`, paneId, "ssh_container", savedSessionId),
    );

    await runWorkspaceRestoreQueue({
      workspace: workspaceWithContainer,
      sessions,
      strategy: "visible_first",
      openTerminal,
      openDefaultLocalTerminal: vi.fn(async (paneId: string) => runtime(`runtime-${paneId}`, paneId, "local", null)),
      openSshContainerTerminal,
      writeTerminal: vi.fn().mockResolvedValue(undefined),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      updatePaneTerminalTab: vi.fn(),
    });

    expect(openSshContainerTerminal).toHaveBeenCalledWith("ssh-a", "pane-a", "abc123", "api");
    expect(openTerminal.mock.calls.some(([savedSessionId]) => savedSessionId === "ssh-a")).toBe(false);
  });

  it("keeps fixed fallback text when restoring a tab fails with a non-Error value", async () => {
    const updates: Array<{ paneTabId: string; status: string | null | undefined; error: string | null | undefined }> = [];

    await runWorkspaceRestoreQueue({
      workspace: workspace(),
      sessions,
      strategy: "visible_first",
      openTerminal: vi.fn(async (savedSessionId: string, paneId: string) => {
        if (savedSessionId === "ssh-a") {
          throw "raw restore failure";
        }
        return runtime(`runtime-${savedSessionId}`, paneId, "ssh", savedSessionId);
      }),
      openDefaultLocalTerminal: vi.fn(async (paneId: string) => runtime(`runtime-${paneId}`, paneId, "local", null)),
      openSshContainerTerminal: vi.fn(),
      writeTerminal: vi.fn().mockResolvedValue(undefined),
      closeTerminal: vi.fn().mockResolvedValue(undefined),
      updatePaneTerminalTab: (_workspaceId, _workspaceTabId, _paneId, paneTabId, patch) => {
        updates.push({ paneTabId, status: patch.restore_status, error: patch.restore_error });
      },
    });

    expect(updates).toContainEqual({
      paneTabId: "pane-a-tab-2",
      status: "failed",
      error: "恢复标签失败",
    });
    expect(updates.map((update) => update.error)).not.toContain("raw restore failure");
  });

  it("does not open terminals when the strategy is layout_only", async () => {
    const updatePaneTerminalTab = vi.fn();
    const openTerminal = vi.fn();
    const openDefaultLocalTerminal = vi.fn();

    await runWorkspaceRestoreQueue({
      workspace: workspace(),
      sessions,
      strategy: "layout_only",
      openTerminal,
      openDefaultLocalTerminal,
      openSshContainerTerminal: vi.fn(),
      writeTerminal: vi.fn(),
      closeTerminal: vi.fn(),
      updatePaneTerminalTab,
    });

    expect(openTerminal).not.toHaveBeenCalled();
    expect(openDefaultLocalTerminal).not.toHaveBeenCalled();
    expect(updatePaneTerminalTab).not.toHaveBeenCalled();
  });
});
