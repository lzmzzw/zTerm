// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ServerInfoSnapshot } from "./serverInfoApi";
import { clearServerInfoSnapshotCacheForTest, useServerInfoSnapshot } from "./useServerInfoSnapshot";

const apiMocks = vi.hoisted(() => ({
  getServerInfoSnapshot: vi.fn(),
}));

vi.mock("./serverInfoApi", async () => {
  const actual = await vi.importActual<typeof import("./serverInfoApi")>("./serverInfoApi");
  return {
    ...actual,
    getServerInfoSnapshot: apiMocks.getServerInfoSnapshot,
  };
});

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    rerender(next: ReactElement) {
      act(() => {
        root.render(next);
      });
    },
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function Probe({ active, savedSessionId }: { active: boolean; savedSessionId: string | null }) {
  const state = useServerInfoSnapshot(savedSessionId, active);
  return (
    <div data-error={state.error ?? ""} data-loading={state.loading}>
      {state.snapshot?.host_name ?? "empty"}
    </div>
  );
}

describe("useServerInfoSnapshot", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearServerInfoSnapshotCacheForTest();
    apiMocks.getServerInfoSnapshot.mockReset();
    apiMocks.getServerInfoSnapshot.mockResolvedValue(snapshot("ssh-1"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("collects only while monitor panel is active", async () => {
    const view = render(<Probe active={false} savedSessionId="ssh-1" />);
    expect(apiMocks.getServerInfoSnapshot).not.toHaveBeenCalled();

    view.rerender(<Probe active={true} savedSessionId="ssh-1" />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(apiMocks.getServerInfoSnapshot).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(apiMocks.getServerInfoSnapshot).toHaveBeenCalledTimes(2);

    view.rerender(<Probe active={false} savedSessionId="ssh-1" />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(apiMocks.getServerInfoSnapshot).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it("keeps String(error) text for non-Error snapshot failures", async () => {
    apiMocks.getServerInfoSnapshot.mockRejectedValueOnce({ code: "raw-monitor-failure" });
    const view = render(<Probe active={true} savedSessionId="ssh-1" />);

    await act(async () => {
      await Promise.resolve();
    });

    expect(apiMocks.getServerInfoSnapshot).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector("[data-error]")?.getAttribute("data-error")).toBe("[object Object]");

    view.unmount();
  });
});

function snapshot(hostId: string): ServerInfoSnapshot {
  return {
    captured_at: "1770000000",
    cpu_core_usage_percents: [],
    disks: [],
    gpus: [],
    host: "app.example.test",
    host_id: hostId,
    host_name: "生产服务器",
    network_interfaces: [],
    port: 22,
    top_processes: [],
    username: "deploy",
  };
}
