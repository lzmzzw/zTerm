// Author: Liz
export type SessionType = "ssh" | "local" | "rdp";
export type AuthMode = "password" | "key" | "agent" | "none";
type SshTunnelKind = "local" | "remote" | "dynamic" | "remote_dynamic";
export type SshTunnelMode = "host_service" | "local_service" | "local_network" | "socks";

export interface SshTunnel {
  mode?: SshTunnelMode | null;
  name?: string | null;
  kind: SshTunnelKind;
  auto_open?: boolean;
  bind_address?: string | null;
  local_port?: number | null;
  remote_host?: string | null;
  remote_port?: number | null;
}

interface SshContainerOptions {
  enabled: boolean;
  runtime: "docker" | "podman" | string;
  container: string;
  shell?: string | null;
  user?: string | null;
  workdir?: string | null;
}

export interface SshOptions {
  connect_timeout_ms?: number | null;
  keepalive_interval_ms?: number | null;
  proxy_command?: string | null;
  identity_file?: string | null;
  jump_hosts?: string[];
  tunnels?: SshTunnel[];
  container?: SshContainerOptions | null;
}

export interface RdpOptions {
  domain: string | null;
  width: number;
  height: number;
  color_depth: 16 | 24 | 32;
  redirect_clipboard: boolean;
  fullscreen?: boolean;
}

interface LocalEnvironmentVariable {
  name: string;
  value: string;
}

export interface LocalOptions {
  profile_id?: string | null;
  working_directory?: string | null;
  environment?: LocalEnvironmentVariable[];
}

export interface SavedSession {
  id: string;
  name: string;
  type: SessionType;
  group_id: string | null;
  host: string;
  port: number;
  username: string;
  auth_mode: AuthMode;
  credential_ref: string | null;
  description: string | null;
  tags: string[];
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
  last_used_at_ms: number | null;
  ssh_options?: SshOptions | null;
  rdp_options?: RdpOptions | null;
  local_options?: LocalOptions | null;
}

export interface SessionGroup {
  id: string;
  parent_id: string | null;
  name: string;
  expanded: boolean;
  sort_order: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SessionTreeSnapshot {
  groups: SessionGroup[];
  sessions: SavedSession[];
}

export interface SessionGroupDraft {
  id?: string | null;
  parent_id: string | null;
  name: string;
  expanded: boolean;
  sort_order: number;
}

export interface SavedSessionDraft {
  id?: string | null;
  name: string;
  type: SessionType;
  group_id: string | null;
  host: string;
  port: number;
  username: string;
  auth_mode: AuthMode;
  credential_ref: string | null;
  description: string | null;
  tags: string[];
  sort_order: number;
  ssh_options?: SshOptions | null;
  rdp_options?: RdpOptions | null;
  local_options?: LocalOptions | null;
}

export interface SessionTestResult {
  ok: boolean;
  message: string;
}
