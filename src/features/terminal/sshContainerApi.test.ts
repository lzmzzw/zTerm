// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

import { listSshContainers } from "./sshContainerApi";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("sshContainerApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists SSH containers through the dedicated IPC command", async () => {
    invokeMock.mockResolvedValue([
      {
        id: "abc123",
        name: "api",
        image: "app:latest",
        status: "Up 3 minutes",
        running: true,
      },
    ]);

    const containers = await listSshContainers("session-1");

    expect(invokeMock).toHaveBeenCalledWith("ssh_container_list", { savedSessionId: "session-1" });
    expect(containers).toEqual([
      {
        id: "abc123",
        name: "api",
        image: "app:latest",
        status: "Up 3 minutes",
        running: true,
      },
    ]);
  });

  it("passes the active runtime id only when transient SSH needs the existing shell", async () => {
    invokeMock.mockResolvedValue([]);

    await listSshContainers("external:launch-1", { runtimeSessionId: "runtime-external" });

    expect(invokeMock).toHaveBeenCalledWith("ssh_container_list", {
      savedSessionId: "external:launch-1",
      runtimeSessionId: "runtime-external",
    });
  });
});
