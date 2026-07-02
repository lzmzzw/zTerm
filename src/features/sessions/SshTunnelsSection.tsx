// Author: Liz
import { Plus } from "lucide-react";

import { emptySshTunnel as emptyTunnel } from "./sshSessionModel";
import { SshTunnelCard, tunnelModes } from "./SshTunnelCard";
import type { SshOptions, SshTunnel, SshTunnelMode } from "./types";

interface SshTunnelsSectionProps {
  sshOptions: SshOptions;
  host: string;
  hostServiceTargetHost?: string;
  hostServiceTargetEditable?: boolean;
  newTunnelMode: SshTunnelMode;
  onNewTunnelModeChange: (mode: SshTunnelMode) => void;
  onSshOptionsChange: (options: SshOptions) => void;
}

export function SshTunnelsSection({
  sshOptions,
  host,
  hostServiceTargetHost,
  hostServiceTargetEditable = false,
  newTunnelMode,
  onNewTunnelModeChange,
  onSshOptionsChange,
}: SshTunnelsSectionProps) {
  const tunnels = sshOptions.tunnels ?? [];
  const normalizedHost = host.trim();
  const normalizedHostServiceTargetHost = hostServiceTargetHost?.trim() || normalizedHost;

  return (
    <div className="zt-session-form-wide zt-ssh-tunnel-editor" aria-label="隧道">
      <div className="zt-ssh-tunnel-header">
        <span>隧道</span>
        <button
          type="button"
          aria-label="添加隧道"
          onClick={() =>
            onSshOptionsChange({
              ...sshOptions,
              tunnels: [...tunnels, emptyTunnelForHost(newTunnelMode, normalizedHostServiceTargetHost)],
            })
          }
        >
          <Plus size={14} aria-hidden="true" />
          添加隧道
        </button>
      </div>
      <div className="zt-ssh-tunnel-mode-grid" role="group" aria-label="隧道用途">
        {tunnelModes.map((mode) => (
          <button
            key={mode.value}
            type="button"
            aria-label={mode.title}
            aria-pressed={newTunnelMode === mode.value}
            onClick={() => onNewTunnelModeChange(mode.value)}
          >
            <span>
              <strong>{mode.title}</strong>
              <code>{mode.command}</code>
            </span>
          </button>
        ))}
      </div>
      {tunnels.length === 0 ? <div className="zt-empty-line">暂无隧道</div> : null}
      {tunnels.map((tunnel, index) => (
        <SshTunnelCard
          key={index}
          index={index}
          tunnel={tunnel}
          host={normalizedHost}
          hostServiceTargetHost={normalizedHostServiceTargetHost}
          hostServiceTargetEditable={hostServiceTargetEditable}
          onChange={(nextTunnel) => {
            const nextTunnels = [...tunnels];
            nextTunnels[index] = nextTunnel;
            onSshOptionsChange({ ...sshOptions, tunnels: nextTunnels });
          }}
          onDelete={() => {
            const nextTunnels = tunnels.filter((_, itemIndex) => itemIndex !== index);
            onSshOptionsChange({ ...sshOptions, tunnels: nextTunnels });
          }}
        />
      ))}
    </div>
  );
}

function emptyTunnelForHost(mode: SshTunnelMode, host: string): SshTunnel {
  const tunnel = emptyTunnel(mode);
  if (mode !== "host_service" || !host) {
    return tunnel;
  }
  return { ...tunnel, remote_host: host };
}
