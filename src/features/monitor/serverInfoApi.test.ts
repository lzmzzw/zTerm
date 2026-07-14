import { beforeEach, describe, expect, it, vi } from "vitest";

import { getServerInfoSnapshot } from "./serverInfoApi";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("serverInfoApi", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({});
  });

  it("requests a local snapshot without a saved SSH session id", async () => {
    await getServerInfoSnapshot("local-machine");

    expect(invokeMock).toHaveBeenCalledWith("server_info_snapshot", { savedSessionId: null });
  });

  it("keeps the saved SSH session id for remote snapshots", async () => {
    await getServerInfoSnapshot("ssh-1");

    expect(invokeMock).toHaveBeenCalledWith("server_info_snapshot", { savedSessionId: "ssh-1" });
  });
});
