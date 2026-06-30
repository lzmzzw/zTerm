// Author: Liz
import type { SavedSession, SshOptions, SshTunnel, SshTunnelMode } from "./types";

interface JumpHostOption {
  id: string;
  label: string;
  value: string;
}

export const defaultSshOptions: SshOptions = {
  connect_timeout_ms: 10000,
  keepalive_interval_ms: 30000,
  proxy_command: null,
  identity_file: null,
  jump_hosts: [],
  tunnels: [],
  container: {
    enabled: false,
    runtime: "docker",
    container: "",
    shell: "/bin/sh",
    user: null,
    workdir: null,
  },
};

const sshTunnelModes: SshTunnelMode[] = ["host_service", "local_service", "local_network", "socks"];

export function normalizeSshOptions(options: SshOptions): SshOptions {
  const identityFile = options.identity_file?.trim() || null;
  return {
    ...options,
    identity_file: identityFile,
    jump_hosts: normalizeJumpHosts(options.jump_hosts),
    tunnels: (options.tunnels ?? []).map(normalizeSshTunnel),
  };
}

function normalizeSshTunnel(tunnel: SshTunnel): SshTunnel {
  const mode = sshTunnelMode(tunnel);
  const isSocks = mode === "socks";
  return {
    ...tunnel,
    mode,
    name: tunnel.name?.trim() || null,
    auto_open: tunnel.auto_open ?? true,
    bind_address: tunnel.bind_address?.trim() || "127.0.0.1",
    local_port: tunnel.local_port ?? null,
    remote_host: isSocks ? null : (tunnel.remote_host?.trim() || null),
    remote_port: isSocks ? null : (tunnel.remote_port ?? null),
  };
}

export function applySshTunnelMode(tunnel: SshTunnel, mode: SshTunnelMode): SshTunnel {
  const preset = emptySshTunnel(mode);
  return {
    ...preset,
    name: tunnel.name ?? null,
    auto_open: tunnel.auto_open ?? true,
    bind_address: tunnel.bind_address?.trim() || preset.bind_address,
    local_port: tunnel.local_port ?? null,
    remote_host: mode === "socks" ? null : (tunnel.remote_host?.trim() || preset.remote_host),
    remote_port: mode === "socks" ? null : (tunnel.remote_port ?? null),
  };
}

export function sshTunnelMode(tunnel: Pick<SshTunnel, "kind" | "mode">): SshTunnelMode {
  if (isSshTunnelMode(tunnel.mode)) {
    return tunnel.mode;
  }
  if (tunnel.kind === "local") return "host_service";
  if (tunnel.kind === "remote") return "local_service";
  return "socks";
}

function isSshTunnelMode(value: unknown): value is SshTunnelMode {
  return sshTunnelModes.some((mode) => mode === value);
}

export function emptySshTunnel(mode: SshTunnelMode): SshTunnel {
  switch (mode) {
    case "host_service":
      return {
        mode,
        name: null,
        kind: "local",
        auto_open: true,
        bind_address: "127.0.0.1",
        local_port: null,
        remote_host: "127.0.0.1",
        remote_port: null,
      };
    case "local_service":
      return {
        mode,
        name: null,
        kind: "remote",
        auto_open: true,
        bind_address: "127.0.0.1",
        local_port: null,
        remote_host: "127.0.0.1",
        remote_port: null,
      };
    case "local_network":
      return {
        mode,
        name: null,
        kind: "remote",
        auto_open: true,
        bind_address: "127.0.0.1",
        local_port: null,
        remote_host: "127.0.0.1",
        remote_port: null,
      };
    case "socks":
      return {
        mode,
        name: null,
        kind: "dynamic",
        auto_open: true,
        bind_address: "127.0.0.1",
        local_port: null,
        remote_host: null,
        remote_port: null,
      };
  }
}

export function emptySshContainer(): NonNullable<SshOptions["container"]> {
  return {
    enabled: false,
    runtime: "docker",
    container: "",
    shell: "/bin/sh",
    user: null,
    workdir: null,
  };
}

export function buildJumpHostOptions(sessions: SavedSession[], currentSessionId: string | null): JumpHostOption[] {
  return sessions
    .filter((session) => session.type === "ssh" && session.id !== currentSessionId)
    .map((session) => {
      const host = session.host.trim();
      const username = session.username.trim();
      const value = username ? `${username}@${host}` : host;
      return {
        id: session.id,
        label: value,
        value,
      };
    })
    .filter((option) => option.value.length > 0);
}

export function normalizeJumpHosts(jumpHosts: string[] | undefined): string[] {
  return (jumpHosts ?? []).map((item) => item.trim()).filter(Boolean);
}
