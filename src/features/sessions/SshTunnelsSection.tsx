// Author: Liz
import { Plus } from "lucide-react";

import { emptySshTunnel as emptyTunnel } from "./sshSessionModel";
import { SshTunnelCard, tunnelModes } from "./SshTunnelCard";
import type { SshOptions, SshTunnelMode } from "./types";

interface SshTunnelsSectionProps {
  sshOptions: SshOptions;
  newTunnelMode: SshTunnelMode;
  onNewTunnelModeChange: (mode: SshTunnelMode) => void;
  onSshOptionsChange: (options: SshOptions) => void;
}

export function SshTunnelsSection({
  sshOptions,
  newTunnelMode,
  onNewTunnelModeChange,
  onSshOptionsChange,
}: SshTunnelsSectionProps) {
  const tunnels = sshOptions.tunnels ?? [];

  return (
    <div className="zt-session-form-wide zt-ssh-tunnel-editor" aria-label="隧道">
      <div className="zt-ssh-tunnel-header">
        <span>隧道</span>
        <button
          type="button"
          aria-label="添加"
          onClick={() =>
            onSshOptionsChange({
              ...sshOptions,
              tunnels: [...tunnels, emptyTunnel(newTunnelMode)],
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
              <small>{mode.description}</small>
            </span>
            <code>{mode.command}</code>
          </button>
        ))}
      </div>
      {tunnels.length === 0 ? <div className="zt-empty-line">暂无隧道</div> : null}
      {tunnels.map((tunnel, index) => (
        <SshTunnelCard
          key={index}
          index={index}
          tunnel={tunnel}
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
