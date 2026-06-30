// Author: Liz
import { describe, expect, it } from "vitest";

import {
  applySshTunnelMode,
  buildJumpHostOptions,
  normalizeJumpHosts,
  normalizeSshOptions,
  sshTunnelMode,
} from "./sshSessionModel";
import type { SavedSession, SshTunnel } from "./types";

function session(overrides: Partial<SavedSession>): SavedSession {
  return {
    id: overrides.id ?? "session-1",
    name: overrides.name ?? "Session",
    type: overrides.type ?? "ssh",
    group_id: null,
    host: overrides.host ?? "127.0.0.1",
    port: overrides.port ?? 22,
    username: overrides.username ?? "root",
    auth_mode: overrides.auth_mode ?? "password",
    credential_ref: null,
    description: null,
    tags: [],
    sort_order: 0,
    created_at_ms: 1,
    updated_at_ms: 1,
    last_used_at_ms: null,
    ssh_options: null,
    rdp_options: null,
    local_options: null,
    ...overrides,
  };
}

describe("sshSessionModel", () => {
  it("normalizes SSH options before saving a draft", () => {
    const normalized = normalizeSshOptions({
      identity_file: " /home/me/.ssh/id_rsa ",
      jump_hosts: [" jump@10.0.0.1 ", " ", "ops@10.0.0.2"],
      tunnels: [
        {
          kind: "dynamic",
          name: " SOCKS ",
          bind_address: " ",
          local_port: 1080,
          remote_host: "internal.service",
          remote_port: 443,
        },
      ],
    });

    expect(normalized.identity_file).toBe("/home/me/.ssh/id_rsa");
    expect(normalized.jump_hosts).toEqual(["jump@10.0.0.1", "ops@10.0.0.2"]);
    expect(normalized.tunnels?.[0]).toMatchObject({
      mode: "socks",
      name: "SOCKS",
      auto_open: true,
      bind_address: "127.0.0.1",
      local_port: 1080,
      remote_host: null,
      remote_port: null,
    });
  });

  it("maps legacy tunnel kinds and applies mode presets without losing shared fields", () => {
    expect(sshTunnelMode({ kind: "local" })).toBe("host_service");
    expect(sshTunnelMode({ kind: "remote" })).toBe("local_service");
    expect(sshTunnelMode({ kind: "remote_dynamic" })).toBe("socks");

    const next = applySshTunnelMode(
      {
        kind: "local",
        name: " Dev proxy ",
        auto_open: false,
        bind_address: " 0.0.0.0 ",
        local_port: 18080,
        remote_host: "127.0.0.1",
        remote_port: 8080,
      },
      "socks",
    );

    expect(next).toEqual({
      mode: "socks",
      name: " Dev proxy ",
      kind: "dynamic",
      auto_open: false,
      bind_address: "0.0.0.0",
      local_port: 18080,
      remote_host: null,
      remote_port: null,
    } satisfies SshTunnel);
  });

  it("builds jump host choices from other SSH sessions only", () => {
    const options = buildJumpHostOptions(
      [
        session({ id: "current", host: "10.0.0.1", username: "root" }),
        session({ id: "jump", host: " 10.0.0.2 ", username: " deploy " }),
        session({ id: "host-only", host: " jumpbox ", username: " " }),
        session({ id: "local", type: "local", host: "localhost", username: "" }),
        session({ id: "empty", host: " ", username: "root" }),
      ],
      "current",
    );

    expect(options).toEqual([
      { id: "jump", label: "deploy@10.0.0.2", value: "deploy@10.0.0.2" },
      { id: "host-only", label: "jumpbox", value: "jumpbox" },
      { id: "empty", label: "root@", value: "root@" },
    ]);
    expect(normalizeJumpHosts([" jumpbox ", "", " deploy@10.0.0.2 "])).toEqual([
      "jumpbox",
      "deploy@10.0.0.2",
    ]);
  });
});
