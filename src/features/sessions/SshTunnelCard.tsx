// Author: Liz
import { Trash2 } from "lucide-react";

import { ZtNumberInput } from "../../components/ZtNumberInput";
import { ZtSelect } from "../../components/ZtSelect";
import { sshTunnelMode as tunnelMode } from "./sshSessionModel";
import type { SshTunnel, SshTunnelMode } from "./types";

export const tunnelModes: Array<{
  value: SshTunnelMode;
  title: string;
  command: string;
  description: string;
}> = [
  {
    value: "host_service",
    title: "访问主机服务",
    command: "-L",
    description: "把主机服务映射到本机端口",
  },
  {
    value: "local_service",
    title: "暴露本机服务",
    command: "-R",
    description: "把本机服务暴露到主机端口",
  },
  {
    value: "local_network",
    title: "主机使用本机网络",
    command: "-R + proxy",
    description: "让主机命令通过本机代理访问外部",
  },
  {
    value: "socks",
    title: "SOCKS / 高级",
    command: "-D / remote -R",
    description: "创建 SOCKS 代理入口",
  },
];

const bindOptions = [
  { value: "127.0.0.1", label: "仅本机 (127.0.0.1)" },
  { value: "0.0.0.0", label: "所有网络 (0.0.0.0)" },
];

const socksLocationOptions = [
  { value: "local", label: "本机 (-D)" },
  { value: "remote", label: "主机 (remote -R)" },
];

export function SshTunnelCard({
  index,
  tunnel,
  host,
  onChange,
  onDelete,
}: {
  index: number;
  tunnel: SshTunnel;
  host: string;
  onChange: (tunnel: SshTunnel) => void;
  onDelete: () => void;
}) {
  const mode = tunnelMode(tunnel);
  const modeLabel = tunnelModes.find((item) => item.value === mode)?.title ?? "SSH 隧道";
  const displayName = tunnel.name?.trim() || `${modeLabel} ${index + 1}`;
  const socksLocation = tunnel.kind === "remote_dynamic" ? "remote" : "local";
  const hostServiceTarget = host.trim();

  return (
    <section className="zt-ssh-tunnel-card" aria-label={displayName}>
      <div className="zt-ssh-tunnel-card-header">
        <input
          className="zt-ssh-tunnel-name-input"
          aria-label="隧道名称"
          value={displayName}
          onChange={(event) => onChange({ ...tunnel, name: event.currentTarget.value || null })}
          placeholder={modeLabel}
        />
        <div className="zt-ssh-tunnel-card-actions">
          <label className="zt-ssh-tunnel-auto">
            <input
              aria-label="在连接时自动打开"
              type="checkbox"
              checked={tunnel.auto_open ?? true}
              onChange={(event) => onChange({ ...tunnel, auto_open: event.currentTarget.checked })}
            />
            <span>在连接时自动打开</span>
          </label>
          <button type="button" aria-label="删除隧道" title="删除隧道" onClick={onDelete}>
            <Trash2 size={14} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div className="zt-ssh-tunnel-card-grid">
        {mode === "host_service" ? (
          <>
            <label>
              <span>主机目标地址</span>
              <input
                aria-label="主机目标地址"
                value={hostServiceTarget}
                readOnly
              />
            </label>
            <label>
              <span>主机目标端口</span>
              <ZtNumberInput
                ariaLabel="主机目标端口"
                min={1}
                max={65535}
                step={1}
                value={tunnel.remote_port ?? null}
                onChange={(value) => onChange({ ...tunnel, remote_port: value })}
              />
            </label>
            <BindAddressSelect
              label="本机监听范围"
              value={tunnel.bind_address}
              onChange={(bind_address) => onChange({ ...tunnel, bind_address })}
            />
            <label>
              <span>本机监听端口</span>
              <ZtNumberInput
                ariaLabel="本机监听端口"
                min={1}
                max={65535}
                step={1}
                value={tunnel.local_port ?? null}
                onChange={(value) => onChange({ ...tunnel, local_port: value })}
              />
            </label>
          </>
        ) : null}
        {mode === "local_service" ? (
          <>
            <label>
              <span>本机服务地址</span>
              <input
                aria-label="本机服务地址"
                value={tunnel.remote_host ?? ""}
                onChange={(event) => onChange({ ...tunnel, remote_host: event.currentTarget.value.trim() || null })}
                placeholder="127.0.0.1"
              />
            </label>
            <label>
              <span>本机服务端口</span>
              <ZtNumberInput
                ariaLabel="本机服务端口"
                min={1}
                max={65535}
                step={1}
                value={tunnel.remote_port ?? null}
                onChange={(value) => onChange({ ...tunnel, remote_port: value })}
              />
            </label>
            <BindAddressSelect
              label="主机监听范围"
              value={tunnel.bind_address}
              onChange={(bind_address) => onChange({ ...tunnel, bind_address })}
            />
            <label>
              <span>主机监听端口</span>
              <ZtNumberInput
                ariaLabel="主机监听端口"
                min={1}
                max={65535}
                step={1}
                value={tunnel.local_port ?? null}
                onChange={(value) => onChange({ ...tunnel, local_port: value })}
              />
            </label>
          </>
        ) : null}
        {mode === "local_network" ? (
          <>
            <label>
              <span>本机代理地址</span>
              <input
                aria-label="本机代理地址"
                value={tunnel.remote_host ?? ""}
                onChange={(event) => onChange({ ...tunnel, remote_host: event.currentTarget.value.trim() || null })}
                placeholder="127.0.0.1"
              />
            </label>
            <label>
              <span>本机代理端口</span>
              <ZtNumberInput
                ariaLabel="本机代理端口"
                min={1}
                max={65535}
                step={1}
                value={tunnel.remote_port ?? null}
                onChange={(value) => onChange({ ...tunnel, remote_port: value })}
              />
            </label>
            <BindAddressSelect
              label="主机代理入口范围"
              value={tunnel.bind_address}
              onChange={(bind_address) => onChange({ ...tunnel, bind_address })}
            />
            <label>
              <span>主机代理入口端口</span>
              <ZtNumberInput
                ariaLabel="主机代理入口端口"
                min={1}
                max={65535}
                step={1}
                value={tunnel.local_port ?? null}
                onChange={(value) => onChange({ ...tunnel, local_port: value })}
              />
            </label>
          </>
        ) : null}
        {mode === "socks" ? (
          <>
            <label>
              <span>SOCKS 入口位置</span>
              <ZtSelect
                ariaLabel="SOCKS 入口位置"
                value={socksLocation}
                options={socksLocationOptions}
                onChange={(nextValue) =>
                  onChange({
                    ...tunnel,
                    mode: "socks",
                    kind: nextValue === "remote" ? "remote_dynamic" : "dynamic",
                    remote_host: null,
                    remote_port: null,
                  })
                }
              />
            </label>
            <BindAddressSelect
              label="SOCKS 监听范围"
              value={tunnel.bind_address}
              onChange={(bind_address) => onChange({ ...tunnel, bind_address })}
            />
            <label>
              <span>SOCKS 监听端口</span>
              <ZtNumberInput
                ariaLabel="SOCKS 监听端口"
                min={1}
                max={65535}
                step={1}
                value={tunnel.local_port ?? null}
                onChange={(value) => onChange({ ...tunnel, local_port: value })}
              />
            </label>
          </>
        ) : null}
      </div>
    </section>
  );
}

function BindAddressSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string | null;
  onChange: (value: string | null) => void;
}) {
  const normalized = value?.trim() || "127.0.0.1";
  const options = bindOptions.some((option) => option.value === normalized)
    ? bindOptions
    : [...bindOptions, { value: normalized, label: normalized }];

  return (
    <label>
      <span>{label}</span>
      <ZtSelect ariaLabel={label} value={normalized} options={options} onChange={(nextValue) => onChange(nextValue || null)} />
    </label>
  );
}
