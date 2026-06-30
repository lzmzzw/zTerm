// Author: Liz
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { ServerMonitorPanel } from "./ServerMonitorPanel";
import type { ServerInfoSnapshot } from "./serverInfoApi";

function render(ui: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

function button(container: HTMLElement, label: string) {
  const match = Array.from(container.querySelectorAll("button")).find(
    (item) => item.textContent?.trim() === label || item.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`Button not found: ${label}`);
  return match as HTMLButtonElement;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function chooseSelect(container: HTMLElement, label: string, value: string) {
  const trigger = container.querySelector(`[aria-label="${label}"][role="combobox"]`) as HTMLElement | null;
  if (!trigger) throw new Error(`Select not found: ${label}`);
  await click(trigger);
  const option = Array.from(document.querySelectorAll('[role="option"]')).find(
    (item) => item.getAttribute("data-value") === value,
  );
  if (!option) throw new Error(`Option not found: ${label}=${value}`);
  await click(option as HTMLElement);
}

describe("ServerMonitorPanel", () => {
  it("renders empty state without active ssh session", () => {
    const view = render(
      <ServerMonitorPanel
        active={true}
        target={null}
        error={null}
        loading={false}
        networkTraffic={null}
        refreshIntervalMs={3000}
        snapshot={null}
        onRefresh={vi.fn()}
        onRefreshIntervalChange={vi.fn()}
      />,
    );

    expect(view.container.textContent).toContain("打开 SSH 会话后显示资源监控");
    view.unmount();
  });

  it("renders overview metric cards and expands details", async () => {
    const view = render(
      <ServerMonitorPanel
        active={true}
        target={{
          host: "app.example.test",
          id: "ssh-1",
          name: "生产服务器",
          port: 22,
          username: "deploy",
        }}
        error={null}
        loading={false}
        networkTraffic={null}
        refreshIntervalMs={3000}
        snapshot={snapshot()}
        onRefresh={vi.fn()}
        onRefreshIntervalChange={vi.fn()}
      />,
    );

    expect(view.container.textContent).toContain("生产服务器");
    expect(view.container.textContent).toContain("Ubuntu 24.04 LTS · x86_64");
    expect(view.container.textContent).toContain("CPU");
    expect(view.container.textContent).toContain("GPU");
    expect(view.container.textContent).toContain("内存");

    await click(button(view.container, "展开CPU详情"));
    expect(view.container.textContent).toContain("AMD EPYC Preview");
    expect(view.container.textContent).toContain("Load");

    view.unmount();
  });

  it("shows loading error and refresh interval controls", async () => {
    const onRefresh = vi.fn();
    const onRefreshIntervalChange = vi.fn();
    const view = render(
      <ServerMonitorPanel
        active={true}
        target={{
          host: "app.example.test",
          id: "ssh-1",
          name: "生产服务器",
          port: 22,
          username: "deploy",
        }}
        error="采集失败"
        loading={true}
        networkTraffic={null}
        refreshIntervalMs={3000}
        snapshot={null}
        onRefresh={onRefresh}
        onRefreshIntervalChange={onRefreshIntervalChange}
      />,
    );

    expect(view.container.textContent).toContain("采集失败");
    await click(button(view.container, "刷新服务器信息"));
    expect(onRefresh).toHaveBeenCalledWith({ force: true });

    await chooseSelect(view.container, "服务器信息采集间隔", "5000");
    expect(onRefreshIntervalChange).toHaveBeenCalledWith(5000);

    view.unmount();
  });
});

function snapshot(): ServerInfoSnapshot {
  return {
    architecture: "x86_64",
    captured_at: "1770000000",
    cpu_count: 4,
    cpu_core_usage_percents: [8.2, 12.4],
    cpu_model: "AMD EPYC Preview",
    cpu_usage_percent: 12.5,
    disk_available_bytes: 49392123904,
    disk_mount: "/",
    disk_total_bytes: 68719476736,
    disk_used_bytes: 19327352832,
    disks: [],
    gpu_probe_status: "nvidia_smi",
    gpus: [
      {
        driver_version: "555.42",
        memory_total_bytes: 25769803776,
        memory_used_bytes: 6442450944,
        name: "NVIDIA RTX 4090",
        temperature_celsius: 54,
        utilization_percent: 36.5,
        vendor: "NVIDIA",
      },
    ],
    host: "app.example.test",
    host_id: "ssh-1",
    host_name: "生产服务器",
    hostname: "prod-app-01",
    kernel: "6.8.0-40-generic",
    load_average: [0.18, 0.24, 0.31],
    memory_available_bytes: 5368709120,
    memory_cached_bytes: 1572864000,
    memory_buffers_bytes: 268435456,
    memory_total_bytes: 8589934592,
    memory_used_bytes: 3221225472,
    network_interfaces: [],
    network_rx_bytes: 10345678,
    network_tx_bytes: 7765432,
    os: "Ubuntu 24.04 LTS",
    port: 22,
    process_count: 142,
    running_process_count: 3,
    swap_total_bytes: 2147483648,
    swap_used_bytes: 0,
    top_processes: [
      {
        cpu_usage_percent: 8.2,
        memory_bytes: 75497472,
        memory_percent: 1.4,
        name: "node",
        pid: 4201,
      },
    ],
    uptime_seconds: 186400,
    username: "deploy",
  };
}
