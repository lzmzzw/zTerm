// Author: Liz
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  externalSshChannelPolicy,
  externalSshHostServiceTarget,
  getExternalSshOptions,
  updateExternalSshOptions,
} from "./externalLaunchApi";
import type { SshOptions } from "../sessions/types";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

describe("externalLaunchApi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads transient SSH options through the external launch IPC command", async () => {
    const options: SshOptions = {
      tunnels: [],
      container: {
        enabled: true,
        runtime: "docker",
        container: "",
        shell: "/bin/sh",
        user: null,
        workdir: null,
      },
    };
    invokeMock.mockResolvedValue(options);

    await expect(getExternalSshOptions("external:launch-1")).resolves.toEqual(options);

    expect(invokeMock).toHaveBeenCalledWith("external_launch_get_ssh_options", {
      sessionId: "external:launch-1",
    });
  });

  it("updates transient SSH options without using the saved session API", async () => {
    const options: SshOptions = {
      tunnels: [
        {
          mode: "host_service",
          kind: "local",
          name: "管理后台",
          auto_open: true,
          bind_address: "127.0.0.1",
          local_port: 18080,
          remote_host: "127.0.0.1",
          remote_port: 8080,
        },
      ],
      container: {
        enabled: true,
        runtime: "podman",
        container: "",
        shell: "/bin/sh",
        user: null,
        workdir: null,
      },
    };
    invokeMock.mockResolvedValue(options);

    await expect(updateExternalSshOptions("external:launch-1", options)).resolves.toEqual(options);

    expect(invokeMock).toHaveBeenCalledWith("external_launch_update_ssh_options", {
      sessionId: "external:launch-1",
      sshOptions: options,
    });
  });

  it("uses the external launch host as the default host-service tunnel target", () => {
    expect(
      externalSshHostServiceTarget({
        host: "10.11.0.75",
        username: "root",
      }),
    ).toBe("10.11.0.75");
  });

  it("uses loopback as the host-service tunnel target for b64 gateway usernames", () => {
    expect(
      externalSshHostServiceTarget({
        host: "172.21.195.223",
        username: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=",
      }),
    ).toBe("127.0.0.1");
  });

  it("marks valid b64 gateway usernames as single-channel SSH sessions", () => {
    expect(
      externalSshChannelPolicy({
        username: "b64>>d2VuOjQ2ODI3MTc4NTE2MDJAcm9vdEAxMC4xMS4wLjc1OjIyOlNTSDI=",
      }),
    ).toBe("single_channel");
  });

  it("keeps an explicit multi-channel policy from the backend", () => {
    expect(
      externalSshChannelPolicy({
        channel_policy: "multi_channel",
        username: "ops",
      }),
    ).toBe("multi_channel");
  });

  it("falls back to the external launch host when the b64 gateway username is invalid", () => {
    expect(
      externalSshHostServiceTarget({
        host: "172.21.195.223",
        username: "b64>>not-valid-base64",
      }),
    ).toBe("172.21.195.223");
  });

  it("keeps normal or invalid external SSH sessions as unknown channel policy", () => {
    expect(externalSshChannelPolicy({ username: "ops" })).toBe("unknown");
    expect(externalSshChannelPolicy({ username: "b64>>not-valid-base64" })).toBe("unknown");
  });
});
