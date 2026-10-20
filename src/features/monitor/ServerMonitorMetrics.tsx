// Author: Liz
import { Activity, ChevronDown, Cpu, Gauge, HardDrive, MemoryStick, Network, Server } from "lucide-react";
import type { ReactNode } from "react";

import type { ServerInfoSnapshot } from "./serverInfoApi";
import {
  formatBytes,
  formatLoadAverage,
  formatPercent,
  formatTrafficRate,
  gpuMemoryLabel,
  gpuMissingMessage,
  percentOf,
  primaryGpuValue,
} from "./serverInfoFormatters";
import type { NetworkTrafficSnapshot } from "./serverInfoMetricsModel";

export type MetricCardId = "cpu" | "gpu" | "memory" | "swap" | "disk" | "network" | "process";

type ServerDiskInfo = ServerInfoSnapshot["disks"][number];
type ServerGpuInfo = ServerInfoSnapshot["gpus"][number];
type ServerProcessInfo = ServerInfoSnapshot["top_processes"][number];

export function ServerMetrics({
  expandedCards,
  networkTraffic,
  onToggleMetric,
  snapshot,
}: {
  expandedCards: Set<MetricCardId>;
  networkTraffic: NetworkTrafficSnapshot | null;
  onToggleMetric: (cardId: MetricCardId) => void;
  snapshot: ServerInfoSnapshot;
}) {
  const memoryPercent = percentOf(snapshot.memory_used_bytes, snapshot.memory_total_bytes);
  const swapPercent = percentOf(snapshot.swap_used_bytes, snapshot.swap_total_bytes);
  const diskPercent = percentOf(snapshot.disk_used_bytes, snapshot.disk_total_bytes);
  const traffic = networkTraffic;
  return (
    <div className="zt-monitor-card-list">
      <MetricCard
        meterValue={snapshot.cpu_usage_percent}
        metricId="cpu"
        expanded={expandedCards.has("cpu")}
        helper={formatLoadAverage(snapshot.load_average) ? `Load ${formatLoadAverage(snapshot.load_average)}` : `${snapshot.cpu_count ?? "-"} 核`}
        icon={<Cpu size={14} aria-hidden="true" />}
        onToggle={() => onToggleMetric("cpu")}
        title="CPU"
        value={formatPercent(snapshot.cpu_usage_percent)}
      >
        <InfoRows
          rows={[
            ["平均使用", formatPercent(snapshot.cpu_usage_percent)],
            ["核心数", snapshot.cpu_count?.toString() ?? "-"],
            ["Load", formatLoadAverage(snapshot.load_average) ?? "-"],
            ["型号", snapshot.cpu_model ?? "-"],
          ]}
        />
      </MetricCard>
      <MetricCard
        metricId="gpu"
        expanded={expandedCards.has("gpu")}
        helper={snapshot.gpus.length > 0 ? `${snapshot.gpus.length} 张显卡` : gpuMissingMessage(snapshot.gpu_probe_status)}
        icon={<Gauge size={14} aria-hidden="true" />}
        onToggle={() => onToggleMetric("gpu")}
        title="GPU"
        value={snapshot.gpus.length > 0 ? primaryGpuValue(snapshot.gpus) : "未识别"}
      >
        {snapshot.gpus.length > 0 ? snapshot.gpus.map((gpu, index) => <GpuRow gpu={gpu} index={index} key={`${gpu.name}-${index}`} />) : <p>{gpuMissingMessage(snapshot.gpu_probe_status)}</p>}
      </MetricCard>
      <MetricCard
        metricId="memory"
        expanded={expandedCards.has("memory")}
        meterValue={memoryPercent}
        helper={`${formatBytes(snapshot.memory_used_bytes)} / ${formatBytes(snapshot.memory_total_bytes)}`}
        icon={<MemoryStick size={14} aria-hidden="true" />}
        onToggle={() => onToggleMetric("memory")}
        title="内存"
        value={formatPercent(memoryPercent)}
      >
        <InfoRows
          rows={[
            ["已用", formatBytes(snapshot.memory_used_bytes)],
            ["可用", formatBytes(snapshot.memory_available_bytes)],
            ["Buffers", formatBytes(snapshot.memory_buffers_bytes)],
            ["Cached", formatBytes(snapshot.memory_cached_bytes)],
          ]}
        />
      </MetricCard>
      <MetricCard
        metricId="swap"
        expanded={expandedCards.has("swap")}
        helper={`${formatBytes(snapshot.swap_used_bytes)} / ${formatBytes(snapshot.swap_total_bytes)}`}
        icon={<Server size={14} aria-hidden="true" />}
        onToggle={() => onToggleMetric("swap")}
        title="Swap"
        value={formatPercent(swapPercent)}
      >
        <Meter value={swapPercent} />
        <InfoRows rows={[["已用", formatBytes(snapshot.swap_used_bytes)], ["总计", formatBytes(snapshot.swap_total_bytes)]]} />
      </MetricCard>
      <MetricCard
        metricId="disk"
        expanded={expandedCards.has("disk")}
        meterValue={diskPercent}
        helper={`${snapshot.disk_mount ?? "/"} · ${formatBytes(snapshot.disk_used_bytes)} / ${formatBytes(snapshot.disk_total_bytes)}`}
        icon={<HardDrive size={14} aria-hidden="true" />}
        onToggle={() => onToggleMetric("disk")}
        title="磁盘"
        value={formatPercent(diskPercent)}
      >
        <InfoRows
          rows={[
            ["挂载点", snapshot.disk_mount ?? "/"],
            ["已用", formatBytes(snapshot.disk_used_bytes)],
            ["可用", formatBytes(snapshot.disk_available_bytes)],
            ["总计", formatBytes(snapshot.disk_total_bytes)],
          ]}
        />
        {snapshot.disks.map((disk, index) => <DiskRow disk={disk} key={`${disk.mount}-${index}`} />)}
      </MetricCard>
      <MetricCard
        metricId="network"
        expanded={expandedCards.has("network")}
        helper={traffic?.top_interface ? `流量排行 ${traffic.top_interface.name}` : "等待网络采样"}
        icon={<Network size={14} aria-hidden="true" />}
        onToggle={() => onToggleMetric("network")}
        title="网络"
        value={`↑ ${formatTrafficRate(traffic?.total_tx_bytes_per_second, "采样中")}  ↓ ${formatTrafficRate(traffic?.total_rx_bytes_per_second, "采样中")}`}
      >
        <InfoRows
          rows={[
            ["排行首位", traffic?.top_interface?.name ?? "-"],
            ["上行", formatTrafficRate(traffic?.top_interface?.tx_bytes_per_second, "等待采样")],
            ["下行", formatTrafficRate(traffic?.top_interface?.rx_bytes_per_second, "等待采样")],
          ]}
        />
      </MetricCard>
      <MetricCard
        metricId="process"
        expanded={expandedCards.has("process")}
        helper={snapshot.running_process_count == null ? `${snapshot.process_count ?? "-"} 个` : `${snapshot.process_count} 个 / 运行 ${snapshot.running_process_count}`}
        icon={<Activity size={14} aria-hidden="true" />}
        onToggle={() => onToggleMetric("process")}
        title="进程"
        value={snapshot.process_count?.toString() ?? "-"}
      >
        {snapshot.top_processes.map((process) => <ProcessRow key={`${process.pid}-${process.name}`} process={process} />)}
      </MetricCard>
    </div>
  );
}

function MetricCard({
  children,
  expanded,
  helper,
  icon,
  onToggle,
  title,
  value,
  meterValue,
  metricId,
}: {
  children: ReactNode;
  expanded: boolean;
  helper: string;
  icon: ReactNode;
  onToggle: () => void;
  title: string;
  value: ReactNode;
  meterValue?: number | null;
  metricId: MetricCardId;
}) {
  const primary = ["cpu", "memory", "disk", "network"].includes(metricId);
  return (
    <section className={`zt-monitor-card zt-monitor-${metricId}${primary ? " is-primary" : " is-secondary"}${expanded ? " is-expanded" : ""}`}>
      <header
        className="zt-monitor-card-toggle"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"}${title}详情`}
        title={`${expanded ? "收起" : "展开"}${title}详情`}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onToggle();
        }}
      >
        <ChevronDown className="zt-monitor-card-indicator" size={14} aria-hidden="true" />
        <div>
          {icon}
          <span>{title}</span>
        </div>
        <strong>{value}</strong>
      </header>
      <small className="zt-monitor-row-helper">{helper}</small>
      <Meter value={meterValue} />
      {expanded ? <div className="zt-monitor-card-body">{children}</div> : null}
    </section>
  );
}

function Meter({ value }: { value?: number | null }) {
  if (value == null || Number.isNaN(value)) return null;
  return (
    <div className="zt-monitor-meter">
      <span style={{ width: `${Math.max(0, Math.min(value, 100))}%` }} />
    </div>
  );
}

function InfoRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="zt-monitor-info-rows">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function GpuRow({ gpu, index }: { gpu: ServerGpuInfo; index: number }) {
  const memoryPercent = percentOf(gpu.memory_used_bytes, gpu.memory_total_bytes);
  return (
    <article className="zt-monitor-sub-card">
      <strong>{gpu.name}</strong>
      <span>GPU {index + 1}{gpu.vendor ? ` · ${gpu.vendor}` : ""}</span>
      <Meter value={gpu.utilization_percent ?? memoryPercent} />
      <InfoRows
        rows={[
          ["使用率", formatPercent(gpu.utilization_percent)],
          ["显存", gpuMemoryLabel(gpu)],
          ["温度", gpu.temperature_celsius == null ? "-" : `${gpu.temperature_celsius.toFixed(0)} °C`],
          ["驱动", gpu.driver_version ?? "-"],
        ]}
      />
    </article>
  );
}

function DiskRow({ disk }: { disk: ServerDiskInfo }) {
  return (
    <article className="zt-monitor-sub-card">
      <strong>{disk.mount}</strong>
      <span>{disk.filesystem}</span>
      <Meter value={percentOf(disk.used_bytes, disk.total_bytes)} />
    </article>
  );
}

function ProcessRow({ process }: { process: ServerProcessInfo }) {
  return (
    <article className="zt-monitor-sub-card">
      <strong>{process.name}</strong>
      <span>PID {process.pid}</span>
      <InfoRows
        rows={[
          ["CPU", formatPercent(process.cpu_usage_percent)],
          ["内存", formatPercent(process.memory_percent)],
          ["RSS", formatBytes(process.memory_bytes)],
        ]}
      />
    </article>
  );
}
