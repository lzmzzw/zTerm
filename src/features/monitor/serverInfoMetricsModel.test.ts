// Author: Liz
import { describe, expect, it } from "vitest";

import {
  clearServerInfoMetricsCacheForTest,
  updateNetworkTrafficCache,
} from "./serverInfoMetricsModel";
import type { ServerInfoSnapshot } from "./serverInfoApi";

describe("serverInfoMetricsModel", () => {
  it("computes network traffic rates from consecutive snapshots", () => {
    clearServerInfoMetricsCacheForTest();
    const first = snapshot({
      captured_at: "100",
      network_interfaces: [{ name: "eth0", rx_bytes: 1000, tx_bytes: 3000 }],
      network_rx_bytes: 1000,
      network_tx_bytes: 3000,
    });
    const second = snapshot({
      captured_at: "105",
      network_interfaces: [{ name: "eth0", rx_bytes: 6000, tx_bytes: 8000 }],
      network_rx_bytes: 6000,
      network_tx_bytes: 8000,
    });

    updateNetworkTrafficCache("ssh-1", first);
    const traffic = updateNetworkTrafficCache("ssh-1", second);

    expect(traffic.total_rx_bytes_per_second).toBe(1000);
    expect(traffic.total_tx_bytes_per_second).toBe(1000);
    expect(traffic.interfaces[0]).toMatchObject({
      name: "eth0",
      rx_bytes_per_second: 1000,
      tx_bytes_per_second: 1000,
    });
  });
});

function snapshot(overrides: Partial<ServerInfoSnapshot>): ServerInfoSnapshot {
  return {
    architecture: "x86_64",
    captured_at: "1",
    cpu_core_usage_percents: [],
    disks: [],
    gpus: [],
    host: "app.example.test",
    host_id: "ssh-1",
    host_name: "生产服务器",
    network_interfaces: [],
    port: 22,
    top_processes: [],
    username: "deploy",
    ...overrides,
  };
}
