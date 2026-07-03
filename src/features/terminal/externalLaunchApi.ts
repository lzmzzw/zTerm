// Author: Liz
import { invoke } from "@tauri-apps/api/core";

import type { SshOptions } from "../sessions/types";

export interface ExternalSshLaunchEvent {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auto_open_sftp: boolean;
  remote_path: string;
}

export async function takePendingExternalLaunches(): Promise<ExternalSshLaunchEvent[]> {
  return invoke<ExternalSshLaunchEvent[]>("external_launch_take_pending");
}

export async function getExternalSshOptions(sessionId: string): Promise<SshOptions> {
  return invoke<SshOptions>("external_launch_get_ssh_options", { sessionId });
}

export async function updateExternalSshOptions(sessionId: string, sshOptions: SshOptions): Promise<SshOptions> {
  return invoke<SshOptions>("external_launch_update_ssh_options", { sessionId, sshOptions });
}

export function externalSshHostServiceTarget(launch: Pick<ExternalSshLaunchEvent, "host" | "username"> | null | undefined): string {
  const host = launch?.host.trim() ?? "";
  return isB64GatewayUsername(launch?.username) ? "127.0.0.1" : host;
}

export function isExternalSessionId(value: string | null | undefined): value is string {
  return typeof value === "string" && value.startsWith("external:");
}

function targetHostFromB64Username(username: string | null | undefined): string | null {
  const payload = username?.trim().replace(/^["']|["']$/g, "").match(/^b64>>(.*)$/)?.[1];
  if (!payload) return null;
  try {
    return parseXshellB64TargetHost(decodeBase64(payload));
  } catch {
    return null;
  }
}

function isB64GatewayUsername(username: string | null | undefined): boolean {
  return targetHostFromB64Username(username) !== null;
}

function decodeBase64(payload: string): string {
  const normalized = payload.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  return globalThis.atob(padded);
}

function parseXshellB64TargetHost(payload: string): string | null {
  const beforeProtocol = splitLast(payload.trim(), ":");
  if (!beforeProtocol) return null;
  if (!["ssh", "ssh2"].includes(beforeProtocol[1].toLowerCase())) return null;
  const beforePort = splitLast(beforeProtocol[0], ":");
  if (!beforePort) return null;
  const beforeHost = splitLast(beforePort[0], "@");
  const host = beforeHost?.[1].trim();
  return host || null;
}

function splitLast(value: string, separator: string): [string, string] | null {
  const index = value.lastIndexOf(separator);
  if (index < 0) return null;
  return [value.slice(0, index), value.slice(index + separator.length)];
}
